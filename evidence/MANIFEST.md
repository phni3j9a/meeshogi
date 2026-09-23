# Evidence manifest — PR #12 Android acceptance (2026-09-23)

Source `7f877a25958fe4cd5c08341271e8c7f0cb00259b` · verification `verification/pr12-android-20260923@12e8550` · evidence branch `evidence/pr12-android-20260923` (orphan, this run only).

## Layout

- `evidence/summary.json`, `evidence/report.md`, `evidence/MANIFEST.md`
- `evidence/suite-run1/` — suite attempt 1 (run dir `20260923T080641Z-12604`)
- `evidence/suite-resume/` — suite remaining flows (run dir `20260923T083737Z-25030`)
- `evidence/pr12-extras/` — PR-specific checks (run dir `20260923T085848Z-37634`)

Per run dir:
- `junit/<flow>.xml` — Maestro junit (final status; retry attempts kept, e.g. `management-review` failed → `management-review-2` passed, `mate-terminal-sente` failed → `mate-terminal-sente-2` passed)
- `screenshots/<flow>/*.png` — named `takeScreenshot` captures (the reviewed evidence)
- `screenshots/<flow>/step-failures/*.png` — screenshots at failed steps (retry trail)
- `logs/<flow>-<ts>.log` — maestro.log per attempt
- `video/flow-*.mp4` — screenrecord of the run
- `logcat.txt`, `exported.kifu`, `kiou*.kif`, `clipboard-*.txt`, `final.png`, `run-id.txt`
- `pr12-extras/display-variants/` — small / tablet-landscape / tablet-portrait shots
- `pr12-extras/graph-check/` — final graph-check results.txt + gesture PNGs; `graph-check-{2..5}/` keep the retry trail (results + mid-drag PNGs)

## How to re-check

- Suite junit: `grep -l 'failures="[1-9]' evidence/*/junit/*.xml` → only the documented retry attempts fail.
- Mid-drag readout: `pr12-extras/graph-check/graph-03-scrub-mid.png` shows '本譜 16手目 +49' with counter '0 / 80手'.
- Mate terminal: `pr12-extras/screenshots/mate-terminal-sente-2/82-sente-*.png`, `.../mate-terminal-gote/`.
- Piece sets: `pr12-extras/screenshots/piece-sets-{picker,reflect,persist}/`, `display-variants/`, `pr12-large-text/`.
