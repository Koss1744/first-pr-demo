import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";

const COOKIE_NAME = "hofi_pending_login";
const TTL_MS = 5 * 60 * 1000;

interface PendingLogin {
  uid: string;
  username: string;
  exp: number;
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) {
    return out;
  }
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      continue;
    }
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/**
 * Carries "AD password already verified for this interaction" between the login and MFA steps as
 * a signed, short-lived cookie rather than server-side session state - keeps the OIDC interaction
 * router horizontally scalable without a shared store beyond what oidc-provider's own adapter needs.
 */
export function issuePendingLoginCookie(res: Response, cookieSecret: string, uid: string, username: string, secure: boolean): void {
  const pending: PendingLogin = { uid, username, exp: Date.now() + TTL_MS };
  const body = Buffer.from(JSON.stringify(pending)).toString("base64url");
  res.cookie(COOKIE_NAME, `${body}.${sign(cookieSecret, body)}`, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/interaction",
    maxAge: TTL_MS,
  });
}

/** Returns the verified username for this interaction uid, or null if the cookie is missing/invalid/expired/mismatched. */
export function readPendingLogin(req: Request, cookieSecret: string, uid: string): string | null {
  const raw = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!raw) {
    return null;
  }
  const dot = raw.lastIndexOf(".");
  if (dot === -1) {
    return null;
  }
  const body = raw.slice(0, dot);
  const signature = raw.slice(dot + 1);
  const expected = sign(cookieSecret, body);
  const provided = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
    return null;
  }

  let pending: PendingLogin;
  try {
    pending = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (pending.uid !== uid || pending.exp < Date.now()) {
    return null;
  }
  return pending.username;
}

export function clearPendingLoginCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: "/interaction" });
}
