# Issue #19 staging analysis gate

This package is an isolated technical gate for one authenticated, synchronous SFEN analysis request. It is not connected to the mobile app. The iOS and Android app continue to analyze on-device, and staging access, an account, and network access are not required to use the initial product.

## Contract and boundaries

The Worker accepts only `POST /internal/analyze` with `Authorization: Bearer <ANALYSIS_INTERNAL_TOKEN>` and a JSON object containing exactly one field: `{"sfen":"..."}`. An unset Worker secret fails closed before the Container is called. The body limit is 1 KiB; the SFEN must be valid, at most 256 bytes, and contain no control characters or line breaks. Arbitrary USI commands, engine paths, engine options, and extra request fields are rejected.

The result is versioned JSON. `perspective` is always `sente`; exact scores remain either integer `cp` or `mate` values. Candidate first moves and complete PVs are checked again with `tsshogi@2.3.4`. A root with no legal moves returns `status: "terminal"` and either `terminal: "checkmate"` or `"no-legal-moves"`, no candidates, and null search measurements. A search without a complete exact MultiPV block returns `status: "incomplete"` and no candidates. Missing measurements remain `null`; bounds are not emitted as exact scores, and a normal mate score is not a mate proof.

The fixed verification conditions are `Threads=1`, `USI_Hash=64 MiB`, `movetime=1500 ms`, and requested `MultiPV=3`. The effective MultiPV is capped at the Worker-verified legal move count and is reported. Failures have `status: "failure"` and a typed code: `invalid`, `busy`, `timeout`, `identity_mismatch`, or `engine_error`. Busy maps to HTTP 409, timeout to 504, and invalid input to a 4xx response.

Cloudflare Containers require one Durable Object class and binding. This implementation has exactly one `AnalysisContainer` class, its `ANALYSIS_CONTAINER` binding, and the `new_sqlite_classes` migration used to register it. It adds no application Durable Object storage, coordinator, alarm, scheduler, retry, or recovery code. The class uses the standard `@cloudflare/containers` routing and lifecycle.

The Python 3.12 driver uses only the standard library. It checks engine, model, options, source archive, source tree, and build identity before opening its HTTP listener. It starts a fresh engine process for each request and waits for it to exit. A busy request is rejected immediately. The search deadline is `movetime + 5 s`; on timeout the driver sends `stop`, waits up to 750 ms for a response, sends `SIGTERM`, then `SIGKILL` if needed, and always calls `wait()` to reap the child. The next request uses a new process. `bestmove resign` yields an incomplete result with `engineOutcome: "resign"` and no fabricated move.

The image is `linux/amd64`. The worker config is only for `meeshogi-analysis-mvp-staging`, one `standard-2` Container instance, and a digest-pinned Cloudflare managed registry image. `wrangler.staging.jsonc` is a template; scripts render a temporary config with the real account ID and image digest, then remove it. The separate SSH facility is enabled for Wrangler operators with account write access so one engine can be stopped during the timeout check. There is no public fault-injection route or public Container port.

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

`deploy-staging.sh` validates the account, repository, digest, and Worker name. It pipes the token to `wrangler secret put ANALYSIS_INTERNAL_TOKEN`; the token is never an argument, config value, build argument, image layer, or log value. It then deploys the digest-pinned image and the one standard Container migration. Do not place this token in `vars`, a `.env` file, a shell trace, or the Docker context.

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

The smoke prints each fixture ID and measured result fields. It never prints the token. A failure is reported without treating fake-engine CI as staging evidence.

## Operator-only timeout and recovery check

This procedure is run by Main after deployment. The Container SSH feature is available only through authenticated Wrangler access; it does not expose the engine or SSH on a public port. No source or runtime fault route is enabled.

1. In Terminal A, set `ANALYSIS_STAGING_URL`, `CLOUDFLARE_ACCOUNT_ID`, `ANALYSIS_IMAGE_REF`, and `ANALYSIS_INTERNAL_TOKEN`, then start one fixed start-position request:

   ```sh
   python3 cloud/scripts/timeout-request.py > /tmp/meeshogi-timeout-result.json &
   echo $!
   ```

2. While it runs, use another terminal to list the staging Container and connect to that instance. The temporary config is rendered and cleaned by the wrapper:

   ```sh
   bash cloud/scripts/wrangler-staging.sh containers list
   bash cloud/scripts/wrangler-staging.sh containers ssh <container-id>
   ```

3. In the authenticated SSH shell, wait for the engine child, record its PID, and stop only that process:

   ```sh
   while :; do
     for comm in /proc/[0-9]*/comm; do
       read -r name < "$comm" || continue
       if [ "$name" = engine ]; then
         engine_pid="${comm#/proc/}"
         engine_pid="${engine_pid%/comm}"
         echo "stopping engine pid $engine_pid"
         kill -STOP "$engine_pid"
         break 2
       fi
     done
     sleep 0.05
   done
   ```

   The request should return with HTTP 504 and `status: "failure"`, `failure.code: "timeout"`. The driver sends `stop`, then terminates/kills and waits for that child. Record the stopped PID shown by the shell.

4. Confirm the response and that the recorded process has been reaped, then send an independent normal request through the same Worker and Container route:

   ```sh
   python3 - <<'PY'
   import json
   from pathlib import Path
   response=json.loads(Path('/tmp/meeshogi-timeout-result.json').read_text())
   assert response['httpStatus'] == 504
   assert response['body']['failure']['code'] == 'timeout'
   print('typed timeout confirmed')
   PY
   ```

   After reconnecting with the same Wrangler Container ID, verify `test ! -e /proc/<stopped-pid>`. Then run the fixed smoke from the previous section. Its first independent start-position request must return a complete result with positive `nodes` and `completedDepth` and a fresh engine process.

If Wrangler SSH is unavailable for the account, do not add a public fault endpoint. Use a short-lived verification image/config with a smaller engine deadline, record that temporary setting in the verification output, remove it after the timeout request, redeploy the regular fixed conditions, and rerun the start-position smoke. A unit test alone does not count as staging timeout evidence.

## Remaining limits

This verifies the #19 staging technical gate only. It does not integrate cloud analysis into the mobile app, establish production service behavior, demonstrate commercial distribution rights for the Plus model, or claim performance for consumer devices. The archive and source-tree hashes are recorded instead of a fabricated upstream Git commit.
