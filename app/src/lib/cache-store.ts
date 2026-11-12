/**
 * Responses from the control plane, kept in memory for this run of the app,
 * for one signed-in account: emptied whenever the account's token changes.
 */
const store = new Map<string, unknown>();

/** The last answer for a path, if this run of the app has one. */
export function peek<T>(path: string): T | null {
  return (store.get(path) as T | undefined) ?? null;
}

export function put(path: string, value: unknown): void {
  store.set(path, value);
}

export function has(path: string): boolean {
  return store.has(path);
}

/** Forgets a path and everything under it, after the person changes that project. */
export function invalidate(path: string): void {
  for (const key of store.keys()) if (key === path || key.startsWith(`${path}/`) || key.startsWith(`${path}?`)) store.delete(key);
}

/** Forgets everything: on signing in or out, nothing one account fetched may show to another. */
export function clear(): void {
  store.clear();
}
