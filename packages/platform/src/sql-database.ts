// Minimal SQL database contract used by the gateway's repo layer. Cloudflare's
// D1 satisfies the shape directly. `meta.changes` is the only metadata field
// the contract requires; runtime-specific fields (D1's duration, rows_read,
// rows_written) intentionally stay out of the platform surface.
export interface SqlResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: SqlResultMeta;
}

export interface SqlResultMeta {
  changes?: number;
}

// The values `node:sqlite` accepts as a bound parameter. It is the strictest
// of the backends the repo layer runs on — it throws ERR_INVALID_ARG_TYPE on
// anything else, where D1 and the sql.js test backend both coerce a JS boolean
// to 0/1 — so typing the contract at its rule is what keeps a bind that works
// on Workers from failing on every request of a self-hosted deploy. Callers
// storing a flag pass `value ? 1 : 0` explicitly.
export type SqlBindValue = null | number | bigint | string | Uint8Array;

export interface SqlPreparedStatement {
  bind(...values: SqlBindValue[]): SqlPreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run(): Promise<SqlResult>;
}

export interface SqlDatabase {
  prepare(query: string): SqlPreparedStatement;
  batch?(statements: SqlPreparedStatement[]): Promise<SqlResult[]>;
  // Execute a SQL string that may contain multiple statements. Used by
  // migration runners that need to apply hand-authored DDL files where a
  // single statement contains a `;` (e.g. CREATE TRIGGER ... BEGIN ... END;)
  // and a per-statement bind/run loop would mangle the body. Returns
  // a runtime-defined value the contract does not promise to expose.
  exec(sql: string): Promise<unknown>;
}
