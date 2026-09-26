# WCSC36 public benchmark dataset

`positions.json` fixes 60 legal, game-derived SFENs for Issue #20. `game.json` fixes a separate complete game, with the position before every played move. The original 1.4 MB CSA archive is not included.

## Source and attribution

The source is the [CSA WCSC36 archive](https://www.computer-shogi.org/kifu/wcsc36_kifu.zip), listed on the [CSA kifu index](https://www.computer-shogi.org/kifu/kifu.html). The index permits use of the records and asks publications to credit the programs, game date, tournament, or source. Each selected position records its CSA filename, event/round, both program names, start time, and ply. The JSON source manifest records the archive SHA-256 and SHA-256 for every CSA file used by either dataset.

Archive SHA-256: `48ece58b091dbb4df41e6fb55b73600767f77f4c9ee9ff8360474d5b75bb2631`.

## Fixed selection rules

These rules were fixed before any engine analysis results existed:

- Decode Shift_JIS CSA with Node's built-in `TextDecoder`, parse with `tsshogi` 2.3.4, and replay every ordinary move. A file is rejected if parsing, attribution metadata, legal-move validation, or replay fails.
- Choose one eligible game from each selected event round: 7 primary-preliminary rounds, 7 secondary-preliminary rounds, and 6 final rounds. Seeded SHA-256 ordering selects rounds and games, giving 20 distinct games spread across all tournament stages.
- Take one position per selected game in each phase: opening after 16–40 plies, middlegame after 41–90 plies, and endgame after ply 91, leaving at least 8 recorded plies before the result. Endgame source games must end in resignation or a recorded mate and contain at least 99 played plies.
- Each sample is the position before a legal recorded move, so it has a legal move and is nonterminal. Repeated positions are deduplicated across all phases by `sfenKey` (board, side to move, and hands; SFEN move number omitted). The seeded candidate ordering is independent of engine scores.
- Select a separate, normally completed 80–160-ply game for `game.json`; its positions do not count toward the 60 samples.
- Each SFEN hash covers its exact UTF-8 SFEN. Each `manifestSha256` covers compact canonical JSON for the positions array: object keys recursively sorted lexicographically, array order retained, no extra whitespace.

The machine-readable form of these rules is in `positions.json` under `rules`.

## Regeneration

With Node.js and the `cloud/` dependencies installed, download the official archive and extract its CSA files:

```sh
unzip -q /path/to/wcsc36_kifu.zip -d /tmp/wcsc36
node cloud/bench/dataset/extract.mjs \
  --archive-file /path/to/wcsc36_kifu.zip \
  --source-dir /tmp/wcsc36/wcsc36_kifu \
  --out-dir cloud/bench/dataset
```

The extractor verifies the pinned archive SHA-256 before reading files. It writes only `positions.json` and `game.json` to the selected output directory.

Run dataset checks from the repository root with:

```sh
node --test cloud/bench/dataset/test_dataset.mjs
WCSC36_ARCHIVE=/path/to/wcsc36_kifu.zip \
WCSC36_CSA_DIR=/tmp/wcsc36/wcsc36_kifu \
  node --test cloud/bench/dataset/test_dataset.mjs
```

The second command also runs extraction twice in temporary directories and checks that both outputs are byte-identical to the checked-in JSON. Source programs are experimental computer-shogi programs; the benchmark measures them as public historical positions and makes no claim that a sampled position is representative of consumer play.
