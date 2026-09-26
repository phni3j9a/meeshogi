declare module 'node:sqlite' {
  export type SqliteValue = null | number | bigint | string | Uint8Array;
  export class StatementSync {
    all(...params: SqliteValue[]): Record<string, SqliteValue>[];
    get(...params: SqliteValue[]): Record<string, SqliteValue> | undefined;
    run(...params: SqliteValue[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module 'node:fs' {
  export function readFileSync(path: string | URL, encoding: 'utf8'): string;
}
