const KEY = 'sfo-device-token';

/**
 * The web build's token store: localStorage, readable by any script on this
 * origin. Acceptable for a development build on localhost; a deployed web app
 * gets an httpOnly cookie instead (SIGN_IN_SPEC §2). Storage can be blocked
 * (private windows, site-data settings), which reads as signed out.
 */
export const tokenStore = {
  get: async (): Promise<string | null> => {
    try {
      return window.localStorage.getItem(KEY);
    } catch {
      return null;
    }
  },
  set: async (token: string): Promise<void> => {
    window.localStorage.setItem(KEY, token);
  },
  clear: async (): Promise<void> => {
    try {
      window.localStorage.removeItem(KEY);
    } catch {}
  },
};
