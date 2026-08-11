import { generateApiKey } from "./crypto/apiKey.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";

const VALID_SCOPES = new Set(["enroll", "verify", "admin"]);

async function main(): Promise<void> {
  const [clientId, description, ...scopes] = process.argv.slice(2);
  if (!clientId || !description || scopes.length === 0 || scopes.some((s) => !VALID_SCOPES.has(s))) {
    console.error("Usage: node dist/create-client.js <clientId> <description> <scope...>");
    console.error("  scopes: enroll | verify | admin (space-separated, at least one)");
    process.exit(1);
  }

  const config = loadConfig();
  const db = createPool(config.databaseUrl);
  try {
    const { key, hash, prefix } = generateApiKey();
    await db.query(
      "INSERT INTO service_clients (client_id, description, api_key_hash, api_key_prefix, scopes) VALUES ($1, $2, $3, $4, $5)",
      [clientId, description, hash, prefix, scopes],
    );
    console.log(`Client "${clientId}" created with scopes [${scopes.join(", ")}].`);
    console.log(`API key (shown once - store it securely, it cannot be recovered): ${key}`);
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
