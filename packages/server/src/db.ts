import pg from "pg";

const { Pool } = pg;

export type Database = pg.Pool;

export function createPool(connectionString: string): Database {
  return new Pool({ connectionString });
}

/** Runs fn inside a BEGIN/COMMIT transaction on a dedicated client, rolling back on error. */
export async function withTransaction<T>(pool: Database, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
