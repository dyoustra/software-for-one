import { API_URL, COOKIE_SESSION, usesCookie } from '@/lib/api';

const KEY = 'sfo-device-token';

/**
 * The web build's token store. The deployed web app keeps nothing: its token
 * is in an httpOnly cookie, and this only asks whether the cookie still signs
 * it in (WEB_APP_SPEC §3). On localhost (the development build) it is
 * localStorage, readable by any script on this origin; anywhere else over
 * plain http, memory only. Storage can be blocked (private windows,
 * site-data settings), which reads as signed out.
 */
const persist = typeof window !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
let inMemory: string | null = null;

export const tokenStore = {
  get: async (): Promise<string | null> => {
    if (usesCookie) {
      // Unreachable is not signed out: the calls that follow say so themselves.
      const res = await fetch(`${API_URL}/auth/session`, { credentials: 'include' }).catch(() => null);
      return res?.status === 401 ? null : COOKIE_SESSION;
    }
    if (!persist) return inMemory;
    try {
      return window.localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: async (token: string): Promise<void> => {
    if (usesCookie) return;
    if (persist) window.localStorage.setItem(KEY, token);
    else inMemory = token;
  },
  clear: async (): Promise<void> => {
    inMemory = null;
    try {
      window.localStorage.removeItem(KEY);
    } catch {}
  },
};
