import initSqlJs from 'sql.js';

import type { SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';

export const migrationSqlByFilename = Object.entries(import.meta.glob('../../migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>)
  .map(([path, sql]) => [path.slice(path.lastIndexOf('/') + 1), sql] as const)
  .toSorted(([a], [b]) => a.localeCompare(b));

type SqlJsDatabase = {
  run(sql: string, params?: unknown[]): void;
  exec(sql: string, params?: unknown[]): Array<{ columns: string[]; values: unknown[][] }>;
};

export const createSqliteTestDb = async (): Promise<SqlDatabase> => {
  const SQL = await initSqlJs();
  const db = new SQL.Database() as SqlJsDatabase;
  for (const [, sql] of migrationSqlByFilename) db.run(sql);
  return new SqlJsSqlDatabase(db);
};

// Each backend rejects something another one accepts: `node:sqlite` throws on
// a boolean that D1 and sql.js coerce to 0/1, and D1 throws D1_TYPE_ERROR on a
// bigint that `node:sqlite` takes. A test backend looser than every deployment
// target lets such a bind ship green and fail only once deployed, so hold this
// one to the intersection `SqlBindValue` declares.
const assertBindable = (value: unknown, index: number): unknown => {
  if (
    value === null
    || typeof value === 'number'
    || typeof value === 'string'
    || value instanceof Uint8Array
  ) return value;
  throw new TypeError(
    `SQL parameter ${index + 1} is a ${typeof value}; bind only null, number, string, or Uint8Array (a flag binds as \`value ? 1 : 0\`).`,
  );
};

class SqlJsPreparedStatement implements SqlPreparedStatement {
  constructor(private readonly db: SqlJsDatabase, private readonly query: string, private readonly bound: readonly unknown[] = []) {}

  bind(...values: unknown[]): SqlPreparedStatement {
    return new SqlJsPreparedStatement(this.db, this.query, values.map(assertBindable));
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    const [result] = this.db.exec(this.query, this.bound as unknown[]);
    if (!result || result.values.length === 0) return Promise.resolve(null);
    const row = Object.fromEntries(result.columns.map((column, index) => [column, result.values[0][index]])) as T;
    return Promise.resolve(row);
  }

  all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    const [result] = this.db.exec(this.query, this.bound as unknown[]);
    if (!result) return Promise.resolve({ results: [], success: true, meta: {} });
    const results = result.values.map(values => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])) as T);
    return Promise.resolve({ results, success: true, meta: {} });
  }

  run(): Promise<SqlResult> {
    // sql.js's `run()` does not surface `changes`. Read it back via
    // `SELECT changes()` so the CAS path in saveState gets an accurate count.
    this.db.run(this.query, this.bound as unknown[]);
    const [changesResult] = this.db.exec('SELECT changes() AS changes');
    const changes = Number(changesResult.values[0][0]);
    return Promise.resolve({ results: [], success: true, meta: { changes } });
  }
}

class SqlJsSqlDatabase implements SqlDatabase {
  constructor(private readonly db: SqlJsDatabase) {}

  prepare(query: string): SqlPreparedStatement {
    return new SqlJsPreparedStatement(this.db, query);
  }

  exec(sql: string): Promise<unknown> {
    this.db.exec(sql);
    return Promise.resolve(undefined);
  }
}
