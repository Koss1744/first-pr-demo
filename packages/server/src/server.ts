import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { createDirectory } from "./directory/index.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = createPool(config.databaseUrl);
  const directory = createDirectory(config);
  const app = createApp(db, config, directory);

  app.listen(config.port, () => {
    console.log(`HOFI Auth Server listening on :${config.port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
