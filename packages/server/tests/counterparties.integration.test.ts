import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCounterparty,
  getCounterparty,
  listCounterparties,
  setCounterpartyStatus,
  updateCounterparty,
} from "../src/counterparties/registry.js";
import type { Database } from "../src/db.js";
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

const CTX = { operator: "buh.ivanova", clientId: "test-client", ip: "127.0.0.1" };

const SBER = {
  kind: "legal_entity",
  name: "ПАО Сбербанк",
  fullName: "Публичное акционерное общество «Сбербанк России»",
  inn: "7707083893",
  kpp: "773601001",
  ogrn: "1027700132195",
  legalAddress: "117312, г. Москва, ул. Вавилова, д. 19",
};

const IP_IVANOV = {
  kind: "sole_proprietor",
  name: "ИП Иванов И.И.",
  inn: "771234567859",
  ogrn: "304774600000000",
};

async function createOk(input: Record<string, unknown>) {
  const result = await createCounterparty(db, input, CTX);
  if (result.outcome !== "created") {
    throw new Error(`create did not succeed: ${result.outcome}`);
  }
  return result.counterparty;
}

async function auditRows() {
  const { rows } = await db.query<{ event_type: string; username: string; metadata: Record<string, unknown> }>(
    "SELECT event_type, username, metadata FROM audit_log ORDER BY id",
  );
  return rows;
}

describe("counterparty registry - create", () => {
  it("stores a legal entity and audits who added it", async () => {
    const created = await createOk(SBER);

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.status).toBe("active");
    expect(created.createdBy).toBe("buh.ivanova");
    expect(created.updatedBy).toBe("buh.ivanova");
    expect(created.inn).toBe(SBER.inn);
    expect(created.countryCode).toBe("RU");

    const stored = await getCounterparty(db, created.id);
    expect(stored?.fullName).toBe(SBER.fullName);

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].event_type).toBe("counterparty_create");
    expect(audit[0].username).toBe("buh.ivanova");
    expect(audit[0].metadata).toMatchObject({ counterparty_id: created.id, inn: SBER.inn, kind: "legal_entity" });
  });

  it("rejects invalid requisites without writing anything", async () => {
    const result = await createCounterparty(db, { ...SBER, inn: "7707083894" }, CTX);
    expect(result.outcome).toBe("invalid");

    const { rows } = await db.query("SELECT count(*)::int AS n FROM counterparties");
    expect(rows[0].n).toBe(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("refuses a second row with the same ИНН and КПП, pointing at the existing one", async () => {
    const first = await createOk(SBER);
    const duplicate = await createCounterparty(db, { ...SBER, name: "Сбер (дубль)" }, CTX);

    expect(duplicate.outcome).toBe("duplicate");
    if (duplicate.outcome !== "duplicate") return;
    expect(duplicate.existing?.id).toBe(first.id);
  });

  it("allows a branch: same ИНН, different КПП", async () => {
    await createOk(SBER);
    const branch = await createCounterparty(db, { ...SBER, name: "Сбербанк, Тверское отделение", kpp: "695043001" }, CTX);
    expect(branch.outcome).toBe("created");
  });

  it("keeps an archived counterparty's ИНН reserved", async () => {
    const created = await createOk(SBER);
    await setCounterpartyStatus(db, created.id, "archived", CTX);

    const again = await createCounterparty(db, SBER, CTX);
    expect(again.outcome).toBe("duplicate");
    if (again.outcome !== "duplicate") return;
    expect(again.existing?.id).toBe(created.id);
  });

  it("does not apply the ИНН/КПП constraint to counterparties without an ИНН", async () => {
    await createOk({ kind: "individual", name: "Иванов Иван Иванович" });
    const second = await createCounterparty(db, { kind: "individual", name: "Петров Пётр Петрович" }, CTX);
    expect(second.outcome).toBe("created");
  });
});

describe("counterparty registry - update", () => {
  it("merges a patch, leaves untouched fields alone and records what changed", async () => {
    const created = await createOk(SBER);
    const result = await updateCounterparty(
      db,
      created.id,
      { email: "buh@sber.ru", phone: "+7 (495) 500-55-50" },
      { ...CTX, operator: "admin.petrov" },
    );

    expect(result.outcome).toBe("updated");
    if (result.outcome !== "updated") return;
    expect(result.counterparty.email).toBe("buh@sber.ru");
    expect(result.counterparty.inn).toBe(SBER.inn);
    expect(result.counterparty.fullName).toBe(SBER.fullName);
    expect(result.counterparty.createdBy).toBe("buh.ivanova");
    expect(result.counterparty.updatedBy).toBe("admin.petrov");
    expect(result.changed.sort()).toEqual(["email", "phone"]);

    const audit = await auditRows();
    expect(audit[1].event_type).toBe("counterparty_update");
    expect(audit[1].metadata).toMatchObject({ counterparty_id: created.id, changed: ["email", "phone"] });
  });

  it("clears a field when the patch sends null", async () => {
    const created = await createOk({ ...SBER, postalAddress: "а/я 42" });
    const result = await updateCounterparty(db, created.id, { postalAddress: null }, CTX);

    expect(result.outcome).toBe("updated");
    if (result.outcome !== "updated") return;
    expect(result.counterparty.postalAddress).toBeNull();
  });

  it("validates the merged entity, not just the patch", async () => {
    const created = await createOk(SBER);
    // Changing kind alone would leave a КПП on an ИП, which is invalid - the
    // caller has to clear it in the same request.
    const halfWay = await updateCounterparty(db, created.id, { kind: "sole_proprietor" }, CTX);
    expect(halfWay.outcome).toBe("invalid");
    if (halfWay.outcome !== "invalid") return;
    expect(halfWay.issues).toContainEqual({ field: "kpp", code: "not_allowed_for_kind" });

    const complete = await updateCounterparty(
      db,
      created.id,
      { kind: "sole_proprietor", kpp: null, inn: IP_IVANOV.inn, ogrn: IP_IVANOV.ogrn, name: IP_IVANOV.name },
      CTX,
    );
    expect(complete.outcome).toBe("updated");
  });

  it("reports a patch that would collide with another counterparty", async () => {
    const first = await createOk(SBER);
    const second = await createOk({ ...SBER, name: "Отделение", kpp: "695043001" });

    const result = await updateCounterparty(db, second.id, { kpp: SBER.kpp }, CTX);
    expect(result.outcome).toBe("duplicate");
    if (result.outcome !== "duplicate") return;
    expect(result.existing?.id).toBe(first.id);
  });

  it("returns not_found for an unknown id", async () => {
    const result = await updateCounterparty(db, "00000000-0000-0000-0000-000000000000", { name: "X" }, CTX);
    expect(result.outcome).toBe("not_found");
  });

  it("does not lose one of two concurrent patches to different fields", async () => {
    const created = await createOk(SBER);
    // Each patch is a read-modify-write of the whole row; without the row lock
    // in updateCounterparty the slower one writes back the other's stale values.
    const [first, second] = await Promise.all([
      updateCounterparty(db, created.id, { email: "buh@sber.ru" }, CTX),
      updateCounterparty(db, created.id, { phone: "+7 (495) 500-55-50" }, CTX),
    ]);
    expect([first.outcome, second.outcome]).toEqual(["updated", "updated"]);

    const stored = await getCounterparty(db, created.id);
    expect(stored?.email).toBe("buh@sber.ru");
    expect(stored?.phone).toBe("+7 (495) 500-55-50");
  });
});

describe("counterparty registry - status", () => {
  it("blocks, then restores, recording the reason each time", async () => {
    const created = await createOk(SBER);

    const blocked = await setCounterpartyStatus(db, created.id, "blocked", { ...CTX, reason: "просроченная задолженность" });
    expect(blocked.outcome).toBe("ok");
    if (blocked.outcome !== "ok") return;
    expect(blocked.previousStatus).toBe("active");
    expect(blocked.counterparty.status).toBe("blocked");

    const restored = await setCounterpartyStatus(db, created.id, "active", { ...CTX, reason: "задолженность погашена" });
    expect(restored.outcome).toBe("ok");
    if (restored.outcome !== "ok") return;
    expect(restored.previousStatus).toBe("blocked");

    const audit = await auditRows();
    expect(audit.map((r) => r.event_type)).toEqual([
      "counterparty_create",
      "counterparty_status",
      "counterparty_status",
    ]);
    expect(audit[1].metadata).toMatchObject({ from: "active", to: "blocked", reason: "просроченная задолженность" });
    expect(audit[2].metadata).toMatchObject({ from: "blocked", to: "active" });
  });

  it("returns not_found for an unknown id", async () => {
    const result = await setCounterpartyStatus(db, "00000000-0000-0000-0000-000000000000", "blocked", CTX);
    expect(result.outcome).toBe("not_found");
  });
});

describe("counterparty registry - list", () => {
  beforeEach(async () => {
    await createOk(SBER);
    await createOk(IP_IVANOV);
    await createOk({ kind: "legal_entity", name: "ООО Ромашка", inn: "7707207517", kpp: "770701001", ogrn: "1077460000001" });
    await createOk({ kind: "foreign", name: "ACME Inc.", countryCode: "US" });
  });

  it("returns every counterparty sorted by name, with a total", async () => {
    const result = await listCounterparties(db, { limit: 50, offset: 0 });
    expect(result.total).toBe(4);
    expect(result.items.map((c) => c.name)).toEqual(["ACME Inc.", "ИП Иванов И.И.", "ООО Ромашка", "ПАО Сбербанк"]);
  });

  it("pages with limit/offset while keeping the total", async () => {
    const page = await listCounterparties(db, { limit: 2, offset: 2 });
    expect(page.total).toBe(4);
    expect(page.items).toHaveLength(2);
    expect(page.items.map((c) => c.name)).toEqual(["ООО Ромашка", "ПАО Сбербанк"]);
  });

  it("searches names case-insensitively on a substring", async () => {
    const result = await listCounterparties(db, { search: "ромашка", limit: 50, offset: 0 });
    expect(result.items.map((c) => c.name)).toEqual(["ООО Ромашка"]);
  });

  it("treats LIKE wildcards in the search term as literal text", async () => {
    await createOk({ kind: "individual", name: "ООО Скидка 50% Плюс" });
    await createOk({ kind: "individual", name: "ООО Скидка 5012 Плюс" });

    const result = await listCounterparties(db, { search: "50%", limit: 50, offset: 0 });
    expect(result.items.map((c) => c.name)).toEqual(["ООО Скидка 50% Плюс"]);

    const underscore = await listCounterparties(db, { search: "а_", limit: 50, offset: 0 });
    expect(underscore.total).toBe(0);
  });

  it("treats a digits-only search term as an exact ИНН or ОГРН", async () => {
    const byInn = await listCounterparties(db, { search: SBER.inn, limit: 50, offset: 0 });
    expect(byInn.items.map((c) => c.name)).toEqual(["ПАО Сбербанк"]);

    const byOgrn = await listCounterparties(db, { search: "1077460000001", limit: 50, offset: 0 });
    expect(byOgrn.items.map((c) => c.name)).toEqual(["ООО Ромашка"]);

    const partial = await listCounterparties(db, { search: "7707", limit: 50, offset: 0 });
    expect(partial.total).toBe(0);
  });

  it("filters by status and by kind", async () => {
    const sber = (await listCounterparties(db, { search: SBER.inn, limit: 1, offset: 0 })).items[0];
    await setCounterpartyStatus(db, sber.id, "archived", CTX);

    const active = await listCounterparties(db, { status: "active", limit: 50, offset: 0 });
    expect(active.total).toBe(3);
    expect(active.items.every((c) => c.status === "active")).toBe(true);

    const archived = await listCounterparties(db, { status: "archived", limit: 50, offset: 0 });
    expect(archived.items.map((c) => c.name)).toEqual(["ПАО Сбербанк"]);

    const entities = await listCounterparties(db, { kind: "legal_entity", limit: 50, offset: 0 });
    expect(entities.total).toBe(2);
  });

  it("combines a filter with paging", async () => {
    const result = await listCounterparties(db, { kind: "legal_entity", limit: 1, offset: 1 });
    expect(result.total).toBe(2);
    expect(result.items.map((c) => c.name)).toEqual(["ПАО Сбербанк"]);
  });

  it("returns an empty page past the end", async () => {
    const result = await listCounterparties(db, { limit: 50, offset: 100 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});
