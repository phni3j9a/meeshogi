# iOS Simulator acceptance — Issue #7 (`e9b5e90`)

**Verdict: FAIL** — build succeeds, but game analysis crashes at ply 0 on a
deterministic engine/validation contract mismatch. Every analysis-dependent
feature (eval graph, candidates, mate badges, deep analysis) is unreachable
in the app. Non-analysis features work, and the old-cache exclusion logic
itself behaves correctly.

## Result matrix

| Flow / check | Result | Evidence |
|---|---|---|
| xcodebuild Release iphonesimulator arm64 | **PASS** | `build.log` — BUILD SUCCEEDED |
| licenses-review | **PASS** | `runs/20260922T132739Z-5546/maestro/licenses-review/` |
| import-review | **FAIL** — `analysis-ready` never appears; error banner `ネイティブ解析結果の meta の整数範囲が不正です。` | junit.xml, `step-020` screenshot |
| ios-visual-review | **FAIL** — same `analysis-ready` signature (all pre-analysis steps passed: settings, names, statistics, board) | `runs/manual-ios-visual2/` |
| analysis-review (new build) | NOT RUN — cannot pass while analysis crashes at ply 0 | — |
| **#1 stored engineId = new ENGINE_ID** | **BLOCKED in-app** (no analysis record can be stored); **engine-verified**: raw engine output returns `sekirei-v0.3.37@7fd1d9b4…+meeshogi-analysis-v2+eval-material1-nnue1-bias0-clip0` | `engine-probe/probe-output.txt` |
| **#2 詰み終局 display both signs** | **BLOCKED in-app** (analysis dies before any position is stored); **engine-verified**: both mate final SFENs return `status:complete, terminal:"checkmate", nodes:0` | `mate-kifs/*.kif`, `verify-output.txt`, `probe-output.txt` |
| **#3 analysis stop/resume + branch** | **BLOCKED** — startAnalysis errors before any resume point; branch UI (`分岐検討`, `0手目から分岐`, `本譜に戻る`) verified working on **old** build via analysis-review PASS | `runs/manual-oldapp-analysis/` |
| **#4 old-cache migration** | **PASS (exclusion side)** — 81 old-ENGINE_ID records preserved+readable, excluded from graph/panel/badges/completion, exclusion persists after restart. Re-analysis attempt reproducibly errors (same meta bug), so "re-analysis yields only new points" is blocked. | `runs/manual-migration/` (PASSED), `migration/*.db` |
| **#5 eval/graph sente perspective, glyphs, badges** | **PARTIAL** — board, 先手評価 axis, empty-state text render correctly with no missing glyphs; no spurious mate badges observed anywhere (including ply 80 which had old mateProof data). Live eval values/graph line unreachable. | `runs/manual-ios-visual2/takeScreenshot/`, `manual-migration/takeScreenshot/` |

## Root cause

`native/sekirei` returns `meta.nodes` **greater than** `meta.requestedNodes`
for some positions — deterministically `10001` vs `10000` at the standard
startpos (mid-game positions can return exactly `10000`). The strict
`parseMeta` contract added in this branch
(`src/analysis/native-engine.ts`, `nodes > requestedNodes` → throw
`ネイティブ解析結果の meta の整数範囲が不正です。`) rejects that payload, so
`startAnalysis` throws on the first position and stores nothing.

Confirmed independently on the host with an rlib probe of the same
`meeshogi-sekirei` source + model (`engine-probe/probe-output.txt`):

```
startpos : {"requestedNodes":10000,"nodes":10001,...,"budgetReached":true}
midgame  : {"requestedNodes":10000,"nodes":10000,...,"budgetReached":true}
mate SFEN: {"status":"complete","terminal":"checkmate","nodes":0,...}
```

The old build (v0.3.36, no such meta validation) completes the full
81-position analysis on the same device — `analysis-review` PASSED
(`runs/manual-oldapp-analysis/`).

## What works

- Import (clipboard KIF), game browsing, library, settings, player names,
  statistics, opening classification — all verified in the run screenshots.
- Upgrade path: old-ENGINE_ID records are preserved in SQLite and correctly
  suppressed from every surface; the kifu stays readable; state persists
  across restart.

## Constraints / notes

- `ios-acceptance.sh` exits on the first failing flow (`set -e`), so
  `ios-visual-review` was re-run manually with identical clipboard
  preparation (`runs/manual-ios-visual2/`).
- The mate-display checks (#2) could not exercise the app UI because no
  analysis can be produced; KIF legality + real checkmate were verified via
  `src/domain` (tsshogi) and the engine's `terminal:"checkmate"` was verified
  on the host. Screenshots of the 詰み終局 display therefore do not exist.
- `mate=0 → no M1 badge` and resign/timeout behaviour could not be exercised
  for the same reason.
- The mate KIFs and `verify-mates.cjs` live in `mate-kifs/` per instructions.
- No tracked files were modified. Helper flows are under `artifacts/ios/helpers/`.
