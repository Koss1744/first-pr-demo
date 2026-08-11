import type { NextFunction, Request, Response } from "express";
import { hashApiKey } from "../crypto/apiKey.js";
import type { Database } from "../db.js";
import { recordAudit } from "../audit.js";

export interface AuthenticatedClient {
  clientId: string;
  scopes: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      client?: AuthenticatedClient;
    }
  }
}

const BEARER_PREFIX = "Bearer ";

/** Express middleware factory: resolves a Bearer API key to {clientId, scopes} and enforces requiredScope. */
export function requireApiKey(db: Database, requiredScope: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.header("authorization");
    if (!header?.startsWith(BEARER_PREFIX)) {
      await recordAudit(db, { eventType: "client_auth_fail", clientId: "unknown", ip: req.ip, metadata: { reason: "missing_key" } });
      res.status(401).json({ error: "missing_api_key" });
      return;
    }

    const rawKey = header.slice(BEARER_PREFIX.length).trim();
    const hash = hashApiKey(rawKey);
    const { rows } = await db.query<{ client_id: string; scopes: string[] }>(
      "SELECT client_id, scopes FROM service_clients WHERE api_key_hash = $1 AND disabled = false",
      [hash],
    );
    const clientRow = rows[0];

    if (!clientRow) {
      await recordAudit(db, { eventType: "client_auth_fail", clientId: "unknown", ip: req.ip, metadata: { reason: "invalid_key" } });
      res.status(401).json({ error: "invalid_api_key" });
      return;
    }

    if (!clientRow.scopes.includes(requiredScope)) {
      await recordAudit(db, {
        eventType: "client_auth_fail",
        clientId: clientRow.client_id,
        ip: req.ip,
        metadata: { reason: "missing_scope", requiredScope },
      });
      res.status(403).json({ error: "forbidden" });
      return;
    }

    await db.query("UPDATE service_clients SET last_used_at = now() WHERE client_id = $1", [clientRow.client_id]);
    req.client = { clientId: clientRow.client_id, scopes: clientRow.scopes };
    next();
  };
}
