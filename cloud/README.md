# Issue #19 staging analysis gate

This package is an isolated technical gate. It serves an authenticated, synchronous SFEN analysis endpoint (Issue #19) and an asynchronous game-analysis job backend over D1 and Queues (Issue #21). It is not connected to the mobile app. The iOS and Android app continue to analyze on-device, and staging access, an account, and network access are not required to use the initial product.

## Contract and boundaries

The Worker accepts only `POST /internal/analyze` with `Authorization: Bearer <ANALYSIS_INTERNAL_TOKEN>` and a JSON object containing exactly one field: `{"sfen":"..."}`. An unset Worker secret fails closed before the Container is called. The body limit is 1 KiB; the SFEN must be valid, at most 256 bytes, and contain no control characters or line breaks. Arbitrary USI commands, engine paths, engine options, and extra request fields are rejected.

The result is versioned JSON. `perspective` is always `sente`; exact scores remain either integer `cp` or `mate` values. Candidate first moves and complete PVs are checked again with `tsshogi@2.3.4`. A root with no legal moves returns `status: "terminal"` and either `terminal: "checkmate"` or `"no-legal-moves"`, no candidates, and null search measurements. A search without a complete exact MultiPV block returns `status: "incomplete"` and no candidates. Missing measurements remain `null`; bounds are not emitted as exact scores, and a normal mate score is not a mate proof.

The fixed verification conditions are `Threads=1`, `USI_Hash=64 MiB`, `movetime=1500 ms`, and requested `MultiPV=3`. The effective MultiPV is capped at the Worker-verified legal move count and is reported. Failures have `status: "failure"` and a typed code: `invalid`, `busy`, `timeout`, `identity_mismatch`, or `engine_error`. Busy maps to HTTP 409, timeout to 504, and invalid input to a 4xx response.

Cloudflare Containers require one Durable Object class and binding. This implementation has exactly one `AnalysisContainer` class, its `ANALYSIS_CONTAINER` binding, and the `new_sqlite_classes` migration used to register it. It adds no application Durable Object storage, coordinator, alarm, scheduler, retry, or recovery code. The class uses the standard `@cloudflare/containers` routing and lifecycle.

The Python 3.12 driver uses only the standard library. It checks engine, model, options, source archive, source tree, and build identity before opening its HTTP listener. The `ubuntu:24.04` image provides a new enough glibc and libstdc++ for the engine; a Docker build-time USI/`isready` smoke applies the same `EvalDir=/opt/engine` and fixed options as the driver, so an incompatible base or unreadable model fails the image build. It starts a fresh engine process for each request and waits for it to exit. A busy request is rejected immediately. The search deadline is `movetime + 5 s`; on timeout the driver sends `stop`, waits up to 750 ms for a response, sends `SIGTERM`, then `SIGKILL` if needed, and always calls `wait()` to reap the child. The next request uses a new process. `bestmove resign` yields an incomplete result with `engineOutcome: "resign"` and no fabricated move.

The image is `linux/amd64`. The Worker config is only for `meeshogi-analysis-mvp-staging`. The normal API uses one `standard-2` Container app (`meeshogi-analysis-mvp-staging-analysis`); benchmark mode has separate fixed `standard-2` and `standard-3` apps. All three use the same digest-pinned Cloudflare managed registry image and have `max_instances: 1`. `wrangler.staging.jsonc` is a template; scripts render a temporary config with the real account ID and image digest, then remove it. There is no public fault-injection route or public Container port.

## Offline checks

From the repository root:

```sh
npm run check
```

The independent cloud package checks are:

```sh
cd cloud
npm ci
npm run check
```

`npm run check` runs the cloud TypeScript check, Vitest Worker-boundary tests, and Python `unittest` tests. Python tests create a synthetic executable as a fake USI engine and synthetic weight bytes under a temporary directory. They do not read the private engine or model. Cloud CI runs these tests only; it never builds, uploads, or deploys the private image.

## Private build, push, and deploy

The operator environment needs Docker with a working `buildx` driver, Wrangler 4.139.0, Cloudflare credentials with Container registry and Worker deployment access, and the existing `/home/server/projects/sekirei-weight` checkout. No new account or package is required. `CLOUDFLARE_ACCOUNT_ID` is the 32-character Cloudflare account ID. `SEKIREI_WEIGHT_ROOT` is optional and defaults to `/home/server/projects/sekirei-weight`.

The Dockerfile uses the `ubuntu:24.04` base tag because this Worker environment could not inspect the local Docker image cache for a digest. Main should record the resolved base image digest from the Docker build environment.

The preparation script reads only the three referenced JSON manifests before locating the files. It checks the manifest links and the expected engine, model, options, archive, and source-tree hashes, then hashes the actual files and copies only `engine`, `nn.bin`, `engine_options.txt`, the public driver, the public artifact manifest, the Dockerfile, and a restrictive `.dockerignore` into a mode-0700 directory under `/tmp`. It does not modify the checkout. The combined build script invokes preparation, runs Wrangler's `containers build --push` for the managed registry, reads the pushed tag's manifest digest, and removes the private context, temporary Docker configuration, and rendered Wrangler config even on failure.

Set the account and a new image tag, then run:

```sh
export CLOUDFLARE_ACCOUNT_ID='0123456789abcdef0123456789abcdef'
export ANALYSIS_IMAGE_TAG="issue19-$(date -u +%Y%m%d%H%M%S)"
bash cloud/scripts/build-push-image.sh
```

The script prints one `ANALYSIS_IMAGE_REF=registry.cloudflare.com/<account>/meeshogi-analysis-mvp-staging@sha256:<digest>` line. Copy that non-secret value into the environment for deploy:

```sh
export ANALYSIS_IMAGE_REF='registry.cloudflare.com/<account>/meeshogi-analysis-mvp-staging@sha256:<64-hex-digest>'
read -r -s -p 'Internal analysis token: ' ANALYSIS_INTERNAL_TOKEN
export ANALYSIS_INTERNAL_TOKEN
bash cloud/scripts/deploy-staging.sh
unset ANALYSIS_INTERNAL_TOKEN
```

`deploy-staging.sh` validates the account, repository, digest, and Worker name. It first deploys the Worker and Container migration while the unset secret makes analysis fail closed, then pipes the token to `wrangler secret put ANALYSIS_INTERNAL_TOKEN`. The script removes the exported token before starting the deploy command, so Wrangler deploy does not inherit it. The token is never an argument, config value, build argument, image layer, or log value. Do not place this token in `vars`, a `.env` file, a shell trace, or the Docker context.

The only operator environment values are:

| Variable | Used for | Secret |
| --- | --- | --- |
| `SEKIREI_WEIGHT_ROOT` | Optional source checkout override | No |
| `CLOUDFLARE_ACCOUNT_ID` | Account selection for build, deploy, and operator Wrangler commands | No |
| `ANALYSIS_IMAGE_TAG` | Unique local/registry tag during build and push | No |
| `ANALYSIS_IMAGE_REF` | Digest-pinned image for deploy and operator Wrangler commands | No |
| `ANALYSIS_INTERNAL_TOKEN` | Worker bearer secret and authenticated smoke requests | **Yes** |
| `ANALYSIS_STAGING_URL` | Deployed Worker base URL for smoke and timeout requests | No |
| `JOBS_D1_DATABASE_ID` | UUID of the `meeshogi-jobs-staging` D1 database, rendered into the deploy config | No |

## Fixed staging smoke

The smoke sends four requests in order: the checked-in `non-mate-startpos` fixture, a legal synthetic middlegame, a legal synthetic mate-in-one position, and the checked-in `checkmate-white` terminal fixture. It verifies echo, expected identity, sente perspective, legal-looking non-empty PVs, positive search measurements for non-terminals, a normal `mate` score for the mate-in-one fixture, and no invented values/candidates for checkmate. All positions are public synthetic data.

```sh
export ANALYSIS_STAGING_URL='https://<deployed-worker-subdomain>.workers.dev'
read -r -s -p 'Internal analysis token: ' ANALYSIS_INTERNAL_TOKEN
export ANALYSIS_INTERNAL_TOKEN
python3 cloud/scripts/smoke-staging.py
unset ANALYSIS_INTERNAL_TOKEN
```

After a deploy, the first analysis request can arrive while the Container is inactive or its port is still starting. The Containers package returns a plain-text 500/503 for some startup failures; the Worker converts that response, or a thrown fetch error, into a typed HTTP 502 JSON failure with `failure.code: "engine_error"`. The smoke uses HTTP only: it sends start-position warm-up requests every five seconds until one succeeds, for up to ten minutes, then runs the fixtures. It prints each fixture ID and measured result fields. It never prints the token. A failure includes HTTP status and response status/failure code or a short non-JSON body preview.

## Operator-only timeout and recovery check

The verifier uses the explicit `deploy-staging.sh --verification` mode to render the Worker var `ANALYSIS_VERIFY_STOP_ENGINE_ONCE=1`. The normal deploy entry ignores and removes any inherited environment variable of that name. `AnalysisContainer` passes the configured var to the driver as a container environment variable; request fields and headers cannot enable it. An authenticated `GET /internal/health` forwards once to the running Container's `/health` and may start it; the response includes the actual container flag, one-shot consumption state, driver boot ID, version, and artifact digests alongside the Worker flag. The verifier polls every 15 seconds for up to ten minutes until those flags match and the one-shot is still unused. If an old warm Container remains, it sends no requests for 315 seconds (longer than the five-minute `sleepAfter`) and checks once more. Only then does the first analysis stop its real engine process after `go`; the normal driver deadline and stop/terminate/kill/wait path must return HTTP 504 `timeout` plus reap evidence. A second request for a different SFEN must succeed with a new engine epoch and PID but the same boot ID reported by health. Finally, the verifier deploys again through the normal mode, waits for the live Container to report the flag disabled using the same bounded idle-restart procedure, then runs the normal HTTP warm-up and four-fixture smoke.

The SSH approach was tried and dropped for this account: `wrangler containers ssh <id> --stdio` returned HTTP 404 “Deployment not found”, while the raw instances API returned an empty `instances` array and only Durable Object metadata. Wrangler also reported `inactive` with null location/version even during successful analysis requests, so instance-state polling cannot gate verification.

Build and push the updated private image using the preceding procedure, then set the normal staging inputs (`ANALYSIS_STAGING_URL`, `CLOUDFLARE_ACCOUNT_ID`, `ANALYSIS_IMAGE_REF`, and `ANALYSIS_INTERNAL_TOKEN`) and run the verifier:

```sh
export ANALYSIS_STAGING_URL='https://<deployed-worker-subdomain>.workers.dev'
export CLOUDFLARE_ACCOUNT_ID='<32-character-account-id>'
export ANALYSIS_IMAGE_REF='registry.cloudflare.com/<account-id>/meeshogi-analysis-mvp-staging@sha256:<image-digest>'
read -r -s -p 'Internal analysis token: ' ANALYSIS_INTERNAL_TOKEN
export ANALYSIS_INTERNAL_TOKEN
python3 cloud/scripts/verify-timeout-staging.py
unset ANALYSIS_INTERNAL_TOKEN
```

The verifier passes `--verification` only to its first deploy invocation; the normal deploy ignores the inherited environment flag and the renderer enables it only when given its explicit verification argument. Output is limited to non-secret JSON evidence including HTTP/failure status, driver boot ID, engine epoch/PID, wait return code, and smoke fixture IDs. A unit test alone does not count as staging timeout evidence.

## staging検証結果 (#19)

2026-09-25に実stagingで検証した（image・Worker・driverとも`0b1dc86`からbuild/deploy）。最終imageは `registry.cloudflare.com/<account>/meeshogi-analysis-mvp-staging@sha256:331f23790cadc0a017516493ac7536c14b268129fc0c0434195e2d4c64c7f13d`、runtime baseは `ubuntu:24.04@sha256:224a1869083a311ef3f13648a154ba79832fbef6364d31493642ca03082da254`。build時のUSI smoke（`usiok` / `readyok`）は成功した。

- Registry manifestとtag一覧への匿名GET、および認証なしの解析POSTはいずれもHTTP 401。
- 通常smokeは4 fixtureすべて成功。手数100のSFENも3候補・depth 19で解析できた。startposは3候補・depth 19（約966k nodes、約2.2秒）、synthetic middlegameはdepth 19、mate-in-oneはmate score、checkmate fixtureは終局・候補なし・探索値なしを確認した。
- timeout検証ではhealthが `enabled=true, consumed=false` を報告し、注入した停止でHTTP 504 `timeout` とengine reap（PID 4、wait rc `-9`）を確認した。同じboot IDで次の独立要求はHTTP 200となり、新しいengine epoch/PIDで成功した。通常modeで再deploy後は `enabled=false` となり、4 fixture smokeも再成功した。
- Wrangler SSHはHTTP 404 `Deployment not found`。instances APIは空で、要求成功中もWranglerの状態は `inactive` / location・version nullだったため、SSHとinstance状態確認は検証ゲートに採用しなかった。
- 新しいimageへ差し替えたdeployの直後は、前のContainer（旧image・旧env）が15分以上応答し続けることがあった。検証用deployはimageを先に通常deployで切り替えてから行い、`/internal/health` のboot IDとflagで対象Containerを確認する。
- deploy直後はContainer起動中の要求がtyped 502になることがある。Python urllib既定User-AgentはCloudflare error 1010（HTTP 403）になった。

## Issue #20 benchmark mode

**2026-09-25/26 result:** the full plan ran on build `faae69bfa42245ea9820cdf0b3420d95` (git `c6d5b52`): 3,060 first-pass attempts, 480 candidate repeats, 1,104 game-position requests and 6 new-instance cold trials (4,650 total, one transient Worker 502). The comparison, initial/alternative Free and Precision candidates and their limits are in [`docs/CLOUD-PROFILE-BENCHMARK.md`](../docs/CLOUD-PROFILE-BENCHMARK.md); the offline aggregate is in [`bench/results/issue-20/`](bench/results/issue-20/). The same directory holds `raw-issue20.jsonl.xz`, the sanitized raw ledger. `bench/sanitize_raw.py` replaced the run-start fingerprint `endpoint` and registry `imageRef` (staging hostname and account ID) with fixed placeholders, keeping the image digest, recomputed each `fingerprintSha256`, and rewrote the matching `runFingerprintSha256` values. All other rows are verbatim. `bench/test/test_issue20_results.py` re-runs `aggregate.py` on that file and requires byte-identical `aggregate.json.xz` (decompressed) and `aggregate.md`. The unsanitized raw stays in the operator's local archive. On 2026-09-26 the user approved the initial candidates as the product profiles: Free = standard-2 / Threads 1 / Hash 64 MiB / 1000 ms / MultiPV 2; Precision = standard-3 / Threads 2 / Hash 64 MiB / 5000 ms / MultiPV 3. Only these approved values are handed to #21 and later issues. Staging was restored to the normal deploy afterwards.

Operational notes from that run: the `ANALYSIS_BENCHMARK_TARGETS` Worker var is limited to 5.1 kB, so the six repeat/game manifests and the two cold manifests were deployed separately. A run that stops at `timeBudgetSeconds` exits 0; rerun the same manifest to resume the remaining attempts. The standard-2 and standard-3 chains can run concurrently because they use separate fixed apps, with separate raw output files aggregated together.

The operator benchmark uses authenticated `POST /internal/benchmark`, `GET /internal/benchmark/health`, and `POST /internal/benchmark/stop` routes. All are disabled on normal deploys. Benchmark deployment requires a build ID and one or more run manifests. The renderer binds a finite JSON allowlist of target names derived from each manifest's `segmentId`, expected type, and build ID. Arbitrary target names are rejected. Benchmark requests include both `targetId` and `segmentId`; normal `/internal/analyze` and `/internal/health` continue to use `analysis-mvp-singleton` on `ANALYSIS_CONTAINER`. Normal deploys still define the two benchmark classes/apps and their migration, but benchmark mode is off and no normal route addresses their bindings. Benchmark health, analysis, terminal handling, and stop use the same target-type-to-binding map. Each benchmark app remains fixed at `max_instances: 1`, so the standard-2 app is never resized to standard-3 or vice versa. A singleton may still be alive from an earlier deployment; readiness and the runner stop it through the authenticated benchmark stop route before starting a named measurement target. Analysis requests remain serial.

The three Container classes are `AnalysisContainer` (`ANALYSIS_CONTAINER`, normal app, fixed standard-2), `BenchmarkStandard2Container` (`ANALYSIS_BENCHMARK_STANDARD_2`, benchmark standard-2 app), and `BenchmarkStandard3Container` (`ANALYSIS_BENCHMARK_STANDARD_3`, benchmark standard-3 app). Migration `v2` adds both benchmark classes with one SQLite migration tag. Each class passes its own fixed expected type into the container environment; benchmark conditions and target IDs must match that type. These are lifecycle-only Durable Objects: no app storage, queue, or scheduler is added.

#### Why benchmark targets use two fixed apps

In the B-005 staging run (image `3393382f`, build `a127e749`), a fresh standard-3 target reported 2 CPUs and `MemTotal=8587268096` bytes, and the reference pilot completed 3/3 positions. A later standard-2 config on the same app reported a 2-CPU / 8-GiB runtime after 22 readiness polls; readiness refused it, although the app health view showed two healthy VMs. The single-app resize result was not accepted as a standard-2 pilot. This observation motivated separate standard-2 and standard-3 apps, each fixed to its declared type. Reuse of previously provisioned VMs is one possible explanation, not a confirmed cause; Cloudflare's [Container lifecycle documentation](https://developers.cloudflare.com/containers/concepts/architecture/) describes prewarming and cold starts but does not establish the cause of this resize mismatch. No running-instance count or billing conclusion is inferred from that health display.

`bench/conditions.json` is the shared condition allowlist: 48 candidate cells (instance type, Threads, movetime, and MultiPV) plus the 10-second standard-3 reference. All conditions request Hash 64 MiB. The Worker and driver resolve `conditionId` from the checked-in manifest. The deploy-rendered target allowlist only includes names for supplied run manifests. Benchmark health, analysis results, and terminal-position handling use the same listed target. Each response includes target ID/segment, expected type/build, actual runtime, boot ID, and Container lifecycle evidence. A request is rejected if the condition, target, deployed build, or observed runtime disagrees. `/internal/health` remains the singleton health route. It reports the driver boot ID, expected instance type, visible CPU/affinity/cgroup CPU quota and memory limit, `/proc/meminfo` MemTotal, root filesystem total bytes, and the five non-secret `identityDigests` for engine, weight, options, and source. Staging health also reports the Worker version ID when Cloudflare supplies the configured `version_metadata` binding. It does not invent missing platform values.

The benchmark-only v2 response keeps USI time, engine-reported NPS, same-info-line nodes/depth, derived NPS, process spawn-to-reap wall time, and obtainable child CPU time separate. It includes the same five artifact digest values as health, without engine/model names or private manifest text. Driver process CPU is read from `wait4` rusage when available. Every benchmark result, including terminal results and typed instance mismatch failures, carries the measured runtime facts. Raw health snapshots whitelist those runtime facts, identity digests, and available Worker version metadata. The raw result files must still be treated as measurement data because they contain SFENs and dataset provenance hashes.

If the engine exits before `bestmove`, the driver returns `engine_error` (HTTP 502) without retrying. The typed failure includes the `wait4` exit code or terminating signal, whether stdout reached EOF, the last parsed info depth/nodes/time, and the last non-info line kind; it never echoes raw engine output.

The runner and aggregator use only Python's standard library. The dataset generator/checker owns `bench/dataset/positions.json` and `bench/dataset/game.json`; do not substitute synthetic data for the measured positions. Run manifests select a stable `segmentId`, condition IDs, repetitions, order seed, optional pilot `positionLimit`, `maxRequests`, and `timeBudgetSeconds`. Before measuring, build the private image with `build-push-image.sh`; it prints `ANALYSIS_IMAGE_REF`, `ANALYSIS_BUILD_ID`, and `ANALYSIS_GIT_COMMIT`. Export the printed image ref and build ID (or provide `--image-ref` and `--expected-build-id`) to deployment, readiness, and runner commands. Deployment binds finite target names to that build ID. Readiness and each run's initial health check require the named target's baked build ID to match the expected ID. The runner also requires a pinned `@sha256:` image ref and records the build ID and git commit with an immutable run fingerprint containing image, Worker/driver versions, artifact digests, input hashes, and endpoint. Each response and periodic health check is checked against the expected build ID before an attempt is adopted. Raw run-start, attempt, health, and target-stop rows retain target ID/segment, expected type/build, runtime, boot IDs, artifact digests, and lifecycle evidence. Worker-generated schema v1 failures are retained separately in `workerFailure`, with driver identity marked unconfirmed; only the Worker failure code, message, and bounded diagnostic format are recorded. Rerunning the same `runId` skips completed attempts only if this fingerprint still matches; a changed image, build, deployment, input, or endpoint is refused. The aggregator rejects missing or mismatched fingerprints, mixed image/build/artifact identities, inconsistent conditions or position-dataset hashes across runs, duplicate primary reference attempts across runs, and duplicate attempt keys. Before applying condition labels or reference roles, it hashes the exact `--conditions` file (or default manifest) and requires that hash to match every run fingerprint. Game dataset hashes are tracked separately from positions datasets. A small `.pending.json` sidecar marks an in-flight request; after interruption, the runner finalizes the attempt as failed and stops its listed target before another name can be used.

### Pilot

Build the private image in the authorized Main environment using the existing procedure above. Start with the standard-3 reference pilot on a fresh named target. Readiness targets the same ID the runner uses, checks for two visible CPUs and 8 GiB MemTotal, and appends lifecycle evidence to the pilot raw file. If the check fails, do not run the pilot or full matrix. After a successful readiness check, the runner continues on that same target and destroys it with stopped-state confirmation at segment end.

```sh
export ANALYSIS_IMAGE_REF='registry.cloudflare.com/<account>/meeshogi-analysis-mvp-staging@sha256:<digest>'
export ANALYSIS_BUILD_ID='<32-hex value printed by build-push-image.sh>'
bash cloud/scripts/deploy-staging.sh --benchmark \
  --run-manifest cloud/bench/manifests/pilot-reference-standard-3.json \
  --run-manifest cloud/bench/manifests/pilot-standard-2.json
python3 cloud/scripts/benchmark-readiness.py --expected-instance-type standard-3 --expected-build-id "$ANALYSIS_BUILD_ID" --manifest cloud/bench/manifests/pilot-reference-standard-3.json --evidence-file /tmp/issue20-bench/pilot.jsonl
python3 cloud/bench/run.py --expected-build-id "$ANALYSIS_BUILD_ID" --manifest cloud/bench/manifests/pilot-reference-standard-3.json --output /tmp/issue20-bench/pilot.jsonl

# Only after the fresh standard-3 pilot proves 2 vCPU / 8 GiB:
python3 cloud/scripts/benchmark-readiness.py --expected-instance-type standard-2 --expected-build-id "$ANALYSIS_BUILD_ID" --manifest cloud/bench/manifests/pilot-standard-2.json --evidence-file /tmp/issue20-bench/pilot.jsonl
python3 cloud/bench/run.py --expected-build-id "$ANALYSIS_BUILD_ID" --manifest cloud/bench/manifests/pilot-standard-2.json --output /tmp/issue20-bench/pilot.jsonl
```

The pilot deployment allowlists both small manifests, but each request is routed only to the app fixed for its condition type. If either class fails CPU/affinity, `MemTotal`, build, or identity readiness, stop before running that pilot or the full matrix. If the newly isolated standard-2 app still fails its runtime check, keep the existing refusal guard and ask for a new decision before measuring; do not repeat a single-app resize experiment.

Before readiness or runner commands, set `ANALYSIS_STAGING_URL` and export `ANALYSIS_INTERNAL_TOKEN` using the existing silent prompt. The Python operator tools send a non-default User-Agent to avoid Cloudflare's Python-urllib 1010 response and never store or print the token. Pilot rows use separate run IDs and should not be mixed into full-run files used for profile comparison.

### Full positions matrix and aggregation

Each condition runs only through its fixed type app. The first-pass manifests include one attempt for all 48 candidate cells and three reference attempts; each instance type has a 90-minute run budget, leaving time in the six-hour total plan for candidate repeats, game timing and cold checks. The runner stops at its manifest's request/time limits and every failed HTTP attempt is retained. The manifests stay separate because the deploy allowlist is bounded; deploying another manifest changes the finite target list, never an app's `instance_type`.

```sh
bash cloud/scripts/deploy-staging.sh --benchmark --run-manifest cloud/bench/manifests/first-pass-standard-2.json
python3 cloud/scripts/benchmark-readiness.py --expected-instance-type standard-2 --expected-build-id "$ANALYSIS_BUILD_ID" --manifest cloud/bench/manifests/first-pass-standard-2.json --evidence-file /tmp/issue20-bench/full.jsonl
python3 cloud/bench/run.py --expected-build-id "$ANALYSIS_BUILD_ID" --manifest cloud/bench/manifests/first-pass-standard-2.json --output /tmp/issue20-bench/full.jsonl

bash cloud/scripts/deploy-staging.sh --benchmark --run-manifest cloud/bench/manifests/first-pass-standard-3.json
python3 cloud/scripts/benchmark-readiness.py --expected-instance-type standard-3 --expected-build-id "$ANALYSIS_BUILD_ID" --manifest cloud/bench/manifests/first-pass-standard-3.json --evidence-file /tmp/issue20-bench/full.jsonl
python3 cloud/bench/run.py --expected-build-id "$ANALYSIS_BUILD_ID" --manifest cloud/bench/manifests/first-pass-standard-3.json --output /tmp/issue20-bench/full.jsonl

python3 cloud/bench/aggregate.py --input /tmp/issue20-bench/full.jsonl --json-out /tmp/issue20-bench/aggregate.json --markdown-out /tmp/issue20-bench/aggregate.md
```

After reviewing the first-pass summary, Main selects at most four candidate cells for two more attempts each. Write one repeat manifest per instance type with those condition IDs, `repetitions: 2`, `attemptNoStart: 2`, a fresh `runId` and `segmentId`, the same position set, and a 3,000-second time cap; pass that same manifest to deploy, readiness, and runner, then aggregate all raw JSONL files together. The aggregator reports Top-1 agreement, reference Top-1 inclusion in candidate Top-2/Top-3, exact-CP absolute differences, mate kind/side/distance, failures and incomplete results, phase splits, repetition variation, and missing-data denominators. A separate candidate table repeats those quality comparisons against reference repetitions 2 and 3, using the same candidate attempts and showing ratio denominators. It does not treat the reference search as ground-truth play quality.

### Full game and cold start

`mode: "game"` reads `bench/dataset/game.json` and analyzes its positions in ply order for each condition/repetition. It writes one game summary with total serial HTTP wall time. Use one run manifest per chosen candidate condition and cap each at 1,800 seconds; if chosen cells use both instance types, deploy and run them separately.

Cold measurements are labelled **new-instance cold start**. Each repetition has a distinct allowlisted target name containing type, build, segment, and trial number. A separate preflight target supplies build and driver fingerprints, then is stopped before the first cold trial. The runner sends no health or warm-up request to a trial target before its first analysis, records unused-name evidence, first dispatch wall time, every HTTP attempt, response runtime/boot ID/identity, first HTTP wall time, and time to the first successful analysis. An unused allowlisted name proves only that the runner had not used that name; it does not prove a Container started. `verifiedNewInstanceTarget` counts a trial only when that unused-name evidence is paired with a valid analysis response boot ID, expected CPU/affinity/MemTotal runtime, target app/class/binding, build ID, git commit, and artifact digests. Failed or interrupted trials remain in the attempts denominator and retain their HTTP/Worker failure cause plus any cold-evidence failure reason. A failure is not assigned a new target or counted as a new trial. After destroy, the Worker polls `getState()` for at most five seconds at 100 ms intervals without another fetch; only `stopped` or `stopped_with_code` is confirmed. Each target's terminal state is confirmed before the next trial. This measures the first start of a new named Container. Idle-sleep resume remains unverified; the earlier same-boot response after more than 6.5 minutes idle remains an observation for that environment and trial.

```sh
bash cloud/scripts/deploy-staging.sh --benchmark --run-manifest cloud/bench/manifests/cold-standard-2.json
python3 cloud/bench/run.py --expected-build-id "$ANALYSIS_BUILD_ID" --manifest cloud/bench/manifests/cold-standard-2.json --output /tmp/issue20-bench/cold.jsonl

bash cloud/scripts/deploy-staging.sh --benchmark --run-manifest cloud/bench/manifests/cold-standard-3.json
python3 cloud/bench/run.py --expected-build-id "$ANALYSIS_BUILD_ID" --manifest cloud/bench/manifests/cold-standard-3.json --output /tmp/issue20-bench/cold.jsonl
python3 cloud/bench/aggregate.py --input /tmp/issue20-bench/full.jsonl /tmp/issue20-bench/cold.jsonl --json-out /tmp/issue20-bench/aggregate.json --markdown-out /tmp/issue20-bench/aggregate.md
```

The cost report applies the public Container rates and Worker/DO request and duration rates dated 2026-09-25. Engine-child `wait4` CPU is a partial lower bound because it excludes Python driver and other Container CPU. Allocated vCPU × the interval from first target dispatch to confirmed stopped state is the Container CPU upper-bound estimate. It includes coexistence and idle time until stop; it does not assume the five-minute `sleepAfter`. Memory/disk uses provisioned instance allocation × this interval. An unconfirmed stop is listed as unbounded; the pre-existing singleton is stopped for capacity control but remains unpriced when its actual type or start time is unknown. Worker CPU, account allowance balance, exact DO active duration, egress and final invoice rounding remain unknown; the report separates these from known request counts and labels gross usage before included allowances. Rate sources: [Containers](https://developers.cloudflare.com/containers/platform/pricing/), [Workers](https://developers.cloudflare.com/workers/platform/pricing/), and [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/).

### Restore normal staging

After measurements, confirm that every known target stop returned a terminal state in the raw evidence. Restore the normal deploy. It continues to declare the two benchmark-only classes/apps and their `v2` migration, but drops benchmark vars/allowlist so benchmark routes return 404 and normal API traffic remains on the standard-2 singleton. Verify the normal Container's actual CPU/affinity/MemTotal and benchmark-off health, then run the existing #19 smoke:

```sh
bash cloud/scripts/deploy-staging.sh
python3 cloud/scripts/benchmark-readiness.py --expected-instance-type standard-2 --benchmark-enabled no
python3 cloud/scripts/smoke-staging.py
```

The readiness check polls for at most two minutes by default (change with `--max-wait-seconds` and `--poll-interval-seconds`) and prints one non-secret JSON evidence line per poll. It succeeds only when Worker/driver deployment flags agree, `osCpuCount` and CPU affinity both equal the requested vCPU count (standard-2: 1, standard-3: 2), and MemTotal is in the expected memory range (6 or 8 GiB, allowing 1.5 GiB VM overhead and 0.25 GiB above). Cgroup CPU quota and memory limits are checked when exposed, but are not required; missing facts remain null. The output distinguishes a stale or contract-mismatched container, deployment-flag lag, wrong CPU count, and missing or out-of-range MemTotal. Root filesystem total bytes are reported as an observation and are not used to infer the Container size. The smoke is the separate normal-analysis check. Both require `ANALYSIS_STAGING_URL` and the existing token environment.

The fixed benchmark apps have no type-switch path: each readiness check names the target for its declared type and checks the matching app/class/binding as well as runtime and build. If a fixed app fails that check, do not start measurements. A standard-2 failure in the normal singleton also means normal staging has not been restored, regardless of the template's declared type. The benchmark-only class and app definitions remain in the Wrangler config after restore; they are not deleted or used by the normal API.

## Issue #21 asynchronous job backend

The same staging Worker also serves the public asynchronous game-analysis API under `/v1/*`. One imported game becomes one persisted job: a Queue consumer analyzes each position through the driver's `POST /session` streaming endpoint and commits validated per-position results to D1. All `/internal/*` routes behave exactly as before.

| Route | Behavior |
| --- | --- |
| `POST /v1/credentials` | Issues an install-scoped anonymous credential. |
| `POST /v1/jobs` | Validates and persists one game as one queued job, then enqueues its id. |
| `GET /v1/jobs/:id` | Owner-scoped status, profile, progress, and cursor for reconnecting clients. |
| `GET /v1/jobs/:id/results?afterPly&limit` | Persisted per-position results in ply order (default limit 100, max 200). |
| `POST /v1/jobs/:id/cancel` | Atomic persisted cancellation. |

### Anonymous credential and identity

The credential is `mcd1_<43 url-safe characters>` (32 random bytes, unpadded base64url) and is returned exactly once at issuance. D1 stores only its SHA-256 hash and derives the `own_<24 hex>` owner id from it; the raw credential is never logged or persisted. Unknown or malformed credentials get a plain 401. Issue #22 is the intended mobile handoff: the app stores this credential in Expo SecureStore and presents it as a bearer token. The identity is install-scoped only — it cannot be recovered cross-device, carries no account claims, and uninstalling or reissuing produces a new owner with separate jobs and quotas.

### Job admission

`POST /v1/jobs` accepts exactly `{idempotencyKey, profileId, initialSfen, moves}` in a body of at most 32 KiB, with at most 512 moves and a 128-character idempotency key made of `[A-Za-z0-9._:-]`. `profileId` is only `free` or `precision`; movetime, Threads, Hash, MultiPV, and any other engine setting are server-side only, and benchmark condition ids or target names are never part of the public API. Every move is replayed through tsshogi before persistence: ply 0 is the initial position and ply i is the position after move i. This accepts ordinary 92- and 150-move games with wide headroom.

Admission is atomic in D1: the job row and its ply-indexed position rows insert in one batch whose `INSERT ... SELECT ... WHERE` guards re-check the limits at insert time, and `UNIQUE(owner_id, idempotency_key)` protects replays. Idempotency is keyed on the canonical initial SFEN — the replayed position's `position.sfen` — so equivalent spellings (e.g. `/81/` vs `/9/`, reordered hand pieces) replay to the same job while a different move list or profile under the same key is still a conflict. Resubmitting the same key with the same canonical input returns the existing job (`idempotentReplay: true`, HTTP 200) without consuming quota or an active slot; the same key with a different input is a 409 `idempotency_conflict`. A different key creates a separate job. If the job row persists but the Queue send fails, the API returns 503 `enqueue_failed` honestly rather than reporting success; resubmitting the same key retries the enqueue.

Usage limits live with the profiles in `cloud/config/job-profiles.json` and are staging defaults, not permanent product limits: Free is 5 jobs per owner per Asia/Tokyo calendar day and 5 new jobs per trailing 60 seconds, and each owner may have 1 active job (queued or running) across both profiles. Cancelled jobs still count toward the daily quota. Precision additionally requires a server-side allowlist flag on the owner row:

```sh
cd cloud
./node_modules/.bin/wrangler d1 execute meeshogi-jobs-staging --remote \
  --command "UPDATE owners SET precision_allowed = 1 WHERE owner_id = 'own_<24 hex>'"
```

### Queue consumer

Exactly one queue `meeshogi-jobs-staging` drives execution (batch size 1, max concurrency 1, `max_retries: 3`, dead-letter `meeshogi-jobs-staging-dlq`), matching the singleton Container constraint — there is no second execution path, scheduler, or custom recovery framework. Each delivery resumes the job from the persisted `next_ply` cursor, calls `POST /session` on the profile's fixed Container app (Free → `analysis-mvp-singleton` on the standard-2 `AnalysisContainer` app — the same named instance as the synchronous `/internal/analyze` gate, so a job session and an internal analysis contend through the driver's single-request busy guard and take the transient retry path; Precision → a dedicated `analysis-jobs-standard-3` name on the standard-3 `BenchmarkStandard3Container` app; no client-visible benchmark route or condition), and streams newline-delimited results. One session covers every remaining position, so the driver reuses a single engine process per run while the Worker isolates validation per position. Each line is re-validated against the analysis contract — identity, conditions, legal PVs — and committed inside one guarded batch that requires the job to still be active and the persisted cursor to still equal that ply, so a committed cancellation guarantees no later result is written and a stale or duplicate line commits nothing.

Each session position carries a `legalMoveCount` recomputed from its persisted SFEN, so the driver's effective MultiPV is `min(profile.multiPV, legalMoveCount)`; positions with fewer legal moves than the profile MultiPV produce narrower-but-valid results rather than fabricated candidates. Precision jobs share the standard-3 app with benchmark mode — a benchmark deployment must not run concurrently with precision job traffic, since the dedicated job name contends with benchmark targets through the same single-request guard and `max_instances: 1`.

The consumer budget is 720,000 ms (~12 minutes) inside the Queue's 15-minute execution limit, with a 20-second tail margin so cursor commits finish before the deadline. A session that ends early (driver `deadline`) commits its progress, then the consumer sends a continuation `{v:1, jobId}` before acking — the send/ack boundary keeps at-least-once delivery without bespoke recovery state. Duplicate deliveries and terminal, cancelled, or failed jobs ack without opening a session. Driver `failure` result lines never advance the cursor and are never committed as results: a failure the Worker already proved impossible (`invalid`, `identity_mismatch`) is a permanent `contract_violation`; every other failure code, and a session `end.reason=error`, takes the transient path and retries from the failed ply with earlier progress preserved. Transient failures use standard Queue retry: `job-profiles.json`'s `consumer.maxRetries` (3) is the single source mirrored by the Wrangler `max_retries: 3`, and because Cloudflare `attempts` starts at 1 the delivery with `attempts === maxRetries` still retries while `attempts === maxRetries + 1` is final. Retry exhaustion marks the job `failed` (`retry_exhausted`), as do contract violations and driver 4xx rejections (`contract_violation`/`driver_rejected`). Marking a job failed is itself persisted before the ack: if the `failed` write fails the delivery is retried so the standard retry/DLQ path can still act — an active job is never silently stranded. Locally-determined terminal positions (checkmate/no-legal-moves at the end of a validated game) are committed without the engine.

### Deploy and smoke

One-time operator steps:

```sh
cd cloud
./node_modules/.bin/wrangler d1 create meeshogi-jobs-staging   # prints the UUID for JOBS_D1_DATABASE_ID
./node_modules/.bin/wrangler queues create meeshogi-jobs-staging
./node_modules/.bin/wrangler queues create meeshogi-jobs-staging-dlq
```

`deploy-staging.sh` renders `JOBS_D1_DATABASE_ID` into the config and applies `cloud/migrations/` after deploy and the secret upload. The job smoke issues a throwaway credential in memory, then verifies: a Free job created and replayed idempotently (same `jobId`, `idempotentReplay`), a second concurrent job rejected with 429 `active_job_limit`, owner isolation (404), precision rejected for a non-allowlisted owner, progress advancing under GET-only polling (client-disconnect equivalence), partial results via `afterPly` while running, per-result profile conditions/identity/`engineLaunch` evidence, and a cancellation that stays cancelled with frozen `nextPly`/result counts. HTTP status is reported in a dedicated `httpStatus` key so it is never confused with a job's `status` field:

```sh
export ANALYSIS_STAGING_URL='https://<deployed-worker-subdomain>.workers.dev'
python3 cloud/scripts/smoke-jobs-staging.py            # Free profile
python3 cloud/scripts/smoke-jobs-staging.py --precision  # two-pass allowlist flow described by the script
```

### Verification boundary

The TypeScript tests run the public API and consumer against a real local SQLite database and a fake session stream, covering validation, canonical-SFEN idempotency, JST day and trailing-window admission, concurrent admission (interleaved `Promise.all` POSTs on one connection — the conditional `INSERT` guards hold under interleaving, and D1 serializes writes per database, so the remaining staging risk is transport/binding behavior, not the guard logic), driver failure lines that never advance the cursor (transient vs permanent), failed-state persistence failure returning the delivery for retry, the `attempts > maxRetries` boundary (3 retries, final at 4), config/Wrangler `maxRetries` consistency, result/cursor/cancel guards, session continuation under an injected clock that expires the consumer budget mid-stream, duplicate delivery, retry exhaustion, and cancellation. They prove Worker-side behavior offline only. Real staging evidence additionally requires a deployed Worker plus the driver `/session` implementation; the Issue #20 benchmark numbers remain measurements of the earlier synchronous path and are not performance or cost data for this asynchronous backend. This is a staging technical gate: it is not wired into the mobile app (Issue #22) and is not production infrastructure (Issue #24).

## Remaining limits

This verifies the #19 staging technical gate only. It does not integrate cloud analysis into the mobile app, establish production service behavior, demonstrate commercial distribution rights for the Plus model, or claim performance for consumer devices. The archive and source-tree hashes are recorded instead of a fabricated upstream Git commit.
