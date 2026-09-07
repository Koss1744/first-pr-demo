import { Router } from "express";
import { requireApiKey } from "../auth/api-key-auth.js";
import {
  createCounterparty,
  getCounterparty,
  listCounterparties,
  setCounterpartyStatus,
  updateCounterparty,
} from "../counterparties/registry.js";
import {
  COUNTERPARTY_KINDS,
  COUNTERPARTY_STATUSES,
  normalizeCode,
  normalizeText,
  type CounterpartyKind,
  type CounterpartyStatus,
} from "../counterparties/requisites.js";
import type { Database } from "../db.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * Express 5 types a path parameter as string | string[] (a wildcard can repeat).
 * :id never repeats here, but an array would still fail the uuid test below and
 * be answered as "no such counterparty", which is the right answer for it.
 */
function pathId(raw: string | string[]): string {
  return Array.isArray(raw) ? "" : raw;
}

/** Every write records who asked for it, matching the admin routes' `operator` convention. */
function parseOperator(body: unknown): string | undefined {
  return normalizeText((body as { operator?: unknown } | undefined)?.operator);
}

export function counterpartyRouter(db: Database): Router {
  const router = Router();
  const requireRead = requireApiKey(db, "counterparties:read");
  const requireWrite = requireApiKey(db, "counterparties:write");

  router.get("/counterparties", requireRead, async (req, res, next) => {
    try {
      const { search, status, kind, inn } = req.query as Record<string, string | undefined>;

      if (status && !COUNTERPARTY_STATUSES.includes(status as CounterpartyStatus)) {
        res.status(400).json({ error: "invalid_status" });
        return;
      }
      if (kind && !COUNTERPARTY_KINDS.includes(kind as CounterpartyKind)) {
        res.status(400).json({ error: "invalid_kind" });
        return;
      }

      // floor(): LIMIT/OFFSET take integers, and a fractional ?limit=10.5 would
      // otherwise be rounded by Postgres instead of by us.
      const limit = Math.floor(Math.min(Math.max(Number(req.query.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT, 1), MAX_LIMIT));
      const offset = Math.floor(Math.max(Number(req.query.offset ?? 0) || 0, 0));

      const result = await listCounterparties(db, {
        search: normalizeText(search),
        status: status as CounterpartyStatus | undefined,
        kind: kind as CounterpartyKind | undefined,
        inn: normalizeCode(inn),
        limit,
        offset,
      });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  });

  router.get("/counterparties/:id", requireRead, async (req, res, next) => {
    try {
      // Checked here rather than left to Postgres: a malformed uuid is a
      // "no such counterparty", not the 500 an invalid-text-representation
      // error would otherwise turn into.
      const id = pathId(req.params.id);
      if (!UUID_PATTERN.test(id)) {
        res.status(404).json({ error: "counterparty_not_found" });
        return;
      }
      const counterparty = await getCounterparty(db, id);
      if (!counterparty) {
        res.status(404).json({ error: "counterparty_not_found" });
        return;
      }
      res.status(200).json({ counterparty });
    } catch (err) {
      next(err);
    }
  });

  router.post("/counterparties", requireWrite, async (req, res, next) => {
    try {
      const operator = parseOperator(req.body);
      if (!operator) {
        res.status(400).json({ error: "operator_required" });
        return;
      }

      const result = await createCounterparty(db, (req.body ?? {}) as Record<string, unknown>, {
        operator,
        clientId: req.client!.clientId,
        ip: req.ip,
      });

      switch (result.outcome) {
        case "created":
          res.status(201).json({ counterparty: result.counterparty });
          return;
        case "invalid":
          res.status(400).json({ error: "validation_failed", issues: result.issues });
          return;
        case "duplicate":
          res.status(409).json({ error: "duplicate_inn_kpp", existingId: result.existing?.id ?? null });
          return;
      }
    } catch (err) {
      next(err);
    }
  });

  router.patch("/counterparties/:id", requireWrite, async (req, res, next) => {
    try {
      const operator = parseOperator(req.body);
      if (!operator) {
        res.status(400).json({ error: "operator_required" });
        return;
      }
      const id = pathId(req.params.id);
      if (!UUID_PATTERN.test(id)) {
        res.status(404).json({ error: "counterparty_not_found" });
        return;
      }

      const result = await updateCounterparty(db, id, (req.body ?? {}) as Record<string, unknown>, {
        operator,
        clientId: req.client!.clientId,
        ip: req.ip,
      });

      switch (result.outcome) {
        case "updated":
          res.status(200).json({ counterparty: result.counterparty, changed: result.changed });
          return;
        case "not_found":
          res.status(404).json({ error: "counterparty_not_found" });
          return;
        case "invalid":
          res.status(400).json({ error: "validation_failed", issues: result.issues });
          return;
        case "duplicate":
          res.status(409).json({ error: "duplicate_inn_kpp", existingId: result.existing?.id ?? null });
          return;
      }
    } catch (err) {
      next(err);
    }
  });

  router.post("/counterparties/:id/status", requireWrite, async (req, res, next) => {
    try {
      const { status, reason } = (req.body ?? {}) as { status?: string; reason?: string };
      const operator = parseOperator(req.body);
      if (!operator) {
        res.status(400).json({ error: "operator_required" });
        return;
      }
      if (!status || !COUNTERPARTY_STATUSES.includes(status as CounterpartyStatus)) {
        res.status(400).json({ error: "invalid_status" });
        return;
      }
      const id = pathId(req.params.id);
      if (!UUID_PATTERN.test(id)) {
        res.status(404).json({ error: "counterparty_not_found" });
        return;
      }

      const result = await setCounterpartyStatus(db, id, status as CounterpartyStatus, {
        operator,
        clientId: req.client!.clientId,
        ip: req.ip,
        reason: normalizeText(reason),
      });

      if (result.outcome === "not_found") {
        res.status(404).json({ error: "counterparty_not_found" });
        return;
      }
      res.status(200).json({ counterparty: result.counterparty, previousStatus: result.previousStatus });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
