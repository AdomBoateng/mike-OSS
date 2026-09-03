// A minimal PostgREST-compatible query builder over node-postgres.
//
// Goal: reproduce the subset of the supabase-js query API that Mike's backend
// actually uses, so the ~315 existing `.from(...).select()/.eq()/...` call
// sites keep working against self-hosted Postgres by swapping only the client
// factory (see ./index.ts), not every call site.
//
// Supported: from, select (+ {count,head}), insert, update, upsert
// (+{onConflict, ignoreDuplicates}), delete, filters eq/neq/gt/in/is/not(is),
// order (+{ascending,nullsFirst}), limit, range, single, maybeSingle, and
// mutation .select() -> RETURNING. Awaiting a builder resolves to
// { data, error, count } and never rejects (errors are returned, like supabase).
//
// NOT supported (rare/absent in this codebase): embedded/nested selects, .or(),
// text-search, and other filters. The single embedded select in the codebase is
// rewritten at its call site.

export interface PostgrestError {
  message: string;
  code: string;
  details: string | null;
  hint: string | null;
}

// `data` defaults to `any` so the builder is a drop-in for the untyped
// supabase-js client the backend used (createClient without generated types),
// where call sites read `data.field` / cast freely.
export interface PostgrestResponse<T = any> {
  data: T | null;
  error: PostgrestError | null;
  count: number | null;
}

export type QueryExecutor = (
  text: string,
  values: unknown[],
) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;

type Op = "select" | "insert" | "update" | "upsert" | "delete";
type Filter = { col: string; op: string; value: unknown };
type Order = { col: string; ascending: boolean; nullsFirst?: boolean };

function quoteIdent(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

// supabase-js passes JS objects/arrays for jsonb columns and lets PostgREST
// serialize them. node-postgres would encode a JS array as a Postgres array
// literal, so serialize objects/arrays to JSON and cast ::jsonb. The schema has
// no native array columns, so this is unambiguous.
function isJsonValue(v: unknown): boolean {
  return (
    v !== null &&
    typeof v === "object" &&
    !(v instanceof Date) &&
    !Buffer.isBuffer(v)
  );
}

// jsonb columns that legitimately receive scalar (string/number/boolean)
// values, not just objects/arrays. supabase-js/PostgREST coerced these into
// jsonb; node-postgres instead binds a JS string as `text`, which Postgres
// refuses to store in a jsonb column ("column is of type jsonb but expression
// is of type text"), so the INSERT fails. The clearest case is a chat user
// turn, whose `content` is the raw message string — a silently-dropped insert
// there made user messages vanish on reload. Keyed by table so genuine text
// columns elsewhere are never mis-cast. Object/array/null values still flow
// through the normal path (isJsonValue / NULL binding).
const JSONB_SCALAR_COLUMNS: Record<string, ReadonlySet<string>> = {
  chat_messages: new Set(["content", "files", "workflow", "annotations"]),
};

function isJsonbColumn(table: string, col: string): boolean {
  return JSONB_SCALAR_COLUMNS[table]?.has(col) ?? false;
}

function mapError(err: unknown): PostgrestError {
  const e = err as { message?: string; code?: string; detail?: string; hint?: string };
  return {
    message: e?.message ?? String(err),
    code: e?.code ?? "",
    details: e?.detail ?? null,
    hint: e?.hint ?? null,
  };
}

/** SQL text + ordered parameter values. */
export interface BuiltQuery {
  text: string;
  values: unknown[];
}

// Mirrors supabase-js typing: a plain select resolves `data: Row[]`, while
// `.single()`/`.maybeSingle()` narrow it to `data: Row`. With Row defaulting to
// `any`, that means `data: any[]` for selects (so `.map(row => ...)` gives a
// clean `any` element) and `data: any` for single-row reads.
export class QueryBuilder<Row = any>
  implements PromiseLike<PostgrestResponse<Row[]>>
{
  private op: Op = "select";
  private projection = "*";
  private returning = false;
  private insertRows: Record<string, unknown>[] = [];
  private updateValues: Record<string, unknown> = {};
  private conflictTarget: string | null = null;
  private ignoreDuplicates = false;
  private filters: Filter[] = [];
  private orders: Order[] = [];
  private limitCount: number | null = null;
  private offsetCount: number | null = null;
  private rowMode: "many" | "single" | "maybeSingle" = "many";
  private countMode: "exact" | null = null;
  private headMode = false;

  constructor(
    private readonly table: string,
    private readonly executor: QueryExecutor,
  ) {}

  // --- operation selectors -------------------------------------------------

  select(
    columns = "*",
    opts?: { count?: "exact"; head?: boolean },
  ): this {
    if (this.op === "select") {
      this.projection = columns || "*";
      if (opts?.count) this.countMode = opts.count;
      if (opts?.head) this.headMode = true;
    } else {
      // .select() after a mutation -> RETURNING
      this.returning = true;
      this.projection = columns || "*";
    }
    return this;
  }

  insert(values: Record<string, unknown> | Record<string, unknown>[]): this {
    this.op = "insert";
    this.insertRows = Array.isArray(values) ? values : [values];
    return this;
  }

  upsert(
    values: Record<string, unknown> | Record<string, unknown>[],
    opts?: { onConflict?: string; ignoreDuplicates?: boolean },
  ): this {
    this.op = "upsert";
    this.insertRows = Array.isArray(values) ? values : [values];
    this.conflictTarget = opts?.onConflict ?? null;
    this.ignoreDuplicates = opts?.ignoreDuplicates ?? false;
    return this;
  }

  update(values: Record<string, unknown>): this {
    this.op = "update";
    this.updateValues = values;
    return this;
  }

  delete(): this {
    this.op = "delete";
    return this;
  }

  // --- filters -------------------------------------------------------------

  eq(col: string, value: unknown): this {
    this.filters.push({ col, op: "eq", value });
    return this;
  }
  neq(col: string, value: unknown): this {
    this.filters.push({ col, op: "neq", value });
    return this;
  }
  gt(col: string, value: unknown): this {
    this.filters.push({ col, op: "gt", value });
    return this;
  }
  in(col: string, values: unknown[]): this {
    this.filters.push({ col, op: "in", value: values });
    return this;
  }
  is(col: string, value: null | boolean): this {
    this.filters.push({ col, op: "is", value });
    return this;
  }
  not(col: string, op: string, value: unknown): this {
    this.filters.push({ col, op: `not.${op}`, value });
    return this;
  }
  // Generic PostgREST filter. Only the operators the codebase uses are
  // implemented; `cs` (contains) is used for jsonb membership checks and takes
  // a JSON string value (e.g. JSON.stringify([email])).
  filter(col: string, op: string, value: unknown): this {
    this.filters.push({ col, op: `filter.${op}`, value });
    return this;
  }

  // --- modifiers -----------------------------------------------------------

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.orders.push({
      col,
      ascending: opts?.ascending ?? true,
      nullsFirst: opts?.nullsFirst,
    });
    return this;
  }
  limit(n: number): this {
    this.limitCount = n;
    return this;
  }
  range(from: number, to: number): this {
    this.offsetCount = from;
    this.limitCount = to - from + 1;
    return this;
  }
  single(): PromiseLike<PostgrestResponse<Row>> {
    this.rowMode = "single";
    return this as unknown as PromiseLike<PostgrestResponse<Row>>;
  }
  maybeSingle(): PromiseLike<PostgrestResponse<Row>> {
    this.rowMode = "maybeSingle";
    return this as unknown as PromiseLike<PostgrestResponse<Row>>;
  }

  // --- SQL construction ----------------------------------------------------

  /** Build the SQL text + params for the current builder state. */
  toSql(): BuiltQuery {
    const values: unknown[] = [];
    const push = (v: unknown): string => {
      if (isJsonValue(v)) {
        values.push(JSON.stringify(v));
        return `$${values.length}::jsonb`;
      }
      values.push(v);
      return `$${values.length}`;
    };
    // Bind a value as-is (no jsonb serialization). Used for `.in(col, array)`,
    // where the array is a query parameter for `= ANY(...)`, not a jsonb column
    // value — node-postgres encodes it as a Postgres array.
    const pushRaw = (v: unknown): string => {
      values.push(v);
      return `$${values.length}`;
    };
    // Column-aware bind for INSERT/UPDATE: for known jsonb columns, serialize
    // even scalar values and cast ::jsonb so a bare string is stored as a jsonb
    // string rather than rejected as text. Everything else uses `push` (objects
    // → ::jsonb, primitives → raw, null → NULL).
    const pushCol = (col: string, v: unknown): string => {
      if (v !== null && !isJsonValue(v) && isJsonbColumn(this.table, col)) {
        values.push(JSON.stringify(v));
        return `$${values.length}::jsonb`;
      }
      return push(v);
    };

    const where = (): string => {
      if (this.filters.length === 0) return "";
      const parts = this.filters.map((f) => {
        const col = quoteIdent(f.col);
        switch (f.op) {
          case "eq":
            return `${col} = ${push(f.value)}`;
          case "neq":
            return `${col} <> ${push(f.value)}`;
          case "gt":
            return `${col} > ${push(f.value)}`;
          case "in":
            return `${col} = ANY(${pushRaw(f.value)})`;
          case "is":
            return `${col} IS ${isTok(f.value)}`;
          case "not.is":
            return `${col} IS NOT ${isTok(f.value)}`;
          case "filter.cs":
            // jsonb contains (@>); value is a JSON string.
            return `${col} @> ${pushRaw(f.value)}::jsonb`;
          default:
            throw new Error(`Unsupported filter op: ${f.op}`);
        }
      });
      return ` WHERE ${parts.join(" AND ")}`;
    };

    const table = quoteIdent(this.table);

    switch (this.op) {
      case "select": {
        if (this.headMode) {
          return { text: `SELECT count(*)::int AS count FROM ${table}${where()}`, values };
        }
        const proj =
          this.countMode
            ? `${this.projection}, count(*) OVER()::int AS __count`
            : this.projection;
        let text = `SELECT ${proj} FROM ${table}${where()}`;
        text += orderBy(this.orders);
        if (this.limitCount != null) text += ` LIMIT ${Number(this.limitCount)}`;
        if (this.offsetCount != null) text += ` OFFSET ${Number(this.offsetCount)}`;
        return { text, values };
      }
      case "insert":
      case "upsert": {
        const cols = [...new Set(this.insertRows.flatMap((r) => Object.keys(r)))];
        const tuples = this.insertRows.map((row) => {
          const cells = cols.map((c) =>
            Object.prototype.hasOwnProperty.call(row, c)
              ? pushCol(c, row[c])
              : "DEFAULT",
          );
          return `(${cells.join(", ")})`;
        });
        let text =
          `INSERT INTO ${table} (${cols.map(quoteIdent).join(", ")}) VALUES ${tuples.join(", ")}`;
        if (this.op === "upsert") {
          const target = this.conflictTarget
            ? `(${this.conflictTarget.split(",").map((c) => quoteIdent(c.trim())).join(", ")})`
            : "";
          const updatable = cols.filter(
            (c) =>
              !this.conflictTarget ||
              !this.conflictTarget.split(",").map((x) => x.trim()).includes(c),
          );
          if (this.ignoreDuplicates || updatable.length === 0) {
            text += ` ON CONFLICT ${target} DO NOTHING`;
          } else {
            const set = updatable
              .map((c) => `${quoteIdent(c)} = EXCLUDED.${quoteIdent(c)}`)
              .join(", ");
            text += ` ON CONFLICT ${target} DO UPDATE SET ${set}`;
          }
        }
        if (this.returning) text += ` RETURNING ${this.projection}`;
        return { text, values };
      }
      case "update": {
        const set = Object.keys(this.updateValues)
          .map((c) => `${quoteIdent(c)} = ${pushCol(c, this.updateValues[c])}`)
          .join(", ");
        let text = `UPDATE ${table} SET ${set}${where()}`;
        if (this.returning) text += ` RETURNING ${this.projection}`;
        return { text, values };
      }
      case "delete": {
        let text = `DELETE FROM ${table}${where()}`;
        if (this.returning) text += ` RETURNING ${this.projection}`;
        return { text, values };
      }
    }
  }

  // --- execution (thenable) ------------------------------------------------

  private async run(): Promise<PostgrestResponse<any>> {
    let built: BuiltQuery;
    try {
      built = this.toSql();
    } catch (err) {
      return { data: null, error: mapError(err), count: null };
    }
    try {
      const res = await this.executor(built.text, built.values);
      return this.shape(res.rows);
    } catch (err) {
      return { data: null, error: mapError(err), count: null };
    }
  }

  private shape(rows: Record<string, unknown>[]): PostgrestResponse<any> {
    if (this.op === "select" && this.headMode) {
      const count = rows[0] ? Number((rows[0] as { count: number }).count) : 0;
      return { data: null, error: null, count };
    }

    let count: number | null = null;
    if (this.op === "select" && this.countMode) {
      count = rows[0] ? Number((rows[0] as { __count: number }).__count) : 0;
      rows = rows.map((r) => {
        const { __count, ...rest } = r as Record<string, unknown>;
        void __count;
        return rest;
      });
    }

    // Mutations without RETURNING yield no data (supabase returns null).
    const producesRows =
      this.op === "select" || this.returning;
    if (!producesRows) {
      return { data: null, error: null, count };
    }

    if (this.rowMode === "single") {
      if (rows.length !== 1) {
        return {
          data: null,
          count,
          error: {
            message: `JSON object requested, multiple (or no) rows returned (${rows.length})`,
            code: "PGRST116",
            details: null,
            hint: null,
          },
        };
      }
      return { data: rows[0] as any, error: null, count };
    }
    if (this.rowMode === "maybeSingle") {
      if (rows.length > 1) {
        return {
          data: null,
          count,
          error: {
            message: `JSON object requested, multiple rows returned (${rows.length})`,
            code: "PGRST116",
            details: null,
            hint: null,
          },
        };
      }
      return { data: (rows[0] ?? null) as any, error: null, count };
    }
    return { data: rows as any, error: null, count };
  }

  then<R1 = PostgrestResponse<Row[]>, R2 = never>(
    onfulfilled?: ((value: PostgrestResponse<Row[]>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

function isTok(value: unknown): string {
  if (value === null) return "NULL";
  return value ? "TRUE" : "FALSE";
}

function orderBy(orders: Order[]): string {
  if (orders.length === 0) return "";
  const parts = orders.map((o) => {
    let s = `${quoteIdent(o.col)} ${o.ascending ? "ASC" : "DESC"}`;
    if (o.nullsFirst != null) s += o.nullsFirst ? " NULLS FIRST" : " NULLS LAST";
    return s;
  });
  return ` ORDER BY ${parts.join(", ")}`;
}
