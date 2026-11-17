import * as AppleAuthentication from 'expo-apple-authentication';
import * as Device from 'expo-device';
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { API_URL, ApiError, authInit, call, COOKIE_SESSION, usesCookie } from '@/lib/api';
import { appleWebIdToken } from '@/lib/apple-web';
import { clear as clearCache } from '@/lib/cache-store';
import { passkeyAnswer } from '@/lib/passkeys';
import { tokenStore } from '@/lib/token-store';

/** GitHub's code for the person to enter, and where. */
export type GitHubCode = { userCode: string; verificationUri: string };

const deviceName = () => (Platform.OS === 'web' ? browserName(navigator.userAgent) : (Device.deviceName ?? 'iPhone'));

/** "Chrome on macOS", so two browsers in the device list can be told apart. */
export function browserName(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : null;
  return os ? `${browser} on ${os}` : browser;
}

async function post<T>(path: string, body: unknown, init: { token?: string | null; signal?: AbortSignal } = {}): Promise<{ status: number; body: T & { error?: string } }> {
  const auth = authInit(init.token);
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    signal: init.signal,
    // The deployed web app asks for its sign-ins to come back as the cookie.
    credentials: usesCookie ? 'include' : auth.credentials,
    headers: { 'content-type': 'application/json', ...(usesCookie ? { 'x-sfo-session': 'cookie' } : {}), ...auth.headers },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(parsed.error ?? `The control plane answered ${res.status}`, res.status);
  return { status: res.status, body: parsed };
}

type SignedIn = { token?: string; cookie?: boolean };

/** The token a sign-in answered with, or the cookie stand-in when it set the cookie instead. */
function tokenFrom(body: SignedIn): string {
  if (body.cookie) return COOKIE_SESSION;
  if (!body.token) throw new Error('The control plane did not sign this device in');
  return body.token;
}

type Auth = {
  /** Undefined while the stored token is being read; null when signed out. */
  token: string | null | undefined;
  signIn(): Promise<void>;
  /** Signs this device in with a passkey already added to the account. False when the person cancelled. */
  passkey(): Promise<boolean>;
  /**
   * GitHub's device flow: shows `onCode` GitHub's code, then waits until the
   * person approves it on GitHub. Signs this device in, or with `link` adds
   * that GitHub account to the signed-in one.
   */
  gitHub(opts: { link?: boolean; onCode: (code: GitHubCode) => void; signal: AbortSignal }): Promise<void>;
  signOut(): Promise<void>;
  /** An authenticated call; a token that stops working signs this device out. */
  api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
};

const AuthContext = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  // Every setToken below is preceded by clearCache(): nothing one account
  // fetched may show to the next.
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    tokenStore.get().then((t) => {
      clearCache();
      setToken(t ?? null);
    });
  }, []);

  const signIn = useCallback(async () => {
    const idToken = Platform.OS === 'web' ? await appleWebIdToken() : (await AppleAuthentication.signInAsync({ requestedScopes: [] })).identityToken;
    if (!idToken) throw new Error('Apple did not return an identity token');
    const signedIn = tokenFrom((await post<SignedIn>('/auth/apple', { idToken, deviceName: deviceName() })).body);
    await tokenStore.set(signedIn);
    clearCache();
    setToken(signedIn);
  }, []);

  const passkey = useCallback(async () => {
    const started = await post<{ challengeId: string; options: Parameters<typeof passkeyAnswer>[0] }>('/auth/passkey/options', {});
    const response = await passkeyAnswer(started.body.options);
    if (!response) return false;
    const signedIn = tokenFrom((await post<SignedIn>('/auth/passkey', { challengeId: started.body.challengeId, response, deviceName: deviceName() })).body);
    await tokenStore.set(signedIn);
    clearCache();
    setToken(signedIn);
    return true;
  }, []);

  const gitHub = useCallback<Auth['gitHub']>(
    async ({ link, onCode, signal }) => {
      const started = await post<GitHubCode & { flow: string }>('/auth/github/start', {}, { signal });
      onCode({ userCode: started.body.userCode, verificationUri: started.body.verificationUri });
      // The server holds each wait about 50 s and answers 202 to be asked again.
      for (;;) {
        let r: Awaited<ReturnType<typeof post<SignedIn>>>;
        try {
          r = await post<SignedIn>('/auth/github/wait', { flow: started.body.flow, deviceName: deviceName(), link }, { token: link ? token : null, signal });
        } catch (err) {
          // A dropped connection (a network change, a phone between Wi-Fi and
          // cellular) loses only this wait: the flow lives on the server, so
          // ask again. The server's own answers, and cancelling, still end it.
          if (err instanceof ApiError || signal.aborted) throw err;
          await new Promise((resolve) => setTimeout(resolve, 2000));
          continue;
        }
        if (r.status === 202) continue;
        if (!link) {
          const signedIn = tokenFrom(r.body);
          await tokenStore.set(signedIn);
          clearCache();
          setToken(signedIn);
        }
        return;
      }
    },
    [token],
  );

  const signOut = useCallback(async () => {
    const current = await tokenStore.get();
    if (current) await call(current, '/devices/current', { method: 'DELETE' }).catch(() => undefined);
    await tokenStore.clear();
    clearCache();
    setToken(null);
  }, []);

  const api = useCallback(
    async <T,>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
      if (!token) throw new ApiError('Signed out', 401);
      try {
        return await call<T>(token, path, init);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          await tokenStore.clear();
          clearCache();
          setToken(null);
        }
        throw err;
      }
    },
    [token],
  );

  const value = useMemo(() => ({ token, signIn, passkey, gitHub, signOut, api }), [token, signIn, passkey, gitHub, signOut, api]);
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): Auth {
  const auth = use(AuthContext);
  if (!auth) throw new Error('useAuth outside AuthProvider');
  return auth;
}
