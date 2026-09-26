/**
 * 開発用比較export のスキーマ（`meeshogi-comparison-export` version 1）。
 *
 * アプリが1棋譜の解析結果（最大3方式: Sekirei / Cloud Free / Cloud Precision）を
 * 1つのJSONファイルとして書き出すための契約。`validate.ts` の runtime validator が
 * このファイルの型と一致する。export には credential・token・接続先 secret を
 * 絶対に含めない（validator が `mcd1_` / Bearer 形状の文字列を拒否する）。
 *
 * 規約:
 * - 評価値はすべて先手（black）視点。cp は符号付き整数、mate は生の符号付き距離と
 *   winner（'black' | 'white' | 'unknown'）を持つ。mate の winner と符号は一致させる
 *   （value > 0 ⇔ 'black'、value < 0 ⇔ 'white'、value === 0 ⇔ 'unknown'）。
 * - `plies[i].ply === i` で ply 0 が初期局面。`plies.length === game.moveCount + 1`。
 * - 行の `sfen` はその ply の局面。各方式結果にもソースが報告した `sfen` を保持し、
 *   集計側は不一致を検出して比較から除外する。
 * - `game.moveListHash` は `sha256hex(initialSfen + '\n' + moves.join(' '))`。
 * - status 語彙: 'complete'（有効な評価あり）/ 'incomplete'（永続化された欠測行）/
 *   'terminal'（終局局面、engine 非呼出しの結果を含む）/ 'missing'（結果行なし）。
 *   Sekirei の `terminal` フィールド付き complete 結果は export 時に 'terminal' へ正規化する。
 * - 時間は計測境界を明示し、不明な場合は null（捏造しない）:
 *   - Sekirei: `timing.wholeGameWallMs` は JS 側で計測した全局の壁時計。
 *     ply 行の `timing.kind: 'app-call'` はその局面の analyze 呼出しの JS 壁時計。
 *     cache から再利用した ply は `fromCache: true` とし call 時間を持たない。
 *   - Cloud: `timing.createdAt`/`finishedAt` は server の job 時刻（queue/retry 込み）。
 *     ply 行の `timing.kind: 'server-search'` は `result.meta.elapsedMs`
 *     （1局面の search+drain のみ。起動・queue・network を含まない）。
 * - 1方式につき選択された1試行（attemptId）だけを含める。Cloud は jobId も保持する
 *   （jobId は credential ではなく、復帰・照合のための識別子）。
 */

export const COMPARISON_EXPORT_SCHEMA = 'meeshogi-comparison-export' as const;
export const COMPARISON_EXPORT_SCHEMA_VERSION = 1 as const;

export const COMPARISON_METHODS = ['sekirei', 'cloud-free', 'cloud-precision'] as const;
export type ComparisonMethod = (typeof COMPARISON_METHODS)[number];

/** 比較の reference。深い参照であり正解ではない（Issue #20 の 10000ms 基準条件とは別物）。 */
export const REFERENCE_METHOD = 'cloud-precision' as const;
/** reference と対比される方式。 */
export const COMPARED_METHODS = ['sekirei', 'cloud-free'] as const;

export type ExportSide = 'black' | 'white';
export type PlyStatus = 'complete' | 'incomplete' | 'terminal' | 'missing';
export type TerminalKind = 'checkmate' | 'no-legal-moves';
export type MateWinner = ExportSide | 'unknown';

export interface ExportScoreCp {
  kind: 'cp';
  /** 先手視点の符号付き centipawn。 */
  value: number;
}
export interface ExportScoreMate {
  kind: 'mate';
  /** 先手視点の符号付き mate 距離（生値）。0 は winner 'unknown' のみ許可。 */
  value: number;
  winner: MateWinner;
}
export type ExportScore = ExportScoreCp | ExportScoreMate;

/** 実際に返された順序の候補手。候補を水増ししない。 */
export interface ExportCandidate {
  move: string;
  score: ExportScore;
}

export interface ExportTerminal {
  kind: TerminalKind;
  /** checkmate は 'black' | 'white'、no-legal-moves は null。 */
  winner: ExportSide | null;
}

/** 1 ply・1方式の結果。status に無関係なフィールドは持たない。 */
export interface PlyResult {
  status: PlyStatus;
  /** 結果ソースが報告した SFEN（行の sfen と一致しない場合は比較から除外される）。 */
  sfen?: string;
  /** status === 'terminal' のとき必須。 */
  terminal?: ExportTerminal;
  /** status === 'complete' のとき必須。候補先頭の生評価。 */
  evaluation?: ExportScore;
  /** status === 'complete' のとき必須・非空。incomplete/terminal/missing では持たない。 */
  candidates?: ExportCandidate[];
  /** ソースが記録した実測の探索量。null は「報告なし」。 */
  observed?: {
    nodes?: number | null;
    completedDepth?: number | null;
    /** Cloud の conditions.actual.multiPV（min(requested, 合法手数)）。 */
    multiPV?: number | null;
    /** Cloud の行レベル engineLaunch（session 内 engine 再利用の証跡）。 */
    engineLaunch?: number | null;
  };
  /** ply 単位の計測。kind が計測境界を示す。 */
  timing?: {
    /** 'app-call' = Sekirei の JS 計測壁時計。'server-search' = Cloud の meta.elapsedMs（search+drain）。 */
    kind: 'app-call' | 'server-search';
    elapsedMs: number;
  };
  /** Sekirei: この ply が新規探索ではなく保存済み結果の再利用だったことを示す。 */
  fromCache?: boolean;
}

export interface PlyRow {
  ply: number;
  sfen: string;
  results: Partial<Record<ComparisonMethod, PlyResult>>;
}

export interface SekireiMethodExport {
  method: 'sekirei';
  attemptId: string;
  identity: { engineId: string; modelId: string };
  /** 要求した探索条件（設定スナップショット）。 */
  conditions: { nodes: number; multiPV: number };
  timing: {
    /** JS 計測の全局壁時計。旧結果など未計測なら null。 */
    wholeGameWallMs: number | null;
    /** 新規探索せず保存済み結果を再利用した ply 数。 */
    cacheReuseCount: number | null;
    /** 全 ply を走査する前に中断したか。 */
    interrupted: boolean | null;
    /** 以前の試行の保存済み結果を引き継いで再開したか。 */
    resumed: boolean | null;
    completion: 'completed' | 'partial' | 'interrupted' | 'unknown';
  };
}

export interface CloudMethodExport {
  method: 'cloud-free' | 'cloud-precision';
  attemptId: string;
  /** server job 識別子（credential ではない）。jobId 不明なら null。 */
  jobId: string | null;
  profileId: 'free' | 'precision';
  /** result.identity の代表値。結果が1件も無い場合は null。 */
  identity: {
    engineName: string | null;
    modelId: string | null;
    engineSha256: string | null;
    weightSha256: string | null;
    optionsSha256: string | null;
    sourceArchiveSha256: string | null;
    sourceTreeSha256: string | null;
    driverVersion: string | null;
    contractVersion: string | null;
  } | null;
  /** 要求した profile 条件（job-profiles.json の既知値）。unknown は null。 */
  conditions: {
    requested: {
      threads: number | null;
      hashMb: number | null;
      moveTimeMs: number | null;
      multiPV: number | null;
    };
  };
  timing: {
    /** server job の createdAt（ISO）。 */
    createdAt: string | null;
    /** server job の finishedAt（ISO）。queue/retry/delivery 分割を含む全局壁時計の終端。 */
    finishedAt: string | null;
    /** export 時点の job 状態。 */
    completion: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  };
}

export type MethodExport = SekireiMethodExport | CloudMethodExport;

export interface ComparisonExport {
  schema: typeof COMPARISON_EXPORT_SCHEMA;
  schemaVersion: typeof COMPARISON_EXPORT_SCHEMA_VERSION;
  /** export 実行時刻（ISO）。 */
  exportedAt: string;
  /** 端末・OS・build の識別子（分かる範囲で、不明は null）。 */
  generator: {
    platform: 'ios' | 'android' | 'unknown';
    osVersion: string | null;
    deviceModel: string | null;
    appVersion: string | null;
    buildId: string | null;
  };
  game: {
    initialSfen: string;
    moveCount: number;
    /** 本譜の USI 指し手列（投了等の非手指し手は含めない）。 */
    moves: string[];
    /** sha256hex(initialSfen + '\n' + moves.join(' '))。 */
    moveListHash: string;
    /** レポート上の区別用ラベル（任意）。 */
    label?: string;
  };
  /** 実際に試行した方式だけを持つ。キーと method/profileId の一致を validator が確認する。 */
  methods: {
    sekirei?: SekireiMethodExport;
    'cloud-free'?: CloudMethodExport;
    'cloud-precision'?: CloudMethodExport;
  };
  plies: PlyRow[];
}
