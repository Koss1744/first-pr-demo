import type { Adapter, AdapterFactory, AdapterPayload } from "oidc-provider";
import type { Database } from "../db.js";

interface StoreRow {
  payload: AdapterPayload;
  consumed_at: Date | null;
  expires_at: Date | null;
}

function toPayload(row: StoreRow | undefined): AdapterPayload | undefined {
  if (!row) {
    return undefined;
  }
  if (row.expires_at && row.expires_at.getTime() < Date.now()) {
    return undefined;
  }
  return row.consumed_at ? { ...row.payload, consumed: Math.floor(row.consumed_at.getTime() / 1000) } : row.payload;
}

class PostgresAdapter implements Adapter {
  constructor(
    private readonly db: Database,
    private readonly modelName: string,
  ) {}

  async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000) : null;
    await this.db.query(
      `INSERT INTO oidc_model_store (model_name, id, payload, grant_id, user_code, uid, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (model_name, id) DO UPDATE SET
         payload = EXCLUDED.payload, grant_id = EXCLUDED.grant_id, user_code = EXCLUDED.user_code,
         uid = EXCLUDED.uid, expires_at = EXCLUDED.expires_at, consumed_at = NULL`,
      [this.modelName, id, payload, payload.grantId ?? null, payload.userCode ?? null, payload.uid ?? null, expiresAt],
    );
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const { rows } = await this.db.query<StoreRow>(
      "SELECT payload, consumed_at, expires_at FROM oidc_model_store WHERE model_name = $1 AND id = $2",
      [this.modelName, id],
    );
    return toPayload(rows[0]);
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    const { rows } = await this.db.query<StoreRow>(
      "SELECT payload, consumed_at, expires_at FROM oidc_model_store WHERE model_name = $1 AND user_code = $2",
      [this.modelName, userCode],
    );
    return toPayload(rows[0]);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const { rows } = await this.db.query<StoreRow>(
      "SELECT payload, consumed_at, expires_at FROM oidc_model_store WHERE model_name = $1 AND uid = $2",
      [this.modelName, uid],
    );
    return toPayload(rows[0]);
  }

  async consume(id: string): Promise<void> {
    await this.db.query("UPDATE oidc_model_store SET consumed_at = now() WHERE model_name = $1 AND id = $2", [
      this.modelName,
      id,
    ]);
  }

  async destroy(id: string): Promise<void> {
    await this.db.query("DELETE FROM oidc_model_store WHERE model_name = $1 AND id = $2", [this.modelName, id]);
  }

  async revokeByGrantId(grantId: string): Promise<void> {
    await this.db.query("DELETE FROM oidc_model_store WHERE grant_id = $1", [grantId]);
  }
}

/** Builds the per-model-kind adapter factory oidc-provider's `adapter` config option expects. */
export function createOidcAdapter(db: Database): AdapterFactory {
  return (modelName: string) => new PostgresAdapter(db, modelName);
}

/**
 * Deletes rows past their expiry. find()/findByUid()/findByUserCode() already hide expired rows
 * from oidc-provider, so this is purely about bounding table/index size over time - nothing
 * calls it automatically, run it on a schedule (see reap-oidc-store.ts / the server README).
 */
export async function reapExpiredOidcModels(db: Database): Promise<number> {
  const { rowCount } = await db.query("DELETE FROM oidc_model_store WHERE expires_at IS NOT NULL AND expires_at < now()");
  return rowCount ?? 0;
}
