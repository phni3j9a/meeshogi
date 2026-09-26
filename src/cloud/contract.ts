/**
 * App-side mirror of the Issue #21 `/v1` job API contract (cloud/src/contract.ts,
 * cloud/config/job-profiles.json). The values here are the approved profile
 * conditions and the pinned engine/model identity; a test asserts they stay in
 * sync with the cloud package sources. Do not adjust them to app convenience.
 */

export type CloudProfileId = 'free' | 'precision';

export interface CloudSearchConditions {
  threads: number;
  hashMb: number;
  moveTimeMs: number;
  multiPV: number;
}

export const CLOUD_PROFILES: Record<CloudProfileId, CloudSearchConditions> = {
  free: { threads: 1, hashMb: 64, moveTimeMs: 1000, multiPV: 2 },
  precision: { threads: 2, hashMb: 64, moveTimeMs: 5000, multiPV: 3 },
};

export const CLOUD_PROFILE_LABELS: Record<CloudProfileId, string> = {
  free: 'Cloud・無料',
  precision: 'Cloud・精密',
};

/** Compact list-row label for one attempt. */
export function cloudAttemptLabel(attempt: {
  status: CloudAttemptStatus;
  serverNextPly: number;
  totalPlies: number;
  validCount: number;
}): string {
  switch (attempt.status) {
    case 'requesting':
      return '開始中';
    case 'queued':
      return '待機中';
    case 'running':
      return `解析中 ${attempt.serverNextPly}/${attempt.totalPlies}`;
    case 'cancel-requested':
      return '取消中';
    case 'completed':
      return attempt.validCount >= attempt.totalPlies
        ? '解析済み'
        : `処理終了・有効 ${attempt.validCount}/${attempt.totalPlies}`;
    case 'failed':
      return '解析失敗';
    case 'cancelled':
      return '取消済み';
    case 'error':
      return '再開できます';
  }
}

/** Every digest and version emitted by the staging job backend. */
export const CLOUD_EXPECTED_IDENTITY = {
  engineName: 'YaneuraOu NNUE 9.70git 64AVX2',
  engineSha256: '0cb27c8302f6eb357cd360372defe172401519c06fb4bf28eb2bf72ee0f39d80',
  modelId: 'Suisho11 Plus SFNN_halfka2_1024_7_64_k3k3',
  weightSha256: 'a78b7f889843037d344f482623b3febd124ead5c1f34f134d9f1c2c78cd0f829',
  optionsSha256: '9c242cd8820c158292af4a6d58890e37ae060000a9a6344d7a549abf7f44f0b3',
  sourceArchiveSha256: '3bd58802922c245e44fdc8fea57019f86b14960a52b7581e39d8b815ee5a4b80',
  sourceTreeSha256: '3b57f1ce5ff6587e9bab35ae6ee397d31f527da469ad0cf85d7de839790af0f6',
  sourceArchive: 'yaneuraou-V970-dev-mac-all.7z',
  buildInfo:
    'YaneuraOu V970-dev source archive; make normal YANEURAOU_ENGINE_SFNN_halfka2_1024_7_64_k3k3 TARGET_CPU=AVX2 COMPILER=g++',
  driverVersion: 'usi-driver-v1',
  contractVersion: 'analysis-json-v1',
} as const;

export const CLOUD_MAX_MOVES = 512;
export const CLOUD_RESULTS_PAGE_LIMIT = 200;

export type CloudJobServerStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Local lifecycle of one analysis attempt. `requesting` means the idempotency
 * record is persisted but no job view has been confirmed; `cancel-requested`
 * keeps polling until the server confirms cancellation or a terminal state.
 * `error` is a local terminal state for failures that cannot produce or
 * reconnect a job (auth loss, quota, invalid input, corrupt results).
 */
export type CloudAttemptStatus =
  | 'requesting'
  | 'queued'
  | 'running'
  | 'cancel-requested'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'error';

export const CLOUD_ACTIVE_STATUSES: readonly CloudAttemptStatus[] = [
  'requesting',
  'queued',
  'running',
  'cancel-requested',
];

export function isActiveAttempt(status: CloudAttemptStatus): boolean {
  return CLOUD_ACTIVE_STATUSES.includes(status);
}

/** Deletion is blocked while a server job may still be live or unconfirmed. */
export function attemptBlocksDelete(attempt: Pick<CloudAttempt, 'status' | 'jobId'>): boolean {
  return (
    CLOUD_ACTIVE_STATUSES.includes(attempt.status) || (attempt.status === 'error' && !!attempt.jobId)
  );
}

export interface CloudResultCounts {
  success: number;
  incomplete: number;
  terminal: number;
}

export interface CloudAttempt {
  attemptId: string;
  gameId: string;
  /** GameRecord.identity at submission: binds the attempt to immutable game content. */
  gameIdentity: string;
  profileId: CloudProfileId;
  endpoint: string;
  installId: string;
  ownerId: string;
  idempotencyKey: string;
  initialSfen: string;
  moves: string[];
  /** positions.length = moves.length + 1, as accepted by the server. */
  totalPlies: number;
  jobId: string | null;
  status: CloudAttemptStatus;
  /** Client receive cursor: last committed result ply (-1 = none). */
  receiveAfterPly: number;
  /** Last observed server processing cursor (count of committed positions). */
  serverNextPly: number;
  /** Server-reported per-status result counts when available. */
  resultCounts: CloudResultCounts | null;
  receivedCount: number;
  /** Rows whose content is displayable (success or terminal). */
  validCount: number;
  failureCode: string | null;
  failureMessage: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface CloudJobView {
  jobId: string;
  status: CloudJobServerStatus;
  profileId: string;
  totalPlies: number;
  nextPly: number;
  resultCounts: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  failure?: { code: string; message: string };
  idempotentReplay?: boolean;
}

/** A row as it arrives from GET /v1/jobs/:id/results — not yet validated. */
export interface CloudWireRow {
  ply: number;
  sfen: string;
  engineLaunch: number | null;
  result: unknown;
}

/** A row accepted by validateCloudResult, as persisted in cloud_results. */
export interface CloudResultRow {
  ply: number;
  sfen: string;
  status: 'success' | 'incomplete' | 'terminal';
  engineLaunch: number | null;
  /** The validated v1 AnalysisResult JSON. Never contains credentials. */
  result: unknown;
}

export interface CloudResultsPage {
  jobId: string;
  status: CloudJobServerStatus;
  totalPlies: number;
  nextPly: number;
  results: CloudWireRow[];
  nextAfterPly: number;
  hasMore: boolean;
}
