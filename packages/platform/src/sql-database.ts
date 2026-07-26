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

// The values every backend the repo layer runs on accepts as a bound
// parameter — the intersection, not the union, because each backend rejects
// something another one takes:
//   * `node:sqlite` (Node target) throws ERR_INVALID_ARG_TYPE on a boolean,
//     which D1 and the sql.js test backend both coerce to 0/1;
//   * D1 (Workers target) throws D1_TYPE_ERROR on a bigint, which
//     `node:sqlite` accepts;
//   * `node:sqlite` also rejects the ArrayBuffer that D1 takes — pass binary
//     as a Uint8Array, which both accept.
// Typing the contract at the intersection is what keeps a bind that works on
// one deployment target from failing on another. Callers storing a flag pass
// `value ? 1 : 0` explicitly.
export type SqlBindValue = null | number | string | Uint8Array;

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
