import { Router } from "express";
import { requireApiKey } from "../auth/api-key-auth.js";
import type { ServerConfig } from "../config.js";
import type { Database } from "../db.js";
import { verifyUser } from "../verify/verify-logic.js";

export function verifyRouter(db: Database, config: ServerConfig): Router {
  const router = Router();

  // This endpoint's request/response shape is deliberately conservative -
  // both the future Windows Credential Provider and the OIDC web-login flow
  // depend on it staying exactly {username, code} -> {result, reason?}.
  router.post("/verify", requireApiKey(db, "verify"), async (req, res, next) => {
    try {
      const { username, code } = req.body as { username?: string; code?: string };
      if (!username || !code) {
        res.status(400).json({ result: "failure", reason: "bad_request" });
        return;
      }

      const result = await verifyUser(db, config, { username, code, clientId: req.client!.clientId, ip: req.ip });

      switch (result.outcome) {
        case "success":
          res.status(200).json({ result: "success" });
          return;
        case "invalid_code":
          res.status(401).json({ result: "failure", reason: "invalid_code" });
          return;
        case "locked":
          res.status(423).json({ result: "failure", reason: "locked", lockedUntil: result.lockedUntil.toISOString() });
          return;
        case "user_not_found":
          res.status(404).json({ result: "failure", reason: "user_not_found" });
          return;
        case "not_enrolled":
          res.status(404).json({ result: "failure", reason: "not_enrolled" });
          return;
        case "user_disabled":
          res.status(403).json({ result: "failure", reason: "user_disabled" });
          return;
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
