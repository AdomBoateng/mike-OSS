import { Pool, type QueryResult } from "pg";

// Single shared connection pool for the self-hosted Postgres backing Mike.
// Reads DATABASE_URL (see docker-compose.yml / .env.example).

let pool: Pool | undefined;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    pool = new Pool({ connectionString, max: 10 });
    // The pool emits 'error' for idle-client / connection failures. Without a
    // listener, node-postgres lets it become an unhandled rejection that crashes
    // the process. Log and swallow — per-query failures are already surfaced to
    // callers by the query promise rejecting.
    pool.on("error", (err) => {
      console.error("[db] idle client error", err.message);
    });
  }
  return pool;
}

/** Run a parameterized query on the shared pool. */
export function query(text: string, values: unknown[]): Promise<QueryResult> {
  return getPool().query(text, values);
}

/** Close the pool (tests / graceful shutdown). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
