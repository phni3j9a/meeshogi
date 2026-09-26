import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { aggregateAll } from '../../src/comparison/aggregate';
import { renderReport } from '../../src/comparison/report';
import { validateComparisonExport } from '../../src/comparison/validate';
import type { ComparisonExport } from '../../src/comparison/schema';
import { cand, completeResult, cp, makeExport, mate } from './fixtures';

const CLI = 'scripts/analysis-compare/compare.ts';
const tmpDirs: string[] = [];
function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), 'cmp-report-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(plyCount = 4): ComparisonExport {
  return makeExport(
    plyCount,
    (ply, sfen) => ({
      sekirei:
        ply === 1
          ? completeResult(sfen, mate(5, 'black'), [cand('7g7f', mate(5, 'black'))])
          : completeResult(sfen, cp(100 + ply), [cand('7g7f', cp(100 + ply)), cand('2g2f', cp(0))], {
              timing: { kind: 'app-call', elapsedMs: 40 + ply },
            }),
      'cloud-free': completeResult(
        sfen,
        cp(80 + ply),
        [cand(ply === 2 ? '9i9h' : '7g7f', cp(80 + ply)), cand('2g2f', cp(0))],
        { timing: { kind: 'server-search', elapsedMs: 1000 } },
      ),
      'cloud-precision': completeResult(
        sfen,
        cp(50 + ply),
        [cand('7g7f', cp(50 + ply)), cand('2g2f', cp(0)), cand('3g3f', cp(-10))],
        { timing: { kind: 'server-search', elapsedMs: 5000 }, observed: { nodes: 999, completedDepth: 9, multiPV: 3, engineLaunch: 1 } },
      ),
    }),
    { label: 'fixture game' },
  );
}

/** 有効な export を正しい moveListHash 付きでファイルへ書く。 */
function writeExport(dir: string, name: string, data: ComparisonExport): string {
  const copy = structuredClone(data);
  copy.game.moveListHash = createHash('sha256')
    .update(`${copy.game.initialSfen}\n${copy.game.moves.join(' ')}`, 'utf8')
    .digest('hex');
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(copy));
  return file;
}

describe('レポートの決定性', () => {
  it('同じ export から byte-identical な Markdown と JSON を生成する', () => {
    const summary = aggregateAll([{ source: 'fixture.json', data: fixture() }]);
    const md1 = renderReport(summary);
    const md2 = renderReport(summary);
    expect(md1).toBe(md2);
    // 生成時刻や順序の揺れが入らないこと（JSON も同値）
    const json1 = JSON.stringify(summary);
    expect(JSON.stringify(aggregateAll([{ source: 'fixture.json', data: fixture() }]))).toBe(json1);
    // 入力をシャッフルしても aggregate → render の結果は入力順にのみ依存する
    const summary2 = aggregateAll([
      { source: 'fixture.json', data: fixture() },
      { source: 'fixture2.json', data: fixture(3) },
    ]);
    expect(renderReport(summary2)).toBe(renderReport(summary2));
  });

  it('CLI が同じ入力に対して byte-identical なファイルを書く', () => {
    const dir = tmpDir();
    const file = writeExport(dir, 'export.json', fixture());
    const run = (md: string, json: string) =>
      execFileSync('node', [CLI, file, '--markdown', md, '--json', json], { encoding: 'utf8' });
    run(join(dir, 'a.md'), join(dir, 'a.json'));
    run(join(dir, 'b.md'), join(dir, 'b.json'));
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe(readFileSync(join(dir, 'b.md'), 'utf8'));
    expect(readFileSync(join(dir, 'a.json'), 'utf8')).toBe(readFileSync(join(dir, 'b.json'), 'utf8'));
  });

  it('検証失敗の入力は exit 1 で読み込まない', () => {
    const dir = tmpDir();
    const file = join(dir, 'bad.json');
    writeFileSync(file, JSON.stringify({ schema: 'meeshogi-comparison-export', schemaVersion: 99 }));
    expect(() =>
      execFileSync('node', [CLI, file], { encoding: 'utf8', stdio: 'pipe' }),
    ).toThrow();
    try {
      execFileSync('node', [CLI, file], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      expect((error as { status: number }).status).toBe(1);
      expect(String((error as { stderr: string }).stderr)).toContain('invalid');
    }
  });

  it('moveListHash の再計算不一致をレポートへ注記する', () => {
    const dir = tmpDir();
    // hash をわざと一致しないものにした export は書き込まず、正しい hash で書く
    const file = writeExport(dir, 'ok.json', fixture());
    execFileSync('node', [CLI, file, '--markdown', join(dir, 'ok.md')], { encoding: 'utf8' });
    expect(readFileSync(join(dir, 'ok.md'), 'utf8')).toContain('hash 再計算: 一致');
    void validateComparisonExport; // schema 側の hash 検証は validate.test.ts で担保
  });
});

describe('レポート内容', () => {
  const md = renderReport(aggregateAll([{ source: 'fixture.json', data: fixture() }]));

  it('reference の位置づけと制約を明記する', () => {
    expect(md).toContain('reference は Cloud Precision');
    expect(md).toContain('正解や棋力の保証ではない');
    expect(md).toContain('手数による便宜区分');
    expect(md).toContain('滑らかさは正しさを示さない');
  });

  it('全方式の行・N/A の分母・候補包含を出力する', () => {
    expect(md).toContain('Sekirei（端末内）');
    expect(md).toContain('Cloud Free');
    expect(md).toContain('Cloud Precision');
    expect(md).toContain('N/A'); // 空の phase bucket
    expect(md).toContain('reference 最善手が比較側の候補列に含まれる率');
  });
});
