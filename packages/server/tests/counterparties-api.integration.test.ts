import { randomBytes } from "node:crypto";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { generateApiKey } from "../src/crypto/apiKey.js";
import type { Database } from "../src/db.js";
import { InMemoryDirectory } from "../src/directory/memory-directory.js";
import { createTestDatabase } from "./support/test-db.js";

let db: Database;
let dropDb: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let readWriteKey: string;

function testConfig(): ServerConfig {
  return {
    port: 0,
    databaseUrl: "unused-in-tests",
    rootKeys: new Map([[1, randomBytes(32)]]),
    activeKekVersion: 1,
    directoryImpl: "memory",
    maxFailedAttempts: 5,
    lockoutDurationMs: 900_000,
    totpDriftSteps: 1,
  };
}

/** Registers a service client with the given scopes and returns its raw API key. */
async function createClient(clientId: string, scopes: string[]): Promise<string> {
  const { key, hash, prefix } = generateApiKey();
  await db.query(
    "INSERT INTO service_clients (client_id, description, api_key_hash, api_key_prefix, scopes) VALUES ($1, $2, $3, $4, $5)",
    [clientId, `${clientId} (test)`, hash, prefix, scopes],
  );
  return key;
}

beforeEach(async () => {
  const created = await createTestDatabase();
  db = created.pool;
  dropDb = created.drop;
  app = createApp(db, testConfig(), new InMemoryDirectory());
  readWriteKey = await createClient("back-office", ["counterparties:read", "counterparties:write"]);
});

afterEach(async () => {
  await dropDb();
});

const SBER = {
  kind: "legal_entity",
  name: "ПАО Сбербанк",
  inn: "7707083893",
  kpp: "773601001",
  ogrn: "1027700132195",
  operator: "buh.ivanova",
};

const auth = (req: request.Test, key = readWriteKey) => req.set("Authorization", `Bearer ${key}`);

async function postCounterparty(body: Record<string, unknown>, key = readWriteKey) {
  return auth(request(app).post("/api/v1/counterparties"), key).send(body);
}

describe("POST /api/v1/counterparties", () => {
  it("creates a counterparty and returns it", async () => {
    const res = await postCounterparty(SBER);
    expect(res.status).toBe(201);
    expect(res.body.counterparty).toMatchObject({ name: "ПАО Сбербанк", inn: SBER.inn, status: "active", createdBy: "buh.ivanova" });
    expect(res.body.counterparty.id).toBeTruthy();
  });

  it("returns 400 with per-field issues for bad requisites", async () => {
    const res = await postCounterparty({ ...SBER, inn: "7707083894", kpp: "нет" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_failed");
    expect(res.body.issues).toEqual(
      expect.arrayContaining([
        { field: "inn", code: "checksum_failed" },
        { field: "kpp", code: "malformed" },
      ]),
    );
  });

  it("returns 400 when the operator is missing", async () => {
    const { operator, ...withoutOperator } = SBER;
    const res = await postCounterparty(withoutOperator);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("operator_required");
  });

  it("returns 409 with the existing id on a duplicate ИНН/КПП", async () => {
    const first = await postCounterparty(SBER);
    const second = await postCounterparty({ ...SBER, name: "Сбер (дубль)" });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: "duplicate_inn_kpp", existingId: first.body.counterparty.id });
  });
});

describe("GET /api/v1/counterparties", () => {
  beforeEach(async () => {
    await postCounterparty(SBER);
    await postCounterparty({
      kind: "sole_proprietor",
      name: "ИП Иванов И.И.",
      inn: "771234567859",
      ogrn: "304774600000000",
      operator: "buh.ivanova",
    });
  });

  it("lists counterparties with paging metadata", async () => {
    const res = await auth(request(app).get("/api/v1/counterparties"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 2, limit: 50, offset: 0 });
    expect(res.body.items.map((c: { name: string }) => c.name)).toEqual(["ИП Иванов И.И.", "ПАО Сбербанк"]);
  });

  it("filters by search term and kind", async () => {
    const bySearch = await auth(request(app).get("/api/v1/counterparties?search=сбербанк"));
    expect(bySearch.body.items).toHaveLength(1);

    const byKind = await auth(request(app).get("/api/v1/counterparties?kind=sole_proprietor"));
    expect(byKind.body.items.map((c: { name: string }) => c.name)).toEqual(["ИП Иванов И.И."]);
  });

  it("caps limit at 200 and rejects unknown filter values", async () => {
    const capped = await auth(request(app).get("/api/v1/counterparties?limit=5000"));
    expect(capped.body.limit).toBe(200);

    const badStatus = await auth(request(app).get("/api/v1/counterparties?status=deleted"));
    expect(badStatus.status).toBe(400);
    expect(badStatus.body.error).toBe("invalid_status");
  });
});

describe("GET /api/v1/counterparties/:id", () => {
  it("returns one counterparty, and 404 for unknown or malformed ids", async () => {
    const created = await postCounterparty(SBER);
    const id = created.body.counterparty.id;

    const found = await auth(request(app).get(`/api/v1/counterparties/${id}`));
    expect(found.status).toBe(200);
    expect(found.body.counterparty.id).toBe(id);

    const missing = await auth(request(app).get("/api/v1/counterparties/00000000-0000-0000-0000-000000000000"));
    expect(missing.status).toBe(404);

    // A malformed uuid must not reach Postgres and surface as a 500.
    const malformed = await auth(request(app).get("/api/v1/counterparties/not-a-uuid"));
    expect(malformed.status).toBe(404);
    expect(malformed.body.error).toBe("counterparty_not_found");
  });
});

describe("PATCH /api/v1/counterparties/:id", () => {
  it("applies a partial change and reports the changed fields", async () => {
    const created = await postCounterparty(SBER);
    const id = created.body.counterparty.id;

    const res = await auth(request(app).patch(`/api/v1/counterparties/${id}`)).send({
      operator: "admin.petrov",
      email: "buh@sber.ru",
    });
    expect(res.status).toBe(200);
    expect(res.body.changed).toEqual(["email"]);
    expect(res.body.counterparty).toMatchObject({ email: "buh@sber.ru", name: "ПАО Сбербанк", updatedBy: "admin.petrov" });
  });

  it("returns 404 for an unknown id and 400 for an invalid merge result", async () => {
    const created = await postCounterparty(SBER);
    const id = created.body.counterparty.id;

    const missing = await auth(request(app).patch("/api/v1/counterparties/00000000-0000-0000-0000-000000000000")).send({
      operator: "admin.petrov",
      email: "buh@sber.ru",
    });
    expect(missing.status).toBe(404);

    const invalid = await auth(request(app).patch(`/api/v1/counterparties/${id}`)).send({
      operator: "admin.petrov",
      kind: "sole_proprietor",
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.issues).toContainEqual({ field: "kpp", code: "not_allowed_for_kind" });
  });
});

describe("POST /api/v1/counterparties/:id/status", () => {
  it("blocks a counterparty and reports the previous status", async () => {
    const created = await postCounterparty(SBER);
    const id = created.body.counterparty.id;

    const res = await auth(request(app).post(`/api/v1/counterparties/${id}/status`)).send({
      operator: "admin.petrov",
      status: "blocked",
      reason: "просроченная задолженность",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ previousStatus: "active" });
    expect(res.body.counterparty.status).toBe("blocked");
  });

  it("rejects an unknown status", async () => {
    const created = await postCounterparty(SBER);
    const res = await auth(request(app).post(`/api/v1/counterparties/${created.body.counterparty.id}/status`)).send({
      operator: "admin.petrov",
      status: "deleted",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_status");
  });
});

describe("registry scopes", () => {
  it("lets a read-only key read but not write", async () => {
    await postCounterparty(SBER);
    const readOnlyKey = await createClient("reporting", ["counterparties:read"]);

    const list = await auth(request(app).get("/api/v1/counterparties"), readOnlyKey);
    expect(list.status).toBe(200);

    const write = await postCounterparty({ ...SBER, name: "ООО Ромашка", inn: "7707207517", kpp: "770701001", ogrn: "1077460000001" }, readOnlyKey);
    expect(write.status).toBe(403);
  });

  it("does not let an MFA key touch the registry at all", async () => {
    const verifyKey = await createClient("credential-provider", ["verify", "enroll", "admin"]);

    const list = await auth(request(app).get("/api/v1/counterparties"), verifyKey);
    expect(list.status).toBe(403);

    const write = await postCounterparty(SBER, verifyKey);
    expect(write.status).toBe(403);
  });

  it("rejects an unauthenticated request", async () => {
    const res = await request(app).get("/api/v1/counterparties");
    expect(res.status).toBe(401);
  });
});

describe("registry audit trail", () => {
  it("records create, update and status changes against the operator", async () => {
    const created = await postCounterparty(SBER);
    const id = created.body.counterparty.id;
    await auth(request(app).patch(`/api/v1/counterparties/${id}`)).send({ operator: "admin.petrov", email: "buh@sber.ru" });
    await auth(request(app).post(`/api/v1/counterparties/${id}/status`)).send({ operator: "admin.petrov", status: "archived" });

    const audit = await auth(request(app).get("/api/v1/counterparties"));
    expect(audit.status).toBe(200);

    const { rows } = await db.query<{ event_type: string; username: string; client_id: string }>(
      "SELECT event_type, username, client_id FROM audit_log ORDER BY id",
    );
    expect(rows.map((r) => r.event_type)).toEqual(["counterparty_create", "counterparty_update", "counterparty_status"]);
    expect(rows.map((r) => r.username)).toEqual(["buh.ivanova", "admin.petrov", "admin.petrov"]);
    expect(rows.every((r) => r.client_id === "back-office")).toBe(true);
  });
});
