import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Db } from "./db.js";

/**
 * The deployed web app's session (WEB_APP_SPEC §3): its device token lives in
 * an httpOnly cookie its scripts never see, instead of in the page.
 */
export const SESSION_COOKIE = "sfo";
export const SESSION_DAYS = 30;

const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Notes, for the routes after it, a request's web origin when it is one of
 * ours, and its session cookie when one may be used. A cookie on a request
 * that changes something is used only from one of our origins: SameSite
 * cannot tell our pages from another *.dannyyoustra.com page, Origin can.
 */
export function sessions(origins: string[]): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin && origins.includes(origin) && origin.startsWith("https://")) c.set("webOrigin", origin);
    const cookie = getCookie(c, SESSION_COOKIE, "host");
    if (cookie && !c.req.header("authorization")) {
      if (!SAFE.has(c.req.method) && !(origin && origins.includes(origin))) return c.json({ error: "this request did not come from sfo's web app" }, 403);
      c.set("sessionToken", cookie);
    }
    await next();
  };
}

export type SessionEnv = { Variables: { webOrigin?: string; sessionToken?: string } };

/** The token a request signs in with, and whether it came in the cookie. */
export function presentedToken(c: Context): { token: string; cookie: boolean } | null {
  const bearer = c.req.header("authorization")?.match(/^Bearer (.+)$/)?.[1];
  if (bearer) return { token: bearer, cookie: false };
  const cookie = (c as Context<SessionEnv>).get("sessionToken");
  return cookie ? { token: cookie, cookie: true } : null;
}

/**
 * Hands a newly signed-in device its token: in the session cookie when the
 * web app asked for one from one of our https origins, otherwise in the body.
 * A device given a cookie is marked, and from then on answers only to it.
 */
export function deliverToken(c: Context, db: Db, issued: { deviceId: string; token: string }): Response {
  if (c.req.header("x-sfo-session") === "cookie" && (c as Context<SessionEnv>).get("webOrigin")) {
    db.prepare("UPDATE devices SET cookie = 1 WHERE id = ?").run(issued.deviceId);
    setSession(c, issued.token);
    return c.json({ cookie: true });
  }
  return c.json({ token: issued.token });
}

export function setSession(c: Context, token: string): void {
  setCookie(c, SESSION_COOKIE, token, { prefix: "host", httpOnly: true, secure: true, sameSite: "Strict", path: "/", maxAge: SESSION_DAYS * 86_400 });
}

export function clearSession(c: Context): void {
  if ((c as Context<SessionEnv>).get("sessionToken")) deleteCookie(c, SESSION_COOKIE, { prefix: "host", secure: true, path: "/" });
}
