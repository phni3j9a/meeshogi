import type {
  CloudAttempt,
  CloudAttemptStatus,
  CloudJobView,
  CloudPendingEntry,
  CloudProfileId,
  CloudResultRow,
} from '../cloud/contract';
import {
  CLOUD_MAX_MOVES,
  CLOUD_PENDING_META_KEY,
  CLOUD_RESULTS_PAGE_LIMIT,
  CLOUD_SERVER_TERMINAL_STATUSES,
  attemptServerUnconfirmed,
  isActiveAttempt,
} from '../cloud/contract';
import { CloudApiError, type CloudClient, type CloudCredential } from '../cloud/client';
import type { CredentialStore } from '../cloud/credentials';
import { validateCloudResult } from '../cloud/results';
import type { GameRecord } from '../domain/model';
import type { LocalRepository } from '../storage/repository';

export interface CloudDeps {
  /** Current build-time endpoint. Attempts always use their recorded endpoint. */
  endpoint(): string | null;
  credentialsFor(endpoint: string): CredentialStore;
  clientFor(endpoint: string): CloudClient;
  createId(): string;
  sleep(ms: number): Promise<void>;
  nowIso(): string;
  pollIntervalMs: number;
  maxBackoffMs: number;
}

/** A server row or response that violates the persisted contract. */
export class CloudContractViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudContractViolationError';
  }
}

export interface CloudContext {
  getAttempts(): CloudAttempt[];
  getGame(id: string): GameRecord | undefined;
  getCloudMethodProfile(): CloudProfileId | null;
  getCloudPositions(gameId: string): string[] | undefined;
  repo(): LocalRepository;
  write<T>(operation: () => Promise<T>): Promise<T>;
  setAttempts(fn: (attempts: CloudAttempt[]) => CloudAttempt[]): void;
  onResultsCommitted(attemptId: string, rows: CloudResultRow[]): void;
  getPending(): CloudPendingEntry[];
  setPending(entries: CloudPendingEntry[]): void;
  /** A queued game that could not be sent for a non-network reason. */
  setPendingError(gameId: string, message: string | null): void;
}

/** No response reached the device: the request may be retried later. */
function isNetworkFailure(error: unknown): boolean {
  return error instanceof CloudApiError && error.status === 0;
}

const TERMINAL_STATUSES: CloudAttemptStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * Contract error codes → concise Japanese. Raw English server text must never
 * reach the UI (FP-018); the code itself stays in `failureCode` and is shown
 * only in development builds.
 */
function mapApiError(error: CloudApiError): string {
  if (error.status === 401) {
    return 'Cloudの認証情報が無効です。アプリを再インストールせず、時間をおいて再試行してください。';
  }
  const base = (() => {
    switch (error.code) {
      case 'profile_not_allowed':
        return '精密解析はこの端末では利用できません（サーバー側の許可が必要です）。';
      case 'daily_quota_exceeded':
        return '本日のCloud・無料の解析回数（1日10局）を使い切りました。明日以降に再度お試しください。';
      case 'rate_limited':
        return '短時間に多くの解析要求があったため制限されています。時間をおいて再度お試しください。';
      case 'active_job_limit':
        return '実行中のCloud解析があるため新しい解析を開始できません。終了または取消してから開始してください。';
      case 'idempotency_conflict':
      case 'idempotency_key_in_use':
        return '同じ解析要求が既に終了しています。新しい解析としてやり直してください。';
      case 'invalid':
        return '解析要求がサーバーに拒否されました。棋譜がCloud解析の条件に合わない可能性があります。';
      case 'not_found':
        return 'Cloudサーバー上に解析ジョブが見つかりません。';
      case 'network':
        return 'Cloudサーバーへ接続できませんでした。';
      case 'invalid_response':
        return 'Cloudサーバーの応答を解釈できませんでした。';
      default:
        return error.status >= 500
          ? 'Cloudサーバーで一時的なエラーが発生しました。時間をおいて再度お試しください。'
          : `Cloudサーバーがエラーを返しました（${error.status}）。`;
    }
  })();
  // The contract code aids diagnosis in development; production users only
  // see the Japanese text (the raw code remains queryable via failureCode).
  return typeof __DEV__ !== 'undefined' && __DEV__ ? `${base}（${error.code}）` : base;
}

/**
 * FP-017: POST /v1/jobs admission is atomic, so any 4xx carrying a parsed
 * contract failure body means no job was created. Exceptions: 401 stays a
 * credential rejection (local-forget exception), and a 4xx without the
 * contract body ('http_error'/'invalid_response') can't be confirmed as an
 * API admission decision — those keep the attempt server-unconfirmed.
 */
function isAdmissionRejection(error: CloudApiError): boolean {
  return (
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.code !== 'http_error' &&
    error.code !== 'invalid_response'
  );
}

/**
 * Drives Cloud attempts through submit → poll → drain → terminal. Pump loops
 * only while the app is foregrounded; attempts persist every durable fact so
 * backgrounding, process death, and network loss are all recovered by resume.
 */
export function makeCloudController(deps: CloudDeps, ctx: CloudContext) {
  const pumps = new Map<string, number>();
  const wakeUps = new Map<string, { token: object; resolve: () => void }>();
  let pumpSequence = 0;
  let foreground = true;
  // Serializes start() so a double-tap cannot create two attempts/jobs.
  let startQueue: Promise<void> = Promise.resolve();
  // Single in-flight credential issuance per endpoint.
  const credentialIssuance = new Map<string, Promise<CloudCredential>>();
  // Backoff for retrying the head of the pending queue after a network failure.
  let queueRetry: object | null = null;
  let queueDelay = deps.pollIntervalMs;

  const attemptById = (attemptId: string) =>
    ctx.getAttempts().find((attempt) => attempt.attemptId === attemptId);

  const replaceAttempt = (next: CloudAttempt) =>
    ctx.setAttempts((attempts) =>
      attempts.map((attempt) => (attempt.attemptId === next.attemptId ? next : attempt)),
    );

  const persist = async (attemptId: string, patch: Parameters<LocalRepository['cloud']['updateAttempt']>[1]) => {
    const updatedAt = deps.nowIso();
    await ctx.write(() => ctx.repo().cloud.updateAttempt(attemptId, { ...patch, updatedAt }));
    ctx.setAttempts((attempts) =>
      attempts.map((attempt) =>
        attempt.attemptId === attemptId ? ({ ...attempt, ...patch, updatedAt } as CloudAttempt) : attempt,
      ),
    );
  };

  const checkJobView = (attempt: CloudAttempt, view: CloudJobView) => {
    if (view.profileId !== attempt.profileId || view.totalPlies !== attempt.totalPlies) {
      throw new CloudContractViolationError(
        'Cloudジョブの方式または局面数が開始時と一致しません。',
      );
    }
  };

  const positionsFor = (attempt: CloudAttempt): string[] => {
    const positions = ctx.getCloudPositions(attempt.gameId);
    if (!positions || positions.length !== attempt.totalPlies) {
      throw new CloudContractViolationError('Cloud結果と棋譜の対応を確認できません。');
    }
    return positions;
  };

  /** Fetch result pages and commit each page with its cursor atomically. */
  const drainResults = async (
    attempt: CloudAttempt,
    client: CloudClient,
    credential: CloudCredential,
  ) => {
    const positions = positionsFor(attempt);
    for (;;) {
      const current = attemptById(attempt.attemptId);
      if (!current || current.receiveAfterPly >= attempt.totalPlies - 1) return;
      const page = await client.getResults(
        credential.credential,
        attempt.jobId as string,
        current.receiveAfterPly,
        CLOUD_RESULTS_PAGE_LIMIT,
      );
      if (page.jobId !== attempt.jobId || page.totalPlies !== attempt.totalPlies) {
        throw new CloudContractViolationError('Cloud結果ページがジョブと一致しません。');
      }
      const rows: CloudResultRow[] = [];
      let expectedPly = current.receiveAfterPly;
      let violation: CloudContractViolationError | null = null;
      for (const wire of page.results) {
        expectedPly += 1;
        if (wire.ply !== expectedPly || wire.ply >= attempt.totalPlies) {
          violation = new CloudContractViolationError('Cloud結果の手順が連続していません。');
          break;
        }
        const row = validateCloudResult(wire, positions[wire.ply], attempt.profileId);
        if (!row) {
          violation = new CloudContractViolationError('Cloud結果の検証に失敗しました。');
          break;
        }
        rows.push(row);
      }
      if (rows.length === 0 && !violation) return;
      const lastCommitted = rows.length ? rows[rows.length - 1].ply : null;
      const committed = await ctx.write(() =>
        ctx.repo().cloud.commitResults(
          attempt.attemptId,
          rows,
          {
            ...(lastCommitted !== null ? { receiveAfterPly: lastCommitted } : {}),
            serverNextPly: Math.max(current.serverNextPly, page.nextPly),
          },
        ),
      );
      replaceAttempt(committed);
      if (rows.length) ctx.onResultsCommitted(attempt.attemptId, rows);
      if (violation) throw violation;
      if (!page.hasMore) return;
    }
  };

  const adoptJobView = async (attempt: CloudAttempt, view: CloudJobView) => {
    const terminal = TERMINAL_STATUSES.includes(view.status as CloudAttemptStatus)
      ? (view.status as CloudAttemptStatus)
      : attempt.status === 'cancel-requested'
        ? attempt.status
        : (view.status as CloudAttemptStatus);
    await persist(attempt.attemptId, {
      status: terminal,
      serverStatus: view.status,
      serverCreatedAt: view.createdAt,
      serverFinishedAt: view.finishedAt ?? null,
      serverNextPly: view.nextPly,
      resultCounts: {
        success: view.resultCounts.success ?? 0,
        incomplete: view.resultCounts.incomplete ?? 0,
        terminal: view.resultCounts.terminal ?? 0,
      },
      failureCode: view.failure?.code ?? null,
      failureMessage: view.failure?.message ?? null,
      lastError: null,
      finishedAt:
        TERMINAL_STATUSES.includes(terminal) && !attempt.finishedAt
          ? (view.finishedAt ?? deps.nowIso())
          : attempt.finishedAt,
    });
  };

  /**
   * A validated GET view carries server-observed facts — status and the
   * server's own created/finished timestamps. Persist them immediately and
   * independently of the result drain: a later drain failure (e.g. a contract
   * violation on one row) must never drop a server clock we already learned.
   * The local lifecycle status stays untouched here so the pump keeps the
   * attempt resumable until every produced row is committed.
   */
  const confirmServerStatus = async (attempt: CloudAttempt, view: CloudJobView) => {
    await persist(attempt.attemptId, {
      serverStatus: view.status,
      serverCreatedAt: view.createdAt,
      serverFinishedAt: view.finishedAt ?? null,
    });
  };

  const submit = async (
    attempt: CloudAttempt,
    client: CloudClient,
    credential: CloudCredential,
  ) => {
    if (attempt.serverStatus === 'not_created') {
      // FP-019: a definitively rejected first POST must never be resubmitted —
      // not on restore, not via cancel re-entry. Rows from before the atomic
      // write can still carry requesting/cancel-requested + not_created;
      // settle them locally instead of POSTing.
      if (attempt.status !== 'error') {
        await persist(attempt.attemptId, {
          status: 'error',
          finishedAt: deps.nowIso(),
        }).catch(() => undefined);
      }
      return;
    }
    // FP-017/019 dispatch bookkeeping BEFORE the POST: submitAttempted is
    // durably true once any POST for this key was ever dispatched (even when
    // its response was lost), and the counter keeps diagnostics. The write
    // re-establishes the unconfirmed state before the request is in flight
    // (the not_created guard above means a stale marker never reaches this
    // persist).
    await persist(attempt.attemptId, {
      submitAttempted: true,
      submitCount: attempt.submitCount + 1,
    });
    // FP-020: "first POST" is judged from the pre-dispatch submitAttempted —
    // persisted before EVERY POST including rows that predate the submitCount
    // column — plus the absence of any job evidence. It never depends on the
    // migrated counter, so an interrupted migration cannot reclassify a
    // previously-submitted key as first.
    const firstPost =
      !attempt.submitAttempted &&
      attempt.jobId === null &&
      attempt.serverStatus === null;
    let view: CloudJobView;
    try {
      view = await client.createJob(credential.credential, {
        idempotencyKey: attempt.idempotencyKey,
        profileId: attempt.profileId,
        initialSfen: attempt.initialSfen,
        moves: attempt.moves,
      });
    } catch (error) {
      // FP-017: only a FIRST-POST definitive rejection proves no job exists —
      // a denied resend can coexist with a job created by an earlier POST
      // whose response was lost, or by the recorded jobId. Those stay
      // unconfirmed (association retained; deletion blocked).
      if (firstPost && error instanceof CloudApiError && isAdmissionRejection(error)) {
        const message = mapApiError(error);
        // FP-019: marker + terminal state in ONE write — a kill between two
        // commits can no longer leave requesting + not_created behind.
        await persist(attempt.attemptId, {
          status: 'error',
          serverStatus: 'not_created',
          failureCode: error.code,
          failureMessage: message,
          lastError: message,
          finishedAt: deps.nowIso(),
        }).catch(() => undefined);
        return;
      }
      throw error;
    }
    checkJobView(attempt, view);
    // The user may have cancelled while the POST was in flight; never let the
    // freshly learned jobId overwrite a cancel-requested state.
    const now = attemptById(attempt.attemptId);
    if (!now) return;
    const serverTerminal = CLOUD_SERVER_TERMINAL_STATUSES.includes(view.status);
    await persist(attempt.attemptId, {
      jobId: view.jobId,
      serverStatus: view.status,
      serverCreatedAt: view.createdAt,
      serverFinishedAt: view.finishedAt ?? null,
      status:
        now.status === 'cancel-requested'
          ? 'cancel-requested'
          : serverTerminal
            ? 'running' // server finished; results may still be undrained
            : view.status === 'queued'
              ? 'queued'
              : 'running',
      serverNextPly: view.nextPly,
      lastError: null,
    });
    const updated = attemptById(attempt.attemptId);
    if (updated?.jobId) {
      await drainResults(updated, client, credential);
      const after = attemptById(attempt.attemptId);
      if (after) await adoptJobView(after, view);
    }
  };

  const poll = async (attempt: CloudAttempt, client: CloudClient, credential: CloudCredential) => {
    if (!attempt.jobId) throw new CloudContractViolationError('CloudジョブIDがありません。');
    const view = await client.getJob(credential.credential, attempt.jobId);
    checkJobView(attempt, view);
    await confirmServerStatus(attempt, view);
    await drainResults(attempt, client, credential);
    const current = attemptById(attempt.attemptId);
    if (current) await adoptJobView(current, view);
  };

  const cancel = async (attempt: CloudAttempt, client: CloudClient, credential: CloudCredential) => {
    if (!attempt.jobId) {
      if (!attempt.submitAttempted) {
        // Nothing was ever dispatched: safe to settle locally.
        await persist(attempt.attemptId, { status: 'cancelled', finishedAt: deps.nowIso() });
        return;
      }
      // A POST may have reached the server: resend under the same idempotency
      // key to learn the jobId; the next iteration cancels it.
      await submit(attempt, client, credential);
      return;
    }
    const view = await client.cancelJob(credential.credential, attempt.jobId);
    checkJobView(attempt, view);
    // A confirmed cancel/terminal is durable even if draining then fails.
    await persist(attempt.attemptId, {
      serverStatus: view.status,
      serverCreatedAt: view.createdAt,
      serverFinishedAt: view.finishedAt ?? null,
    });
    await drainResults(attempt, client, credential);
    const current = attemptById(attempt.attemptId);
    if (current) await adoptJobView(current, view);
  };

  /**
   * One pump iteration. Returns 'ok' to keep polling at the base interval,
   * 'retry' to back off, and 'stop' when the attempt can no longer proceed.
   */
  const step = async (attempt: CloudAttempt): Promise<'ok' | 'retry' | 'stop'> => {
    // Attempts are bound to the endpoint recorded at submission so a later
    // config change never crosses credentials or results.
    const endpoint = attempt.endpoint;
    const client = deps.clientFor(endpoint);
    let credential: CloudCredential | null;
    try {
      credential = await deps.credentialsFor(endpoint).load();
    } catch {
      await persist(attempt.attemptId, {
        lastError: 'Cloudの認証情報を読み込めませんでした。',
      }).catch(() => undefined);
      return 'retry';
    }
    if (!credential || credential.ownerId !== attempt.ownerId) {
      // failureCode feeds delete-boundary eligibility (Plan §3 limited
      // exception): only a CONFIRMED absent key or a backend 401 makes the
      // local-forget escape possible. Owner mismatch and unreadable/corrupt
      // entries stay recoverable-blocking.
      let failureCode: string;
      let message: string;
      if (credential) {
        failureCode = 'credential_owner_mismatch';
        message = 'Cloudの認証情報が変わったため、実行中の解析へ再接続できません。';
      } else {
        const probe = await deps
          .credentialsFor(endpoint)
          .probe()
          .catch(() => null);
        failureCode = probe?.state === 'absent' ? 'credential_absent' : 'credential_unusable';
        message = 'Cloudの認証情報が見つからず、実行中の解析へ再接続できません。';
      }
      await persist(attempt.attemptId, {
        status: 'error',
        failureCode,
        failureMessage: message,
        lastError: message,
      }).catch(() => undefined);
      return 'stop';
    }
    try {
      if (attempt.status === 'requesting') {
        await submit(attempt, client, credential);
      } else if (attempt.status === 'cancel-requested' && !attempt.jobId) {
        // Cancelled before the POST response arrived: resend under the same
        // idempotency key to learn the jobId, then cancel it next iteration.
        await submit(attempt, client, credential);
      } else if (
        attempt.status === 'cancel-requested' &&
        attempt.serverStatus !== null &&
        CLOUD_SERVER_TERMINAL_STATUSES.includes(
          attempt.serverStatus as (typeof CLOUD_SERVER_TERMINAL_STATUSES)[number],
        )
      ) {
        // The server already finished/cancelled the job: skip the cancel POST
        // (it would 404/409 on a finished job) and just drain + settle.
        await poll(attempt, client, credential);
      } else if (attempt.status === 'cancel-requested') {
        await cancel(attempt, client, credential);
      } else {
        await poll(attempt, client, credential);
      }
      return 'ok';
    } catch (error) {
      if (error instanceof CloudApiError) {
        const transient =
          error.status === 0 || error.status === 408 || error.status >= 500;
        if (transient) {
          await persist(attempt.attemptId, { lastError: mapApiError(error) }).catch(
            () => undefined,
          );
          return 'retry';
        }
        const message = mapApiError(error);
        await persist(attempt.attemptId, {
          status: 'error',
          // A backend 401 means the submitted credential was rejected and this
          // device cannot reconnect to that job (the local-forget exception).
          failureCode: error.status === 401 ? 'credential_rejected' : error.code,
          failureMessage: message,
          lastError: message,
          finishedAt: deps.nowIso(),
        }).catch(() => undefined);
        return 'stop';
      }
      if (error instanceof CloudContractViolationError) {
        await persist(attempt.attemptId, {
          status: 'error',
          failureCode: 'contract_violation',
          failureMessage: error.message,
          lastError: error.message,
          finishedAt: deps.nowIso(),
        }).catch(() => undefined);
        return 'stop';
      }
      // Storage failures and unexpected errors: keep the attempt resumable.
      await persist(attempt.attemptId, {
        lastError: error instanceof Error ? error.message : 'Cloud解析の処理に失敗しました。',
      }).catch(() => undefined);
      return 'retry';
    }
  };

  const wake = (attemptId: string) => {
    const entry = wakeUps.get(attemptId);
    wakeUps.delete(attemptId);
    entry?.resolve();
  };

  const sleepWakeable = async (attemptId: string, ms: number): Promise<void> => {
    // Token-guarded: an old timer must not delete the registration of a newer
    // sleep for the same attempt (e.g. woken once, then sleeping again).
    const token = {};
    await new Promise<void>((resolve) => {
      wakeUps.set(attemptId, { token, resolve });
      void deps.sleep(ms).then(() => {
        const entry = wakeUps.get(attemptId);
        if (entry?.token === token) wakeUps.delete(attemptId);
        resolve();
      });
    });
  };

  /**
   * Active attempts need pumping; additionally a terminal-status attempt whose
   * result cursor lags what the server produced still needs draining. The
   * drain bound is the server's confirmed processed cursor (serverNextPly),
   * not totalPlies: a cancelled/failed job stops producing mid-game, so once
   * every produced row is committed the pump must stop instead of polling a
   * finished job forever.
   */
  const pumpEligible = (attempt: CloudAttempt): boolean => {
    if (isActiveAttempt(attempt.status)) return true;
    if (attempt.jobId === null || !TERMINAL_STATUSES.includes(attempt.status)) return false;
    const produced = Math.min(attempt.serverNextPly, attempt.totalPlies);
    return attempt.receiveAfterPly < produced - 1;
  };

  const ensurePump = (attemptId: string) => {
    if (pumps.has(attemptId)) return;
    const token = ++pumpSequence;
    pumps.set(attemptId, token);
    void (async () => {
      let delay = deps.pollIntervalMs;
      try {
        while (foreground && pumps.get(attemptId) === token) {
          const attempt = attemptById(attemptId);
          if (!attempt || !pumpEligible(attempt)) return;
          const outcome = await step(attempt);
          if (outcome === 'stop') return;
          delay = outcome === 'ok' ? deps.pollIntervalMs : Math.min(delay * 2, deps.maxBackoffMs);
          const still = attemptById(attemptId);
          if (!still || !pumpEligible(still)) return;
          await sleepWakeable(attemptId, delay);
        }
      } finally {
        pumps.delete(attemptId);
        wakeUps.delete(attemptId);
        // A finished attempt frees the owner's single active slot.
        kickQueue();
      }
    })().catch(() => undefined);
  };

  /**
   * Returns the latest reusable attempt for this game+profile — an active one
   * gets its pump ensured and yields null (caller returns); a terminal one
   * blocks a new start only until the caller re-checks.
   */
  const latestAttemptFor = (gameId: string, profileId: CloudProfileId) =>
    ctx
      .getAttempts()
      .filter((attempt) => attempt.gameId === gameId && attempt.profileId === profileId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  /**
   * An error attempt whose server-side job was never confirmed terminal:
   * a POST may have been in flight (submitAttempted) or a jobId was learned,
   * but no terminal serverStatus was ever observed. Such attempts must be
   * recovered under the same key — a fresh attempt would strand the job.
   */
  const unconfirmedError = attemptServerUnconfirmed;

  /** Checks shared by an immediate start and by adding a game to the queue. */
  const startable = (gameId: string): { endpoint: string; game: GameRecord } => {
    const endpoint = deps.endpoint();
    if (!endpoint) {
      throw new Error('Cloud解析の接続先が設定されていません。端末内（Sekirei）をお使いください。');
    }
    const game = ctx.getGame(gameId);
    if (!game) throw new Error('棋譜が見つかりません。');
    if (game.moves.length > CLOUD_MAX_MOVES) {
      throw new Error(
        `Cloud解析は${CLOUD_MAX_MOVES}手までの棋譜に対応しています。`,
      );
    }
    return { endpoint, game };
  };

  /** Read-modify-write inside the serialized writer, like game deletion. */
  const updatePending = (fn: (entries: CloudPendingEntry[]) => CloudPendingEntry[]) =>
    ctx.write(async () => {
      const current = ctx.getPending();
      const next = fn(current);
      if (next === current) return;
      await ctx.repo().cloud.metaSet(CLOUD_PENDING_META_KEY, JSON.stringify(next));
      ctx.setPending(next);
    });

  const removePending = (gameId: string) =>
    updatePending((entries) =>
      entries.some((entry) => entry.gameId === gameId)
        ? entries.filter((entry) => entry.gameId !== gameId)
        : entries,
    );

  const enqueue = async (game: GameRecord, profileId: CloudProfileId) => {
    ctx.setPendingError(game.id, null);
    await updatePending((entries) =>
      entries.some((entry) => entry.gameId === game.id)
        ? entries
        : [
            ...entries,
            { gameId: game.id, gameIdentity: game.identity, profileId, requestedAt: deps.nowIso() },
          ],
    );
  };

  const scheduleQueueRetry = () => {
    if (queueRetry) return;
    const token = {};
    queueRetry = token;
    queueDelay = Math.min(queueDelay * 2, deps.maxBackoffMs);
    void deps.sleep(queueDelay).then(() => {
      if (queueRetry !== token) return;
      queueRetry = null;
      kickQueue();
    });
  };

  /**
   * Sends the head of the pending queue once no attempt is active. Runs inside
   * the serialized start queue, only in the foreground; a network failure
   * keeps the entry and retries with backoff, any other failure drops it and
   * reports the reason on that game.
   */
  const processQueue = async (): Promise<void> => {
    while (foreground) {
      const head = ctx.getPending()[0];
      if (!head) return;
      if (ctx.getAttempts().some((attempt) => isActiveAttempt(attempt.status))) return;
      const game = ctx.getGame(head.gameId);
      if (!game || game.identity !== head.gameIdentity) {
        await removePending(head.gameId);
        continue;
      }
      try {
        await doStart(head.gameId, head.profileId);
      } catch (error) {
        if (isNetworkFailure(error)) {
          scheduleQueueRetry();
          return;
        }
        await removePending(head.gameId);
        ctx.setPendingError(
          head.gameId,
          error instanceof CloudApiError
            ? mapApiError(error)
            : error instanceof Error
              ? error.message
              : 'Cloud解析を開始できませんでした。',
        );
        continue;
      }
      queueDelay = deps.pollIntervalMs;
      await removePending(head.gameId);
      return;
    }
  };

  function kickQueue() {
    if (!foreground || ctx.getPending().length === 0) return;
    startQueue = startQueue.then(processQueue).catch(() => undefined);
  }

  /**
   * User or auto-import request: start now when the owner has no active job
   * and nothing is already waiting; otherwise, or when the device cannot reach
   * the server, keep the game in the pending queue.
   */
  const startOrQueue = async (gameId: string): Promise<'started' | 'queued'> => {
    const profileId = ctx.getCloudMethodProfile();
    if (!profileId) throw new Error('解析方法がCloudではありません。');
    const { game } = startable(gameId);
    const existing = latestAttemptFor(gameId, profileId);
    if (existing && isActiveAttempt(existing.status)) {
      ensurePump(existing.attemptId);
      return 'started';
    }
    if (ctx.getPending().some((entry) => entry.gameId === gameId)) return 'queued';
    if (
      ctx.getPending().length > 0 ||
      ctx.getAttempts().some((attempt) => isActiveAttempt(attempt.status))
    ) {
      await enqueue(game, profileId);
      return 'queued';
    }
    try {
      await doStart(gameId, profileId);
      return 'started';
    } catch (error) {
      if (!isNetworkFailure(error)) throw error;
      await enqueue(game, profileId);
      scheduleQueueRetry();
      return 'queued';
    }
  };

  const doStart = async (gameId: string, profileId: CloudProfileId): Promise<void> => {
    // Runs inside the serialized start queue: re-check the latest state at
    // each stage so a queued second tap collapses into the first attempt.
    const { endpoint, game } = startable(gameId);
    const reusableActive = () => {
      const existing = latestAttemptFor(gameId, profileId);
      if (existing && isActiveAttempt(existing.status)) {
        ensurePump(existing.attemptId);
        return true;
      }
      return false;
    };
    const checkNoOtherActive = () => {
      if (ctx.getAttempts().some((attempt) => isActiveAttempt(attempt.status))) {
        throw new Error('別のCloud解析を実行中です。終了または取消のあとで開始してください。');
      }
    };
    if (reusableActive()) return;
    checkNoOtherActive();
    const previous = latestAttemptFor(gameId, profileId);
    if (previous && unconfirmedError(previous)) {
      // FP-014 / Plan §3: the server may still hold this job, so the only
      // permitted path is same-key recovery — never a new attempt, a new
      // idempotency key, or a replacement credential under another owner.
      if (previous.gameIdentity !== game.identity) {
        throw new Error(
          'Cloud解析要求と棋譜の対応を確認できないため、復帰できません。',
        );
      }
      let stored: CloudCredential | null;
      try {
        stored =
          previous.failureCode === 'credential_rejected'
            ? null // backend already rejected this credential: do not reuse
            : await deps.credentialsFor(previous.endpoint).load();
      } catch {
        throw new Error('Cloudの認証情報を読み込めませんでした。時間をおいて再試行してください。');
      }
      if (!stored || stored.endpoint !== previous.endpoint || stored.ownerId !== previous.ownerId) {
        throw new Error(
          'このCloud解析の認証情報が失われたため復帰できません。サーバー上のジョブは継続している可能性があり、この端末から再接続・取消できません。',
        );
      }
      // Re-activate the same attempt: the pump re-POSTs under the same
      // idempotency key + same input, and the server replays the original job.
      const now = attemptById(previous.attemptId);
      if (now && unconfirmedError(now)) {
        await persist(previous.attemptId, {
          status: 'requesting',
          failureCode: null,
          failureMessage: null,
          lastError: null,
          finishedAt: null,
        });
        ensurePump(previous.attemptId);
      }
      return;
    }
    const credential = await ensureCredential(endpoint);
    // The await above may have queued behind another start: re-verify before
    // creating the attempt so we never produce a duplicate.
    if (ctx.getGame(gameId)?.identity !== game.identity) {
      throw new Error('棋譜が見つかりません。');
    }
    if (reusableActive()) return;
    checkNoOtherActive();
    const now = deps.nowIso();
    const attempt: CloudAttempt = {
      attemptId: deps.createId(),
      gameId,
      gameIdentity: game.identity,
      profileId,
      endpoint,
      installId: credential.installId,
      ownerId: credential.ownerId,
      idempotencyKey: `mk.${deps.createId()}`,
      initialSfen: game.positions[0],
      moves: game.moves.map((move) => move.usi),
      totalPlies: game.positions.length,
      jobId: null,
      status: 'requesting',
      receiveAfterPly: -1,
      serverNextPly: 0,
      resultCounts: null,
      receivedCount: 0,
      validCount: 0,
      failureCode: null,
      failureMessage: null,
      lastError: null,
      submitAttempted: false,
      submitCount: 0,
      serverStatus: null,
      serverCreatedAt: null,
      serverFinishedAt: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    // The idempotency record must exist before any POST can be in flight.
    await ctx.write(() => ctx.repo().cloud.createAttempt(attempt));
    ctx.setAttempts((attempts) => [...attempts, attempt]);
    ensurePump(attempt.attemptId);
  };

  return {
    /**
     * Start (or reconnect to) a Cloud analysis for a game using the selected
     * method, or add it to the pending queue when it cannot be sent now.
     */
    start(gameId: string): Promise<'started' | 'queued'> {
      const run = startQueue.then(() => startOrQueue(gameId));
      startQueue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },

    /** Remove a game from the pending queue at the user's request. */
    removePending(gameId: string): Promise<void> {
      const run = startQueue.then(() => removePending(gameId));
      startQueue = run.catch(() => undefined);
      ctx.setPendingError(gameId, null);
      return run;
    },

    /** Explicit user cancellation — the only path that POSTs /cancel. */
    async cancel(attemptId: string): Promise<void> {
      const attempt = attemptById(attemptId);
      if (!attempt) return;
      if (isActiveAttempt(attempt.status)) {
        await persist(attemptId, { status: 'cancel-requested' });
        wake(attemptId);
        ensurePump(attemptId);
        return;
      }
      if (attemptServerUnconfirmed(attempt)) {
        // A job that may still be live server-side (e.g. drained results were
        // rejected, or a POST whose response was lost) gets an explicit cancel
        // attempt: without a jobId the pump re-sends under the same idempotency
        // key to learn it, then cancels. A 'not_created' attempt is settled —
        // there is nothing server-side to cancel.
        await persist(attemptId, { status: 'cancel-requested', lastError: null });
        wake(attemptId);
        ensurePump(attemptId);
      }
    },

    /** Restart pumps for every locally-live attempt after load or foregrounding. */
    resume() {
      foreground = true;
      for (const attempt of ctx.getAttempts()) {
        if (pumpEligible(attempt)) ensurePump(attempt.attemptId);
      }
      // Returning to the foreground retries the queue at once.
      queueRetry = null;
      queueDelay = deps.pollIntervalMs;
      kickQueue();
    },

    /** Stop local polling; server jobs keep running and resume on foreground. */
    pause() {
      foreground = false;
    },
  };

  async function ensureCredential(endpoint: string): Promise<CloudCredential> {
    // Single in-flight issuance per endpoint: concurrent starts share one
    // credential request instead of racing to overwrite SecureStore.
    const pending = credentialIssuance.get(endpoint);
    if (pending) return pending;
    const promise = doEnsureCredential(endpoint).finally(() => {
      if (credentialIssuance.get(endpoint) === promise) credentialIssuance.delete(endpoint);
    });
    credentialIssuance.set(endpoint, promise);
    return promise;
  }

  async function doEnsureCredential(endpoint: string): Promise<CloudCredential> {
    const store = deps.credentialsFor(endpoint);
    const installId = await ctx.write(() => ctx.repo().cloud.installId(deps.createId));
    const existing = await store.load();
    if (existing && existing.endpoint === endpoint && existing.ownerId) {
      if (existing.installId !== installId) {
        // A reinstall reuses the anonymous credential but records the new
        // install so attempts stay attributable to the current data set.
        const rebound = { ...existing, installId };
        await store.save(rebound);
        return rebound;
      }
      return existing;
    }
    // FP-014 / Plan §3: the stored credential is absent or unusable. Issuing a
    // replacement creates a NEW owner, which can never reconnect to jobs that
    // unconfirmed attempts already submitted under the old owner — so while
    // any such attempt exists on this endpoint, issuance is refused entirely.
    const stranded = ctx
      .getAttempts()
      .some(
        (attempt) =>
          attempt.endpoint === endpoint &&
          !!attempt.ownerId &&
          (attempt.submitAttempted || attempt.jobId !== null) &&
          attempt.serverStatus !== 'not_created' &&
          !(
            attempt.serverStatus !== null &&
            CLOUD_SERVER_TERMINAL_STATUSES.includes(attempt.serverStatus)
          ),
      );
    if (stranded) {
      throw new Error(
        'Cloudの認証情報が失われているため、新しいCloud解析を開始できません。既存の解析要求がサーバー上に残っている可能性があります。',
      );
    }
    const issued = await deps.clientFor(endpoint).createCredential();
    const credential: CloudCredential = {
      credential: issued.credential,
      ownerId: issued.ownerId,
      installId,
      endpoint,
      issuedAt: issued.createdAt,
    };
    // Credentials must be durable before any job POST can reference them.
    await store.save(credential);
    return credential;
  }
}
