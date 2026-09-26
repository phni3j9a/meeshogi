/**
 * node:sqlite-backed test double for D1Database and the JobStore RawDb
 * interface. Statements run inside a real SQLite database so migrations,
 * unique constraints, conditional inserts, and batch (transaction) behavior
 * are exercised exactly as on D1.
 */
import { readFileSync } from 'node:fs';
import { DatabaseSync, type SqliteValue } from 'node:sqlite';
import type { RawDb, SqlParam, SqlStatement } from '../src/jobStore';

const MIGRATION = new URL('../migrations/0001_job_backend.sql', import.meta.url);

type Param = string | number | null;

export class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: Param[] = [],
  ) {}

  bind(...params: SqliteValue[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, params as Param[]);
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true }> {
    return { results: this.db.prepare(this.sql).all(...this.params as SqliteValue[]) as T[], success: true };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.db.prepare(this.sql).get(...this.params as SqliteValue[]) as T | undefined) ?? null;
  }

  async run(): Promise<{ success: true; meta: { changes: number } }> {
    const outcome = this.db.prepare(this.sql).run(...this.params as SqliteValue[]);
    return { success: true, meta: { changes: Number(outcome.changes) } };
  }

  async raw<T = unknown>(): Promise<T[]> {
    const rows = this.db.prepare(this.sql).all(...this.params as SqliteValue[]);
    return rows.map((row) => Object.values(row) as T);
  }
}

export class SqliteD1 {
  private batchCounter = 0;

  constructor(private readonly db: DatabaseSync) {}

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.db, sql);
  }

  // Savepoints let concurrent batches interleave their statements on the one
  // connection — the same interleaving a conditional INSERT must survive.
  async batch(statements: SqliteStatement[]): Promise<{ success: true; meta: { changes: number } }[]> {
    const name = `batch_${this.batchCounter++}`;
    this.db.exec(`SAVEPOINT "${name}"`);
    try {
      const results = [] as { success: true; meta: { changes: number } }[];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec(`RELEASE "${name}"`);
      return results;
    } catch (error) {
      this.db.exec(`ROLLBACK TO "${name}"`);
      this.db.exec(`RELEASE "${name}"`);
      throw error;
    }
  }

  get rawDb(): RawDb {
    const prepared = (sql: string, params: SqlParam[]): SqliteStatement =>
      new SqliteStatement(this.db, sql, params as Param[]);
    return {
      run: async (sql, params = []) => (await prepared(sql, params).run()).meta.changes,
      all: async <T,>(sql: string, params: SqlParam[] = []) =>
        (await prepared(sql, params).all<T>()).results,
      batch: async (statements: SqlStatement[]) => {
        const results = await this.batch(statements.map((s) => prepared(s.sql, s.params)));
        return results.map((result) => result.meta.changes);
      },
    };
  }
}

export function createTestDb(): { sqlite: DatabaseSync; d1: SqliteD1 } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  sqlite.exec(readFileSync(MIGRATION, 'utf8'));
  return { sqlite, d1: new SqliteD1(sqlite) };
}
