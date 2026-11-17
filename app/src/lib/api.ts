import { fetch } from 'expo/fetch';
import { Platform } from 'react-native';

import type { Project } from '@sfo/api';

export const API_URL = process.env.EXPO_PUBLIC_SFO_CONTROL_URL ?? 'https://api.sfo.dannyyoustra.com';

/**
 * Whether this is the deployed web app, which holds no token: the browser
 * keeps it in an httpOnly cookie and sends it itself (WEB_APP_SPEC §3).
 */
export const usesCookie = Platform.OS === 'web' && typeof window !== 'undefined' && window.location.protocol === 'https:';

/** What the deployed web app has where others have a token. */
export const COOKIE_SESSION = 'cookie-session';

/** How a call carries its token: as a bearer header, or as the cookie the browser holds. */
export function authInit(token: string | null | undefined): { headers: Record<string, string>; credentials?: 'include' } {
  if (token === COOKIE_SESSION) return { headers: {}, credentials: 'include' };
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

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
  const auth = authInit(token);
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    credentials: auth.credentials,
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
  const auth = authInit(token);
  const res = await fetch(`${API_URL}/projects`, {
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    credentials: auth.credentials,
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as { project?: Project; error?: string };
  if (!res.ok || !parsed.project) throw new ApiError(parsed.error ?? `The control plane answered ${res.status}`, res.status);
  return parsed.project;
}
