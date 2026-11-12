import { fetch } from 'expo/fetch';

import type { Project } from '@sfo/api';

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
 * Starts a project from an idea. The control plane answers at once with the
 * project as `creating` and sets it up after (about a minute); the project
 * list shows it until then.
 */
export async function startProject(token: string, body: { idea: string; budget?: string }): Promise<Project> {
  const res = await fetch(`${API_URL}/projects`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as { project?: Project; error?: string };
  if (!res.ok || !parsed.project) throw new ApiError(parsed.error ?? `The control plane answered ${res.status}`, res.status);
  return parsed.project;
}
