import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../src/db.js";
import { createOidcAdapter } from "../src/oidc/adapter.js";
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

describe("oidc PostgresAdapter", () => {
  it("round-trips a payload through upsert/find and isolates model kinds", async () => {
    const adapterFor = createOidcAdapter(db);
    const sessions = adapterFor("Session");
    const grants = adapterFor("Grant");

    await sessions.upsert("sess-1", { accountId: "jdoe" }, 3600);
    await grants.upsert("sess-1", { accountId: "someone-else" }, 3600);

    expect(await sessions.find("sess-1")).toEqual({ accountId: "jdoe" });
    expect(await grants.find("sess-1")).toEqual({ accountId: "someone-else" });
    expect(await sessions.find("no-such-id")).toBeUndefined();
  });

  it("treats an expired payload as not found", async () => {
    const adapter = createOidcAdapter(db)("AuthorizationCode");
    await adapter.upsert("code-1", { accountId: "jdoe" }, -10);
    expect(await adapter.find("code-1")).toBeUndefined();
  });

  it("marks a payload consumed rather than deleting it", async () => {
    const adapter = createOidcAdapter(db)("AuthorizationCode");
    await adapter.upsert("code-2", { accountId: "jdoe" }, 3600);
    await adapter.consume("code-2");
    const found = await adapter.find("code-2");
    expect(found?.accountId).toBe("jdoe");
    expect(typeof found?.consumed).toBe("number");
  });

  it("finds by userCode and by uid", async () => {
    const adapter = createOidcAdapter(db)("DeviceCode");
    await adapter.upsert("dc-1", { accountId: "jdoe", userCode: "BCDF-GHJK", uid: "interaction-uid" }, 3600);
    expect((await adapter.findByUserCode("BCDF-GHJK"))?.accountId).toBe("jdoe");
    expect((await adapter.findByUid("interaction-uid"))?.accountId).toBe("jdoe");
  });

  it("revokeByGrantId removes every payload sharing that grantId regardless of model kind", async () => {
    const adapterFor = createOidcAdapter(db);
    await adapterFor("AccessToken").upsert("at-1", { accountId: "jdoe", grantId: "grant-1" }, 3600);
    await adapterFor("RefreshToken").upsert("rt-1", { accountId: "jdoe", grantId: "grant-1" }, 3600);
    await adapterFor("AccessToken").upsert("at-2", { accountId: "jdoe", grantId: "grant-2" }, 3600);

    await adapterFor("AccessToken").revokeByGrantId("grant-1");

    expect(await adapterFor("AccessToken").find("at-1")).toBeUndefined();
    expect(await adapterFor("RefreshToken").find("rt-1")).toBeUndefined();
    expect(await adapterFor("AccessToken").find("at-2")).toBeDefined();
  });

  it("destroy removes a single payload", async () => {
    const adapter = createOidcAdapter(db)("Session");
    await adapter.upsert("sess-2", { accountId: "jdoe" }, 3600);
    await adapter.destroy("sess-2");
    expect(await adapter.find("sess-2")).toBeUndefined();
  });
});
