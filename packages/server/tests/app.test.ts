import { randomBytes } from "node:crypto";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import type { Database } from "../src/db.js";
import { InMemoryDirectory } from "../src/directory/memory-directory.js";

const VALID_KEY = "hofi_cp_test-key-not-a-real-secret";

/**
 * Stands in for the pg Pool so route/validation behavior can be tested
 * without a real database. Only handles the query shapes app.ts's routes
 * actually issue before reaching business logic (auth lookup, audit
 * inserts, health check) - anything else is a test bug, hence the throw.
 */
function createFakeDb(scopes: string[] | null = ["enroll", "verify", "admin"]): Database {
  const query = async (sql: string, _params?: unknown[]): Promise<{ rows: unknown[] }> => {
    if (/^SELECT 1/.test(sql)) {
      return { rows: [] };
    }
    if (/SELECT client_id, scopes FROM service_clients/.test(sql)) {
      return scopes ? { rows: [{ client_id: "test-client", scopes }] } : { rows: [] };
    }
    if (/UPDATE service_clients SET last_used_at/.test(sql)) {
      return { rows: [] };
    }
    if (/INSERT INTO audit_log/.test(sql)) {
      return { rows: [] };
    }
    throw new Error(`FakeDb: unhandled query in app.test.ts: ${sql}`);
  };
  return { query } as unknown as Database;
}

function testConfig(): ServerConfig {
  return {
    port: 0,
    databaseUrl: "postgres://unused-in-this-test",
    rootKeys: new Map([[1, randomBytes(32)]]),
    activeKekVersion: 1,
    directoryImpl: "memory",
    maxFailedAttempts: 5,
    lockoutDurationMs: 900_000,
    totpDriftSteps: 1,
  };
}

describe("app - health", () => {
  it("GET /api/v1/healthz reports ok when the DB responds", async () => {
    const app = createApp(createFakeDb(), testConfig(), new InMemoryDirectory());
    const res = await request(app).get("/api/v1/healthz");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", dbOk: true });
  });
});

describe("app - API key auth", () => {
  it("rejects a request with no Authorization header", async () => {
    const app = createApp(createFakeDb(), testConfig(), new InMemoryDirectory());
    const res = await request(app).post("/api/v1/verify").send({ username: "jdoe", code: "123456" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_api_key");
  });

  it("rejects a request with an unrecognized API key", async () => {
    const app = createApp(createFakeDb(null), testConfig(), new InMemoryDirectory());
    const res = await request(app)
      .post("/api/v1/verify")
      .set("Authorization", `Bearer ${VALID_KEY}`)
      .send({ username: "jdoe", code: "123456" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_api_key");
  });

  it("rejects a recognized key missing the required scope", async () => {
    const app = createApp(createFakeDb(["enroll"]), testConfig(), new InMemoryDirectory());
    const res = await request(app)
      .post("/api/v1/verify")
      .set("Authorization", `Bearer ${VALID_KEY}`)
      .send({ username: "jdoe", code: "123456" });
    expect(res.status).toBe(403);
  });
});

describe("app - request validation", () => {
  const app = createApp(createFakeDb(), testConfig(), new InMemoryDirectory());

  it("POST /verify without username/code returns 400", async () => {
    const res = await request(app).post("/api/v1/verify").set("Authorization", `Bearer ${VALID_KEY}`).send({ username: "jdoe" });
    expect(res.status).toBe(400);
  });

  it("POST /enroll/start without username returns 400", async () => {
    const res = await request(app).post("/api/v1/enroll/start").set("Authorization", `Bearer ${VALID_KEY}`).send({});
    expect(res.status).toBe(400);
  });

  it("POST /enroll/confirm without code returns 400", async () => {
    const res = await request(app)
      .post("/api/v1/enroll/confirm")
      .set("Authorization", `Bearer ${VALID_KEY}`)
      .send({ username: "jdoe" });
    expect(res.status).toBe(400);
  });

  it("POST /admin/reset without operator returns 400", async () => {
    const res = await request(app)
      .post("/api/v1/admin/reset")
      .set("Authorization", `Bearer ${VALID_KEY}`)
      .send({ username: "jdoe" });
    expect(res.status).toBe(400);
  });

});
