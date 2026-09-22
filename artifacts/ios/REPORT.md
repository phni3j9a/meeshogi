# iOS Simulator acceptance — Issue #7

Two runs were executed on branch `issue-7-engine-correctness`:

| Run | Commit | Verdict |
|---|---|---|
| **RUN-A** | `e9b5e90` | **FAIL** — defect 1: `meta.nodes` overshoot rejected by strict `parseMeta` |
| **RUN-B** | `c8db524` (fix for defect 1) | **standard flows PASS**; **defect 2 found**: `status:"incomplete"` aborts bulk analysis on dense midgame positions |

`c8db524` fixes the RUN-A failure — `meta.nodes` is now treated as an observed
non-negative integer and may exceed `requestedNodes`. The RUN-B run below is
the acceptance on the fix.

---

## RUN-B (`c8db524`) — result matrix

| Flow / check | Result | Evidence |
|---|---|---|
| xcodebuild Release iphonesimulator arm64 | **PASS** | `build.log` — BUILD SUCCEEDED |
| licenses-review | **PASS** | `runs/20260922T144439Z-17396/maestro/licenses-review/` |
| import-review | **PASS** (58s) | `runs/20260922T144439Z-17396/maestro/import-review/` — `analysis-ready` appears once the first record is stored; `analysis-stop` pauses the job (10 records in `migration/acceptance-meeshogi.db`) |
| ios-visual-review | **PASS** (2m30s) | `runs/20260922T144439Z-17396/maestro/ios-visual-review/` — settings, names, statistics, board, eval -38 先手評価, candidates, focused analysis, mate badge `後手・3手詰め ›` at ply 67 |
| **#1 stored engineId = new ENGINE_ID** | **PASS** — every stored record carries `sekirei-v0.3.37@7fd1d9b4…+meeshogi-analysis-v2+eval-material1-nnue1-bias0-clip0` | `migration/after-resume-meeshogi.db` (41 recs), `mate-kifs/meeshogi-mate-sente.db` (30 recs incl. terminal@29) |
| **#2 詰み終局 display, both signs** | **PASS** — sente: `先手勝ち・詰み終局` + graph climbs to +1500 edge @ply29 + `全局解析が完了しました`; gote: `後手勝ち・詰み終局` display correct (via focused analysis). Graph −1500 endpoint for gote **not persistable** (bulk job died at ply 4 → focused result is transient-only by design) | `runs/mate-sente/.../mate-0*.png`, `runs/mate-gote/.../mate-gote-0*.png`, `mate-kifs/` |
| **#3 stop/resume + branch** | **PARTIAL** — stop works (import-review paused at 10 recs); resume works mechanically but deterministically dies at ply 41 (defect 2); branch `分岐検討`/`0手目から分岐`/`本譜に戻る` all work | `runs/resume-incomplete/` (10→41 then `incomplete`), `runs/branch-check/` (PASS) |
| **#4 old-cache migration** | **PASS** — 81 old-ENGINE_ID records preserved+readable, excluded from graph/panel/badges/completion (`以前のモデル・解析条件の結果が40局面あります` banner); re-analysis stores only new-ID points; exclusion persists across restart; 41 new + 40 old coexist | `runs/manual-migration-fixed/` (exclusion asserts all passed; completion wait hit defect 2), `migration/*.db` |
| **#5 perspective / glyphs / badges** | **PASS** — `-38 先手評価` at startpos consistent sente perspective with graph; no missing glyphs; no spurious mate badges (M badges appear only for proven mateProof) | `runs/20260922T144439Z-17396/maestro/ios-visual-review/takeScreenshot/` |

### RUN-B defect 2 — `status:"incomplete"` kills bulk analysis mid-game

Reproduced deterministically in-app and on the host probe
(`engine-probe/probe-output-c8db524.txt`):

- Engine: when the node budget (10 000 default) is exhausted before iteration
  1 completes (`info.depth == 0` / `lines.len() < expected_candidates`), the
  engine returns `status:"incomplete"` with `completedDepth:0`,
  `fallback:true`, one depth-0 candidate.
- App: `src/analysis/native-engine.ts:255` treats any status ≠ `complete` as
  fatal → `ネイティブ解析が完了しませんでした: incomplete` → `startAnalysis`
  aborts the whole job.
- Observed: KeroPona 80-ply game dies at ply index 41 every time (records 0–40
  stored, resumable state, resume re-fails at the same position — 10→41→error).
  The 34-ply gote-mate game dies at ply 4.
- Same position at 50 000 nodes returns `status:"complete"`, completedDepth 3.
- Consequence: `全局解析が完了しました` is unreachable on real-length games at
  the default budget — full-game completion (and gote −1500 graph endpoint,
  ply-51-style stored mate badges) could not be exercised.

### RUN-B what works

- All three standard flows green on the new binary.
- Meta fix verified end-to-end: ply-0 record stores `nodes:10001` >
  `requestedNodes:10000` without error.
- Focused analysis (50k nodes) completes, shows transient
  `この局面の追加解析結果を表示中` + proven `3手詰め` badge (not persisted — by
  design, `focusedAnalysis` is component state).

---

## RUN-A (`e9b5e90`) — result matrix (previous run, kept for the record)

| Flow / check | Result | Evidence |
|---|---|---|
| xcodebuild | PASS | build.log in evidence commit `3e98d6a` |
| licenses-review | **PASS** | `runs/20260922T132739Z-5546/maestro/licenses-review/` |
| import-review | **FAIL** — `analysis-ready` 180s timeout; banner `ネイティブ解析結果の meta の整数範囲が不正です。` | `runs/20260922T132739Z-5546/maestro/import-review/` |
| ios-visual-review | **FAIL** — same signature (manual rerun; script exits on first failure) | `runs/manual-ios-visual2/` |
| #1 stored engineId | BLOCKED in-app; engine-verified new ENGINE_ID | `engine-probe/probe-output.txt` |
| #2 mate display | BLOCKED in-app; KIF legality + `terminal:"checkmate"` engine-verified | `mate-kifs/`, `probe-output.txt` |
| #3 stop/resume+branch | BLOCKED (no record ever stored); verified working on old build | `runs/manual-oldapp-analysis/` |
| #4 migration exclusion | **PASS** (exclusion side) | `runs/manual-migration/`, `migration/*.db` |
| #5 perspective/glyphs | PARTIAL — chrome correct, live eval unreachable | screenshots in the run dirs |

### RUN-A root cause (fixed by c8db524)

sekirei v0.3.37 returns `meta.nodes:10001` for `requestedNodes:10000` at
startpos (stop-check granularity); the strict `parseMeta`
(`nodes > requestedNodes` → throw) rejected it → `startAnalysis` failed on
the first position → zero records → all analysis surfaces unreachable.

Host probe (`engine-probe/probe-output.txt`):

```
startpos : {"requestedNodes":10000,"nodes":10001,...,"budgetReached":true}
midgame  : {"requestedNodes":10000,"nodes":10000,...,"budgetReached":true}
mate SFEN: {"status":"complete","terminal":"checkmate","nodes":0,...}
```

## Constraints / notes

- `ios-acceptance.sh` exits on the first failing flow (`set -e`); manual
  reruns used identical clipboard preparation.
- Mate KIFs verified legal + real checkmate via `src/domain` (tsshogi)
  brute-force legal-move scan (`mate-kifs/verify-mates.cjs`,
  `verify-output.txt`); the app parser requires the `N+1 詰み` terminal-move
  row, included in both KIFs.
- Focused analysis results are display-only by design (`useState` in
  `app/game/[id].tsx`), so the gote graph −1500 endpoint requires bulk
  analysis reaching the terminal ply — blocked by defect 2.
- `mate=0 → no M1 badge`: verified structurally — no M badges anywhere except
  the proven `後手・3手詰め ›` at ply 67.
- No tracked files modified. All helper flows live under `helpers/`.
