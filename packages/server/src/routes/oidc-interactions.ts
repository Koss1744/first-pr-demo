import express, { Router } from "express";
import type Provider from "oidc-provider";
import type { ServerConfig } from "../config.js";
import type { Database } from "../db.js";
import type { Directory } from "../directory/types.js";
import { clearPendingLoginCookie, issuePendingLoginCookie, readPendingLogin } from "../oidc/pending-login.js";
import { renderErrorPage, renderLoginForm, renderMfaForm } from "../oidc/views.js";
import { verifyUser } from "../verify/verify-logic.js";

// Audit clientId for the web-SSO login path - distinct from any api-key-authenticated
// integration so verify_success/verify_fail events in the audit log show where they came from.
const OIDC_AUDIT_CLIENT_ID = "oidc-web-sso";

function lockoutMessage(outcome: "locked" | "not_enrolled" | "user_disabled" | "user_not_found", lockedUntil?: Date): string {
  switch (outcome) {
    case "locked":
      return `This account is locked until ${lockedUntil!.toISOString()} after too many failed codes.`;
    case "not_enrolled":
      return "Two-factor authentication is not set up for this account yet. Contact IT to enroll.";
    default:
      return "This account cannot sign in right now. Contact IT.";
  }
}

/**
 * The custom interaction UI oidc-provider's `interactions.url` redirects to. Two steps: AD
 * password (Directory.verifyCredentials) then TOTP (verifyUser - the same logic the /verify API
 * and, later, the Windows Credential Provider use). Consent is auto-granted since every client is
 * a first-party company app registered by an admin, not a third party the user needs to approve.
 */
export function oidcInteractionRouter(provider: Provider, db: Database, config: ServerConfig, directory: Directory): Router {
  const router = Router();
  const cookieSecret = config.oidc!.cookieKeys[0]!;
  router.use(express.urlencoded({ extended: false }));

  router.get("/interaction/:uid", async (req, res, next) => {
    try {
      const details = await provider.interactionDetails(req, res);
      const { uid, prompt, params, session } = details;

      if (prompt.name === "login") {
        const pendingUsername = readPendingLogin(req, cookieSecret, uid);
        if (pendingUsername) {
          res.send(renderMfaForm({ uid, username: pendingUsername }));
          return;
        }
        res.send(renderLoginForm({ uid, clientName: typeof params.client_id === "string" ? params.client_id : undefined }));
        return;
      }

      if (prompt.name === "consent") {
        const grant = new provider.Grant({ accountId: session!.accountId, clientId: String(params.client_id) });
        grant.addOIDCScope(typeof params.scope === "string" ? params.scope : "openid");
        const grantId = await grant.save();
        await provider.interactionFinished(req, res, { consent: { grantId } });
        return;
      }

      res.status(400).send(renderErrorPage("This sign-in request needs an interaction step HOFI doesn't support."));
    } catch (err) {
      next(err);
    }
  });

  router.post("/interaction/:uid/login", async (req, res, next) => {
    try {
      const { uid } = await provider.interactionDetails(req, res);
      const { username, password } = req.body as { username?: string; password?: string };
      if (!username || !password) {
        res.status(400).send(renderLoginForm({ uid, error: "Username and password are required." }));
        return;
      }

      const valid = await directory.verifyCredentials(username, password);
      if (!valid) {
        res.status(401).send(renderLoginForm({ uid, error: "Invalid username or password." }));
        return;
      }

      issuePendingLoginCookie(res, cookieSecret, uid, username, req.secure);
      res.send(renderMfaForm({ uid, username }));
    } catch (err) {
      next(err);
    }
  });

  router.post("/interaction/:uid/mfa", async (req, res, next) => {
    try {
      const { uid } = await provider.interactionDetails(req, res);
      const username = readPendingLogin(req, cookieSecret, uid);
      if (!username) {
        res.status(400).send(renderLoginForm({ uid, error: "Your sign-in session expired - please start over." }));
        return;
      }

      const { code } = req.body as { code?: string };
      if (!code) {
        res.status(400).send(renderMfaForm({ uid, username, error: "Enter the 6-digit code." }));
        return;
      }

      const result = await verifyUser(db, config, { username, code, clientId: OIDC_AUDIT_CLIENT_ID, ip: req.ip });

      if (result.outcome === "success") {
        clearPendingLoginCookie(res);
        await provider.interactionFinished(req, res, { login: { accountId: username, remember: true } });
        return;
      }

      if (result.outcome === "invalid_code") {
        res.status(401).send(renderMfaForm({ uid, username, error: "Incorrect code. Try again." }));
        return;
      }

      clearPendingLoginCookie(res);
      const description = lockoutMessage(result.outcome, result.outcome === "locked" ? result.lockedUntil : undefined);
      await provider.interactionFinished(req, res, { error: "access_denied", error_description: description });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
