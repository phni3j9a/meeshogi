#!/usr/bin/env node
/**
 * 比較export JSON → Markdown レポート + 機械可読 JSON の再生成 CLI（オフライン・決定的）。
 *
 * 使い方:
 *   node scripts/analysis-compare/compare.ts <export.json> [<export2.json> …]
 *        [--markdown <out.md>] [--json <out.json>]
 *
 * - 引数なし・-h/--help でこの使い方を表示して終了する。
 * - --markdown / --json を省略した場合、Markdown は stdout、JSON は書き出さない。
 * - 各 export の moveListHash を initialSfen+moves から SHA-256 で再計算して検証する。
 * - 検証に失敗したファイルは読み込まず exit 1。再計算不一致はレポートに注記する。
 *
 * Node 22.18 以降の type stripping で直接実行する（tsx 等は不要）。
 * ロジックは src/comparison/ の pure module にあり、アプリ側の writer も検証できる。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { aggregateAll } from '../../src/comparison/aggregate.ts';
import { renderReport } from '../../src/comparison/report.ts';
import { validateComparisonExport } from '../../src/comparison/validate.ts';
import type { ComparisonExport } from '../../src/comparison/schema.ts';

function moveListHashOf(data: ComparisonExport): string {
  return createHash('sha256')
    .update(`${data.game.initialSfen}\n${data.game.moves.join(' ')}`, 'utf8')
    .digest('hex');
}

function usage(): string {
  return [
    'Usage: node scripts/analysis-compare/compare.ts <export.json> [more.json …]',
    '       [--markdown <out.md>] [--json <out.json>]',
  ].join('\n');
}

function main(argv: string[]): number {
  const files: string[] = [];
  let markdownPath: string | null = null;
  let jsonPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      console.log(usage());
      return 0;
    }
    if (arg === '--markdown' || arg === '-o') {
      markdownPath = argv[++i] ?? null;
      continue;
    }
    if (arg === '--json') {
      jsonPath = argv[++i] ?? null;
      continue;
    }
    if (arg.startsWith('-')) {
      console.error(`unknown option: ${arg}\n${usage()}`);
      return 2;
    }
    files.push(arg);
  }
  if (files.length === 0) {
    console.error(`no input files.\n${usage()}`);
    return 2;
  }

  const inputs: { source: string; data: ComparisonExport; moveListHashVerified: boolean }[] = [];
  let failed = false;
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      console.error(`${file}: failed to read/parse JSON: ${String(error)}`);
      failed = true;
      continue;
    }
    const result = validateComparisonExport(parsed);
    if (!result.ok) {
      console.error(`${file}: invalid comparison export:`);
      for (const error of result.errors) console.error(`  ${error}`);
      failed = true;
      continue;
    }
    const data = result.value;
    inputs.push({
      source: basename(file),
      data,
      moveListHashVerified: moveListHashOf(data) === data.game.moveListHash,
    });
  }
  if (failed) return 1;

  const summary = aggregateAll(inputs);
  const markdown = renderReport(summary);
  if (markdownPath) {
    writeFileSync(markdownPath, `${markdown}\n`, 'utf8');
    console.error(`wrote ${markdownPath}`);
  } else {
    process.stdout.write(`${markdown}\n`);
  }
  if (jsonPath) {
    writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    console.error(`wrote ${jsonPath}`);
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
