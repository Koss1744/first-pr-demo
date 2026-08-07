import { randomBytes } from "node:crypto";
import type pg from "pg";
import { base32Decode, base32Encode, buildOtpauthUri, matchTotpWindow, type OtpAlgorithm } from "@hofi/core";
import { recordAudit } from "../audit.js";
import type { ServerConfig } from "../config.js";
import {
  decryptSecret,
  encryptSecret,
  generateDek,
  unwrapDek,
  wrapDek,
  type EncryptedSecret,
  type WrappedDek,
} from "../crypto/envelope.js";
import type { Database } from "../db.js";
import { withTransaction } from "../db.js";
import type { Directory, DirectoryUser } from "../directory/types.js";

interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  status: "active" | "disabled";
  failed_count: number;
  locked_until: Date | null;
}

interface TotpSecretRow {
  id: string;
  user_id: string;
  algorithm: OtpAlgorithm;
  digits: number;
  period_seconds: number;
  kek_version: number;
  wrapped_dek: Buffer;
  wrapped_dek_iv: Buffer;
  wrapped_dek_tag: Buffer;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_tag: Buffer;
  last_used_step: string | null; // bigint columns come back as strings from node-postgres
  confirm_attempts: number;
  confirmed_at: Date | null;
  disabled_at: Date | null;
}

const MAX_CONFIRM_ATTEMPTS = 5;

function requireRootKey(config: ServerConfig, kekVersion: number): Buffer {
  const rootKey = config.rootKeys.get(kekVersion);
  if (!rootKey) {
    throw new Error(`No root key configured for kek_version ${kekVersion}`);
  }
  return rootKey;
}

function toWrappedDek(row: TotpSecretRow): WrappedDek {
  return { wrappedDek: row.wrapped_dek, wrappedDekIv: row.wrapped_dek_iv, wrappedDekTag: row.wrapped_dek_tag };
}

function toEncryptedSecret(row: TotpSecretRow): EncryptedSecret {
  return { secretCiphertext: row.secret_ciphertext, secretIv: row.secret_iv, secretTag: row.secret_tag };
}

function decryptRowSecret(config: ServerConfig, row: TotpSecretRow, userId: string): string {
  const rootKey = requireRootKey(config, row.kek_version);
  const dek = unwrapDek(rootKey, toWrappedDek(row), userId);
  return decryptSecret(dek, toEncryptedSecret(row), userId);
}

async function upsertUser(client: pg.PoolClient, directoryUser: DirectoryUser): Promise<{ id: string; username: string }> {
  const result = await client.query<{ id: string; username: string }>(
    `INSERT INTO users (username, display_name, status)
     VALUES ($1, $2, 'active')
     ON CONFLICT (lower(username))
     DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
     RETURNING id, username`,
    [directoryUser.username, directoryUser.displayName],
  );
  return result.rows[0];
}

interface CallContext {
  clientId: string;
  ip?: string;
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export type EnrollStartResult =
  | { outcome: "started"; username: string; secret: string; otpauthUri: string; algorithm: OtpAlgorithm; digits: number; period: number }
  | { outcome: "user_not_found" }
  | { outcome: "already_enrolled" };

export async function enrollStart(
  db: Database,
  directory: Directory,
  config: ServerConfig,
  params: { username: string } & CallContext,
): Promise<EnrollStartResult> {
  const directoryUser = await directory.lookupUser(params.username);
  if (!directoryUser || !directoryUser.active) {
    return { outcome: "user_not_found" };
  }

  return withTransaction(db, async (client) => {
    const user = await upsertUser(client, directoryUser);

    const existing = await client.query<{ confirmed_at: Date | null }>(
      "SELECT confirmed_at FROM totp_secrets WHERE user_id = $1",
      [user.id],
    );
    if (existing.rows[0]?.confirmed_at) {
      return { outcome: "already_enrolled" };
    }

    const algorithm: OtpAlgorithm = "SHA1";
    const digits = 6;
    const period = 30;
    const secret = base32Encode(randomBytes(20));

    const dek = generateDek();
    const wrapped = wrapDek(requireRootKey(config, config.activeKekVersion), dek, user.id);
    const encrypted = encryptSecret(dek, secret, user.id);

    // Replace any prior unconfirmed attempt - only one pending enrollment per user at a time.
    await client.query("DELETE FROM totp_secrets WHERE user_id = $1 AND confirmed_at IS NULL", [user.id]);
    await client.query(
      `INSERT INTO totp_secrets
         (user_id, algorithm, digits, period_seconds, kek_version,
          wrapped_dek, wrapped_dek_iv, wrapped_dek_tag,
          secret_ciphertext, secret_iv, secret_tag)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        user.id,
        algorithm,
        digits,
        period,
        config.activeKekVersion,
        wrapped.wrappedDek,
        wrapped.wrappedDekIv,
        wrapped.wrappedDekTag,
        encrypted.secretCiphertext,
        encrypted.secretIv,
        encrypted.secretTag,
      ],
    );

    await recordAudit(client, {
      eventType: "enroll_start",
      userId: user.id,
      username: user.username,
      clientId: params.clientId,
      ip: params.ip,
    });

    const otpauthUri = buildOtpauthUri({ label: user.username, secret, issuer: "HOFI", algorithm, digits, period });
    return { outcome: "started", username: user.username, secret, otpauthUri, algorithm, digits, period };
  });
}

export type EnrollConfirmResult =
  | { outcome: "confirmed" }
  | { outcome: "invalid_code" }
  | { outcome: "no_pending_enrollment" };

export async function enrollConfirm(
  db: Database,
  config: ServerConfig,
  params: { username: string; code: string } & CallContext,
): Promise<EnrollConfirmResult> {
  return withTransaction(db, async (client) => {
    const userRes = await client.query<UserRow>("SELECT * FROM users WHERE lower(username) = lower($1) FOR UPDATE", [
      params.username,
    ]);
    const user = userRes.rows[0];
    if (!user) {
      return { outcome: "no_pending_enrollment" };
    }

    const secretRes = await client.query<TotpSecretRow>(
      "SELECT * FROM totp_secrets WHERE user_id = $1 AND confirmed_at IS NULL FOR UPDATE",
      [user.id],
    );
    const secretRow = secretRes.rows[0];
    if (!secretRow) {
      return { outcome: "no_pending_enrollment" };
    }

    const secret = decryptRowSecret(config, secretRow, user.id);
    const matchedStep = matchTotpWindow(base32Decode(secret), params.code, {
      digits: secretRow.digits,
      period: secretRow.period_seconds,
      algorithm: secretRow.algorithm,
      driftSteps: config.totpDriftSteps,
    });

    if (matchedStep === null) {
      const attempts = secretRow.confirm_attempts + 1;
      if (attempts >= MAX_CONFIRM_ATTEMPTS) {
        // Force a fresh enroll/start rather than letting a pending enrollment be brute-forced indefinitely.
        await client.query("DELETE FROM totp_secrets WHERE id = $1", [secretRow.id]);
      } else {
        await client.query("UPDATE totp_secrets SET confirm_attempts = $1, updated_at = now() WHERE id = $2", [
          attempts,
          secretRow.id,
        ]);
      }
      await recordAudit(client, {
        eventType: "enroll_cancel",
        userId: user.id,
        username: user.username,
        clientId: params.clientId,
        ip: params.ip,
        metadata: { reason: "invalid_code", attempts, restarted: attempts >= MAX_CONFIRM_ATTEMPTS },
      });
      return { outcome: "invalid_code" };
    }

    await client.query("UPDATE totp_secrets SET confirmed_at = now(), last_used_step = $1, updated_at = now() WHERE id = $2", [
      matchedStep,
      secretRow.id,
    ]);
    await recordAudit(client, {
      eventType: "enroll_confirm",
      userId: user.id,
      username: user.username,
      clientId: params.clientId,
      ip: params.ip,
    });
    return { outcome: "confirmed" };
  });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type VerifyResult =
  | { outcome: "success" }
  | { outcome: "invalid_code" }
  | { outcome: "locked"; lockedUntil: Date }
  | { outcome: "user_not_found" }
  | { outcome: "not_enrolled" }
  | { outcome: "user_disabled" };

export async function verifyUser(
  db: Database,
  config: ServerConfig,
  params: { username: string; code: string } & CallContext,
): Promise<VerifyResult> {
  return withTransaction(db, async (client) => {
    const userRes = await client.query<UserRow>("SELECT * FROM users WHERE lower(username) = lower($1) FOR UPDATE", [
      params.username,
    ]);
    const user = userRes.rows[0];
    if (!user) {
      return { outcome: "user_not_found" };
    }

    if (user.status === "disabled") {
      await recordAudit(client, {
        eventType: "verify_fail",
        userId: user.id,
        username: user.username,
        clientId: params.clientId,
        ip: params.ip,
        metadata: { reason: "user_disabled" },
      });
      return { outcome: "user_disabled" };
    }

    if (user.locked_until && user.locked_until.getTime() > Date.now()) {
      await recordAudit(client, {
        eventType: "verify_fail",
        userId: user.id,
        username: user.username,
        clientId: params.clientId,
        ip: params.ip,
        metadata: { reason: "locked" },
      });
      return { outcome: "locked", lockedUntil: user.locked_until };
    }

    const secretRes = await client.query<TotpSecretRow>(
      "SELECT * FROM totp_secrets WHERE user_id = $1 AND confirmed_at IS NOT NULL AND disabled_at IS NULL FOR UPDATE",
      [user.id],
    );
    const secretRow = secretRes.rows[0];
    if (!secretRow) {
      return { outcome: "not_enrolled" };
    }

    const secret = decryptRowSecret(config, secretRow, user.id);
    const matchedStep = matchTotpWindow(base32Decode(secret), params.code, {
      digits: secretRow.digits,
      period: secretRow.period_seconds,
      algorithm: secretRow.algorithm,
      driftSteps: config.totpDriftSteps,
    });
    const lastUsedStep = secretRow.last_used_step === null ? -1 : Number(secretRow.last_used_step);

    if (matchedStep === null || matchedStep <= lastUsedStep) {
      const failedCount = user.failed_count + 1;
      const locked = failedCount >= config.maxFailedAttempts;
      const lockedUntil = locked ? new Date(Date.now() + config.lockoutDurationMs) : null;

      await client.query("UPDATE users SET failed_count = $1, locked_until = $2, updated_at = now() WHERE id = $3", [
        failedCount,
        lockedUntil,
        user.id,
      ]);
      await recordAudit(client, {
        eventType: locked ? "lockout" : "verify_fail",
        userId: user.id,
        username: user.username,
        clientId: params.clientId,
        ip: params.ip,
        metadata: { failedCount, replay: matchedStep !== null && matchedStep <= lastUsedStep },
      });

      return locked ? { outcome: "locked", lockedUntil: lockedUntil! } : { outcome: "invalid_code" };
    }

    await client.query("UPDATE totp_secrets SET last_used_step = $1, updated_at = now() WHERE id = $2", [
      matchedStep,
      secretRow.id,
    ]);
    await client.query("UPDATE users SET failed_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1", [
      user.id,
    ]);
    await recordAudit(client, {
      eventType: "verify_success",
      userId: user.id,
      username: user.username,
      clientId: params.clientId,
      ip: params.ip,
    });
    return { outcome: "success" };
  });
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export type AdminResult = { outcome: "ok" } | { outcome: "user_not_found" };

async function withUser(
  db: Database,
  username: string,
  fn: (client: pg.PoolClient, user: UserRow) => Promise<AdminResult>,
): Promise<AdminResult> {
  return withTransaction(db, async (client) => {
    const userRes = await client.query<UserRow>("SELECT * FROM users WHERE lower(username) = lower($1) FOR UPDATE", [
      username,
    ]);
    const user = userRes.rows[0];
    if (!user) {
      return { outcome: "user_not_found" };
    }
    return fn(client, user);
  });
}

export async function adminUnlock(db: Database, params: { username: string; operator: string } & CallContext): Promise<AdminResult> {
  return withUser(db, params.username, async (client, user) => {
    await client.query("UPDATE users SET failed_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1", [user.id]);
    await recordAudit(client, {
      eventType: "unlock",
      userId: user.id,
      username: user.username,
      clientId: params.clientId,
      ip: params.ip,
      metadata: { operator: params.operator },
    });
    return { outcome: "ok" };
  });
}

export async function adminReset(db: Database, params: { username: string; operator: string } & CallContext): Promise<AdminResult> {
  return withUser(db, params.username, async (client, user) => {
    await client.query("DELETE FROM totp_secrets WHERE user_id = $1", [user.id]);
    await client.query("UPDATE users SET failed_count = 0, locked_until = NULL, updated_at = now() WHERE id = $1", [user.id]);
    await recordAudit(client, {
      eventType: "admin_reset",
      userId: user.id,
      username: user.username,
      clientId: params.clientId,
      ip: params.ip,
      metadata: { operator: params.operator },
    });
    return { outcome: "ok" };
  });
}

export async function adminSetStatus(
  db: Database,
  params: { username: string; operator: string; status: "active" | "disabled" } & CallContext,
): Promise<AdminResult> {
  return withUser(db, params.username, async (client, user) => {
    await client.query("UPDATE users SET status = $1, updated_at = now() WHERE id = $2", [params.status, user.id]);
    await recordAudit(client, {
      eventType: params.status === "disabled" ? "admin_disable" : "admin_enable",
      userId: user.id,
      username: user.username,
      clientId: params.clientId,
      ip: params.ip,
      metadata: { operator: params.operator },
    });
    return { outcome: "ok" };
  });
}
