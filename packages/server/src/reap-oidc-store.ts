import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { reapExpiredOidcModels } from "./oidc/adapter.js";

/** Deletes expired oidc-provider rows. Intended to run on a schedule (e.g. hourly cron) - see packages/server/README.md. */
async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  try {
    const deleted = await reapExpiredOidcModels(pool);
    console.log(`Deleted ${deleted} expired oidc_model_store row(s)`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
