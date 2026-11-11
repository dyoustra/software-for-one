const KEY = 'sfo-device-token';

/**
 * The web build's token store. On localhost (the development build) it is
 * localStorage, readable by any script on this origin; anywhere else the
 * token is kept only in memory, for the tab's life, until a deployed web app
 * gets an httpOnly cookie instead (SIGN_IN_SPEC §2). Storage can be blocked
 * (private windows, site-data settings), which reads as signed out.
 */
const persist = typeof window !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
let inMemory: string | null = null;

export const tokenStore = {
  get: async (): Promise<string | null> => {
    if (!persist) return inMemory;
    try {
      return window.localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: async (token: string): Promise<void> => {
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
