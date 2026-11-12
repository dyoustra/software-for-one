import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';

import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { has, invalidate, peek, put } from '@/lib/cache-store';

export { invalidate, peek, put };

/**
 * A GET that shows its last answer at once and fetches a fresh one each time
 * the screen comes into view. `null` path fetches nothing.
 */
export function useCached<T>(path: string | null) {
  const { api } = useAuth();
  const [data, setData] = useState<T | null>(() => (path ? peek<T>(path) : null));
  const [error, setError] = useState<unknown>(null);

  const refresh = useCallback(async () => {
    if (!path) return;
    try {
      const fresh = await api<T>(path);
      put(path, fresh);
      setData(fresh);
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && [401, 403, 404].includes(err.status)) {
        // Gone, or no longer this person's: the old copy must not stay on screen.
        invalidate(path);
        setData(null);
        setError(err);
      } else if (!has(path)) {
        // Otherwise (no network, say) a cached answer is still worth showing.
        setError(err);
      }
    }
  }, [api, path]);

  useFocusEffect(
    useCallback(() => {
      refresh();
    }, [refresh]),
  );

  return { data, error, refresh };
}
