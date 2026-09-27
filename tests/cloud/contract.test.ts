import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  CLOUD_EXPECTED_IDENTITY,
  CLOUD_PROFILES,
} from '../../src/cloud/contract';

/**
 * src/cloud/contract.ts mirrors server-side values. If the cloud package's
 * approved profiles or pinned identity change, the app must be updated
 * deliberately — these tests fail instead of silently drifting.
 */
describe('Cloud契約値がcloudパッケージと一致する', () => {
  it('プロファイル条件がjob-profiles.jsonと一致する', () => {
    const config = JSON.parse(
      readFileSync('cloud/config/job-profiles.json', 'utf8'),
    ) as { profiles: Record<string, Record<string, number>> };
    for (const profileId of ['free', 'precision'] as const) {
      for (const key of ['threads', 'hashMb', 'moveTimeMs', 'multiPV'] as const) {
        expect(config.profiles[profileId][key]).toBe(CLOUD_PROFILES[profileId][key]);
      }
    }
  });

  it('EXPECTED_IDENTITYがcontract.tsの値と一致する', () => {
    const source = readFileSync('cloud/src/contract.ts', 'utf8');
    const block = source.match(/EXPECTED_IDENTITY = Object\.freeze\(\{([\s\S]*?)\}\)/u);
    expect(block).not.toBeNull();
    const driverVersion = source.match(/DRIVER_VERSION = '([^']+)'/u)?.[1];
    const contractVersion = source.match(/CONTRACT_VERSION = '([^']+)'/u)?.[1];
    const fields = new Map<string, string>();
    for (const match of block![1].matchAll(/(\w+):\s*('(?:[^'\\]|\\.)*'|\w+)/gu)) {
      const raw = match[2];
      const value =
        raw === 'DRIVER_VERSION'
          ? driverVersion
          : raw === 'CONTRACT_VERSION'
            ? contractVersion
            : raw.replace(/^'|'$/gu, '');
      fields.set(match[1], value!);
    }
    expect(fields.get('driverVersion')).toBe('usi-driver-v1');
    expect(fields.get('contractVersion')).toBe('analysis-json-v1');
    for (const [key, value] of Object.entries(CLOUD_EXPECTED_IDENTITY)) {
      expect(fields.get(key), `identity.${key}`).toBe(value);
    }
  });
});
