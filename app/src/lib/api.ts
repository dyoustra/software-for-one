import { fetch } from 'expo/fetch';

import type { CreateEvent } from '@sfo/api';

export const API_URL = process.env.EXPO_PUBLIC_SFO_CONTROL_URL ?? 'https://sfo-control.fly.dev';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** One authenticated call to the control plane; a 401 means the token no longer works. */
export async function call<T>(token: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(body.error ?? `The control plane answered ${res.status}`, res.status);
  return body as T;
}

/**
 * Creating a project holds its request for the whole setup (about a minute)
 * and answers with a line of JSON per step; each is handed to `onEvent` as it
 * arrives.
 */
export async function createProject(token: string, body: { idea: string; budget?: string }, onEvent: (event: CreateEvent) => void): Promise<void> {
  const res = await fetch(`${API_URL}/projects`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const error = ((await res.json().catch(() => ({}))) as { error?: string }).error;
    throw new ApiError(error ?? `The control plane answered ${res.status}`, res.status);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let rest = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value, { stream: true });
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) onEvent(JSON.parse(line) as CreateEvent);
  }
}
