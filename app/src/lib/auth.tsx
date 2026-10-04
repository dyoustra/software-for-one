import * as AppleAuthentication from 'expo-apple-authentication';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import { API_URL, ApiError, call } from '@/lib/api';

const TOKEN_KEY = 'sfo-device-token';

type Auth = {
  /** Undefined while the stored token is being read; null when signed out. */
  token: string | null | undefined;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  /** An authenticated call; a token that stops working signs this device out. */
  api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T>;
};

const AuthContext = createContext<Auth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    SecureStore.getItemAsync(TOKEN_KEY).then((t) => setToken(t ?? null));
  }, []);

  const signIn = useCallback(async () => {
    const credential = await AppleAuthentication.signInAsync({ requestedScopes: [] });
    if (!credential.identityToken) throw new Error('Apple did not return an identity token');
    const res = await fetch(`${API_URL}/auth/apple`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken: credential.identityToken, deviceName: Device.deviceName ?? 'iPhone' }),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!res.ok || !body.token) throw new ApiError(body.error ?? `Sign-in failed (${res.status})`, res.status);
    await SecureStore.setItemAsync(TOKEN_KEY, body.token);
    setToken(body.token);
  }, []);

  const signOut = useCallback(async () => {
    const current = await SecureStore.getItemAsync(TOKEN_KEY);
    if (current) await call(current, '/devices/current', { method: 'DELETE' }).catch(() => undefined);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    setToken(null);
  }, []);

  const api = useCallback(
    async <T,>(path: string, init?: { method?: string; body?: unknown }): Promise<T> => {
      if (!token) throw new ApiError('Signed out', 401);
      try {
        return await call<T>(token, path, init);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          await SecureStore.deleteItemAsync(TOKEN_KEY);
          setToken(null);
        }
        throw err;
      }
    },
    [token],
  );

  const value = useMemo(() => ({ token, signIn, signOut, api }), [token, signIn, signOut, api]);
  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): Auth {
  const auth = use(AuthContext);
  if (!auth) throw new Error('useAuth outside AuthProvider');
  return auth;
}
