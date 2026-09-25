import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_PROFILES,
  classifyTerminal,
  decodeResultCursor,
  encodeResultCursor,
  estimateContainerCostUsd,
  estimateAttemptCostUsd,
  estimateJobReservationUsd,
  estimateJobStartupAndIdleUsd,
  estimatePositionReservationUsd,
  estimateWorstCaseAttemptCostUsd,
  executionIdentityComponents,
  finalJobStatus,
  makeResultCacheKey,
  profileFor,
  quotaAllows,
  runtimeIdentityMatches,
  shouldStopAfterPositionFailure,
} from '../src/job-types';
import { parseJobPayload, replayJobPayload } from '../src/jobs';

const SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

describe('async job policy helpers', () => {
  const artifacts = {
    engineBinarySha256: 'a'.repeat(64), weightSha256: 'b'.repeat(64), engineOptionsSha256: 'c'.repeat(64),
    helperBinarySha256: 'd'.repeat(64), driverSha256: 'e'.repeat(64),
  };
  it('fixes both CPU-routed version-2 profiles and rejects unknown profiles', () => {
    expect(profileFor('free-v1')).toEqual(ANALYSIS_PROFILES['free-v1']);
    expect(profileFor('precision-v1')).toEqual(ANALYSIS_PROFILES['precision-v1']);
    expect(ANALYSIS_PROFILES['free-v1']).toMatchObject({ version: 2, instanceType: 'standard-2', vcpu: 1 });
    expect(ANALYSIS_PROFILES['precision-v1']).toMatchObject({ version: 2, instanceType: 'standard-3', vcpu: 2 });
    expect(profileFor('free-v2')).toBeNull();
    expect(profileFor({ id: 'free-v1' })).toBeNull();
  });

  it('replays a legal game into the initial position and each following state', () => {
    const parsed = replayJobPayload({ idempotency_key: 'k-1', profile: 'free-v1', initialSfen: SFEN, moves: ['7g7f'] });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.payload.positions).toHaveLength(2);
      expect(parsed.payload.positions[0]).toBe(SFEN);
      expect(parsed.payload.positions[1]).toContain(' w - 1');
    }
    expect(parseJobPayload({ idempotency_key: 'k-2', profile: 'free-v1', initialSfen: SFEN, moves: [] })?.positions).toHaveLength(1);
    expect(replayJobPayload({ idempotency_key: 'k-3', profile: 'free-v1', initialSfen: SFEN, moves: ['1a1b'] })).toEqual({
      ok: false, error: 'illegal_move', moveIndex: 0,
    });
    expect(parseJobPayload({ idempotency_key: 'k-4', profile: 'free-v1', initialSfen: SFEN, moves: Array(513).fill('7g7f') })).toBeNull();
    expect(parseJobPayload({ idempotency_key: 'k-5', profile: 'free-v1', positions: [SFEN] })).toBeNull();
  });

  it('enforces daily job and position reservations by profile', () => {
    expect(quotaAllows('free-v1', 4, 1023, 1)).toBe(true);
    expect(quotaAllows('free-v1', 5, 0, 1)).toBe(false);
    expect(quotaAllows('free-v1', 0, 1024, 1)).toBe(false);
    expect(quotaAllows('precision-v1', 1, 511, 1)).toBe(true);
    expect(quotaAllows('precision-v1', 2, 0, 1)).toBe(false);
    expect(quotaAllows('precision-v1', 0, 512, 1)).toBe(false);
  });

  it('round-trips job-monotonic result sequence cursors, including the empty-page tail', () => {
    for (const seq of [0, 1, 99, 511]) expect(decodeResultCursor(encodeResultCursor(seq))).toBe(seq);
    expect(decodeResultCursor(null)).toBe(0);
    expect(() => decodeResultCursor(btoa('v1:4'))).toThrow('invalid_cursor');
    expect(() => decodeResultCursor('!!!!')).toThrow('invalid_cursor');
    expect(() => encodeResultCursor(Number.MAX_SAFE_INTEGER + 1)).toThrow('invalid_cursor');
  });

  it('hash components include profile CPU/options and all result-affecting revisions', () => {
    const free = executionIdentityComponents(ANALYSIS_PROFILES['free-v1'], 'engine', 'model', `sha256:${artifacts.engineBinarySha256}`, artifacts);
    const precision = executionIdentityComponents(ANALYSIS_PROFILES['precision-v1'], 'engine', 'model', `sha256:${artifacts.engineBinarySha256}`, artifacts);
    expect(free.instance).toEqual({ type: 'standard-2', vcpu: 1 });
    expect(precision.instance).toEqual({ type: 'standard-3', vcpu: 2 });
    expect(free.revisions.parser).toBe('last-complete-multipv-publication-v2');
    expect(free.options).toMatchObject({ movetimeMs: 1000, requestedMultiPv: 2, threads: 1, hashMb: 256 });
    expect(JSON.stringify(free)).not.toBe(JSON.stringify(precision));
    expect(JSON.stringify(free)).not.toBe(JSON.stringify(executionIdentityComponents(ANALYSIS_PROFILES['free-v1'], 'engine', 'model', `sha256:${'f'.repeat(64)}`, { ...artifacts, engineBinarySha256: 'f'.repeat(64) })));
    expect(JSON.stringify(free)).not.toBe(JSON.stringify(executionIdentityComponents(ANALYSIS_PROFILES['free-v1'], 'engine', 'model', `sha256:${artifacts.engineBinarySha256}`, { ...artifacts, weightSha256: 'f'.repeat(64) })));
  });

  it('classifies successful, incomplete, terminal and failed engine states', () => {
    expect(classifyTerminal('ok')).toMatchObject({ evaluationSuccess: true, cacheEligible: true, failed: false });
    expect(classifyTerminal('mate')).toMatchObject({ evaluationSuccess: true, cacheEligible: true, failed: false });
    expect(classifyTerminal('incomplete')).toMatchObject({ processed: false, evaluationSuccess: false, cacheEligible: false, failed: false, evaluationMissing: true });
    expect(classifyTerminal('resign')).toMatchObject({ processed: false, cacheEligible: false, evaluationMissing: true, failed: false });
    expect(classifyTerminal('none')).toMatchObject({ processed: true, cacheEligible: false, evaluationMissing: false, failed: false });
    expect(classifyTerminal('no_legal_moves')).toMatchObject({ processed: true, cacheEligible: false, evaluationMissing: false, failed: false });
    expect(classifyTerminal('win')).toMatchObject({ processed: true, cacheEligible: false, evaluationMissing: false, failed: false });
    expect(classifyTerminal('position_failed:protocol_error')).toMatchObject({ failed: true, cacheEligible: false });
    expect(finalJobStatus(4, 0)).toBe('completed');
    expect(finalJobStatus(2, 1)).toBe('partial');
    expect(finalJobStatus(0, 1)).toBe('failed');
    expect(shouldStopAfterPositionFailure(2, 2)).toBe(false);
    expect(shouldStopAfterPositionFailure(3, 3)).toBe(true);
    expect(shouldStopAfterPositionFailure(1, 5)).toBe(true);
  });

  it('keys cache entries by the immutable identity hash and contract namespace', () => {
    const identity = {
      profileId: 'free-v1' as const, profileVersion: 2 as const, engineId: 'engine-a', engineBinaryDigestLabel: 'sha256:a',
      modelId: 'model-a', instanceType: 'standard-2' as const, vcpu: 1 as const, artifacts,
      executionIdentityHash: 'identity-a',
      executionIdentityComponents: executionIdentityComponents(ANALYSIS_PROFILES['free-v1'], 'engine-a', 'model-a', `sha256:${artifacts.engineBinarySha256}`, artifacts),
    };
    const base = makeResultCacheKey(identity, SFEN);
    expect(base).toContain('identity-a');
    expect(makeResultCacheKey({ ...identity, executionIdentityHash: 'identity-b' }, SFEN)).not.toBe(base);
    expect(makeResultCacheKey({ ...identity, instanceType: 'standard-3', vcpu: 2 }, SFEN)).toContain('identity-a');
  });

  it('binds every full runtime artifact digest and fails closed on a provenance mismatch', () => {
    const profile = ANALYSIS_PROFILES['free-v1'];
    const components = executionIdentityComponents(profile, 'engine-a', 'model-a', `sha256:${artifacts.engineBinarySha256}`, artifacts);
    const identity = {
      profileId: profile.id, profileVersion: profile.version, engineId: 'engine-a',
      engineBinaryDigestLabel: `sha256:${artifacts.engineBinarySha256}`, modelId: 'model-a',
      instanceType: profile.instanceType, vcpu: profile.vcpu, artifacts, executionIdentityHash: 'hash',
      executionIdentityComponents: components,
    };
    const health = { ready: true, engineId: 'engine-a', driverEpoch: 'driver-lifetime-a', engineEpoch: 'engine-process-a', restartCount: 0, artifactProvenance: artifacts };
    expect(runtimeIdentityMatches(identity, health, identity.engineBinaryDigestLabel)).toBe(true);
    expect(runtimeIdentityMatches(identity, { ...health, artifactProvenance: { ...artifacts, driverSha256: 'f'.repeat(64) } }, identity.engineBinaryDigestLabel)).toBe(false);
    expect(runtimeIdentityMatches(identity, { ...health, driverEpoch: undefined }, identity.engineBinaryDigestLabel)).toBe(false);
    expect(runtimeIdentityMatches(identity, health, `sha256:${'f'.repeat(64)}`)).toBe(false);
  });

  it('prices both profile CPU and daily reservations including both container idle windows', () => {
    const free = estimateContainerCostUsd(1000, 1, 'standard-2', 1000);
    const precision = estimateContainerCostUsd(2000, 1, 'standard-3', 2000);
    expect(precision).toBeGreaterThan(free);
    expect(estimateContainerCostUsd(1000, 2, 'standard-2', 1000)).toBeGreaterThan(free);
    expect(estimateJobReservationUsd(ANALYSIS_PROFILES['free-v1'], 1)).toBeGreaterThan(free);
    expect(estimateJobReservationUsd(ANALYSIS_PROFILES['precision-v1'], 1)).toBeGreaterThan(estimateJobReservationUsd(ANALYSIS_PROFILES['free-v1'], 1));
    const profile = ANALYSIS_PROFILES['free-v1'];
    expect(estimateWorstCaseAttemptCostUsd(profile)).toBeGreaterThan(estimateAttemptCostUsd(profile.movetimeMs, profile.instanceType));
    expect(estimatePositionReservationUsd(profile)).toBeGreaterThan(2 * estimateWorstCaseAttemptCostUsd(profile));
    expect(estimateJobStartupAndIdleUsd(profile)).toBeGreaterThan(0);
  });
});
