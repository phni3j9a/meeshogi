# iOS Simulator acceptance — Issue #7

Three runs were executed on branch `issue-7-engine-correctness`:

| Run | Commit | Verdict |
|---|---|---|
| **RUN-A** | `e9b5e90` | **FAIL** — defect 1: `meta.nodes` overshoot rejected by strict `parseMeta` |
| **RUN-B** | `c8db524` (fix for defect 1) | **standard flows PASS**; **defect 2 found**: `status:"incomplete"` aborts bulk analysis on dense midgame positions |
| **RUN-C** | `1887617` (fix for defect 2: budget-shortfall → per-position skip → `partial` end state) | **PASS — all checks green** |

`1887617` resolves defect 2 by design: a validated budget-shortfall result is
skipped per-position, the scan continues to the last move, and the job ends in
a new `partial` state instead of `error`. The RUN-C run below verifies the
partial-end behavior end-to-end plus the required regressions.

---

## RUN-C (`1887617`) — result matrix

| Flow / check | Result | Evidence |
|---|---|---|
| xcodebuild Release iphonesimulator arm64 | **PASS** | `build.log` — BUILD SUCCEEDED |
| licenses-review | **PASS** | `runs/20260922T162013Z-7504/maestro/licenses-review/` |
| import-review | **PASS** | `runs/20260922T162013Z-7504/maestro/import-review/` |
| ios-visual-review | **PASS** (2m+) | `runs/20260922T162013Z-7504/maestro/ios-visual-review/` |

### Partial-end spec verification — KeroPona real game (81 positions @ 10k nodes)

| # | Spec | Result | Evidence |
|---|---|---|---|
| 1 | 全局解析 runs to the LAST position; incomplete positions skipped — not saved, not shown | **PASS** — 65/81 records stored; missing plies are exactly `41,43,45,47,49,50,51,52,54,57,59,61,62,63,64,77` (16 plies; all shortfall positions previously probed). Graph renders them as dotted gaps; skipped ply shows `—` eval + `解析すると候補手を確認できます` | `runs/keropona-partial-live.db`, `runs/partial-check/.../partial-02-skipped-ply-empty.png` |
| 2 | `解析処理が終了しました` + aggregated notice; no per-position dialogs; `全局解析が完了しました` absent | **PASS** — notice reads `解析処理が終了しました。65 / 81局面を解析済み、16局面は探索量不足です。設定の解析量（ノード数）を増やすか、「この局面を深く解析」をお試しください。` No dialogs. `全局解析が完了しました` and `解析に失敗しました` both asserted NOT visible | `runs/partial-check/.../partial-01-partial-end.png` |
| 3 | Skipped ply keeps missing eval/graph points; positions AFTER it show valid results | **PASS** — ply 41: `—` 先手評価, empty candidate list, graph gap; ply 42+ show own records (`analysis-ready`) | `runs/partial-check/.../partial-03-after-gap-evaluated.png` |
| 4 | 「解析を再開」 retries ONLY the missing plies; shortfall-again at 10k is expected; run ends `partial` not `error` | **PASS** — resume run finishes in ~1s (16 plies × ~50ms vs ~17s for a full 81-position scan). Transient `解析中` is unobservable by Maestro polls AND by a 5fps screen recording, so the run was proven via host CPU sampling: app PID burst 21.3%→56.3%→**85.7%**→33.6%→13.8% over ~0.8s after the tap. End state: `partial` (notice re-shown, `解析に失敗しました` absent) | `runs/cpu-watch-resume.txt`, `runs/resume-watch2.mov`, `runs/resume-restart3/.../resume-03-still-partial.png` |
| 5 | Stop/resume, settings change mid-run, app restart → honest display | **PASS** — stop mid-run → `解析を停止中 N / 81局面` (paused); settings change 10k→50k → `この棋譜は未解析です` + honest `以前のモデル・解析条件の結果が65局面あります` (no fabricated gap-reason; `探索量不足` absent on that screen); app restart → `解析済み 65 / 81局面` | `runs/settings-stop5/.../settings-0*.png`, `runs/resume-restart3/.../resume-04-restart-honest.png` |
| 6 | Regressions | **PASS** — complete games still end `全局解析が完了しました` (50k rescan of KeroPona after the partial run; sente-mate game); mate display both signs (`先手勝ち・詰み終局` + `後手勝ち・詰み終局`, graphs at ±1500 edge); overshoot persists (record with `meta.nodes > requestedNodes` stored in DB); old-cache exclusion logic `src/analysis/cache.ts` is **byte-identical** to RUN-B where exclusion was functionally verified (see Constraints) | `runs/settings-stop5/.../settings-06-complete.png`, `runs/mate-sente/`, `runs/mate-gote2/`, `/tmp DB check` |
| 7 | Screenshots of partial-end + post-skip positions | **PASS** | `partial-0*.png`, `settings-0*.png`, `resume-0*.png`, `mate-*-0*.png` |

### RUN-C notes

- The 34-ply gote-mate game also ends `partial` at 10k
  (`7 / 35局面を解析済み、28局面は探索量不足です` — mate-heavy positions are
  node-hungry at the default budget). `後手勝ち・詰み終局` still displayed via
  focused analysis (50k). This is consistent, correct new behavior — second
  live instance of the aggregated notice.
- Resume's ~1s transient could not be captured by any polling/screenshot
  method — the CPU-spike method (`runs/cpu-watch-resume.txt`) is the proof
  the retry actually ran.
- Defect 2 is resolved: no `incomplete` abort, no `解析に失敗しました`,
  deterministic ply-41-style deaths are gone.

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
  analysis reaching the terminal ply — on RUN-B this was blocked by defect 2;
  on RUN-C bulk analysis runs to the last ply (mate games included).
- `mate=0 → no M1 badge`: verified structurally — no M badges anywhere except
  the proven `後手・3手詰め ›` at ply 67.
- RUN-C old-cache exclusion is reported by code-inheritance:
  `git diff c8db524 1887617 -- src/analysis/cache.ts` is empty, and the
  exclusion was functionally verified on RUN-B (`manual-migration-fixed`,
  `migration/*.db`). Re-running the old-app cycle on RUN-C would have tested
  identical code.
- Resume-transient proof method: the ~1s `解析中` window on a partial resume
  (skipped plies only) is below Maestro's poll granularity and a 5fps screen
  recording; the host `ps` CPU burst on the app PID is the positive evidence
  that the retry engine run happened.
- No tracked files modified. All helper flows live under `helpers/`.
