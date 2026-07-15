import { query as poolQuery } from "./pool";
import {
  QueryBuilder,
  type QueryExecutor,
  type PostgrestResponse,
} from "./queryBuilder";

export {
  QueryBuilder,
  type QueryExecutor,
  type PostgrestResponse,
  type PostgrestError,
  type BuiltQuery,
} from "./queryBuilder";
export { getPool, closePool, query } from "./pool";

/**
 * The subset of the supabase-js service client that Mike's backend uses.
 * `createDb()` returns an object with this shape backed by node-postgres, so
 * existing call sites keep working after swapping the client factory.
 */
export interface Db {
  from(table: string): QueryBuilder;
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<PostgrestResponse<any[]>>;
}

function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

/** Thenable that calls a `RETURNS TABLE` Postgres function with named args. */
class RpcCall implements PromiseLike<PostgrestResponse<any[]>> {
  constructor(
    private readonly fn: string,
    private readonly args: Record<string, unknown>,
    private readonly executor: QueryExecutor,
  ) {}

  private async run(): Promise<PostgrestResponse> {
    const keys = Object.keys(this.args);
    const values: unknown[] = [];
    const params = keys
      .map((k) => {
        values.push(this.args[k]);
        return `${quoteIdent(k)} => $${values.length}`;
      })
      .join(", ");
    const text = `SELECT * FROM ${quoteIdent(this.fn)}(${params})`;
    try {
      const res = await this.executor(text, values);
      return { data: res.rows, error: null, count: null };
    } catch (err) {
      const e = err as { message?: string; code?: string; detail?: string; hint?: string };
      return {
        data: null,
        count: null,
        error: {
          message: e?.message ?? String(err),
          code: e?.code ?? "",
          details: e?.detail ?? null,
          hint: e?.hint ?? null,
        },
      };
    }
  }

  then<R1 = PostgrestResponse, R2 = never>(
    onfulfilled?: ((value: PostgrestResponse) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

/**
 * Create a db client backed by the shared pool. Accepts an optional executor
 * for tests (defaults to the real pool).
 */
export function createDb(executor: QueryExecutor = defaultExecutor): Db {
  return {
    from: (table: string) => new QueryBuilder(table, executor),
    rpc: (fn: string, args: Record<string, unknown> = {}) =>
      new RpcCall(fn, args, executor),
  };
}

const defaultExecutor: QueryExecutor = async (text, values) => {
  const res = await poolQuery(text, values);
  return { rows: res.rows as Record<string, unknown>[], rowCount: res.rowCount };
};
