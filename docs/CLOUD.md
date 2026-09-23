# Cloud analysis staging

## Current status

The staging service runs contract v3 (image `sha256:84599cdf…`): the fixed-SFEN gate, single-legal-move and `middlegame-150` probes, and the selected-profile re-runs on the original fixture set all pass — see [Post-fix verification](#post-fix-verification-2026-09-23-image-sha25684599cdf-contract-v3). The earlier `standard-2` / `standard-3` matrix is retained as pre-fix reference only. D1, Queues, job profiles, app integration, and production resources remain intentionally absent.

The cloud path is an evaluation stage. The app's on-device analysis remains in place until the fixed-SFEN gate, cloud benchmark, and both iOS and Android acceptance complete. Cloud connectivity is not a condition for local game management or analysis during migration.

## Staging architecture

- `cloud/src/handler.ts` accepts authenticated `POST /v1/internal/analyze`, `POST /v1/internal/bench/analyze`, `GET /v1/internal/health`, and `POST /v1/internal/stop`. The Worker validates the strict SFEN shape, request bounds, and exact field set before forwarding. It does not forward the bearer token.
- `/v1/internal/bench/analyze` is staging measurement instrumentation behind the admin bearer token. It stays under `/internal` and must never ship as an app-client endpoint or collide with the future public job API.
- `AnalysisContainer` is a SQLite-backed Container Durable Object with one `standard-2` instance maximum and a 30-second idle sleep target. The config has one worker named `meeshogi-analysis-staging` and no production or named environment.
- `cloud/container/driver.py` verifies the engine and weight SHA-256 values on every fresh process, waits for USI readiness, and serializes analysis. Before search it gets the root legal-move count from `helper-sekirei`, sets `GenerateAllLegalMoves=true`, and searches with `effectiveMultiPv=min(requestedMultiPv, rootLegalMoveCount)`. `info` lines are grouped into contiguous emission blocks; re-emission of a `(depth, multipv)` slot — including the engine's end-of-search flush, which may even lower the reported depth — is treated as a normal update, not a duplicate. The result uses the last block that wholly contains ranks 1..effectiveMultiPv at one depth, all with exact scores, distinct legal first moves, and legal PVs. Bound scores, missing ranks, and duplicate first moves inside a block keep that block from being presented as complete.
- The response uses contract v3 from the pure TypeScript module in `src/cloud/analysis-contract.ts`. Stored centipawn scores are safe integers in ±1,000,000; this pinned engine adapter separately rejects cp values outside its observed ±35,281 range. Scores are neither clamped nor reinterpreted as mate. Mate sign is explicit, including `mate -0` and unknown distance. `modelId` remains the opaque alias `analysis-model-staging-v1`.
- The engine's own `bestmove` is recorded as `engineBestmove`. It must be a legal root move — otherwise the request fails as a protocol error — but it need not equal the first candidate of the returned block: a deeper partial iteration can legitimately reorder the root, so a disagreement keeps the completed candidates and terminal `ok`/`mate` without reordering or re-scoring.
- The driver reports a unique `engineEpoch`, `processId`, and `restartCount` in health and analysis responses. Search deadline is `movetime + 5,000 ms`; timeout sends `stop`, waits at most one second, reaps via SIGTERM then SIGKILL if needed, and starts a fresh, re-verified process. Restart and startup readiness attempts are bounded. Timeout returns `position_failed:engine_timeout`; `incomplete` means the search completed without a full initial iteration and is not a retry hint.
- `cloud/helper-sekirei` is a rules-only Rust binary pinned to sekirei-core revision `7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac`. It generates the complete legal root move set, verifies declaration-win board conditions, replays PVs for legality, and supports a separately budgeted 1/3-ply mate proof. It does not load a model or engine.

The driver reads `engine_options.txt` as data, not as shell or arbitrary USI commands. The reviewed file contains one setting, `FV_SCALE 40`; startup fails closed unless the file is exactly that allowlisted setting and the engine advertises `FV_SCALE`. It then sends `setoption name FV_SCALE value 40`. The driver also points the engine's `EvalDir` at `/opt/engine`, sets `Threads=1`, `USI_Hash=256`, and `GenerateAllLegalMoves=true`, disables ponder and the opening book, and changes `MultiPV` only to the helper-derived effective count. The `GenerateAllLegalMoves` setting is part of profile identity.

Health reports the USI engine identity, short binary, weight, and options SHA-256 prefixes, `engineEpoch`, `processId`, `restartCount`, `lastRestartReason`, CPU flags (including whether `avx2` is present), readiness, and best-effort process/cgroup statistics. Analysis responses carry the process epoch/PID that produced the result, even when a timeout then starts another process. Benchmark analysis also includes process peak/current RSS, cumulative engine CPU time, and cgroup memory when readable. Missing statistics are omitted and never fail a request.

The terminal values distinguish `ok`, `mate`, `incomplete`, `position_failed:<reason>`, `win`, `resign`, `none` / `no_legal_moves`, `cancelled`, and `failed`. `bestmove win` is only returned as `win` after the helper verifies the board-state conditions for an entering-king declaration; SFEN does not include clock state. The board checks follow the [Japan Shogi Association's declaration conditions](https://www.shogi.or.jp/faq/rules/), excluding the clock condition that is not encoded in SFEN. A zero-legal-move result records whether the side to move is in check. `bestmove resign` and `bestmove none` never receive a synthetic score.

## Private artifact build and deploy

The engine, `nn.bin`, and `engine_options.txt` are read from the authoritative `sekirei-weight` manifests. `scripts/prepare-private-context.sh` verifies the manifest references and all three artifact hashes, then copies only those three files into a mode-0700 temporary directory outside this repository. It prints a JSON object containing the temporary path and verified digests. A digest mismatch or unexpected options file stops the script. The context persists after success so Main can build from it; Main removes that temporary directory after its build attempt.

The Docker build context must remain outside the checkout. Main can compose a mode-0700 temporary context containing the three prepared private files, `cloud/container/driver.py`, and the public `cloud/helper-sekirei/` crate under `helper-src/`, then build with `cloud/container/Dockerfile`. A Rust builder stage compiles the helper for linux/amd64; the runtime stage remains Ubuntu 24.04 pinned by the `BASE_IMAGE` digest build argument. Pass the expected engine / weight digests as build arguments. The runtime image runs as UID/GID 10001 and contains no API token.

Wrangler's container image build behavior must be checked by Main against the authorized staging build path before the first deploy. The checked-in config points at `./container/Dockerfile`; never stage private artifacts under the repository to satisfy a local build. If Wrangler cannot consume the external temporary context, Main must use an authorized external image-build / registry path and adjust only the staging image reference before deployment.

1. Install this package's pinned dependencies from `cloud/` with `npm install`.
2. In Main's permitted Docker environment, run `bash scripts/prepare-private-context.sh` and parse its JSON output without printing any credentials.
3. Build the linux/amd64 image from a separate external temporary context. Pin the base image by digest and retain only sanitized build output and the image digest.
4. Set the Cloudflare secret `STAGING_ADMIN_TOKEN` through Main's authorized Wrangler secret path. Do not add it to `vars`, `.env`, command logs, or source files.
5. Run `npm run deploy:staging`. The guard requires the exact staging worker name, rejects environment overrides, and invokes Wrangler with one of the two allowlisted staging configs, without an environment selector.
6. Main's staging record reports that the fixed-SFEN smoke and CPU ISA check passed. After each benchmark-size deploy, verify readiness and retain only sanitized results; keep image/model bytes non-public.

## Security posture

- Every Worker route is behind the staging bearer secret. Requests that do not match the exact internal routes return 404.
- The bearer token is compared but never forwarded to the Container or logged. Engine stdout is consumed only by the USI parser and stderr is discarded.
- There are no public image/model read routes, file download routes, shell/debug routes, arbitrary engine-option pass-throughs, or public analysis proxy endpoints.
- `.gitignore` covers private build-context directory names. The intended private contexts live under the system temporary directory, never in the worktree.
- Only staging resource names are configured. No D1, Queue, R2, account token, or production binding is present.

## Tests and remaining gate

`cloud/test/handler.test.ts` tests worker authentication, input rejection, typed error mapping, and contract-v3 validation, including cp limits, effective MultiPV, mate sign, terminal context, `engineBestmove` presence rules, benchmark bounds, and rejection of older versions. `cloud/test/test_driver.py` injects both a synthetic engine and helper and synthetic weight bytes; it covers partial/duplicate-move/depth/bound transcripts, re-emitted and depth-downgraded flush blocks, legal bestmove disagreement and illegal bestmove, effective MultiPV, cp range, mate signs, terminal values, engine death, timeout kill/restart, restart caps, and next-request recovery. `cargo test --manifest-path cloud/helper-sekirei/Cargo.toml --locked` checks all 12 fixture legal counts, 1- and 3-ply mate, budget exhaustion, check handling, and pawn-drop mate.

Synthetic tests and helper tests do not independently verify the live deployment or invoice. The earlier staging smoke and AVX2 response are recorded; this code update still needs a new image/deployment, fixed-SFEN check, and process-restart fault injection on staging. Old benchmark data remains available but is not post-fix acceptance evidence.

## Benchmark

The benchmark compares the same digest-pinned private image on one `standard-2` instance (1 vCPU / 6 GiB / 12 GB) and one `standard-3` instance (2 vCPU / 8 GiB / 16 GB). `max_instances` stays at 1. The runner serializes every request, waits between calls, retries a single 409 once after a gap, retries one 5xx once after a 5-second gap, and stops with a non-zero exit code if an error remains. It begins with three cold samples separated by 45 seconds of idle, then runs the warm matrix. Each deployment should be supervised by Main; do not run the two instance configs at the same time.

The committed fixtures are synthetic legal positions generated from `startpos` by `cloud/scripts/gen-fixtures.mjs` using the root `tsshogi` dependency. Regenerate and review them with:

```sh
node cloud/scripts/gen-fixtures.mjs
```

From `cloud/`, Main can use this order to deploy `standard-2`, run the full matrix, deploy `standard-3`, run the same matrix, then restore `standard-2`:

```sh
MATRIX='{"movetimeMs":[100,250,500,1000,2000,5000],"multipv":[2,3],"threads":[1,2],"hashMb":[256]}'
STAGING_URL='https://meeshogi-analysis-staging.yuki-nakano-1020.workers.dev'
STAGING_TOKEN_FILE='/secure/path/staging-admin-token'
STAGING_IMAGE_DIGEST='sha256:<64-hex-digest-from-staging-config>'
STAGING_WORKER_VERSION='<version-id-from-wrangler-deploy>'

npm run deploy:staging -- --config wrangler.staging.jsonc
node ./bench/run-benchmark.mjs \
  --url "$STAGING_URL" --token-file "$STAGING_TOKEN_FILE" \
  --matrix "$MATRIX" --fixtures ./bench/fixtures.json \
  --out ./bench/results/standard-2 --warm 3 --cold-idle-seconds 45 \
  --cold-samples 3 --image-digest "$STAGING_IMAGE_DIGEST" \
  --worker-version "$STAGING_WORKER_VERSION" --instance-type standard-2

npm run deploy:staging -- --config wrangler.staging-2vcpu.jsonc
STAGING_WORKER_VERSION='<version-id-from-wrangler-deploy>'
node ./bench/run-benchmark.mjs \
  --url "$STAGING_URL" --token-file "$STAGING_TOKEN_FILE" \
  --matrix "$MATRIX" --fixtures ./bench/fixtures.json \
  --out ./bench/results/standard-3 --warm 3 --cold-idle-seconds 45 \
  --cold-samples 3 --image-digest "$STAGING_IMAGE_DIGEST" \
  --worker-version "$STAGING_WORKER_VERSION" --instance-type standard-3

npm run deploy:staging -- --config wrangler.staging.jsonc
```

Keep the token in the private file passed to `--token-file`; neither command output nor benchmark records contain its value. `--matrix` accepts either JSON text or a JSON file. For a quick serial smoke before the full matrix, use `'{"movetimeMs":[500],"multipv":[2],"threads":[1],"hashMb":[256]}'` with `--warm 1`; cold samples remain at least three. `--worker-version` records the deployment version reported by Wrangler because the driver health response does not invent one. `--image-digest` records the digest configured for the deployed private image.

Each run writes four timestamped files under `--out`:

- `raw-<timestamp>.jsonl`: one line per HTTP request, including request parameters, status/error, latency, retry classification, nodes/depth/terminal/candidates/scores/bounds/incomplete flag, engine epoch, restart count, process ID, and returned engine statistics. Bearer headers are never written.
- `summary-<timestamp>.csv`: warm observations by fixture and combo, with success, wall/engine time, NPS, nodes, depth, terminal counts, bound/incomplete counts, and candidate snapshots.
- `env-<timestamp>.json`: worker version, configured image digest, instance type, health response, CPU flags, fixture/matrix settings, SHA-256 of the exact fixture input bytes as `fixturesSha256`, and runner environment.
- `cost-estimate-<timestamp>.md`: measured engine CPU and conservative resource-cost estimates by combo and cold sample, clearly separated from invoice amounts.

The default prices are dated **2026-09-24**: active vCPU-s **$0.000020**, provisioned GiB-s **$0.0000025**, and provisioned disk GB-s **$0.00000007**. Override them with `--price-config <json-or-file>` using `activeVcpuSecondUsd`, `provisionedGiBSecondUsd`, `provisionedDiskGBSecondUsd`, and optional `instances.standard-2` / `instances.standard-3` specs. The writer treats engine CPU time as measured, active vCPU ceilings and provisioned GiB/GB-seconds as conservative estimates, and explicitly excludes Workers / DO / Queue / D1, egress, logging, monthly base charges, and included allowances where metered usage is unavailable. A request-wall estimate is not a Cloudflare invoice.

The benchmark route is admin-only instrumentation and must never be exposed as part of the public app API. It is not the future asynchronous job API.

## Benchmark results (2026-09-23, pre-fix reference)

Image `sha256:145d3983…` ran 1,992 recorded requests across `standard-2` and `standard-3` (raw JSONL under `cloud/bench/results/`). This table predates contract v2, helper-derived root counts, and the restart path; it is retained as a pre-fix reference and must not be read as corrected acceptance results. Warm figures are p50 wall latency; `term ok` / `incomplete` / `empty` count 200 responses whose terminal was `ok`, whose terminal was `incomplete`, or whose candidate list was empty.

### `standard-2` (1 vCPU) vs `standard-3` (2 vCPU)

| movetime | mpv | thr | s2 wall p50/p95 ms | s2 nps | s2 depth | s2 ok/inc/empty | s3 wall p50/p95 ms | s3 nps | s3 depth | s3 ok/inc/empty |
|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 2 | 1 | 492/1053 | 588k | 13 | 14/16/16 | 480/748 | 673k | 14 | 15/15/15 |
| 100 | 2 | 2 | 624/1095 | 646k | 13 | 18/13/13 | 501/854 | 1.33M | 14 | 16/14/14 |
| 100 | 3 | 1 | 570/842 | 622k | 0 | 8/28/28 | 463/613 | 685k | 0 | 13/22/22 |
| 100 | 3 | 2 | 613/966 | 636k | 0 | 12/23/23 | 513/697 | 1.37M | 12 | 14/17/17 |
| 250 | 2 | 1 | 639/1140 | 620k | 16 | 20/10/10 | 632/713 | 657k | 16 | 21/10/10 |
| 250 | 2 | 2 | 764/1130 | 625k | 14 | 20/10/10 | 653/778 | 1.33M | 15 | 16/14/14 |
| 250 | 3 | 1 | 708/943 | 600k | 14 | 18/17/17 | 625/779 | 706k | 14 | 17/16/16 |
| 250 | 3 | 2 | 745/1123 | 651k | 0 | 13/21/21 | 654/783 | 1.35M | 0 | 11/21/21 |
| 500 | 2 | 1 | 891/1072 | 634k | 17 | 25/15/15 | 881/1329 | 672k | 17 | 17/13/13 |
| 500 | 2 | 2 | 943/1475 | 618k | 15 | 22/8/8 | 906/1149 | 1.33M | 17 | 24/6/6 |
| 500 | 3 | 1 | 898/1279 | 609k | 16 | 19/11/11 | 861/962 | 690k | 16 | 19/11/11 |
| 500 | 3 | 2 | 1024/1379 | 603k | 15 | 23/7/7 | 897/1218 | 1.33M | 16 | 22/8/8 |
| 1000 | 2 | 1 | 1479/1917 | 593k | 18 | 43/3/3 | 1364/1860 | 660k | 18 | 27/3/3 |
| 1000 | 2 | 2 | 1526/2266 | 578k | 17 | 26/4/4 | 1390/1485 | 1.33M | 18 | 26/4/4 |
| 1000 | 3 | 1 | 1398/1768 | 617k | 17 | 26/4/4 | 1360/1778 | 705k | 17 | 27/3/3 |
| 1000 | 3 | 2 | 1520/1966 | 600k | 16 | 26/4/4 | 1381/1612 | 1.37M | 17 | 26/4/4 |
| 2000 | 2 | 1 | 2470/3006 | 617k | 20 | 27/3/3 | 2366/2525 | 696k | 20 | 27/3/3 |
| 2000 | 2 | 2 | 2501/2793 | 604k | 18 | 27/3/3 | 2386/2484 | 1.36M | 19 | 52/4/4 |
| 2000 | 3 | 1 | 2474/2850 | 595k | 19 | 27/3/3 | 2365/2389 | 669k | 19 | 27/3/3 |
| 2000 | 3 | 2 | 2439/3098 | 623k | 17 | 26/4/4 | 2389/2495 | 1.36M | 19 | 27/3/3 |
| 5000 | 2 | 1 | 5460/5931 | 619k | 23 | 110/3/3 | 5365/5458 | 659k | 24 | 27/3/3 |
| 5000 | 2 | 2 | 5495/5722 | 616k | 20 | 51/3/3 | 5386/5508 | 1.37M | 22 | 27/3/3 |
| 5000 | 3 | 1 | 5367/5902 | 659k | 23 | 27/3/3 | 5374/5718 | 699k | 22 | 27/3/3 |
| 5000 | 3 | 2 | 5488/5776 | 639k | 20 | 27/3/3 | 5406/5564 | 1.35M | 21 | 29/3/3 |

Cold-start readiness (`cold-health` to ready): `standard-2` p50 4.4 s / p95 6.2 s / max 18.5 s (n=30); `standard-3` p50 3.6 s / p95 7.4 s / max 11.1 s (n=12). Cold-analyze at 500 ms then completes in ~0.9-1.3 s.

### Findings from the pre-fix reference data

- Wall latency is `movetime + ~350-550 ms` overhead; at 100 ms the overhead dominates (~500 ms wall).
- `threads=2` yields no NPS gain on 1 vCPU (578-659k) but doubles NPS on 2 vCPU (1.33-1.37M). Threads only pay on `standard-3`.
- Depth grows ~1-2 plies per movetime doubling: d13-14@100ms → d17-20@1-2s → d20-24@5s.
- The historical 15 HTTP 500s are attributed to the now-reproduced contract rejection of engine `score cp` values above ±32,000. A host replay of the recorded `middlegame-150` transcript returned ±35,281, within this build's adapter range; the old Worker validator rejected it. The saved requests returned at normal movetime completion timing, and the benchmark records no `terminal=timeout`, so those 500s are not evidence of an engine timeout.
- Main separately observed a local `middlegame-150` search that emitted its last `info` around 5,001 ms and ignored `stop` for 25 seconds. That distinct hang path remains unconfirmed: it was not reproduced by the Director's host replay, and no pre-fix restart verification exists. The new synthetic tests exercise timeout→kill→fresh process→next request, but staging fault injection is still outstanding.
- Earlier `incomplete` / empty-candidate counts include single-legal-move positions under the v1 contract, which treated requested MultiPV as the number to complete. They cannot be compared directly with v2's `effectiveMultiPv` semantics.
- Per-run cost estimates are in each `cost-estimate-*.md`; they bound container vCPU/GiB/GB-seconds only and exclude Workers/DO/D1/Queues/egress/base charges.

### Staging profile decisions

- `free-v1`: 1,000 ms, requested MultiPV 2, Threads 1, Hash 256 MiB, `standard-2` (1 vCPU / 6 GiB / 12 GB).
- `precision-v1`: 2,000 ms, requested MultiPV 3, Threads 2, Hash 256 MiB, `standard-3` (2 vCPU / 8 GiB / 16 GB).
- Both use the same engine/model, SFEN-only history, `usinewgame` TT reset per position, `FV_SCALE=40`, no book/Ponder, and `GenerateAllLegalMoves=true`. Effective MultiPV is derived from independent legal generation. These are staging calculation-budget choices, not a strength guarantee. Five seconds remains comparison-only, not an automatic fallback.

## Post-fix verification (2026-09-23, image `sha256:84599cdf…`, contract v3)

The repaired image was deployed and the selected profiles were re-run on the **original** 12-fixture set (`cloud/bench/results/postfix-free-standard-2`, `postfix-precision-standard-3`; fixture SFEN set verified identical to the pre-fix runs). Before the matrix, three gate probes passed live: initial position `ok` d21, `single-legal-move` `ok` with `effectiveMultiPv=1`, and `middlegame-150` `ok` with three exact candidates — the position whose high cp values previously failed the contract.

| Profile | Requests | Warm terminal | Wall p50 / p95 / max | Depth med | NPS med | Restarts | `bm≠rank1` |
| --- | ---: | --- | --- | ---: | ---: | ---: | ---: |
| free-v1 `standard-2` mt1000-mpv2-t1-h256 | 60 warm + 6 cold | 50 `ok`, 10 `mate` | 1,461 / 1,506 / 1,766 ms | 18 | 732k | 0 | 0 |
| precision-v1 `standard-3` mt2000-mpv3-t2-h256 | 60 warm + 6 cold | 47 `ok`, 13 `mate` | 2,398 / 2,513 / 3,639 ms | 18 | 1,526k | 0 | 4 |

- All 132 requests returned HTTP 200 with a valid contract-v3 result; zero 4xx/5xx, zero `position_failed:*`, zero engine restarts (single `engineEpoch` per run).
- `mate` terminals are expected: the `mate-in-one` fixture and other mate-scored positions emit explicit mate signs.
- Precision produced 4 natural `engineBestmove ≠ rank1` cases; all were legal moves kept per contract v3 instead of failing — the behavior the pre-fix build rejected.
- Cold-health to ready: `standard-2` 2.8/3.0/4.0 s; `standard-3` 4.0/4.2/21.1 s (one slow instance-start outlier, recorded not retried). Cold-analyze ~0.9 s.
- Estimated container component cost per analyzed position (conservative, from `cost-estimate-*.md`): free ≈ measured engine CPU $0.0000204 + provisioned ≈ $0.000069 total; precision ≈ measured $0.0000773 + provisioned ≈ $0.000169 total. Excludes Workers/DO/Queue/D1/egress/base charges — estimates, not invoices.
- The earlier claim of a deterministic `middlegame-150` engine hang did not reproduce under the repaired driver: `ok` at mpv3/2 s and mpv2/1 s on staging, and `ok` at mpv3/5 s/threads 2 in a local container run of the same image generation. The remaining hang evidence is one local stop-ignoring observation on the pre-repair build; the timeout→kill→restart path is covered by synthetic tests and the bounded driver deadline.
