/* Minimal Cloudflare Worker API declarations for this package's TypeScript check.
 * Runtime behavior is exercised by @cloudflare/vitest-pool-workers in workerd.
 */
type SqlValue = string | number | null | ArrayBuffer | Uint8Array;

interface D1Meta {
  changes: number;
  last_row_id: number;
}

interface D1Result<T = unknown> {
  success: boolean;
  results: T[];
  meta: D1Meta;
}

interface D1PreparedStatement {
  bind(...values: SqlValue[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

interface Fetcher {
  fetch(request: Request | string | URL, init?: RequestInit): Promise<Response>;
}

interface QueueSendRequest<T> {
  body: T;
  contentType?: 'json' | 'text' | 'bytes' | 'v8';
  delaySeconds?: number;
}

interface Queue<T = unknown> {
  send(message: T, options?: { contentType?: QueueSendRequest<T>['contentType']; delaySeconds?: number }): Promise<void>;
  sendBatch(messages: QueueSendRequest<T>[]): Promise<void>;
}

interface DurableObjectId {
  toString(): string;
}

type DurableObjectStub<T = unknown> = T & Fetcher & { id: DurableObjectId };

interface DurableObjectNamespace<T = unknown> {
  get(id: DurableObjectId): DurableObjectStub<T>;
  getByName(name: string): DurableObjectStub<T>;
  idFromName(name: string): DurableObjectId;
}

interface SqlStorageCursor<T> extends Iterable<T> {
  toArray(): T[];
}

interface SqlStorage {
  exec<T = Record<string, unknown>>(query: string, ...values: SqlValue[]): SqlStorageCursor<T>;
}

interface DurableObjectStorage {
  sql: SqlStorage;
}

interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

interface ScheduledController {
  cron: string;
  scheduledTime: number;
  noRetry(): void;
}

interface Message<T = unknown> {
  body: T;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

interface MessageBatch<T = unknown> {
  queue: string;
  messages: Message<T>[];
}

declare module 'cloudflare:workers' {
  export class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

declare module 'cloudflare:test' {
  export const env: Cloudflare.Env;
  export const SELF: Fetcher;
  export interface D1Migration { name: string; queries: string[] }
  export function applyD1Migrations(db: D1Database, migrations: D1Migration[], migrationsTableName?: string): Promise<void>;
  export function reset(): Promise<void>;
  export function createMessageBatch<T>(queueName: string, messages: Array<{ body: T }>): MessageBatch<T>;
  export function getQueueResult(batch: MessageBatch, ctx: unknown): Promise<unknown>;
}

declare module '*?raw' {
  const contents: string;
  export default contents;
}

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    JOB_QUEUE: Queue<import('./job-types').JobChunk>;
    JOB_COORDINATOR: DurableObjectNamespace<import('./job-coordinator').JobCoordinator>;
    ANALYSIS_CONTAINER: DurableObjectNamespace<import('./index').AnalysisContainer>;
    ANALYSIS_CONTAINER_PRECISION: DurableObjectNamespace<import('./index').AnalysisContainerPrecision>;
    ANALYSIS_ENGINE?: Fetcher;
    ANALYSIS_ENGINE_PRECISION?: Fetcher;
    ANALYSIS_ADMIN_TOKEN?: string;
    STAGING_ADMIN_TOKEN?: string;
    ANALYSIS_ENGINE_ID: string;
    ANALYSIS_MODEL_ID: string;
    ANALYSIS_ENGINE_BINARY_DIGEST_LABEL: string;
    TEST_MIGRATIONS?: string[];
  }
}
