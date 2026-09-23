# Cloud analysis staging

## Current status

Issue #17 has passed the **fixed-SFEN gate on staging**: the `meeshogi-analysis-staging` Worker and `meeshogi-analysis-staging-analysiscontainer` have returned a 500 ms / MultiPV 2 analysis using the real engine, and the staging CPU reported AVX2. The serial benchmark on `standard-2` and `standard-3` is complete; see [Benchmark results](#benchmark-results-2026-09-23). D1, Queues, job profiles, app integration, and production resources remain intentionally absent.

The cloud path is an evaluation stage. The app's on-device analysis remains in place until the fixed-SFEN gate, cloud benchmark, and both iOS and Android acceptance complete. Cloud connectivity is not a condition for local game management or analysis during migration.

## Staging architecture

- `cloud/src/handler.ts` accepts authenticated `POST /v1/internal/analyze`, `POST /v1/internal/bench/analyze`, `GET /v1/internal/health`, and `POST /v1/internal/stop`. The Worker validates the strict SFEN shape, request bounds, and exact field set before forwarding. It does not forward the bearer token.
- `/v1/internal/bench/analyze` is staging measurement instrumentation behind the admin bearer token. It stays under `/internal` and must never ship as an app-client endpoint or collide with the future public job API.
- `AnalysisContainer` is a SQLite-backed Container Durable Object with one `standard-2` instance maximum and a 30-second idle sleep target. The config has one worker named `meeshogi-analysis-staging` and no production or named environment.
- `cloud/container/driver.py` starts one engine process, verifies engine and weight SHA-256 values before launch, waits for USI readiness, and serializes analysis. It uses `usinewgame` between positions, accepts only bounded numeric controls, and chooses the deepest iteration with all requested MultiPV scores present and exact. Bound scores are not returned as completed candidates.
- The response uses the versioned, pure TypeScript contract in `src/cloud/analysis-contract.ts`. `modelId` is the opaque public alias `analysis-model-staging-v1`; it does not contain the private model name.

The driver reads `engine_options.txt` as data, not as shell or arbitrary USI commands. The reviewed file contains one setting, `FV_SCALE 40`; startup fails closed unless the file is exactly that allowlisted setting and the engine advertises `FV_SCALE`. It then sends `setoption name FV_SCALE value 40`. The driver also points the engine's `EvalDir` at the bundled `/opt/engine` directory, sets `Threads=1` and `USI_Hash=256`, disables ponder and the opening book, and changes `MultiPV` only within the request bound.

Health reports the USI engine identity, short binary and weight SHA-256 prefixes, CPU flags (including whether `avx2` is present), readiness, and best-effort process/cgroup statistics. Analysis responses from the benchmark route include process peak/current RSS, cumulative engine CPU time, and cgroup memory when readable. Missing statistics are omitted and never fail a request. Main's fixed-SFEN staging record confirms AVX2 support on the Cloudflare CPU.

## Private artifact build and deploy

The engine, `nn.bin`, and `engine_options.txt` are read from the authoritative `sekirei-weight` manifests. `scripts/prepare-private-context.sh` verifies the manifest references and all three artifact hashes, then copies only those three files into a mode-0700 temporary directory outside this repository. It prints a JSON object containing the temporary path and verified digests. A digest mismatch or unexpected options file stops the script. The context persists after success so Main can build from it; Main removes that temporary directory after its build attempt.

The Docker build context must remain outside the checkout. To include the public driver source alongside the three private files, Main can compose a second mode-0700 temporary build context containing the three prepared files plus `cloud/container/driver.py`, then run the Docker build with `cloud/container/Dockerfile`. Pin `BASE_IMAGE` to an Ubuntu 24.04 digest in Main's build command and pass the expected engine / weight digests as build arguments. The Docker image runs as UID/GID 10001 and contains no API token.

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

`cloud/test/handler.test.ts` tests worker authentication, input rejection, error mapping, and result-contract validation, including benchmark bounds and unknown fields. `cloud/test/test_driver.py` uses a synthetic executable and synthetic weight bytes only; it covers complete-iteration selection, bound-score exclusion, mate and sente-score conversion, synthetic process/cgroup metrics, exclusive-search conflict, and invalid SFEN.

Synthetic local tests do not independently verify the live deployment or invoice. The staging record reports the fixed-SFEN analysis and AVX2 gate passed; availability of `standard-3`, the two-size benchmark, and end-to-end costs remain to be measured.

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

- `raw-<timestamp>.jsonl`: one line per HTTP request, including request parameters, status/error, latency, retry classification, nodes/depth/terminal/candidates/scores/bounds/incomplete flag, and returned engine statistics. Bearer headers are never written.
- `summary-<timestamp>.csv`: warm observations by fixture and combo, with success, wall/engine time, NPS, nodes, depth, terminal counts, bound/incomplete counts, and candidate snapshots.
- `env-<timestamp>.json`: worker version, configured image digest, instance type, health response, CPU flags, fixture/matrix settings, and runner environment.
- `cost-estimate-<timestamp>.md`: measured engine CPU and conservative resource-cost estimates by combo and cold sample, clearly separated from invoice amounts.

The default prices are dated **2026-09-24**: active vCPU-s **$0.000020**, provisioned GiB-s **$0.0000025**, and provisioned disk GB-s **$0.00000007**. Override them with `--price-config <json-or-file>` using `activeVcpuSecondUsd`, `provisionedGiBSecondUsd`, `provisionedDiskGBSecondUsd`, and optional `instances.standard-2` / `instances.standard-3` specs. The writer treats engine CPU time as measured, active vCPU ceilings and provisioned GiB/GB-seconds as conservative estimates, and explicitly excludes Workers / DO / Queue / D1, egress, logging, monthly base charges, and included allowances where metered usage is unavailable. A request-wall estimate is not a Cloudflare invoice.

The benchmark route is admin-only instrumentation and must never be exposed as part of the public app API. It is not the future asynchronous job API.

## Benchmark results (2026-09-23)

Image `sha256:145d3983…` ran 1,992 recorded requests across `standard-2` and `standard-3` (raw JSONL under `cloud/bench/results/`). Warm figures are p50 wall latency; `term ok` / `incomplete` / `empty` count 200 responses whose terminal was `ok`, whose terminal was `incomplete`, or whose candidate list was empty.

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

### Findings

- Wall latency is `movetime + ~350-550 ms` overhead; at 100 ms the overhead dominates (~500 ms wall).
- `threads=2` yields no NPS gain on 1 vCPU (578-659k) but doubles NPS on 2 vCPU (1.33-1.37M). Threads only pay on `standard-3`.
- Depth grows ~1-2 plies per movetime doubling: d13-14@100ms → d17-20@1-2s → d20-24@5s.
- `incomplete`/empty-candidate responses are frequent at ≤500 ms (strict complete-iteration rule cannot fill all MultiPV lines) and rare at ≥1000 ms (~3/36). At ≥1000 ms the residual empties are almost entirely `single-legal-move`, where legal moves (1) < requested MultiPV — a contract-semantics case, not an engine failure.
- One fixture (`middlegame-150`, hand-heavy position) hangs the engine after its movetime elapses: it emits final `info` lines then never returns `bestmove`, and ignores `stop` (reproduced locally; driver times out, kills, and auto-restarts the engine — verified end-to-end). Deterministic at 5 s on `standard-2` in all four combos; intermittent on `standard-3` (also seen once at 1000 ms and 2000 ms). Other transient 500/503s were rare (~0.4% of requests) and recovered on retry.
- Per-run cost estimates are in each `cost-estimate-*.md`; they bound container vCPU/GiB/GB-seconds only and exclude Workers/DO/D1/Queues/egress/base charges.

### Implications for profiles (pending Director decision)

- Free candidate: 1000 ms / MultiPV 2-3 / threads 1 on `standard-2` — ≥1s virtually eliminates incompletes; threads do not help on 1 vCPU; p95 wall ~2 s.
- Precision candidate: 2000-5000 ms / MultiPV 2-3 / threads 2 on `standard-3` — doubles NPS, adds ~1-3 plies; rare position-dependent engine hangs mean jobs need bounded retry + acceptable-partial-result semantics.
- `single-legal-move` needs a contract decision: candidates should return `min(requested, legalMoves)` rather than `incomplete` with an empty list.
