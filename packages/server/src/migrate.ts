import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { createPool } from "./db.js";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Applies any not-yet-applied migrations from migrations/*.sql, in filename order. Idempotent. */
export async function runMigrations(pool: pg.Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const { rows } = await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.filename));

  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
      await client.query("COMMIT");
      newlyApplied.push(file);
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }
  return newlyApplied;
}

async function main(): Promise<void> {
  const { loadConfig } = await import("./config.js");
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    const applied = await runMigrations(pool);
    console.log(applied.length > 0 ? `Applied: ${applied.join(", ")}` : "Already up to date");
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
