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

---

# RUN-D — f376ee7 suite-wiring validation (2026-09-22)

Scope: full acceptance suite in the NEW order (analysis-partial-review wired
between analysis-review and candidate-review; background-review initial
asserts updated for the shared 50k state). Product code is identical to
1887617 (RUN-C) — `.maestro/**` + runner scripts only — so RUN-C product
checks stand; this run validates the suite definition end-to-end on iOS.

## Build / environment

- Commit: `f376ee7` (issue-7-engine-correctness). `npm ci`; product code
  unchanged vs 1887617 → existing RUN-C binary reused (verified: no
  src/**, native/**, package.json diffs).
- Device: iPhone 18 Pro, iOS 27.0 (udid 1308A109-3EE0-4711-9287-85246639DBC7)
- Run dir: `runs/20260922T184318Z-12026/` (junit.xml per flow, screenshots,
  hierarchy dumps, commands.json per step)

## Per-flow results (15/16 PASS)

| Flow | Result | Notes |
|---|---|---|
| licenses-review | PASS | stock yaml |
| import-review | PASS | stock yaml |
| player-names | PASS (ios helper) | `hideKeyboard` → `完了` nav button (commits + pops to settings); Android `names-save`/`保存して反映` steps are subsumed on iOS — `asitaka_y` persisted in settings.playerNames.shogiwars |
| player-names-kiou | PASS (ios helper) | same `完了` behavior; `シシ神` persisted in settings.playerNames.kiou |
| analysis-review | PASS (ios helper) | 50k full completion → `全局解析が完了しました`; mate badges ply 67 `後手・3手詰め ›`, ply 51 `先手・1手詰め ›`; SQLite reload; post-settings tab via `棋譜, tab.*` (the `棋譜.*` selector hits 棋譜解析 heading on iOS — same trap the 7448f94 fix addresses); move-prev guard taps for dropped-tap drift |
| analysis-partial-review | PASS (ios helper) | partial end at 標準: `解析処理が終了しました` + `65 / 81局面を解析済み、16局面は探索量不足です`; ply-41 `—`/no candidates; `解析を再開` retries missing only → partial again |
| candidate-review | PASS (ios helper) | candidate-0 at 標準 (ply 0 re-analyzed); swipe needed — in-tree off-viewport element |
| file-import | PASS (ios helper) | `サービス.*` merged label |
| management-review | PASS (ios helper) | merged-label stats rows; action-sheet retap guards; idempotent favorite |
| appearance-review | PASS (ios helper) | `表示テーマ.*` merged label |
| appearance-dark | PASS (ios helper) | dark theme applied + persisted |
| export-review-ios | PASS (ios helper) | share-sheet + document-picker are RemoteUI — no a11y tree → coordinate taps (38%,89% / 18%,28% / 87%,11%) |
| exported .kifu cmp | PASS | `meeshogi-*.kifu` in helper Documents byte-identical to `fixtures/kif/shogiwars.kif` |
| background-review | **FAIL** | see below |
| large-text-review | PASS (ios helper) | `後手の戦型.*` merged label |
| search-delete-review | PASS (ios helper) | `この棋譜を削除` row not exposed to a11y tree → swipe + coordinate tap; delete confirm + `1局` stats verified |

## background-review — partial verification + suite-prep limitation

- The flow's decisive asserts PASSED on device (screenshots
  `34-changed-analysis-conditions.png`, `35-background-paused.png`):
  `以前のモデル・解析条件の結果が5局面あります` old-conditions notice,
  `解析済み 76 / 81局面` status, analysis-start → `analysis-stop` visible,
  Home → relaunch → `解析を停止中` (background pause verified).
- Final step FAILED: after resume + optional stop, the 300s wait for
  `解析を停止中|全局解析が完了しました` timed out mid-scan.
- Root cause is suite-prep, not product: on iOS the KeroPona game already had
  all 81 plies at 50k (RUN-C data), so nothing remained to pause/resume at
  長め. To create old-condition rows I rewrote `conditions.nodes`→10000 on
  plies 76–80 via sqlite — the app's load-time validation REJECTED the forged
  entries (`保存したデータを読み込めません` error screen) whenever meta was
  internally inconsistent OR proof data didn't match claimed conditions.
  Reverting to original values restores normal loading (verified).
- Net: background-review is verified through the background-pause assert;
  the resume-end-state wait is unverifiable without real old-condition data
  (needs an actual 10k bulk analysis on the game, not a DB forge).

## Suite-level iOS differences observed (not product defects)

- `hideKeyboard` unsupported by the app's 完了 keyboard → nav `完了` both
  commits and pops; stock `names-save` unreachable on iOS (values persist).
- Merged a11y labels need `X.*`/`.*X.*` (fullmatch regex), incl. the
  `棋譜.*` post-settings trap fixed in 7448f94 (`棋譜$` — expected to match
  the iOS tab inner element; if not, this is the one untested-on-iOS spot).
- `scrollUntilVisible` treats in-tree off-viewport elements as visible;
  bottom rows of the 対局情報 sheet are outside the a11y tree entirely.
- Share sheet / document picker are RemoteUI with no a11y tree (point taps).
- No product defects found on f376ee7.

---

## RUN @ 6a54ff5 (2026-09-22, suite final candidate — tab-games + delay:800)

HEAD `6a54ff5a04359f075a16f8165cc06f0b7ea2a57c` on `issue-7-engine-correctness`.
Run dir: `artifacts/ios/runs/20260922T204527Z-37636` (all flows green).
Simulator: iPhone 18 Pro / iOS 27.0 (`1308A109-3EE0-4711-9287-85246639DBC7`).

### Build

`xcodebuild -configuration Release -sdk iphonesimulator ARCHS=arm64` — **BUILD SUCCEEDED**
(`artifacts/ios/build-6a54ff5.log`).

Note on the first attempt: `npm ci` deletes the pod-install-vendored
`node_modules/expo-sqlite/ios/sqlite3.h`; the first build compiled a
sqlite3-less ExpoSQLite Clang module (71KB pcm) and cached it in
DerivedData `ModuleCache.noindex`. After `pod install` restored the
header, the cached module was still replayed → `SQLiteModule.swift:
cannot find 'exsqlite3_*' in scope`. Fix: `rm -rf <derivedData>/ModuleCache.noindex`
and rebuild — the second pcm (380KB) includes the vendored header.
Blueprint/CI note: after `npm ci` on a dirty DerivedData, pod install
must precede xcodebuild AND the module cache must be cleared.

### Fix verification (the point of this commit)

- `id: tab-games` — **works on iOS**: `tabBarButtonTestID` surfaces as
  resource-id `tab-games` on the merged-label element `棋譜, tab, 1 of 3`.
  All three post-settings tab taps matched (analysis-review ×3 sites).
- `delay: 800` on move-prev/move-next repeats — **works**: analysis-review
  navigated 80 plies, hit both ±1 drift nets and still landed exact plies;
  appearance-review/dark (inherited) also passed. No drift beyond the nets.
- The `一手進む` mate-detail block (still `delay: 350` in stock, id-less)
  drifted on iOS — covered by conditional nets in the run helper.

### Per-flow results (suite order)

| Flow | Result | Variant |
|---|---|---|
| licenses-review | PASS (21s) | stock runner |
| import-review | PASS (41s) | stock runner |
| player-names | PASS (43s) | kbd helper (+`保存して反映` conditional dialog) |
| player-names-kiou | PASS (31s) | kbd helper |
| analysis-review | PASS (2m40s) | 6a54ff5 variant (`解析の長さ.*` merged-label + drift nets; `id: tab-games`/`delay: 800` as stock) — 長め 50k full completion, mate badges ply 67 (3手詰め) & 51 (1手詰め), SQLite reload `1手目から再開` |
| analysis-partial-review | PASS (1m42s) | 6a54ff5 variant — 標準 partial end `解析処理が終了しました` + aggregated notice, `全局解析が完了しました` absent, ply-41 skipped `—`/no candidates, 解析を再開 → partial again |
| candidate-review | PASS (44s) | ios helper (candidate panel visibility) — candidate-0 at 標準 ply 0, 分岐検討, 0手目から分岐, 本譜に戻る |
| file-import | PASS (1m24s) | ios helper (`サービス.*`) — kiou.kif via Files picker, 77手読み取り, 登録名判定, `0 / 77手`, analysis-ready |
| management-review | PASS (2m8s) | ios helper (favorites/menu/戦型 nets) — `2局`, 戦型 manual edit, 対局情報, `2局1勝0敗` filtered stats |
| appearance-review | PASS (56s) | 6a54ff5 variant (`表示テーマ.*`; delay:800 stock) — theme switch ライト, ply-67 3手詰め badge |
| appearance-dark | PASS (57s) | ios helper → appearance variant (ダーク) |
| export-review-ios | PASS (23s) | ios helper — share sheet → Save to Files → Meeshogi Fixtures |
| exported .kifu | **byte-identical** to `fixtures/kif/shogiwars.kif` (app-cache copy `exported-shogiwars.kifu`) |
| background-review | PASS (50s) | 6a54ff5 variant — 長め `解析済み 76/81` + old-conditions notice, Home→`解析を停止中` pause, resume → `全局解析が完了しました` |
| large-text | PASS (37s) | ios helper at content_size=extra-extra-extra-large |
| search-delete | PASS (36s) | ios helper — search `2099` empty state, SiGototti delete via swipe+point tap, `2局→1局`, stats `1局1勝0敗`, gone after restart |

**Result: 16/16 flows PASS on iOS. No product defects on 6a54ff5.**

### Suite-level iOS differences exercised (unchanged platform gaps, not product bugs)

- `hideKeyboard` unsupported on the custom 完了-key keyboard → kbd helpers
  (完了 commits + pops to settings). NEW this run: when the pasted name
  actually changes a registered name with existing games, iOS shows
  `既存の棋譜にも反映しますか？` (`保存して反映`) before popping — handled
  via conditional `when visible` tap.
- Exact-match `text:` selectors fail on iOS merged a11y labels
  (`解析の長さ, 標準, Forward`; `表示テーマ, システム, Forward`; `サービス, …`;
  戦型 rows). 6a54ff5 variants widen to `.*` while keeping the new
  `id: tab-games` selector — i.e. the selector fix itself is exercised
  verbatim.
- Candidate-panel `candidate-0` needs a swipe before tap; delete row
  `この棋譜を削除` is outside the a11y tree → swipe + `tapOn {point: '26%,90%'}`.
- Document picker / share sheet are RemoteUI → helper flows use coordinate
  + labeled paths; exported file lands in app `Library/Caches` (verified
  byte-identical) — the helper-Documents polling spot showed only fixture
  files this run (same as RUN-D).
- background-review post-resume end-state wait kept at 300s for iOS.

### Cascade note

The first continuation attempt aborted at `player-names` (dialog), which
left stats off for two downstream asserts (`file-import` `2局2勝`,
`management`/`search-delete` count lines). After fixing the dialog step
and re-running the dependent chain in suite order, every flow passed.
Earlier aborts' artifacts are kept alongside the passing ones in the run
dir (the junit per flow reflects the final attempt).
