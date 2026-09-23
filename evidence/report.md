# meeshogi PR #12 / Issue #16 — Android native acceptance report

- **Source**: `phni3j9a/meeshogi@7f877a25958fe4cd5c08341271e8c7f0cb00259b` (`feat/analysis-design-generated-pieces`, includes main `b646d92`)
- **Verification branch**: `verification/pr12-android-20260923` @ `12e8550` (flow/script fixes only)
- **Environment**: emulator-5554, AVD `acceptance` (Pixel 7 class, 1080×2400 @420dpi), Android 16 (`sdk_gphone64_x86_64`), Release APK `meeshogi.apk` (80.7 MB, sekirei-core v0.3.37, real engine), Maestro 2.10.0
- **App**: freshly built, installed, launched; fixture data only — no demo analysis, no web substitute

## Verdict

**PASS.** All 15 existing suite flows and all PR-12-specific checks pass on the real-engine Release build. No product bugs block acceptance. Findings are observations/cosmetics listed below.

## Suite results (15 flows)

| Flow | Result | Notes |
|---|---|---|
| licenses-review | pass | run1, script-auto |
| import-review | pass | run1 |
| player-names (wars) | pass | run1 |
| player-names-kiou | pass | run1 |
| analysis-review (50k full) | pass | run1, full completion |
| analysis-partial-review | pass | resume run; 1 helper retry — new layout puts the end label below the fold; flow fixed (scroll + union wait). partial/ply41 gap/finite resume verified |
| candidate-review | pass | branch → mainline round-trip |
| file-import | pass | KIF file import incl. mate fixtures |
| management-review | pass | 1 helper retry — raced async favorite write; wait added |
| appearance-review / -dark | pass ×2 | light + dark |
| export-review | pass | exported KIF byte-identical (`cmp`) |
| background-review | pass | background stop/resume |
| large-text-review | pass | |
| search-delete-review | pass | |

Two flows needed semantic-preserving fixes (committed on the verification branch): `analysis-partial-review` (end-state label/notice below fold — scroll + union wait) and `management-review` (wait for async favorite write). No assert or operation was silently skipped.

## PR-specific checks

| Check | Result |
|---|---|
| 4 generated piece sets — preview + select | pass (黄楊/白木/桜木/青磁, selected checkmark) |
| Reflection on board / hands / flipped / mate sequence | pass — verified visually per set |
| light/dark per set | pass — shots per set per theme |
| kill/relaunch persistence (SQLite) | pass |
| kifu/analysis intact | pass (suite green) |
| mate-terminal gote | pass (−M1, 後手・1手詰め, terminal label, no candidates) |
| mate-terminal sente | pass (+M1, 先手・1手詰め, 先手勝ち・詰み終局) — 5 helper retries fixing the flow (Maestro full-text matching, dedupe-import branch, banner latency) |
| small screen (720×1280) | pass — board/eval/first-candidate/transport intact |
| OS text-scaling | pass — cosmetic '第一候…' truncation only |
| tablet (landscape/portrait via wm overrides) | pass — centered column, no clipping |

## Graph checks (`android-graph-check.sh`, real-gesture)

PASS: left/right edge taps (0↔80), release-once commit (x→ply, ±2), readout cleared after release, same-index release no-nav, vertical-drag cancel (position unchanged), center tap, branch opened, **branch shows no mainline chart**.
SCREENSHOT-VERIFIED: mid-drag '本譜 16手目 +49' readout + frozen '0 / 80手' counter (`graph-03-scrub-mid.png`; the pan state lives ~1–2 s < uiautomator dump latency).
WARN (product observation): vertical drag over the chart does not scroll the page — the chart's PanResponder claims the gesture; scroll works outside the chart.
Fixtures: `fixtures/analysis/positions.json` cases exercised via the KeroPona 80-ply record — positive/negative, missing-position dots, normal mate and terminal mate displays all confirmed visually and by asserts.

## Findings / observations for Main

1. **WARN**: page does not scroll when a vertical drag starts on the chart (scrub-cancel works; gesture ownership). Likely intended; flagging since it changes scroll affordance around the chart.
2. End-state labels + partial notice live below the fold in the new actions section — acceptable, required flow updates.
3. Import dedupe: banner lands seconds after the read-confirmation; the save button is *unmounted* on collision (not just disabled).
4. Cosmetic: '第一候補' truncates under OS text-scaling.
5. Repo hygiene: `scripts/ci/__pycache__/devin-cloud.cpython-312.pyc` is committed on the PR branch.

## Constraints (what could NOT be verified and why)

- '合法手なし' terminal state is not reachable via KIF import on-device; the same panel is shown at mate terminals (verified there).
- Off-scale (>±1500) non-mate evals not generatable on the emulator engine.
- True OS gesture-cancel (notification pull) not synthesizable via `adb input`; cancel verified via vertical drag.
- Tablet approximated by `wm size/density` overrides, not a physical device.
- Mid-drag readout verified by screenshot only (tree latency) — documented, not skipped.
- Mate fixtures end partial at 20/28 (8 positions 探索量不足, deterministic); mate plies are analyzed (+M1 shown).

## Evidence

Branch `evidence/pr12-android-20260923`, this run only: junit XML, named screenshots (141 PNG, all opened by the verifier), step-failure shots, per-flow `maestro.log`, 15 screenrecord videos, logcat, `exported.kifu`, display-variant shots, graph-check results + PNGs, and `summary.json`.
Runs: `suite-run1` (20260923T080641Z), `suite-resume` (20260923T083737Z), `pr12-extras` (20260923T085848Z).
