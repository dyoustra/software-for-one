import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { useAuth } from '@/lib/auth';

/**
 * Responses from the control plane, kept in memory for this run of the app,
 * so a screen opened again shows at once and refreshes quietly behind it.
 */
const store = new Map<string, unknown>();

/** The last answer for a path, if this run of the app has one. */
export function peek<T>(path: string): T | null {
  return (store.get(path) as T | undefined) ?? null;
}

export function put(path: string, value: unknown): void {
  store.set(path, value);
}

/** Forgets a path and everything under it, after the person changes that project. */
export function invalidate(path: string): void {
  for (const key of store.keys()) if (key === path || key.startsWith(`${path}/`) || key.startsWith(`${path}?`)) store.delete(key);
}

/**
 * A GET that shows its last answer at once and fetches a fresh one each time
 * the screen comes into view. `null` path fetches nothing.
 */
export function useCached<T>(path: string | null) {
  const { api } = useAuth();
  const [data, setData] = useState<T | null>(() => (path ? ((store.get(path) as T | undefined) ?? null) : null));
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!path) return;
    try {
      const fresh = await api<T>(path);
      store.set(path, fresh);
      setData(fresh);
      setError(null);
    } catch (err) {
      // A cached answer is still worth showing; the error is for when there is none.
      if (!store.has(path)) setError(err);
    }
  }, [api, path]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  return { data, error, refresh };
}
