import {
  PHASE_IDS,
  PHASE_LABELS,
  type ComparisonSummary,
  type ExportSummary,
  type MethodTimingSummary,
  type PairwiseSummary,
  type PlyComparisonRow,
  type PlyExclusion,
  type PlySideView,
  type Ratio,
  type Stats,
} from './aggregate.ts';
import {
  COMPARISON_METHODS,
  type CloudMethodExport,
  type ComparisonMethod,
  type MethodExport,
  type SekireiMethodExport,
} from './schema.ts';

/** ComparisonSummary を決定的な Markdown レポートへ変換する。生成時刻は埋め込まない。 */

export const METHOD_LABELS: Record<ComparisonMethod, string> = {
  sekirei: 'Sekirei（端末内）',
  'cloud-free': 'Cloud Free',
  'cloud-precision': 'Cloud Precision',
};

function fmtNum(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function fmtMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '不明';
  return `${fmtNum(value)} ms`;
}

function fmtRatio(r: Ratio): string {
  if (r.denominator === 0 || r.rate === null) return `N/A（${r.numerator}/${r.denominator}）`;
  return `${(r.rate * 100).toFixed(1)}%（${r.numerator}/${r.denominator}）`;
}

function fmtStats(s: Stats): string {
  if (s.count === 0) return 'N/A';
  return `n=${s.count}・中央値 ${fmtNum(s.median)}・p90 ${fmtNum(s.p90)}・最大 ${fmtNum(s.max)}`;
}

function methodConditions(method: MethodExport): string {
  if (method.method === 'sekirei') {
    const m = method as SekireiMethodExport;
    return `nodes ${m.conditions.nodes}・MultiPV ${m.conditions.multiPV}`;
  }
  const m = method as CloudMethodExport;
  const req = m.conditions.requested;
  const parts = [
    req.moveTimeMs !== null ? `${req.moveTimeMs}ms` : null,
    req.multiPV !== null ? `MultiPV ${req.multiPV}` : null,
    req.threads !== null ? `Threads ${req.threads}` : null,
    req.hashMb !== null ? `Hash ${req.hashMb}MiB` : null,
  ].filter((p): p is string => p !== null);
  return `profile ${m.profileId}（${parts.length ? parts.join('・') : '条件不明'}）`;
}

function methodIdentity(method: MethodExport): string {
  if (method.method === 'sekirei') {
    return `engine \`${method.identity.engineId}\` / model \`${method.identity.modelId}\``;
  }
  if (!method.identity) return '（結果行なし・identity 不明）';
  const identity = method.identity;
  const head = [identity.engineName ?? 'engine不明', identity.modelId ?? 'model不明'].join(' / ');
  const tail = [identity.driverVersion, identity.contractVersion]
    .filter((v): v is string => v !== null)
    .join(' / ');
  const digests = [identity.engineSha256, identity.weightSha256]
    .map((v) => (v ? `${v.slice(0, 12)}…` : null))
    .filter((v): v is string => v !== null);
  return `${head}${tail ? `（${tail}）` : ''}${digests.length ? ` sha256:${digests.join('/')}` : ''}`;
}

function runKindLabel(t: MethodTimingSummary): string {
  if (t.boundary === 'server-job') return `server job（${t.completion}）`;
  switch (t.runKind) {
    case 'fresh-complete':
      return '新規解析で完了';
    case 'completed-with-cache-reuse':
      return 'cache再利用を含む完了';
    case 'resumed':
      return '再開で完了';
    case 'partial':
      return 'partial（探索量不足あり）';
    case 'interrupted':
      return '中断';
    default:
      return '不明（旧結果等）';
  }
}

const EXCLUSION_LABELS: Record<PlyExclusion, string> = {
  'missing-both': '双方欠測',
  'missing-compared': '比較側欠測',
  'missing-reference': 'reference欠測',
  'incomplete-both': '双方incomplete',
  'incomplete-compared': '比較側incomplete',
  'incomplete-reference': 'reference incomplete',
  'sfen-mismatch': 'SFEN不一致',
  'terminal-mismatch': '片側のみ終局',
};

/** 1方式側の生評価を短く表示する（mate/terminal を cp に換算しない）。 */
function fmtSideEval(side: PlySideView): string {
  if (side.status === 'absent') return '行なし';
  if (side.status === 'missing') return 'missing';
  if (side.status === 'incomplete') return 'incomplete';
  if (side.status === 'terminal') {
    if (side.terminal?.kind === 'checkmate') {
      return `詰み終局・${side.terminal.winner === 'black' ? '先手' : '後手'}`;
    }
    return '合法手なし終局';
  }
  const evaluation = side.evaluation;
  if (!evaluation) return '?';
  if (evaluation.kind === 'cp') return `${evaluation.value > 0 ? '+' : ''}${evaluation.value}`;
  if (evaluation.winner === 'unknown') return 'mate(不明)';
  return `${evaluation.value > 0 ? '+' : '-'}M${Math.abs(evaluation.value)}`;
}

/** ply 別の行を出す（完全な SFEN は JSON に残し、表では盤面フィールドを短いキーにする）。 */
function renderPlyRows(rows: PlyComparisonRow[]): string[] {
  if (rows.length === 0) return [];
  const lines: string[] = [];
  lines.push(
    '##### ply 別の評価値（生値は先手視点。Δ は両側が有効な cp のときだけ、それ以外は除外/欠測理由）',
    '',
    '| ply | 局面 | 比較側 | reference | Δ | \\|Δ\\| | 状態 |',
    '|---:|---|---|---|---:|---:|---|',
  );
  for (const row of rows) {
    const sfenKey = `\`${row.sfen.split(' ')[0]}\``;
    const reason =
      row.exclusion !== null
        ? EXCLUSION_LABELS[row.exclusion]
        : row.compared.evaluation && row.reference.evaluation &&
            row.compared.evaluation.kind !== row.reference.evaluation.kind
          ? '種別不一致（cp×mate）'
          : '—';
    lines.push(
      `| ${row.ply} | ${sfenKey} | ${fmtSideEval(row.compared)} | ${fmtSideEval(row.reference)} | ` +
        `${row.cpDiff !== null ? (row.cpDiff > 0 ? `+${row.cpDiff}` : String(row.cpDiff)) : '—'} | ` +
        `${row.cpAbsDiff ?? '—'} | ${reason} |`,
    );
  }
  lines.push('');
  return lines;
}

function renderPairwise(heading: string, c: PairwiseSummary): string[] {
  const cov = c.coverage;
  const lines: string[] = [];
  lines.push(`#### ${heading} vs Cloud Precision（reference）`, '');
  lines.push(
    `- 比較対象 ply: ${cov.comparedPairs} / ${cov.plies}` +
      `（除外: 双方欠測 ${cov.missingBoth}・比較側のみ欠測 ${cov.missingCompared}・referenceのみ欠測 ${cov.missingReference}・SFEN不一致 ${cov.sfenMismatch}・incomplete 比較側 ${cov.incompleteCompared} / reference側 ${cov.incompleteReference}）`,
  );
  lines.push(
    `- 先手視点 CP 差（両側が有効な cp のみ。mate/terminal は換算しない）:` +
      ` n=${c.cpDiff.count}・符号差 中央値 ${fmtNum(c.cpDiff.median)} / |差| 中央値 ${fmtNum(c.cpAbsDiff.median)}・p90 ${fmtNum(c.cpAbsDiff.p90)}・最大 ${fmtNum(c.cpAbsDiff.max)}`,
  );
  lines.push(`- Top-1 一致率: ${fmtRatio(c.top1Agreement)}`);
  lines.push(
    `- reference 最善手が比較側の候補列に含まれる率: ${fmtRatio(c.refBestMoveInclusion)}` +
      `（要求候補数 ${c.candidateCounts.requested ?? '不明'}・実効候補数 ${fmtStats(c.candidateCounts.effective)}）`,
  );
  lines.push(
    `- 評価の種別（双方 complete のみ）: cp×cp ${c.scoreKind.bothCp}・mate×mate ${c.scoreKind.bothMate}` +
      `・ref=cp/比較側=mate ${c.scoreKind.refCpCmpMate}・ref=mate/比較側=cp ${c.scoreKind.refMateCmpCp}`,
  );
  if (c.mateWinner.pairs > 0) {
    lines.push(
      `- mate 勝者の一致（mate×mate ${c.mateWinner.pairs} 組）: 一致 ${c.mateWinner.agree}・不一致 ${c.mateWinner.disagree}` +
        `（ref unknown ${c.mateWinner.refUnknown}・比較側 unknown ${c.mateWinner.cmpUnknown}）。` +
        `生の手数一致 ${c.mateWinner.distanceExact} 組（参考値・品質指標ではない）`,
    );
  }
  lines.push(
    `- terminal: 双方 terminal ${c.terminal.pairs} 組（種別一致 ${c.terminal.kindAgree}・不一致 ${c.terminal.kindDisagree}` +
      `・勝者一致 ${c.terminal.winnerAgree}・不一致 ${c.terminal.winnerDisagree}）・片側のみ terminal ${c.terminal.oneSidedPairs} 組`,
  );
  lines.push('');
  lines.push('| 区分 | 対象 ply | 比較可能 | cp ペア | \\|Δcp\\| 中央値 / p90 | Top-1 | ref最善手の包含 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const phase of PHASE_IDS) {
    const p = c.byPhase[phase];
    const cell = (r: Ratio) => (r.denominator === 0 ? 'N/A' : fmtRatio(r));
    lines.push(
      `| ${PHASE_LABELS[phase]} | ${p.plies} | ${p.comparablePairs} | ${p.cpPairs} | ` +
        `${p.cpPairs === 0 ? 'N/A' : `${fmtNum(p.cpAbsDiff.median)} / ${fmtNum(p.cpAbsDiff.p90)}`} | ` +
        `${cell(p.top1)} | ${cell(p.bestMoveInclusion)} |`,
    );
  }
  lines.push('');
  lines.push(...renderPlyRows(c.plyRows));
  return lines;
}

function renderVolatilityTable(volatility: ExportSummary['volatility']): string[] {
  const lines: string[] = [];
  lines.push('| 方式 | 有効 ply | 隣接ペア | \\|Δ\\| 中央値 | p90 | 最大 |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const v of volatility) {
    lines.push(
      `| ${METHOD_LABELS[v.method]} | ${v.validPlies} | ${v.adjacentAbsDiff.count} | ` +
        `${fmtNum(v.adjacentAbsDiff.median)} | ${fmtNum(v.adjacentAbsDiff.p90)} | ${fmtNum(v.adjacentAbsDiff.max)} |`,
    );
  }
  return lines;
}

function renderExportSection(e: ExportSummary, index: number): string[] {
  const lines: string[] = [];
  const title = (e.game.label ?? `${e.game.moveListHash.slice(0, 12)}…（${e.game.moveCount} 手）`).replace(
    /[\r\n]+/gu,
    ' ',
  );
  const device = [e.generator.platform, e.generator.deviceModel, e.generator.osVersion]
    .filter((v): v is string => v !== null && v !== 'unknown')
    .join(' / ');
  const build = [e.generator.appVersion, e.generator.buildId]
    .filter((v): v is string => v !== null)
    .join(' / ');
  lines.push(
    `## ${index + 1}. ${title}`,
    '',
    `- 棋譜: hash \`${e.game.moveListHash.slice(0, 16)}…\`・${e.game.moveCount} 手・初期局面 \`${e.game.initialSfen}\``,
    `- export: ${e.exportedAt}・端末 ${device || '不明'}・build ${build || '不明'}` +
      `・hash 再計算: ${e.moveListHashVerified === null ? '未検証' : e.moveListHashVerified ? '一致' : '**不一致**'}`,
    '',
    '| 方式 | 試行 | complete | incomplete | terminal | missing | 条件 | identity |',
    '|---|---|---:|---:|---:|---:|---|---|',
  );
  for (const method of COMPARISON_METHODS) {
    const counts = e.methods[method];
    if (!counts.present) {
      lines.push(`| ${METHOD_LABELS[method]} | 未実行 | – | – | – | – | — | — |`);
      continue;
    }
    const missingCell =
      counts.statusCounts.absent > 0
        ? `${counts.statusCounts.missing}（行なし ${counts.statusCounts.absent}）`
        : `${counts.statusCounts.missing}`;
    lines.push(
      `| ${METHOD_LABELS[method]} | \`${counts.attemptId ?? '?'}\` | ${counts.statusCounts.complete} | ` +
        `${counts.statusCounts.incomplete} | ${counts.statusCounts.terminal} | ${missingCell} | ` +
        `${counts.detail ? methodConditions(counts.detail) : '—'} | ${counts.detail ? methodIdentity(counts.detail) : '—'} |`,
    );
  }
  if (
    COMPARISON_METHODS.some(
      (method) => e.methods[method].present && e.methods[method].statusCounts.absent > 0,
    )
  ) {
    lines.push(
      '',
      '- missing は明示 missing 行と結果行なし（行なし N）の合計。方式ごとの合計は局面数に一致する。',
    );
  }
  lines.push('');

  if (e.comparisons.length === 0) {
    lines.push('（Cloud Precision の結果がこの export に無いため方式間比較はなし）', '');
  }
  for (const c of e.comparisons) {
    lines.push(...renderPairwise(METHOD_LABELS[c.method], c));
  }

  const anySfenMismatch = e.volatility.some((v) => v.sfenMismatchRows > 0);
  lines.push(
    '#### グラフ変動（アプリの表示値・±1500 clip と mate/terminal 写像を適用。正しさではなく画面の見え方の変動量）',
    '',
    ...(anySfenMismatch
      ? [
          `結果側 SFEN が行と異なり欠測として扱った行: ${e.volatility
            .filter((v) => v.sfenMismatchRows > 0)
            .map((v) => `${METHOD_LABELS[v.method]} ${v.sfenMismatchRows}`)
            .join('・')}`,
          '',
        ]
      : []),
    ...renderVolatilityTable(e.volatility),
    '',
  );

  lines.push(
    '#### タイミング（計測境界ごとに分離。Issue #20 の同期 benchmark 時間は流用していない）',
    '',
    '| 方式 | 計測境界 | 全局時間 | 局面時間 | cache再利用 | 状態 |',
    '|---|---|---|---|---:|---|',
  );
  for (const t of e.timing) {
    const perPos =
      t.perPositionKind === null || t.perPosition.count === 0
        ? '不明'
        : t.perPositionKind === 'server-search'
          ? `search+drain ${fmtStats(t.perPosition)}ms`
          : `アプリ呼出し ${fmtStats(t.perPosition)}ms`;
    const wall =
      t.boundary === 'server-job'
        ? `${fmtMs(t.wholeGameWallMs)}（server createdAt→finishedAt・queue/retry込み）`
        : `${fmtMs(t.wholeGameWallMs)}（JS計測の全局壁時計）`;
    lines.push(
      `| ${METHOD_LABELS[t.method]} | ${t.boundary === 'server-job' ? 'server job' : 'アプリJS'} | ` +
        `${wall} | ${perPos} | ${t.cacheReuseCount ?? '—'} | ${runKindLabel(t)} |`,
    );
  }
  lines.push('');
  return lines;
}

export function renderReport(summary: ComparisonSummary): string {
  const lines: string[] = [];
  lines.push('# meeshogi 解析方式の比較レポート（開発用）', '');
  lines.push(
    '同一棋譜を Sekirei / Cloud Free / Cloud Precision で解析した export から `scripts/analysis-compare` で再生成した集計。同じ入力からは常に同じレポートが生成される。',
    '',
    '## 前提と reference の位置づけ',
    '',
    `- **reference は Cloud Precision**（\`${summary.reference.method}\`）。深い参照であって、正解や棋力の保証ではない。`,
    '- Issue #20 benchmark の基準条件（standard-3 / 10000ms / MultiPV 3）とは**別の条件**。ここでは job API の Precision（5000ms / MultiPV 3）を使う。',
    '- 評価値はすべて先手（black）視点。mate・terminal を cp へ換算しない。未解析・incomplete を「mate なし」として数えない。',
    '- 序盤/中盤/終盤は ply 0–40 / 41–90 / 91+ の手数による便宜区分で、局面内容から実際の戦況を判定したものではない。対象の無い区分は N/A。',
    '- mate の生の手数は残すが、両エンジンの距離規約は未確認のため、距離の完全一致は品質指標にしない。mateProof（証明済み詰め）の有無は Cloud の精度不一致として数えない。',
    '- グラフ変動はアプリの表示値（±1500 clip・mate/terminal 写像）の隣接 ply 差。画面上の変動量であり、滑らかさは正しさを示さない。',
    '',
    '## 入力',
    '',
    '| # | ファイル | 棋譜 hash | 手数 | exportedAt | platform |',
    '|---|---|---|---:|---|---|',
  );
  summary.inputs.forEach((input, i) => {
    lines.push(
      `| ${i + 1} | ${input.source} | \`${input.moveListHash.slice(0, 12)}…\` | ${input.moveCount} | ${input.exportedAt} | ${input.platform} |`,
    );
  });
  lines.push('');

  summary.exports.forEach((e, i) => {
    lines.push(...renderExportSection(e, i));
  });

  if (summary.exports.length > 1) {
    lines.push('## 全 export の合算', '');
    if (summary.overall.comparisons.length === 0) {
      lines.push('（reference を持つ export がないため合算比較はなし）', '');
    }
    for (const c of summary.overall.comparisons) {
      lines.push(...renderPairwise(`${METHOD_LABELS[c.method]}（合算）`, c));
    }
    if (summary.overall.volatility.length > 0) {
      lines.push('#### グラフ変動（合算）', '', ...renderVolatilityTable(summary.overall.volatility), '');
    }
  }

  lines.push('## 残る注意', '');
  lines.push(
    '- terminal の種別は `checkmate`（詰み終局・勝者あり）と `no-legal-moves`（合法手なし・勝者なし）を区別する。',
    '- Cloud の `server-search` 時間は session 内の search+drain で、engine 起動・queue・network・端末での受信時間を含まない。job の createdAt→finishedAt（queue/retry 込み）と別に扱う。',
    '- Sekirei の `app-call` 時間は JS 側の呼出し壁時計。cache 再利用の ply は呼出し自体が無いため分母に入らない。',
    '- Cloud job の `completed` は server 処理の終了であり、全局面の有効な評価成立を保証しない（incomplete 行が残り得る）。',
    '',
  );
  return lines.join('\n');
}
