# Evidence manifest — PR #12 Android re-acceptance @ ba6c6df

Target SHA: `ba6c6df839f27394d99061014f13faa3b0b8baee`
Runs: suite `20260923T141103Z-23840`, PR12 extras `20260923T143118Z-34182`, manual `fix-vertscroll`

- `evidence/report.md` — human report (SHA, build/install/launch, operations, verdicts, constraints)
- `evidence/summary.json` — machine-readable summary
- `evidence/suite/` — android-acceptance.sh artifacts
  - `maestro/<flow>/junit.xml` + per-flow screenshots/logs (15 flows)
  - `videos/flow-*.mp4` — per-flow screen recordings
  - `logcat.txt`, `androidruntime.logcat.txt`, `final.png`, `exported.kifu`, clipboard inputs
- `evidence/pr12/` — android-pr12-checks.sh artifacts
  - `maestro/<flow>/junit.xml` + screenshots (7 flows)
  - `graph-check/` — PNG sequence + `results.txt`
  - `display-variants/` — 8 shots (default/small/tablet x library/game)
  - `videos/flow-*.mp4`, logcat
- `evidence/vertscroll/` — manual controlled experiments (objectives 1–3)
  - `vertscroll.mp4`, `scrub.mp4` — gesture videos
  - `vs-*.png` — on/off-chart drag comparisons (start/end)
  - `sc-*.png` — edge taps, mid-drag readout, release, cancel
  - `mate-large-*.png` — mate.tsx counter under font_scale 1.3
  - `results.txt`, `results-extra.txt` — numeric measurements
- `evidence/graph-check-v2/` — updated android-graph-check.sh @ 99a70dd rerun on the same ba6c6df install: results.txt (9 PASS / 2 INFO), graph-01..07 PNGs, ui.xml
