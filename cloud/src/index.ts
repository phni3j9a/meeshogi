import { Container, getContainer } from '@cloudflare/containers';
import {
  EXPECTED_IDENTITY,
  BENCHMARK_CONDITION_BY_ID,
  BENCHMARK_CONTRACT_VERSION,
  SEARCH_CONDITIONS,
  SINGLETON_TARGET_ID,
  failure,
  isValidSfen,
  legalMoves,
  hasBenchmarkRuntime,
  benchmarkRuntimeMismatch,
  type BenchmarkValidationDiagnostic,
  validateDriverResult,
  validateBenchmarkDriverResult,
} from './contract';
import { Position } from 'tsshogi';
import { json, readBody } from './httpUtil';
import { handleV1Request } from './jobs';
import { handleJobBatch } from './jobConsumer';

export interface Env {
  ANALYSIS_INTERNAL_TOKEN?: string;
  ANALYSIS_VERIFY_STOP_ENGINE_ONCE?: string;
  ANALYSIS_BENCHMARK_ENABLED?: string;
  ANALYSIS_EXPECTED_INSTANCE_TYPE?: 'standard-2' | 'standard-3';
  ANALYSIS_BENCHMARK_BUILD_ID?: string;
  ANALYSIS_BENCHMARK_TARGETS?: string;
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  ANALYSIS_CONTAINER: DurableObjectNamespace<AnalysisContainer>;
  ANALYSIS_BENCHMARK_STANDARD_2: DurableObjectNamespace<BenchmarkStandard2Container>;
  ANALYSIS_BENCHMARK_STANDARD_3: DurableObjectNamespace<BenchmarkStandard3Container>;
  JOBS_DB?: D1Database;
  JOBS_QUEUE?: Queue<JobQueueMessage>;
}

export interface JobQueueMessage {
  v: 1;
  jobId: string;
}

function workerVersionFields(env: Env): Record<string, string> {
  const metadata = env.CF_VERSION_METADATA;
  if (!metadata || typeof metadata.id !== 'string' || !metadata.id) return {};
  return {
    workerVersionId: metadata.id,
    ...(typeof metadata.tag === 'string' && metadata.tag ? { workerVersionTag: metadata.tag } : {}),
    ...(typeof metadata.timestamp === 'string' && metadata.timestamp ? { workerVersionTimestamp: metadata.timestamp } : {}),
  };
}

const ANALYSIS_PATH = '/internal/analyze';
const HEALTH_PATH = '/internal/health';
const BENCHMARK_PATH = '/internal/benchmark';
const BENCHMARK_HEALTH_PATH = '/internal/benchmark/health';
const BENCHMARK_STOP_PATH = '/internal/benchmark/stop';
const TARGET_ID_RE = /^bench-(standard-2|standard-3)-[0-9a-f]{32}-[a-z0-9][a-z0-9-]{0,63}(?:-cold-trial-[1-9][0-9]*)?$/u;
const NORMAL_CONTAINER_TARGET = {
  containerApp: 'meeshogi-analysis-mvp-staging-analysis',
  containerClass: 'AnalysisContainer',
  containerBinding: 'ANALYSIS_CONTAINER',
} as const;
const BENCHMARK_CONTAINER_TARGETS = {
  'standard-2': {
    containerApp: 'meeshogi-analysis-mvp-staging-benchmark-standard-2',
    containerClass: 'BenchmarkStandard2Container',
    containerBinding: 'ANALYSIS_BENCHMARK_STANDARD_2',
  },
  'standard-3': {
    containerApp: 'meeshogi-analysis-mvp-staging-benchmark-standard-3',
    containerClass: 'BenchmarkStandard3Container',
    containerBinding: 'ANALYSIS_BENCHMARK_STANDARD_3',
  },
} as const;
const STOP_CONFIRM_TIMEOUT_MS = 5_000;
const STOP_CONFIRM_INTERVAL_MS = 100;
const IDENTITY_DIGEST_KEYS = [
  'engineSha256',
  'weightSha256',
  'optionsSha256',
  'sourceArchiveSha256',
  'sourceTreeSha256',
] as const;

export class AnalysisContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '5m';

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      ...(env.ANALYSIS_VERIFY_STOP_ENGINE_ONCE === '1' ? { ANALYSIS_VERIFY_STOP_ENGINE_ONCE: '1' } : {}),
      ANALYSIS_EXPECTED_INSTANCE_TYPE: 'standard-2',
    };
  }
}

export class BenchmarkStandard2Container extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '5m';

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      ...(env.ANALYSIS_BENCHMARK_ENABLED === '1' ? { ANALYSIS_BENCHMARK_ENABLED: '1' } : {}),
      ANALYSIS_EXPECTED_INSTANCE_TYPE: 'standard-2',
    };
  }
}

export class BenchmarkStandard3Container extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = '5m';

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      ...(env.ANALYSIS_BENCHMARK_ENABLED === '1' ? { ANALYSIS_BENCHMARK_ENABLED: '1' } : {}),
      ANALYSIS_EXPECTED_INSTANCE_TYPE: 'standard-3',
    };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  const count = Math.max(a.length, b.length);
  for (let index = 0; index < count; index++) {
    difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function unauthorized(status: number, code: 'auth_unconfigured' | 'unauthorized'): Response {
  const message = code === 'auth_unconfigured' ? 'Internal analysis is not configured.' : 'Unauthorized.';
  return json(failure(code, message), status);
}

function authorize(request: Request, env: Env): Response | null {
  const expectedToken = env.ANALYSIS_INTERNAL_TOKEN;
  if (!expectedToken) return unauthorized(503, 'auth_unconfigured');
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ') || !constantTimeEqual(authorization.slice(7), expectedToken)) {
    return unauthorized(401, 'unauthorized');
  }
  return null;
}

function isDriverHealth(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const health = value as Record<string, unknown>;
  const digests = health.identityDigests;
  if (typeof digests !== 'object' || digests === null || Array.isArray(digests)) return false;
  const digestRecord = digests as Record<string, unknown>;
  return health.schemaVersion === 1
    && health.status === 'ready'
    && typeof health.driverBootId === 'string'
    && /^[0-9a-f]{32}$/u.test(health.driverBootId)
    && typeof health.verifyStopEngineOnceEnabled === 'boolean'
    && typeof health.verifyStopEngineOnceConsumed === 'boolean'
    && typeof health.driverVersion === 'string'
    && health.driverVersion.length > 0
    && typeof health.contractVersion === 'string'
    && health.contractVersion.length > 0
    && ['standard-2', 'standard-3'].includes(String(health.expectedInstanceType))
    && hasBenchmarkRuntime(health.runtime, String(health.expectedInstanceType), health.driverBootId)
    && IDENTITY_DIGEST_KEYS.every((key) => typeof digestRecord[key] === 'string' && /^[0-9a-f]{64}$/u.test(digestRecord[key] as string));
}

function benchmarkInstanceFailure(
  sfen: string,
  conditionId: string,
  expectedInstanceType: string | null,
  driverBootId: string,
  engineEpoch: number,
  buildId: string | undefined,
  gitCommit: string | undefined,
  runtime: Record<string, unknown>,
  identityDigests: Record<string, unknown>,
  runtimeMismatch: string,
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    contractVersion: BENCHMARK_CONTRACT_VERSION,
    sfen,
    perspective: 'sente',
    status: 'failure',
    failure: { code: 'instance_mismatch', message: 'Container runtime evidence does not match the benchmark condition.' },
    conditionId,
    expectedInstanceType,
    driverBootId,
    engineEpoch,
    ...(buildId ? { buildId } : {}),
    ...(gitCommit ? { gitCommit } : {}),
    runtime,
    identityDigests,
    runtimeMismatch,
  };
}

function benchmarkValidationDetail(
  diagnostic: BenchmarkValidationDiagnostic,
  driverResult: unknown,
  containerHttpStatus: number,
): string {
  const result = typeof driverResult === 'object' && driverResult !== null && !Array.isArray(driverResult)
    ? driverResult as Record<string, unknown>
    : {};
  const safeLabel = (value: unknown): string | null =>
    typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,64}$/u.test(value) ? value : null;
  const driverStatus = safeLabel(result.status) ?? 'unknown';
  const failureValue = typeof result.failure === 'object' && result.failure !== null && !Array.isArray(result.failure)
    ? result.failure as Record<string, unknown>
    : {};
  const failureCode = safeLabel(failureValue.code);
  return [
    `check=${diagnostic.check ?? 'unknown'}`,
    `driverStatus=${driverStatus}`,
    ...(failureCode ? [`failureCode=${failureCode}`] : []),
    `containerHttpStatus=${containerHttpStatus}`,
  ].join('; ');
}

async function readJsonBody(request: Request): Promise<{ record: Record<string, unknown> } | Response> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return json(failure('invalid', 'Expected application/json.'), 415);
  }
  const bytes = await readBody(request);
  if (!bytes) return json(failure('invalid', 'Request body exceeds the 1024 byte limit.'), 413);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return json(failure('invalid', 'Request body is not valid JSON.'), 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json(failure('invalid', 'Expected a JSON object.'), 400);
  }
  return { record: body as Record<string, unknown> };
}

type BenchmarkTarget = {
  targetId: string;
  segmentId: string;
  instanceType: 'standard-2' | 'standard-3' | null;
  buildId: string | null;
  purpose: 'measurement' | 'cold-preflight' | 'cold-trial' | 'capacity-control';
  containerApp: string;
  containerClass: string;
  containerBinding: string;
  coldTrialNo?: number;
};

type ContainerStateView = {
  status: 'running' | 'healthy' | 'stopping' | 'stopped' | 'stopped_with_code';
  lastChange: number;
  exitCode?: number;
};

function benchmarkTargetMap(env: Env): Map<string, BenchmarkTarget> | null {
  if (typeof env.ANALYSIS_BENCHMARK_TARGETS !== 'string') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(env.ANALYSIS_BENCHMARK_TARGETS);
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 24) return null;
  const targets = new Map<string, BenchmarkTarget>();
  for (const value of raw) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (typeof row.targetId !== 'string' || typeof row.segmentId !== 'string' || typeof row.purpose !== 'string') return null;
    if (targets.has(row.targetId)) return null;
    if (row.targetId === SINGLETON_TARGET_ID) {
      if (row.segmentId !== 'preexisting-singleton' || row.purpose !== 'capacity-control'
        || row.instanceType !== null || row.buildId !== null
        || row.containerApp !== NORMAL_CONTAINER_TARGET.containerApp
        || row.containerClass !== NORMAL_CONTAINER_TARGET.containerClass
        || row.containerBinding !== NORMAL_CONTAINER_TARGET.containerBinding) return null;
      targets.set(row.targetId, row as BenchmarkTarget);
      continue;
    }
    if (!TARGET_ID_RE.test(row.targetId)
      || !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(row.segmentId)
      || !['standard-2', 'standard-3'].includes(String(row.instanceType))
      || typeof row.buildId !== 'string'
      || !/^[0-9a-f]{32}$/u.test(row.buildId)
      || !['measurement', 'cold-preflight', 'cold-trial'].includes(row.purpose)) return null;
    const containerTarget = BENCHMARK_CONTAINER_TARGETS[row.instanceType as 'standard-2' | 'standard-3'];
    if (row.containerApp !== containerTarget.containerApp
      || row.containerClass !== containerTarget.containerClass
      || row.containerBinding !== containerTarget.containerBinding) return null;
    const trial = row.coldTrialNo;
    if (row.purpose === 'cold-trial' ? !Number.isSafeInteger(trial) || Number(trial) < 1 : trial !== undefined) return null;
    const targetPrefix = `bench-${String(row.instanceType)}-${row.buildId}-`;
    const expectedTargetId = row.purpose === 'cold-preflight'
      ? `${targetPrefix}${row.segmentId}-preflight`
      : row.purpose === 'cold-trial'
        ? `${targetPrefix}${row.segmentId}-cold-trial-${String(trial)}`
        : `${targetPrefix}${row.segmentId}`;
    if (row.targetId !== expectedTargetId) return null;
    targets.set(row.targetId, row as BenchmarkTarget);
  }
  if (!targets.has(SINGLETON_TARGET_ID)) return null;
  return targets;
}

function selectBenchmarkTarget(env: Env, targetId: unknown, segmentId?: unknown): BenchmarkTarget | null {
  if (typeof targetId !== 'string') return null;
  const target = benchmarkTargetMap(env)?.get(targetId);
  if (!target || target.purpose === 'capacity-control') return null;
  if (typeof segmentId === 'string' && segmentId !== target.segmentId) return null;
  if (target.buildId !== env.ANALYSIS_BENCHMARK_BUILD_ID) return null;
  return target;
}

type ContainerStub<T extends Container> = ReturnType<typeof getContainer<T>>;
type RoutedAnalysisContainer =
  | ContainerStub<AnalysisContainer>
  | ContainerStub<BenchmarkStandard2Container>
  | ContainerStub<BenchmarkStandard3Container>;

function containerForBenchmarkTarget(env: Env, target: BenchmarkTarget): RoutedAnalysisContainer {
  if (target.instanceType === 'standard-2') {
    return getContainer<BenchmarkStandard2Container>(env.ANALYSIS_BENCHMARK_STANDARD_2, target.targetId);
  }
  if (target.instanceType === 'standard-3') {
    return getContainer<BenchmarkStandard3Container>(env.ANALYSIS_BENCHMARK_STANDARD_3, target.targetId);
  }
  throw new Error('Benchmark target has no fixed benchmark instance type.');
}

function containerForTarget(env: Env, target: BenchmarkTarget): RoutedAnalysisContainer {
  if (target.purpose === 'capacity-control') {
    return getContainer<AnalysisContainer>(env.ANALYSIS_CONTAINER, target.targetId);
  }
  return containerForBenchmarkTarget(env, target);
}

function containerStateFields(state: ContainerStateView): Record<string, unknown> {
  const allowed = new Set(['running', 'healthy', 'stopping', 'stopped', 'stopped_with_code']);
  return {
    containerState: allowed.has(state.status) ? state.status : 'unknown',
    containerStateLastChangeWall: Number.isFinite(state.lastChange)
      ? new Date(state.lastChange).toISOString()
      : null,
    ...(typeof state.exitCode === 'number' ? { containerExitCode: state.exitCode } : {}),
  };
}

function benchmarkTargetFields(target: BenchmarkTarget, state?: ContainerStateView): Record<string, unknown> {
  return {
    targetId: target.targetId,
    segmentId: target.segmentId,
    targetPurpose: target.purpose,
    targetInstanceType: target.instanceType,
    expectedBuildId: target.buildId,
    containerApp: target.containerApp,
    containerClass: target.containerClass,
    containerBinding: target.containerBinding,
    ...(state ? containerStateFields(state) : {}),
  };
}

function isStopped(state: ContainerStateView): boolean {
  return state.status === 'stopped' || state.status === 'stopped_with_code';
}

async function handleBenchmarkHealth(request: Request, env: Env): Promise<Response> {
  if (env.ANALYSIS_BENCHMARK_ENABLED !== '1') return json(failure('invalid', 'Not found.'), 404);
  if (request.method !== 'GET') return json(failure('invalid', 'Method not allowed.'), 405);
  const authFailure = authorize(request, env);
  if (authFailure) return authFailure;
  const target = selectBenchmarkTarget(env, new URL(request.url).searchParams.get('targetId'));
  if (!target || target.purpose === 'cold-trial') {
    return json(failure('invalid', 'Unknown benchmark target.'), 400);
  }
  try {
    const container = containerForBenchmarkTarget(env, target);
    const response = await container.fetch(new Request('http://analysis-container/health', { method: 'GET' }));
    if (!response.ok) return json({ ...failure('engine_error', 'Analysis container health is unavailable.'), ...benchmarkTargetFields(target) }, 502);
    const text = await response.text();
    if (text.length > 8192) return json({ ...failure('engine_error', 'Analysis container health exceeded the response limit.'), ...benchmarkTargetFields(target) }, 502);
    let driverHealth: unknown;
    try {
      driverHealth = JSON.parse(text);
    } catch {
      return json({ ...failure('engine_error', 'Analysis container returned an invalid health response.'), ...benchmarkTargetFields(target) }, 502);
    }
    if (!isDriverHealth(driverHealth)) {
      return json({ ...failure('engine_error', 'Analysis container health failed contract validation.'), ...benchmarkTargetFields(target) }, 502);
    }
    const state = await container.getState() as ContainerStateView;
    return json({
      ...driverHealth,
      ...workerVersionFields(env),
      workerVerifyStopEngineOnceEnabled: env.ANALYSIS_VERIFY_STOP_ENGINE_ONCE === '1',
      workerBenchmarkEnabled: true,
      workerExpectedInstanceType: target.instanceType,
      ...benchmarkTargetFields(target, state),
    });
  } catch {
    return json({ ...failure('engine_error', 'Analysis container health is unavailable.'), ...benchmarkTargetFields(target) }, 502);
  }
}

async function waitForStoppedState(
  container: RoutedAnalysisContainer,
  initialState: ContainerStateView,
  deadline: number,
): Promise<{ state: ContainerStateView; pollCount: number }> {
  let state = initialState;
  let pollCount = 0;
  while (!isStopped(state)) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    if (pollCount > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(STOP_CONFIRM_INTERVAL_MS, remainingMs)));
    }
    const readRemainingMs = deadline - Date.now();
    if (readRemainingMs <= 0) break;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let nextState: ContainerStateView | null;
    try {
      nextState = await Promise.race([
        container.getState() as Promise<ContainerStateView>,
        new Promise<null>((resolve) => {
          timeout = setTimeout(() => resolve(null), readRemainingMs);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    if (nextState === null) break;
    state = nextState;
    pollCount += 1;
  }
  return { state, pollCount };
}

async function handleBenchmarkStop(request: Request, env: Env): Promise<Response> {
  if (env.ANALYSIS_BENCHMARK_ENABLED !== '1') return json(failure('invalid', 'Not found.'), 404);
  if (request.method !== 'POST') return json(failure('invalid', 'Method not allowed.'), 405);
  const authFailure = authorize(request, env);
  if (authFailure) return authFailure;
  const parsed = await readJsonBody(request);
  if (parsed instanceof Response) return parsed;
  const { record } = parsed;
  if (Object.keys(record).length !== 1 || typeof record.targetId !== 'string') {
    return json(failure('invalid', 'Expected only a listed targetId.'), 400);
  }
  const target = benchmarkTargetMap(env)?.get(record.targetId);
  if (!target) return json(failure('invalid', 'Unknown benchmark target.'), 400);
  if (target.purpose !== 'capacity-control' && target.buildId !== env.ANALYSIS_BENCHMARK_BUILD_ID) {
    return json(failure('invalid', 'Benchmark target is not bound to this deploy.'), 400);
  }
  try {
    const container = containerForTarget(env, target);
    const stateBefore = await container.getState() as ContainerStateView;
    let stateAfter = stateBefore;
    let stopPollCount = 0;
    if (!isStopped(stateBefore)) {
      await container.destroy();
      const deadline = Date.now() + STOP_CONFIRM_TIMEOUT_MS;
      const confirmed = await waitForStoppedState(container, stateBefore, deadline);
      stateAfter = confirmed.state;
      stopPollCount = confirmed.pollCount;
    }
    const stopped = isStopped(stateAfter);
    return json({
      stopped,
      ...benchmarkTargetFields(target, stateAfter),
      stateBefore: containerStateFields(stateBefore),
      stateAfter: containerStateFields(stateAfter),
      stopPollCount,
      stopConfirmTimeoutMs: STOP_CONFIRM_TIMEOUT_MS,
      stopCheckedWithoutFetch: true,
    }, stopped ? 200 : 409);
  } catch {
    return json({
      stopped: false,
      ...benchmarkTargetFields(target),
      stopCheckedWithoutFetch: true,
    }, 502);
  }
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/v1/')) return handleV1Request(request, env);
  if (url.pathname === BENCHMARK_HEALTH_PATH) return handleBenchmarkHealth(request, env);
  if (url.pathname === BENCHMARK_STOP_PATH) return handleBenchmarkStop(request, env);
  if (url.pathname === HEALTH_PATH) {
    if (request.method !== 'GET') return json(failure('invalid', 'Method not allowed.'), 405);
    const authFailure = authorize(request, env);
    if (authFailure) return authFailure;
    try {
      const container = getContainer<AnalysisContainer>(env.ANALYSIS_CONTAINER, SINGLETON_TARGET_ID);
      const response = await container.fetch(new Request('http://analysis-container/health', { method: 'GET' }));
      if (!response.ok) return json(failure('engine_error', 'Analysis container health is unavailable.'), 502);
      const text = await response.text();
      if (text.length > 8192) return json(failure('engine_error', 'Analysis container health exceeded the response limit.'), 502);
      let driverHealth: unknown;
      try {
        driverHealth = JSON.parse(text);
      } catch {
        return json(failure('engine_error', 'Analysis container returned an invalid health response.'), 502);
      }
      if (!isDriverHealth(driverHealth)) {
        return json(failure('engine_error', 'Analysis container health failed contract validation.'), 502);
      }
      return json({
        ...driverHealth,
        ...workerVersionFields(env),
        workerVerifyStopEngineOnceEnabled: env.ANALYSIS_VERIFY_STOP_ENGINE_ONCE === '1',
        workerBenchmarkEnabled: env.ANALYSIS_BENCHMARK_ENABLED === '1',
        workerExpectedInstanceType: env.ANALYSIS_EXPECTED_INSTANCE_TYPE ?? null,
      });
    } catch {
      return json(failure('engine_error', 'Analysis container health is unavailable.'), 502);
    }
  }
  if (url.pathname === BENCHMARK_PATH) {
    if (env.ANALYSIS_BENCHMARK_ENABLED !== '1') return json(failure('invalid', 'Not found.'), 404);
    if (request.method !== 'POST') return json(failure('invalid', 'Method not allowed.'), 405);
    const authFailure = authorize(request, env);
    if (authFailure) return authFailure;
    const parsed = await readJsonBody(request);
    if (parsed instanceof Response) return parsed;
    const { record } = parsed;
    if (Object.keys(record).length !== 4 || !Object.hasOwn(record, 'sfen') || !Object.hasOwn(record, 'conditionId')
      || !Object.hasOwn(record, 'targetId') || !Object.hasOwn(record, 'segmentId') || !isValidSfen(record.sfen)) {
      return json(failure('invalid', 'Expected a valid SFEN, manifest condition ID, targetId, and segmentId.'), 400);
    }
    if (typeof record.conditionId !== 'string') return json(failure('invalid', 'Unknown benchmark condition.'), 400);
    const condition = BENCHMARK_CONDITION_BY_ID.get(record.conditionId);
    if (!condition) return json(failure('invalid', 'Unknown benchmark condition.'), 400);
    const target = selectBenchmarkTarget(env, record.targetId, record.segmentId);
    if (!target) {
      return json(failure('invalid', 'Unknown benchmark target or segment.'), 400);
    }
    if (target.instanceType !== condition.instanceType) {
      return json(failure('invalid', 'Benchmark condition type does not match its fixed target app.'), 409);
    }
    const sfen = record.sfen;
    const rootMoves = legalMoves(sfen);
    const position = Position.newBySFEN(sfen);
    if (!position) return json(failure('invalid', 'SFEN is invalid.'), 400);
    if (rootMoves.length === 0) {
      const terminal: 'checkmate' | 'no-legal-moves' = position.checked ? 'checkmate' : 'no-legal-moves';
      try {
        const container = containerForBenchmarkTarget(env, target);
        const healthResponse = await container.fetch(new Request('http://analysis-container/health', { method: 'GET' }));
        if (!healthResponse.ok) return json({ ...failure('engine_error', 'Analysis container health is unavailable.', sfen), ...benchmarkTargetFields(target) }, 502);
        const healthText = await healthResponse.text();
        if (healthText.length > 8192) return json({ ...failure('engine_error', 'Analysis container health exceeded the response limit.', sfen), ...benchmarkTargetFields(target) }, 502);
        let driverHealth: unknown;
        try {
          driverHealth = JSON.parse(healthText);
        } catch {
          return json({ ...failure('engine_error', 'Analysis container returned an invalid health response.', sfen), ...benchmarkTargetFields(target) }, 502);
        }
        if (!isDriverHealth(driverHealth)) return json({ ...failure('engine_error', 'Analysis container health failed contract validation.', sfen), ...benchmarkTargetFields(target) }, 502);
        const runtime = driverHealth.runtime as Record<string, unknown>;
        const targetState = await container.getState() as ContainerStateView;
        const runtimeMismatch = driverHealth.expectedInstanceType !== condition.instanceType
          ? 'driver_expected_instance_type_mismatch'
          : benchmarkRuntimeMismatch(runtime, condition.instanceType);
        if (runtimeMismatch) {
          return json({ ...benchmarkInstanceFailure(
            sfen,
            condition.conditionId,
            String(driverHealth.expectedInstanceType),
            String(driverHealth.driverBootId),
            0,
            typeof driverHealth.buildId === 'string' ? driverHealth.buildId : undefined,
            typeof driverHealth.gitCommit === 'string' ? driverHealth.gitCommit : undefined,
            runtime,
            driverHealth.identityDigests as Record<string, unknown>,
            runtimeMismatch,
          ), ...benchmarkTargetFields(target, targetState) }, 409);
        }
        return json({
          schemaVersion: 2,
          contractVersion: BENCHMARK_CONTRACT_VERSION,
          sfen,
          perspective: 'sente',
          status: 'terminal',
          terminal,
          candidates: [],
          conditionId: condition.conditionId,
          expectedInstanceType: condition.instanceType,
          driverBootId: driverHealth.driverBootId,
          engineEpoch: 0,
          driverVersion: driverHealth.driverVersion,
          buildId: driverHealth.buildId,
          gitCommit: driverHealth.gitCommit,
          identityDigests: driverHealth.identityDigests,
          runtime,
          ...benchmarkTargetFields(target, targetState),
          conditions: { requested: condition, actual: null },
          meta: { nodes: null, completedDepth: null, searchElapsedMs: null, engineNps: null, derivedNps: null, processElapsedMs: null, processCpuSeconds: null },
        });
      } catch {
        return json({ ...failure('engine_error', 'Analysis container health is unavailable.', sfen), ...benchmarkTargetFields(target) }, 502);
      }
    }
    try {
      const container = containerForBenchmarkTarget(env, target);
      const internalRequest = new Request('http://analysis-container/benchmark', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sfen, legalMoveCount: rootMoves.length, conditionId: condition.conditionId }),
      });
      const response = await container.fetch(internalRequest);
      const targetState = await container.getState() as ContainerStateView;
      const text = await response.text();
      if (text.length > 64 * 1024) return json({ ...failure('engine_error', 'Benchmark result exceeded the response limit.', sfen), ...benchmarkTargetFields(target, targetState) }, 502);
      let driverResult: unknown;
      try {
        driverResult = JSON.parse(text);
      } catch {
        return json({ ...failure('engine_error', 'Analysis container returned an invalid response.', sfen), ...benchmarkTargetFields(target, targetState) }, 502);
      }
      const diagnostic: BenchmarkValidationDiagnostic = {};
      const validated = validateBenchmarkDriverResult(driverResult, sfen, rootMoves, condition, diagnostic);
      if (!validated) {
        return json({ ...failure(
          'engine_error',
          'Benchmark result failed contract validation.',
          sfen,
          benchmarkValidationDetail(diagnostic, driverResult, response.status),
        ), ...benchmarkTargetFields(target, targetState) }, 502);
      }
      if (validated.status === 'failure') {
        const failureRecord = validated.failure as { code: string };
        const status = failureRecord.code === 'busy' || failureRecord.code === 'instance_mismatch' ? 409 : failureRecord.code === 'timeout' ? 504 : 502;
        return json({ ...validated, ...benchmarkTargetFields(target, targetState) }, status);
      }
      return json({ ...validated, ...workerVersionFields(env), ...benchmarkTargetFields(target, targetState) });
    } catch {
      return json({ ...failure('engine_error', 'Analysis container is unavailable.', sfen), ...benchmarkTargetFields(target) }, 502);
    }
  }
  if (url.pathname !== ANALYSIS_PATH) return json(failure('invalid', 'Not found.'), 404);
  if (request.method !== 'POST') return json(failure('invalid', 'Method not allowed.'), 405);

  const authFailure = authorize(request, env);
  if (authFailure) return authFailure;

  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    return json(failure('invalid', 'Expected application/json.'), 415);
  }
  const bytes = await readBody(request);
  if (!bytes) return json(failure('invalid', 'Request body exceeds the 1024 byte limit.'), 413);

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return json(failure('invalid', 'Request body is not valid JSON.'), 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json(failure('invalid', 'Expected a JSON object with one SFEN field.'), 400);
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.hasOwn(record, 'sfen') || !isValidSfen(record.sfen)) {
    const echo = typeof record.sfen === 'string' && !/[\u0000-\u001f\u007f]/u.test(record.sfen)
      ? record.sfen.slice(0, 256)
      : null;
    return json(failure('invalid', 'SFEN must be valid, single-line shogi notation.' , echo), 400);
  }
  const sfen = record.sfen;
  const position = Position.newBySFEN(sfen);
  if (!position) return json(failure('invalid', 'SFEN is invalid.'), 400);
  const rootMoves = legalMoves(sfen);
  if (rootMoves.length === 0) {
    const terminal: 'checkmate' | 'no-legal-moves' = position.checked ? 'checkmate' : 'no-legal-moves';
    return json({
      schemaVersion: 1,
      sfen,
      perspective: 'sente',
      status: 'terminal',
      terminal,
      candidates: [],
      meta: { nodes: null, completedDepth: null, elapsedMs: null },
      conditions: { requested: SEARCH_CONDITIONS, actual: null },
      identity: EXPECTED_IDENTITY,
    });
  }

  try {
    const container = getContainer<AnalysisContainer>(env.ANALYSIS_CONTAINER, 'analysis-mvp-singleton');
    const internalRequest = new Request('http://analysis-container/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sfen, legalMoveCount: rootMoves.length }),
    });
    const response = await container.fetch(internalRequest);
    const text = await response.text();
    if (text.length > 64 * 1024) return json(failure('engine_error', 'Analysis result exceeded the response limit.', sfen), 502);
    let driverResult: unknown;
    try {
      driverResult = JSON.parse(text);
    } catch {
      return json(failure('engine_error', 'Analysis container returned an invalid response.', sfen), 502);
    }
    const validated = validateDriverResult(driverResult, sfen, rootMoves);
    if (!validated) return json(failure('engine_error', 'Analysis result failed contract validation.', sfen), 502);
    if (validated.status === 'failure') {
      const status = validated.failure.code === 'busy' ? 409 : validated.failure.code === 'timeout' ? 504 : 502;
      return json(validated, status);
    }
    return json(validated);
  } catch {
    return json(failure('engine_error', 'Analysis container is unavailable.', sfen), 502);
  }
}

export default {
  fetch: handleRequest,
  queue: (batch: MessageBatch, env: Env): Promise<void> => handleJobBatch(batch as MessageBatch<JobQueueMessage>, env),
} satisfies ExportedHandler<Env>;
