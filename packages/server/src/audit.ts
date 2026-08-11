import type pg from "pg";

export interface AuditEvent {
  eventType:
    | "enroll_start"
    | "enroll_confirm"
    | "enroll_cancel"
    | "verify_success"
    | "verify_fail"
    | "lockout"
    | "unlock"
    | "admin_reset"
    | "admin_disable"
    | "admin_enable"
    | "client_auth_fail";
  userId?: string | null;
  username?: string | null;
  clientId: string;
  ip?: string | null;
  metadata?: Record<string, unknown>;
}

/** Appends one row to audit_log. Accepts either a pool or an in-transaction client. */
export async function recordAudit(db: pg.Pool | pg.PoolClient, event: AuditEvent): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (event_type, user_id, username, client_id, ip_address, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      event.eventType,
      event.userId ?? null,
      event.username ?? null,
      event.clientId,
      event.ip ?? null,
      JSON.stringify(event.metadata ?? {}),
    ],
  );
}
