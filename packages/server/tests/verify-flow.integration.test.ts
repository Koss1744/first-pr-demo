import { randomBytes } from "node:crypto";
import { totp } from "@hofi/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ServerConfig } from "../src/config.js";
import type { Database } from "../src/db.js";
import { InMemoryDirectory } from "../src/directory/memory-directory.js";
import { adminReset, adminUnlock, enrollConfirm, enrollStart, verifyUser } from "../src/verify/verify-logic.js";
import { createTestDatabase } from "./support/test-db.js";

let db: Database;
let dropDb: () => Promise<void>;

beforeEach(async () => {
  const created = await createTestDatabase();
  db = created.pool;
  dropDb = created.drop;
});

afterEach(async () => {
  await dropDb();
});

function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    port: 0,
    databaseUrl: "unused-in-tests",
    rootKeys: new Map([[1, randomBytes(32)]]),
    activeKekVersion: 1,
    directoryImpl: "memory",
    maxFailedAttempts: 3,
    lockoutDurationMs: 60_000,
    totpDriftSteps: 1,
    ...overrides,
  };
}

const CTX = { clientId: "test-client", ip: "127.0.0.1" };

async function enrollAndConfirm(db: Database, config: ServerConfig, directory: InMemoryDirectory, username: string) {
  const started = await enrollStart(db, directory, config, { username, ...CTX });
  if (started.outcome !== "started") {
    throw new Error(`enrollStart did not start: ${started.outcome}`);
  }
  // Anchored once (not re-read per call) so that offsets stay relative to a
  // fixed point - matchTotpWindow's default driftSteps=1 only accepts codes
  // within one 30s step of the ACTUAL current time when verifyUser runs, so
  // only offsets in roughly [-30, +30] around this anchor will ever match.
  const anchorMs = Date.now();
  const codeAt = (offsetSeconds = 0) =>
    totp({
      secret: started.secret,
      algorithm: started.algorithm,
      digits: started.digits,
      period: started.period,
      timestamp: anchorMs + offsetSeconds * 1000,
    });

  // Confirm using the earliest step in the drift window (anchor - 30s), so
  // the anchor's other two steps (anchor, anchor + 30s) are still free for
  // callers to use as fresh, unconsumed codes afterwards.
  const confirmed = await enrollConfirm(db, config, { username, code: codeAt(-30), ...CTX });
  if (confirmed.outcome !== "confirmed") {
    throw new Error(`enrollConfirm did not confirm: ${confirmed.outcome}`);
  }
  return { started, codeAt };
}

describe("full enroll -> verify -> lockout -> admin flow", () => {
  it("walks through the entire lifecycle with a correct audit trail", async () => {
    const config = testConfig();
    const directory = new InMemoryDirectory([{ username: "jdoe", displayName: "Jane Doe", active: true }]);
    const { codeAt } = await enrollAndConfirm(db, config, directory, "jdoe");

    // A fresh, not-yet-consumed code succeeds.
    const successCode = codeAt(0);
    const verify1 = await verifyUser(db, config, { username: "jdoe", code: successCode, ...CTX });
    expect(verify1.outcome).toBe("success");

    // Replaying the exact same (already-consumed) code is rejected, and -
    // like any rejected attempt - counts towards the lockout threshold
    // (failed_count: 0 -> 1).
    const replay = await verifyUser(db, config, { username: "jdoe", code: successCode, ...CTX });
    expect(replay.outcome).toBe("invalid_code");

    // Two more wrong codes reach maxFailedAttempts (3) and lock the account.
    expect((await verifyUser(db, config, { username: "jdoe", code: "000001", ...CTX })).outcome).toBe("invalid_code");
    const thirdFailure = await verifyUser(db, config, { username: "jdoe", code: "000002", ...CTX });
    expect(thirdFailure.outcome).toBe("locked");

    // Locked out even when the code itself would otherwise be irrelevant -
    // the lock check short-circuits before any code matching happens.
    const lockedAttempt = await verifyUser(db, config, { username: "jdoe", code: "999999", ...CTX });
    expect(lockedAttempt.outcome).toBe("locked");

    // Admin unlock restores access; the next step (anchor + 30s) is still a
    // fresh, unconsumed step within the drift window.
    expect((await adminUnlock(db, { username: "jdoe", operator: "alice@it", ...CTX })).outcome).toBe("ok");
    const verifyAfterUnlock = await verifyUser(db, config, { username: "jdoe", code: codeAt(30), ...CTX });
    expect(verifyAfterUnlock.outcome).toBe("success");

    // Admin reset removes the secret entirely - again, the code value is
    // irrelevant since "not_enrolled" is decided before any code matching.
    expect((await adminReset(db, { username: "jdoe", operator: "alice@it", ...CTX })).outcome).toBe("ok");
    const verifyAfterReset = await verifyUser(db, config, { username: "jdoe", code: "999999", ...CTX });
    expect(verifyAfterReset.outcome).toBe("not_enrolled");

    const { rows } = await db.query<{ event_type: string }>(
      "SELECT event_type FROM audit_log WHERE username = 'jdoe' ORDER BY id ASC",
    );
    const eventTypes = rows.map((r) => r.event_type);
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "enroll_start",
        "enroll_confirm",
        "verify_success",
        "verify_fail",
        "lockout",
        "unlock",
        "admin_reset",
      ]),
    );
  });

  it("returns user_not_found when verifying an unknown user", async () => {
    const result = await verifyUser(db, testConfig(), { username: "ghost", code: "123456", ...CTX });
    expect(result.outcome).toBe("user_not_found");
  });

  it("rejects enrollment for a user the directory doesn't know about", async () => {
    const result = await enrollStart(db, new InMemoryDirectory(), testConfig(), { username: "ghost", ...CTX });
    expect(result.outcome).toBe("user_not_found");
  });

  it("rejects a second enrollment once one is already confirmed", async () => {
    const config = testConfig();
    const directory = new InMemoryDirectory([{ username: "jdoe", displayName: "Jane Doe", active: true }]);
    await enrollAndConfirm(db, config, directory, "jdoe");

    const secondStart = await enrollStart(db, directory, config, { username: "jdoe", ...CTX });
    expect(secondStart.outcome).toBe("already_enrolled");
  });

  it("forces a fresh enroll/start after too many wrong confirm attempts", async () => {
    const config = testConfig();
    const directory = new InMemoryDirectory([{ username: "sloppy.typist", displayName: "Sloppy Typist", active: true }]);
    await enrollStart(db, directory, config, { username: "sloppy.typist", ...CTX });

    for (let i = 0; i < 5; i++) {
      await enrollConfirm(db, config, { username: "sloppy.typist", code: "000000", ...CTX });
    }

    // The pending enrollment was discarded; confirming again finds nothing pending.
    const result = await enrollConfirm(db, config, { username: "sloppy.typist", code: "000000", ...CTX });
    expect(result.outcome).toBe("no_pending_enrollment");
  });
});

describe("concurrent verify with the same code", () => {
  it("lets exactly one of two simultaneous requests succeed", async () => {
    const config = testConfig();
    const directory = new InMemoryDirectory([{ username: "concurrent.user", displayName: "Concurrent User", active: true }]);
    const { codeAt } = await enrollAndConfirm(db, config, directory, "concurrent.user");
    const sharedCode = codeAt(30);

    const [first, second] = await Promise.all([
      verifyUser(db, config, { username: "concurrent.user", code: sharedCode, ...CTX }),
      verifyUser(db, config, { username: "concurrent.user", code: sharedCode, ...CTX }),
    ]);

    expect([first.outcome, second.outcome].sort()).toEqual(["invalid_code", "success"]);
  });
});
