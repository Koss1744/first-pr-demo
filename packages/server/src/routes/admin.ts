import { Router } from "express";
import { requireApiKey } from "../auth/api-key-auth.js";
import type { Database } from "../db.js";
import { adminReset, adminSetStatus, adminUnlock } from "../verify/verify-logic.js";

function parseUsernameOperator(body: unknown): { username: string; operator: string } | null {
  const { username, operator } = (body ?? {}) as { username?: string; operator?: string };
  if (!username || !operator) {
    return null;
  }
  return { username, operator };
}

export function adminRouter(db: Database): Router {
  const router = Router();
  const requireAdminScope = requireApiKey(db, "admin");

  router.post("/admin/unlock", requireAdminScope, async (req, res, next) => {
    try {
      const parsed = parseUsernameOperator(req.body);
      if (!parsed) {
        res.status(400).json({ error: "username_and_operator_required" });
        return;
      }
      const result = await adminUnlock(db, { ...parsed, clientId: req.client!.clientId, ip: req.ip });
      if (result.outcome === "user_not_found") {
        res.status(404).json({ error: "user_not_found" });
        return;
      }
      res.status(200).json({ unlocked: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/reset", requireAdminScope, async (req, res, next) => {
    try {
      const parsed = parseUsernameOperator(req.body);
      if (!parsed) {
        res.status(400).json({ error: "username_and_operator_required" });
        return;
      }
      const result = await adminReset(db, { ...parsed, clientId: req.client!.clientId, ip: req.ip });
      if (result.outcome === "user_not_found") {
        res.status(404).json({ error: "user_not_found" });
        return;
      }
      res.status(200).json({ username: parsed.username, reset: true });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/disable", requireAdminScope, async (req, res, next) => {
    try {
      const parsed = parseUsernameOperator(req.body);
      if (!parsed) {
        res.status(400).json({ error: "username_and_operator_required" });
        return;
      }
      const result = await adminSetStatus(db, { ...parsed, status: "disabled", clientId: req.client!.clientId, ip: req.ip });
      if (result.outcome === "user_not_found") {
        res.status(404).json({ error: "user_not_found" });
        return;
      }
      res.status(200).json({ status: "disabled" });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/enable", requireAdminScope, async (req, res, next) => {
    try {
      const parsed = parseUsernameOperator(req.body);
      if (!parsed) {
        res.status(400).json({ error: "username_and_operator_required" });
        return;
      }
      const result = await adminSetStatus(db, { ...parsed, status: "active", clientId: req.client!.clientId, ip: req.ip });
      if (result.outcome === "user_not_found") {
        res.status(404).json({ error: "user_not_found" });
        return;
      }
      res.status(200).json({ status: "active" });
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/audit", requireAdminScope, async (req, res, next) => {
    try {
      const { username, eventType, since, until, cursor } = req.query as Record<string, string | undefined>;
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);

      const conditions: string[] = [];
      const values: unknown[] = [];
      const add = (sql: string, value: unknown) => {
        values.push(value);
        conditions.push(sql.replace("?", `$${values.length}`));
      };

      if (username) add("username = ?", username);
      if (eventType) add("event_type = ?", eventType);
      if (since) add("occurred_at >= ?", new Date(since));
      if (until) add("occurred_at <= ?", new Date(until));
      if (cursor) add("id < ?", Number(cursor));

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const { rows } = await db.query(
        `SELECT id, occurred_at, event_type, user_id, username, client_id, ip_address, metadata
         FROM audit_log ${whereClause}
         ORDER BY id DESC
         LIMIT $${values.length + 1}`,
        [...values, limit],
      );

      const nextCursor = rows.length === limit ? String(rows[rows.length - 1].id) : null;
      res.status(200).json({ entries: rows, nextCursor });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
