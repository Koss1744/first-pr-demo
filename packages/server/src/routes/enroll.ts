import { Router } from "express";
import { requireApiKey } from "../auth/api-key-auth.js";
import type { ServerConfig } from "../config.js";
import type { Database } from "../db.js";
import type { Directory } from "../directory/types.js";
import { enrollConfirm, enrollStart } from "../verify/verify-logic.js";

export function enrollRouter(db: Database, config: ServerConfig, directory: Directory): Router {
  const router = Router();
  const requireEnrollScope = requireApiKey(db, "enroll");

  router.post("/enroll/start", requireEnrollScope, async (req, res, next) => {
    try {
      const { username } = req.body as { username?: string };
      if (!username) {
        res.status(400).json({ error: "username_required" });
        return;
      }

      const result = await enrollStart(db, directory, config, {
        username,
        clientId: req.client!.clientId,
        ip: req.ip,
      });

      switch (result.outcome) {
        case "started":
          res.status(200).json({
            username: result.username,
            secret: result.secret,
            otpauthUri: result.otpauthUri,
            algorithm: result.algorithm,
            digits: result.digits,
            period: result.period,
          });
          return;
        case "user_not_found":
          res.status(404).json({ error: "user_not_found" });
          return;
        case "already_enrolled":
          res.status(409).json({ error: "already_enrolled" });
          return;
      }
    } catch (err) {
      next(err);
    }
  });

  router.post("/enroll/confirm", requireEnrollScope, async (req, res, next) => {
    try {
      const { username, code } = req.body as { username?: string; code?: string };
      if (!username || !code) {
        res.status(400).json({ error: "username_and_code_required" });
        return;
      }

      const result = await enrollConfirm(db, config, { username, code, clientId: req.client!.clientId, ip: req.ip });

      switch (result.outcome) {
        case "confirmed":
          res.status(200).json({ username, confirmed: true });
          return;
        case "invalid_code":
          res.status(400).json({ result: "failure", reason: "invalid_code" });
          return;
        case "no_pending_enrollment":
          res.status(404).json({ error: "no_pending_enrollment" });
          return;
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
