# Cloud analysis staging

## Current status

Issue #17 has passed the **fixed-SFEN gate on staging**: the `meeshogi-analysis-staging` Worker and `meeshogi-analysis-staging-analysiscontainer` have returned a 500 ms / MultiPV 2 analysis using the real engine, and the staging CPU reported AVX2. The next gate is the serial benchmark on `standard-2` and `standard-3`. D1, Queues, job profiles, app integration, and production resources remain intentionally absent.

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

The benchmark compares the same digest-pinned private image on one `standard-2` instance (1 vCPU / 6 GiB / 12 GB) and one `standard-3` instance (2 vCPU / 8 GiB / 16 GB). `max_instances` stays at 1. The runner serializes every request, waits between calls, retries a single 409 once after a gap, and stops with a non-zero exit code if an error remains. It begins with three cold samples separated by 45 seconds of idle, then runs the warm matrix. Each deployment should be supervised by Main; do not run the two instance configs at the same time.

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
