# Cloud analysis staging

## Current status

Issue #17 is at **fixed-SFEN gate pending**. The repository contains a staging-only Worker / Container skeleton and synthetic tests. No Cloudflare resource has been created or deployed by this package yet. D1, Queues, job profiles, app integration, and production resources are intentionally absent.

The cloud path is an evaluation stage. The app's on-device analysis remains in place until the fixed-SFEN gate, cloud benchmark, and both iOS and Android acceptance complete. Cloud connectivity is not a condition for local game management or analysis during migration.

## Staging architecture

- `cloud/src/handler.ts` accepts authenticated `POST /v1/internal/analyze` and `GET /v1/internal/health`. The Worker validates the strict SFEN shape, request bounds, and exact field set before forwarding. It does not forward the bearer token.
- `AnalysisContainer` is a SQLite-backed Container Durable Object with one `standard-2` instance maximum and a 30-second idle sleep target. The config has one worker named `meeshogi-analysis-staging` and no production or named environment.
- `cloud/container/driver.py` starts one engine process, verifies engine and weight SHA-256 values before launch, waits for USI readiness, and serializes analysis. It uses `usinewgame` between positions, accepts only bounded numeric controls, and chooses the deepest iteration with all requested MultiPV scores present and exact. Bound scores are not returned as completed candidates.
- The response uses the versioned, pure TypeScript contract in `src/cloud/analysis-contract.ts`. `modelId` is the opaque public alias `analysis-model-staging-v1`; it does not contain the private model name.

The driver reads `engine_options.txt` as data, not as shell or arbitrary USI commands. The reviewed file contains one setting, `FV_SCALE 40`; startup fails closed unless the file is exactly that allowlisted setting and the engine advertises `FV_SCALE`. It then sends `setoption name FV_SCALE value 40`. The driver also points the engine's `EvalDir` at the bundled `/opt/engine` directory, sets `Threads=1` and `USI_Hash=256`, disables ponder and the opening book, and changes `MultiPV` only within the request bound.

Health reports the USI engine identity, short binary and weight SHA-256 prefixes, CPU flags (including whether `avx2` is present), and readiness. Main must compare the Cloudflare CPU flags with the engine ISA before treating a successful deployment as accepted.

## Private artifact build and deploy

The engine, `nn.bin`, and `engine_options.txt` are read from the authoritative `sekirei-weight` manifests. `scripts/prepare-private-context.sh` verifies the manifest references and all three artifact hashes, then copies only those three files into a mode-0700 temporary directory outside this repository. It prints a JSON object containing the temporary path and verified digests. A digest mismatch or unexpected options file stops the script. The context persists after success so Main can build from it; Main removes that temporary directory after its build attempt.

The Docker build context must remain outside the checkout. To include the public driver source alongside the three private files, Main can compose a second mode-0700 temporary build context containing the three prepared files plus `cloud/container/driver.py`, then run the Docker build with `cloud/container/Dockerfile`. Pin `BASE_IMAGE` to an Ubuntu 24.04 digest in Main's build command and pass the expected engine / weight digests as build arguments. The Docker image runs as UID/GID 10001 and contains no API token.

Wrangler's container image build behavior must be checked by Main against the authorized staging build path before the first deploy. The checked-in config points at `./container/Dockerfile`; never stage private artifacts under the repository to satisfy a local build. If Wrangler cannot consume the external temporary context, Main must use an authorized external image-build / registry path and adjust only the staging image reference before deployment.

1. Install this package's pinned dependencies from `cloud/` with `npm install`.
2. In Main's permitted Docker environment, run `bash scripts/prepare-private-context.sh` and parse its JSON output without printing any credentials.
3. Build the linux/amd64 image from a separate external temporary context. Pin the base image by digest and retain only sanitized build output and the image digest.
4. Set the Cloudflare secret `STAGING_ADMIN_TOKEN` through Main's authorized Wrangler secret path. Do not add it to `vars`, `.env`, command logs, or source files.
5. Run `npm run deploy:staging`. The guard requires the exact staging worker name, rejects environment overrides, and invokes `wrangler deploy -c wrangler.staging.jsonc` without an environment selector.
6. Main performs the fixed-SFEN smoke, checks CPU ISA compatibility, and verifies that images and model bytes are not publicly readable. Only sanitized results belong in repository evidence.

## Security posture

- Every Worker route is behind the staging bearer secret. Requests that do not match the exact internal routes return 404.
- The bearer token is compared but never forwarded to the Container or logged. Engine stdout is consumed only by the USI parser and stderr is discarded.
- There are no public image/model read routes, file download routes, shell/debug routes, arbitrary engine-option pass-throughs, or public analysis proxy endpoints.
- `.gitignore` covers private build-context directory names. The intended private contexts live under the system temporary directory, never in the worktree.
- Only staging resource names are configured. No D1, Queue, R2, account token, or production binding is present.

## Tests and remaining gate

`cloud/test/handler.test.ts` tests worker authentication, input rejection, error mapping, and result-contract validation. `cloud/test/test_driver.py` uses a synthetic executable and synthetic weight bytes only; it covers complete-iteration selection, bound-score exclusion, mate and sente-score conversion, exclusive-search conflict, and invalid SFEN.

This package does not establish that the AVX2 engine can run on Cloudflare CPUs, that the account supports `standard-2`, or that Wrangler can build from the external private context. Those are deployment checks owned by Main and remain part of the fixed-SFEN gate.
