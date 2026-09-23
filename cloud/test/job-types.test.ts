import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_PROFILES,
  decodeResultCursor,
  encodeResultCursor,
  estimateContainerCostUsd,
  finalJobStatus,
  makeResultCacheKey,
  profileFor,
  quotaAllows,
  shouldStopAfterPositionFailure,
} from '../src/job-types';
import { parseJobPayload } from '../src/jobs';

const SFEN = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

describe('async job policy helpers', () => {
  it('fixes both analysis profiles and rejects unknown profiles', () => {
    expect(profileFor('free-v1')).toEqual(ANALYSIS_PROFILES['free-v1']);
    expect(profileFor('precision-v1')).toEqual(ANALYSIS_PROFILES['precision-v1']);
    expect(profileFor('free-v2')).toBeNull();
    expect(profileFor({ id: 'free-v1' })).toBeNull();
  });

  it('accepts only strict SFEN payloads, bounded arrays, and public fields', () => {
    const valid = { idempotency_key: 'k-1', profile: 'free-v1', positions: [SFEN] };
    expect(parseJobPayload(valid)?.positions).toEqual([SFEN]);
    expect(parseJobPayload({ ...valid, positions: [] })).toBeNull();
    expect(parseJobPayload({ ...valid, positions: Array(513).fill(SFEN) })).toBeNull();
    expect(parseJobPayload({ ...valid, positions: ['invalid'] })).toBeNull();
    expect(parseJobPayload({ ...valid, profile: 'unknown' })).toBeNull();
    expect(parseJobPayload({ ...valid, movetime_ms: 1000 })).toBeNull();
    expect(parseJobPayload({ ...valid, idempotency_key: 'spaces are invalid' })).toBeNull();
    expect(parseJobPayload({ ...valid, label: ' leading-space' })).toBeNull();
  });

  it('enforces daily job and position reservations by profile', () => {
    expect(quotaAllows('free-v1', 4, 1023, 1)).toBe(true);
    expect(quotaAllows('free-v1', 5, 0, 1)).toBe(false);
    expect(quotaAllows('free-v1', 0, 1024, 1)).toBe(false);
    expect(quotaAllows('precision-v1', 1, 511, 1)).toBe(true);
    expect(quotaAllows('precision-v1', 2, 0, 1)).toBe(false);
    expect(quotaAllows('precision-v1', 0, 512, 1)).toBe(false);
  });

  it('round-trips stable cursors and rejects malformed or unsafe positions', () => {
    for (const position of [-1, 0, 99, 511]) expect(decodeResultCursor(encodeResultCursor(position))).toBe(position);
    expect(decodeResultCursor(null)).toBe(-1);
    expect(() => decodeResultCursor('v2:4')).toThrow('invalid_cursor');
    expect(() => decodeResultCursor('!!!!')).toThrow('invalid_cursor');
    expect(() => encodeResultCursor(Number.MAX_SAFE_INTEGER + 1)).toThrow('invalid_cursor');
  });

  it('uses terminal taxonomy and failure stop thresholds consistently', () => {
    expect(finalJobStatus(4, 0)).toBe('completed');
    expect(finalJobStatus(2, 1)).toBe('partial');
    expect(finalJobStatus(0, 1)).toBe('failed');
    expect(shouldStopAfterPositionFailure(2, 2)).toBe(false);
    expect(shouldStopAfterPositionFailure(3, 3)).toBe(true);
    expect(shouldStopAfterPositionFailure(1, 5)).toBe(true);
  });

  it('keys cached results by contract, engine, model, and profile identity', () => {
    const identity = {
      profileId: 'free-v1' as const,
      profileVersion: 1 as const,
      engineId: 'engine-a',
      modelId: 'model-a',
      instanceType: 'standard-2' as const,
    };
    const base = makeResultCacheKey(identity, SFEN);
    expect(base).toBe(JSON.stringify([3, 'engine-a', 'model-a', 'free-v1', 1, SFEN]));
    expect(makeResultCacheKey({ ...identity, engineId: 'engine-b' }, SFEN)).not.toBe(base);
    expect(makeResultCacheKey({ ...identity, modelId: 'model-b' }, SFEN)).not.toBe(base);
    expect(makeResultCacheKey({ ...identity, profileId: 'precision-v1' }, SFEN)).not.toBe(base);
  });

  it('prices active vCPU and provisioned memory/disk with a conservative sleep window', () => {
    const free = estimateContainerCostUsd(1000, 1, 'standard-2', 1000);
    const precision = estimateContainerCostUsd(2000, 1, 'standard-3', 2000);
    expect(free).toBeGreaterThan(0.0005);
    expect(precision).toBeGreaterThan(free);
    expect(estimateContainerCostUsd(1000, 2, 'standard-2', 1000)).toBeGreaterThan(free);
    expect(estimateContainerCostUsd(1000, 1, 'standard-2', 1000)).toBe(free);
  });
});
