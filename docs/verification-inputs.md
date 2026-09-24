# Verification inputs — provenance

Verification game inputs must be re-derivable after ephemeral `/tmp` copies disappear. This file records the durable provenance for each staged full-game observation.

## Asahi Cup final (104 positions, 103 moves)

- Game: 16th Asahi Cup Shogi Open final, Fujii Sota (Ryuo) vs Watanabe Akira (Meijin), 2023-02-23, Gangi, 103 moves, sente wins.
- Source URL: `https://digital.asahi.com/shougi/asahicup_live/kifu/asahi202302230301.kif` (official Asahi Shimbun live-kifu file).
- Retrieved: 2026-09-24 UTC. Re-fetched on 2026-09-25 UTC for provenance confirmation; bytes identical.
- Downloaded file SHA-256: `c832119e4c4916fbb15ae0da6a66e2c187a5b160f75e433831b0f187dd3cdd1c` (CP932 KIF, header `対局ID：14892`, `記録ID：63e9f52f7f84d4a5bd56606b`). The annotated file is not committed; it is re-fetchable from the source URL.
- USI conversion: `tsshogi` KIF import → `exportUSI` moves. SHA-256 of the UTF-8 `position startpos moves …` string used for the job: see digest below.
- Legal USI move list (103 moves; 104 positions including the root):

```json
["2g2f","3c3d","7g7f","4c4d","2f2e","2b3c","3i4h","3a4b","3g3f","4a3b","5i6h","8c8d","4h3g","4b4c","8h7g","6a5b","4i5h","7a6b","3g2f","5c5d","3f3e","3c4b","3e3d","4b6d","2f3g","6b5c","3g4f","4c3d","2e2d","2c2d","2h2d","3b2c","2d2f","P*2d","2i3g","2a3c","6h7h","7c7d","7i8h","8a7c","P*3e","3d4c","5g5f","7d7e","5f5e","7e7f","7g8f","5d5e","P*7d","7c8e","8f6d","5c6d","B*7c","6d7c","7d7c+","8b9b","7c8c","9b6b","8c7c","6b9b","7c8c","9b6b","4f5e","P*5g","5h6h","B*6e","8c7c","6b9b","P*5c","5b5c","S*5f","B*1e","2f4f","6e5d","5e5d","5c5d","4f3f","5g5h+","6i5h","P*5g","5h5g","S*2g","P*5e","5d6d","1g1f","2g3f","1f1e","R*5i","7c8b","7f7g+","8i7g","8e7g+","8h7g","N*8e","8b9b","8e7g+","6h7g","5i5g+","R*8a","5a4b","B*3a","4b3b","B*2a"]
```

- USI moves JSON SHA-256 (the array above, compact-serialized): `bcbacdae668a1a790265c5f7cf56617304a9d489dbf8ae6bcfcee9236a2b2769`.
- Execution artifact: staging job `98401ddc-480b-4025-a6cf-d6e005a7184a`, profile `precision-v1` (`standard-3`, 2 vCPU), identity `446477ab…`, submitted 2026-09-24 UTC → `partial` (103 `done` + 1 `incomplete`).

## ShogiWars fixture (81 positions, 80 moves)

- Committed at `fixtures/kif/shogiwars.kif` (SHA-256 `e527fbd0bd25e88652176ff4e6c572ff638c597b1eacfb902799ea6d202dbf55`), added by `9653287`; already durable in git.
- Legal USI move list (80 moves):

```json
["7g7f","3c3d","3i4h","8c8d","6g6f","7a6b","7i6h","6c6d","6i7h","6b6c","5g5f","6c5d","4h5g","7c7d","2g2f","8b6b","2f2e","2b3c","4i5h","3a4b","5h6g","4a3b","6h7g","5a4a","2h2f","4a3a","2f2h","8a7c","5i6i","6d6e","5g6h","6e6f","7h7i","6f6g+","2h4h","6g6h","4h6h","G*6g","7f7e","6g6h","7g6h","R*3i","6i7h","3c8h+","7i8h","S*6g","7h7g","6g6h","7g8f","9c9d","G*7b","6b7b","8h7h","3i6i+","B*4a","3a4a","9g9f","S*7g","7h7g","6h7g","8i7g","B*6h","S*6f","P*6e","S*5h","6i5h","6f5g","6h5g+","P*6f","7b6b","7g8e","7c8e","9i9h","5g6f","3g3f","G*9e","9f9e","9d9e","G*4d","B*6h"]
```

## Kiou fixture (78 positions, 77 moves)

- Committed at `fixtures/kif/kiou.kif` (SHA-256 `816544f6bda230b89d24604cd7ad716a3582a3da08c731e552818f1163c91d3b`); used for the earlier 78-position observations `6aecc815` (free) and `940d30b5` (precision).
