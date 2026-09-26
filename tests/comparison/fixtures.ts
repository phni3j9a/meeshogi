import type {
  CloudMethodExport,
  ComparisonExport,
  ComparisonMethod,
  ExportCandidate,
  ExportScore,
  PlyResult,
  SekireiMethodExport,
} from '../../src/comparison/schema';

export const SFEN_BASE = 'lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1';

/** ply に応じて手番と手数だけ変えた形状上の SFEN（合法性は fixture の責務外）。 */
export function sfenAt(ply: number): string {
  return `lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL ${ply % 2 === 0 ? 'b' : 'w'} - ${ply + 1}`;
}

export function cp(value: number): ExportScore {
  return { kind: 'cp', value };
}

export function mate(value: number, winner: 'black' | 'white' | 'unknown'): ExportScore {
  return { kind: 'mate', value, winner };
}

export function cand(move: string, score: ExportScore): ExportCandidate {
  return { move, score };
}

export function completeResult(
  sfen: string,
  evaluation: ExportScore,
  candidates: ExportCandidate[],
  extra: Partial<PlyResult> = {},
): PlyResult {
  return { status: 'complete', sfen, evaluation, candidates, ...extra };
}

export function sekireiMethod(timing?: Partial<SekireiMethodExport['timing']>): SekireiMethodExport {
  return {
    method: 'sekirei',
    attemptId: 'att-sek-1',
    identity: { engineId: 'sekirei-v0.3.37@test', modelId: 'c-leaf-wrm-seed42@test' },
    conditions: { nodes: 10000, multiPV: 2 },
    timing: {
      wholeGameWallMs: 400,
      cacheReuseCount: 0,
      interrupted: false,
      resumed: false,
      completion: 'completed',
      ...timing,
    },
  };
}

export function cloudMethod(
  method: 'cloud-free' | 'cloud-precision',
  timing?: Partial<CloudMethodExport['timing']>,
): CloudMethodExport {
  return {
    method,
    attemptId: `att-${method}-1`,
    jobId: `job_${method}`,
    profileId: method === 'cloud-free' ? 'free' : 'precision',
    identity: {
      engineName: 'YaneuraOu NNUE 9.70git 64AVX2',
      modelId: 'Suisho11 Plus',
      engineSha256: 'a'.repeat(64),
      weightSha256: 'b'.repeat(64),
      optionsSha256: 'c'.repeat(64),
      sourceArchiveSha256: 'd'.repeat(64),
      sourceTreeSha256: 'e'.repeat(64),
      driverVersion: 'usi-driver-v1',
      contractVersion: 'analysis-json-v1',
    },
    conditions:
      method === 'cloud-free'
        ? { requested: { threads: 1, hashMb: 64, moveTimeMs: 1000, multiPV: 2 } }
        : { requested: { threads: 2, hashMb: 64, moveTimeMs: 5000, multiPV: 3 } },
    timing: {
      createdAt: '2026-09-26T00:00:00.000Z',
      finishedAt: '2026-09-26T00:00:20.000Z',
      completion: 'completed',
      ...timing,
    },
  };
}

/** 全方式が全 ply で complete な最小の有効 export を組み立てる。 */
export function makeExport(
  plyCount: number,
  resultsFor: (ply: number, sfen: string) => Partial<Record<ComparisonMethod, PlyResult>>,
  options: {
    moves?: string[];
    methods?: ComparisonExport['methods'];
    label?: string;
    platform?: 'ios' | 'android' | 'unknown';
    exportedAt?: string;
  } = {},
): ComparisonExport {
  const moveCount = plyCount - 1;
  const moves =
    options.moves ?? Array.from({ length: moveCount }, (_, i) => `${((i % 9) + 1)}g${((i % 9) + 1)}f`);
  const plies = Array.from({ length: plyCount }, (_, ply) => ({
    ply,
    sfen: ply === 0 ? SFEN_BASE : sfenAt(ply),
    results: resultsFor(ply, ply === 0 ? SFEN_BASE : sfenAt(ply)),
  }));
  return {
    schema: 'meeshogi-comparison-export',
    schemaVersion: 1,
    exportedAt: options.exportedAt ?? '2026-09-27T00:00:00.000Z',
    generator: {
      platform: options.platform ?? 'android',
      osVersion: '36',
      deviceModel: 'emu64a',
      appVersion: '0.1.0',
      buildId: 'testbuild',
    },
    game: {
      initialSfen: SFEN_BASE,
      moveCount,
      moves,
      // fixture の hash は形だけ（中身は CLI が再計算する）
      moveListHash: '0'.repeat(64),
      ...(options.label !== undefined ? { label: options.label } : {}),
    },
    methods:
      options.methods ??
      ({
        sekirei: sekireiMethod(),
        'cloud-free': cloudMethod('cloud-free'),
        'cloud-precision': cloudMethod('cloud-precision'),
      } satisfies ComparisonExport['methods']),
    plies,
  };
}
