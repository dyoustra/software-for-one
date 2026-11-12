import * as AppleAuthentication from 'expo-apple-authentication';
import * as Device from 'expo-device';
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

import { API_URL, ApiError, call } from '@/lib/api';
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
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    signal: init.signal,
    headers: { 'content-type': 'application/json', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}) },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(parsed.error ?? `The control plane answered ${res.status}`, res.status);
  return { status: res.status, body: parsed };
}

type Auth = {
  /** Undefined while the stored token is being read; null when signed out. */
  token: string | null | undefined;
  signIn(): Promise<void>;
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
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    tokenStore.get().then((t) => setToken(t ?? null));
  }, []);

  const signIn = useCallback(async () => {
    const credential = await AppleAuthentication.signInAsync({ requestedScopes: [] });
    if (!credential.identityToken) throw new Error('Apple did not return an identity token');
    const { body } = await post<{ token: string }>('/auth/apple', { idToken: credential.identityToken, deviceName: deviceName() });
    await tokenStore.set(body.token);
    setToken(body.token);
  }, []);

  const gitHub = useCallback<Auth['gitHub']>(
    async ({ link, onCode, signal }) => {
      const started = await post<GitHubCode & { flow: string }>('/auth/github/start', {}, { signal });
      onCode({ userCode: started.body.userCode, verificationUri: started.body.verificationUri });
      // The server holds each wait about 50 s and answers 202 to be asked again.
      for (;;) {
        const r = await post<{ token?: string }>('/auth/github/wait', { flow: started.body.flow, deviceName: deviceName(), link }, { token: link ? token : null, signal });
        if (r.status === 202) continue;
        if (!link && r.body.token) {
          await tokenStore.set(r.body.token);
          setToken(r.body.token);
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
          setToken(null);
        }
        throw err;
      }
    },
    [token],
  );

  const value = useMemo(() => ({ token, signIn, gitHub, signOut, api }), [token, signIn, gitHub, signOut, api]);
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): Auth {
  const auth = use(AuthContext);
  if (!auth) throw new Error('useAuth outside AuthProvider');
  return auth;
}
