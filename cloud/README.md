# Issue #19 staging analysis gate

This package is an isolated technical gate for one authenticated, synchronous SFEN analysis request. It is not connected to the mobile app. The iOS and Android app continue to analyze on-device, and staging access, an account, and network access are not required to use the initial product.

## Contract and boundaries

The Worker accepts only `POST /internal/analyze` with `Authorization: Bearer <ANALYSIS_INTERNAL_TOKEN>` and a JSON object containing exactly one field: `{"sfen":"..."}`. An unset Worker secret fails closed before the Container is called. The body limit is 1 KiB; the SFEN must be valid, at most 256 bytes, and contain no control characters or line breaks. Arbitrary USI commands, engine paths, engine options, and extra request fields are rejected.

The result is versioned JSON. `perspective` is always `sente`; exact scores remain either integer `cp` or `mate` values. Candidate first moves and complete PVs are checked again with `tsshogi@2.3.4`. A root with no legal moves returns `status: "terminal"` and either `terminal: "checkmate"` or `"no-legal-moves"`, no candidates, and null search measurements. A search without a complete exact MultiPV block returns `status: "incomplete"` and no candidates. Missing measurements remain `null`; bounds are not emitted as exact scores, and a normal mate score is not a mate proof.

The fixed verification conditions are `Threads=1`, `USI_Hash=64 MiB`, `movetime=1500 ms`, and requested `MultiPV=3`. The effective MultiPV is capped at the Worker-verified legal move count and is reported. Failures have `status: "failure"` and a typed code: `invalid`, `busy`, `timeout`, `identity_mismatch`, or `engine_error`. Busy maps to HTTP 409, timeout to 504, and invalid input to a 4xx response.

Cloudflare Containers require one Durable Object class and binding. This implementation has exactly one `AnalysisContainer` class, its `ANALYSIS_CONTAINER` binding, and the `new_sqlite_classes` migration used to register it. It adds no application Durable Object storage, coordinator, alarm, scheduler, retry, or recovery code. The class uses the standard `@cloudflare/containers` routing and lifecycle.

The Python 3.12 driver uses only the standard library. It checks engine, model, options, source archive, source tree, and build identity before opening its HTTP listener. The `ubuntu:24.04` image provides a new enough glibc and libstdc++ for the engine; a Docker build-time USI/`isready` smoke applies the same `EvalDir=/opt/engine` and fixed options as the driver, so an incompatible base or unreadable model fails the image build. It starts a fresh engine process for each request and waits for it to exit. A busy request is rejected immediately. The search deadline is `movetime + 5 s`; on timeout the driver sends `stop`, waits up to 750 ms for a response, sends `SIGTERM`, then `SIGKILL` if needed, and always calls `wait()` to reap the child. The next request uses a new process. `bestmove resign` yields an incomplete result with `engineOutcome: "resign"` and no fabricated move.

The image is `linux/amd64`. The worker config is only for `meeshogi-analysis-mvp-staging`, with one `standard-2` Container instance named `meeshogi-analysis-mvp-staging-analysis` and a digest-pinned Cloudflare managed registry image. `wrangler.staging.jsonc` is a template; scripts render a temporary config with the real account ID and image digest, then remove it. There is no public fault-injection route or public Container port.

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

The operator benchmark is a separate authenticated route, `POST /internal/benchmark`, and is disabled on normal deploys. Only the explicit `deploy-staging.sh --benchmark --instance-type standard-2|standard-3` arguments enable it. Inherited `ANALYSIS_BENCHMARK_ENABLED` and `ANALYSIS_EXPECTED_INSTANCE_TYPE` values are removed before rendering. A normal `deploy-staging.sh` restores standard-2 with benchmark mode off. The existing `/internal/analyze` request remains an SFEN-only request with the fixed #19 conditions.

`bench/conditions.json` is the shared allowlist: 48 candidate cells (instance type, Threads, movetime, and MultiPV) plus the 10-second standard-3 reference. All conditions request Hash 64 MiB. Requests contain only `sfen` and a `conditionId`; the Worker and driver both resolve that ID from the checked-in manifest. A request is rejected if its instance type differs from the deploy-rendered expected type or the runtime evidence disagrees. `/internal/health` reports the driver boot ID, expected instance type, visible CPU/affinity/cgroup CPU quota and memory limit, `/proc/meminfo` MemTotal, root filesystem total bytes, and the five non-secret `identityDigests` for engine, weight, options, and source. Staging health also reports the Worker version ID when Cloudflare supplies the configured `version_metadata` binding. It does not invent missing platform values.

The benchmark-only v2 response keeps USI time, engine-reported NPS, same-info-line nodes/depth, derived NPS, process spawn-to-reap wall time, and obtainable child CPU time separate. It includes the same five artifact digest values as health, without engine/model names or private manifest text. Driver process CPU is read from `wait4` rusage when available. Every benchmark result, including terminal results and typed instance mismatch failures, carries the measured runtime facts. Raw health snapshots whitelist those runtime facts, identity digests, and available Worker version metadata. The raw result files must still be treated as measurement data because they contain SFENs and dataset provenance hashes.

The runner and aggregator use only Python's standard library. The dataset generator/checker owns `bench/dataset/positions.json` and `bench/dataset/game.json`; do not substitute synthetic data for the measured positions. Run manifests select condition IDs, repetitions, order seed, optional pilot `positionLimit`, `maxRequests`, and `timeBudgetSeconds`. Before measuring, the runner requires `--image-ref` or `ANALYSIS_IMAGE_REF` with a pinned `@sha256:` digest and records an immutable run fingerprint containing image, Worker/driver versions, artifact digests, input hashes, and endpoint. Rerunning the same `runId` skips attempts only if this fingerprint still matches; a changed image, deployment, input, or endpoint is refused. Each attempt retains health and response boot IDs and artifact digest evidence. The aggregator rejects missing or mismatched fingerprints, mixed image/artifact identities, and duplicate attempt keys. A small `.pending.json` sidecar marks an in-flight request; after an interrupted process, the runner finalizes that attempt as `interrupted-before-response` before continuing, so the raw JSONL keeps one outcome row per attempt.

### Pilot

Build the private image in the authorized Main environment using the existing procedure above. Set `ANALYSIS_IMAGE_REF` to its pinned result, then deploy and verify each instance type before sending measurements:

```sh
export ANALYSIS_IMAGE_REF='registry.cloudflare.com/<account>/meeshogi-analysis-mvp-staging@sha256:<digest>'
bash cloud/scripts/deploy-staging.sh --benchmark --instance-type standard-2
python3 cloud/scripts/benchmark-readiness.py --expected-instance-type standard-2
python3 cloud/bench/run.py --manifest cloud/bench/manifests/pilot-standard-2.json --output /tmp/issue20-bench/pilot.jsonl

bash cloud/scripts/deploy-staging.sh --benchmark --instance-type standard-3
python3 cloud/scripts/benchmark-readiness.py --expected-instance-type standard-3
python3 cloud/bench/run.py --manifest cloud/bench/manifests/pilot-reference-standard-3.json --output /tmp/issue20-bench/pilot.jsonl
```

Before either runner command, set `ANALYSIS_STAGING_URL` and export `ANALYSIS_INTERNAL_TOKEN` using the existing silent prompt. The runner sends a non-default User-Agent to avoid Cloudflare's Python-urllib 1010 response and never stores or prints the token. Pilot rows use separate run IDs and should not be mixed into full-run files used for profile comparison.

### Full positions matrix and aggregation

Each condition has to run only while its declared instance type is deployed. The first-pass manifests include one attempt for all 48 candidate cells and three reference attempts; each instance type has a 90-minute run budget, leaving time in the six-hour total plan for candidate repeats, game timing and cold checks. The runner stops at its manifest's request/time limits and every failed HTTP attempt is retained.

```sh
bash cloud/scripts/deploy-staging.sh --benchmark --instance-type standard-2
python3 cloud/scripts/benchmark-readiness.py --expected-instance-type standard-2
python3 cloud/bench/run.py --manifest cloud/bench/manifests/first-pass-standard-2.json --output /tmp/issue20-bench/full.jsonl

bash cloud/scripts/deploy-staging.sh --benchmark --instance-type standard-3
python3 cloud/scripts/benchmark-readiness.py --expected-instance-type standard-3
python3 cloud/bench/run.py --manifest cloud/bench/manifests/first-pass-standard-3.json --output /tmp/issue20-bench/full.jsonl

python3 cloud/bench/aggregate.py --input /tmp/issue20-bench/full.jsonl --json-out /tmp/issue20-bench/aggregate.json --markdown-out /tmp/issue20-bench/aggregate.md
```

After reviewing the first-pass summary, Main selects at most four candidate cells for two more attempts each. Write one repeat manifest per instance type with those condition IDs, `repetitions: 2`, `attemptNoStart: 2`, a fresh `runId`, the same position set, and a 3,000-second time cap; deploy the matching instance type, run it, then aggregate all raw JSONL files together. The aggregator reports Top-1 agreement, reference Top-1 inclusion in candidate Top-2/Top-3, exact-CP absolute differences, mate kind/side/distance, failures and incomplete results, phase splits, repetition variation, and missing-data denominators. A separate candidate table repeats those quality comparisons against reference repetitions 2 and 3, using the same candidate attempts and showing ratio denominators. It does not treat the reference search as ground-truth play quality.

### Full game and cold start

`mode: "game"` reads `bench/dataset/game.json` and analyzes its positions in ply order for each condition/repetition. It writes one game summary with total serial HTTP wall time. Use one run manifest per chosen candidate condition and cap each at 1,800 seconds; if chosen cells use both instance types, deploy and run them separately.

`mode: "cold"` needs one condition per instance type per run manifest, `idleSeconds` greater than `sleepAfterSeconds` (the checked-in examples use 315 and 300), a position limit of one, and the desired repetition count. The runner sends an authenticated health snapshot before the quiet period, sends no HTTP requests during the wait, measures the next analysis including failures, and takes a health snapshot after it. A cold result is confirmed only when the analysis response itself has a boot ID different from the pre-idle boot ID and the idle interval exceeded `sleepAfter`; a later health boot change cannot confirm an analysis request that returned no boot ID.

```sh
bash cloud/scripts/deploy-staging.sh --benchmark --instance-type standard-2
python3 cloud/scripts/benchmark-readiness.py --expected-instance-type standard-2
python3 cloud/bench/run.py --manifest cloud/bench/manifests/cold-standard-2.json --output /tmp/issue20-bench/cold.jsonl

bash cloud/scripts/deploy-staging.sh --benchmark --instance-type standard-3
python3 cloud/scripts/benchmark-readiness.py --expected-instance-type standard-3
python3 cloud/bench/run.py --manifest cloud/bench/manifests/cold-standard-3.json --output /tmp/issue20-bench/cold.jsonl
python3 cloud/bench/aggregate.py --input /tmp/issue20-bench/full.jsonl /tmp/issue20-bench/cold.jsonl --json-out /tmp/issue20-bench/aggregate.json --markdown-out /tmp/issue20-bench/aggregate.md
```

The cost report applies the public Container rates and Worker/DO request and duration rates dated 2026-09-25. Engine-child `wait4` CPU is labeled as a partial lower bound because it excludes Python driver and other Container CPU. Separately, allocated vCPU × the full observed active interval is the Container CPU upper-bound estimate. The interval includes health/analysis request spans and gaps plus one configured `sleepAfter` tail per observed boot session; first-request latency includes startup when startup occurs in that request. Memory/disk uses provisioned instance allocation × this interval estimate. Worker CPU, account allowance balance, exact DO active duration, egress and final invoice rounding remain unknown; the report separates these from known request counts and labels gross usage before included allowances. Rate sources: [Containers](https://developers.cloudflare.com/containers/platform/pricing/), [Workers](https://developers.cloudflare.com/workers/platform/pricing/), and [Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/).

### Restore normal staging

After measurements, redeploy without a benchmark flag, verify standard-2 and benchmark-off via health, then run the existing #19 smoke:

```sh
bash cloud/scripts/deploy-staging.sh
python3 cloud/scripts/benchmark-readiness.py --expected-instance-type standard-2 --benchmark-enabled no
python3 cloud/scripts/smoke-staging.py
```

The readiness check polls for at most two minutes by default (change with `--max-wait-seconds` and `--poll-interval-seconds`) and prints one non-secret JSON evidence line per poll. It succeeds only when Worker/driver deployment flags agree, `osCpuCount` and CPU affinity both equal the requested vCPU count (standard-2: 1, standard-3: 2), and MemTotal is in the expected memory range (6 or 8 GiB, allowing 1.5 GiB VM overhead and 0.25 GiB above). Cgroup CPU quota and memory limits are checked when exposed, but are not required; missing facts remain null. The output distinguishes a stale or contract-mismatched container, deployment-flag lag, wrong CPU count, and missing or out-of-range MemTotal. Root filesystem total bytes are reported as an observation and are not used to infer the Container size. The smoke is the separate normal-analysis check. Both require `ANALYSIS_STAGING_URL` and the existing token environment.

After an image change or instance-type switch, the Worker can temporarily report new vars while an older Container still answers health, or the old Container can keep serving until a later deploy replaces it. Re-run readiness and compare the boot ID and all runtime facts. If the old health contract or boot ID persists, run a second deploy (for example, a normal deploy followed by the intended benchmark deploy), then check readiness again before sending measurements.

## Remaining limits

This verifies the #19 staging technical gate only. It does not integrate cloud analysis into the mobile app, establish production service behavior, demonstrate commercial distribution rights for the Plus model, or claim performance for consumer devices. The archive and source-tree hashes are recorded instead of a fabricated upstream Git commit.
