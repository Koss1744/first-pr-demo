import { randomBytes } from "node:crypto";
import pg from "pg";
import { createPool, type Database } from "../../src/db.js";
import { runMigrations } from "../../src/migrate.js";

const ADMIN_URL = process.env.HOFI_TEST_ADMIN_DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

/**
 * Creates a fresh, migrated, throwaway Postgres database for one test (mirrors
 * packages/cli/tests/vault.test.ts's mkdtemp/rm filesystem isolation, but for
 * a real local Postgres cluster instead of the filesystem). The database name
 * is generated from random hex only, so it's safe to interpolate directly
 * into DDL (Postgres can't parameterize identifiers in CREATE/DROP DATABASE).
 */
export async function createTestDatabase(): Promise<{ pool: Database; drop: () => Promise<void> }> {
  const dbName = `hofi_test_${randomBytes(6).toString("hex")}`;
  const adminPool = new pg.Pool({ connectionString: ADMIN_URL });
  try {
    await adminPool.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await adminPool.end();
  }

  const dbUrl = new URL(ADMIN_URL);
  dbUrl.pathname = `/${dbName}`;
  const pool = createPool(dbUrl.toString());
  await runMigrations(pool);

  const drop = async (): Promise<void> => {
    await pool.end();
    const cleanupPool = new pg.Pool({ connectionString: ADMIN_URL });
    try {
      await cleanupPool.query(`DROP DATABASE IF EXISTS ${dbName}`);
    } finally {
      await cleanupPool.end();
    }
  };

  return { pool, drop };
}
