import { Router } from "express";
import type { Database } from "../db.js";

export function healthRouter(db: Database): Router {
  const router = Router();

  router.get("/healthz", async (_req, res) => {
    try {
      await db.query("SELECT 1");
      res.status(200).json({ status: "ok", dbOk: true });
    } catch {
      res.status(503).json({ status: "error", dbOk: false });
    }
  });

  return router;
}
