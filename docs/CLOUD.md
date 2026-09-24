# Cloud analysis staging

## Current status

Deployed staging Worker `c041494a` runs the repaired Cost envelope v2 code (`7a0c93a`) on the pinned image (`sha256:3908907a…`). Migrations `0001`–`0005` are applied remotely. A 104-position precision job (`98401ddc`, public Asahi Cup final game) demonstrated rolling chunk reservations and phase settlement under the `$1` daily cap on the pre-repair deployment (`0f0c33b6`); see the W3F-02 live-verification section. The Director's own investigation then reproduced five defects (R1–R5); the independent final review remains a separate later step. The current deployment routes Queue, cron, and same-key replay through a shared chunk transition and terminal cost finalizer, checks required settlements before releasing reservations, preserves lifecycle events locally when D1 is unavailable, and records budget overruns without clipping observations. Live verification of those repairs is pending — today's per-principal quota is exhausted, so game-level runs resume after the UTC rollover. Production resources remain absent; on-device analysis remains in the app during evaluation.

The cloud path is an evaluation stage. The app's on-device analysis remains in place until the fixed-SFEN gate, cloud benchmark, and both iOS and Android acceptance complete. Cloud connectivity is not a condition for local game management or analysis during migration.

## Staging architecture

- `cloud/src/handler.ts` accepts authenticated `POST /v1/internal/analyze`, `POST /v1/internal/bench/analyze`, `GET /v1/internal/health`, and `POST /v1/internal/stop`. The Worker validates the strict SFEN shape, request bounds, and exact field set before forwarding. It does not forward the bearer token. These internal routes accept an optional `profile` selector — `free-v1` (default, the `standard-2` container) or `precision-v1` (the `standard-3` container) — in the JSON body for analyze/bench, as `?profile=` for health, and as `{"profile": ...}` for stop. The selector is a fixed server-side allowlist; no other container or engine parameter is reachable.
- `/v1/internal/bench/analyze` is staging measurement instrumentation behind the admin bearer token. It stays under `/internal` and must never ship as an app-client endpoint or collide with the future public job API.
- `AnalysisContainer` routes `free-v1` to one `standard-2` slot; `AnalysisContainerPrecision` routes `precision-v1` to one `standard-3` slot. Both are in the same staging deployment, use the same private image, and have `max_instances: 1`. A D1 lease row in `JobCoordinator` fences one real engine search globally across both slots. The config has one worker named `meeshogi-analysis-staging` and no production or named environment.
- `cloud/container/driver.py` verifies the engine and weight SHA-256 values on every fresh process, waits for USI readiness, and serializes analysis. Before search it gets the root legal-move count from `helper-sekirei`, sets `GenerateAllLegalMoves=true`, and searches with `effectiveMultiPv=min(requestedMultiPv, rootLegalMoveCount)`. `info` lines are grouped into contiguous emission blocks; re-emission of a `(depth, multipv)` slot — including the engine's end-of-search flush, which may even lower the reported depth — is treated as a normal update, not a duplicate. The result uses the last block that wholly contains ranks 1..effectiveMultiPv at one depth, all with exact scores, distinct legal first moves, and legal PVs. Bound scores, missing ranks, and duplicate first moves inside a block keep that block from being presented as complete.
- The response uses contract v3 from the pure TypeScript module in `src/cloud/analysis-contract.ts`. Stored centipawn scores are safe integers in ±1,000,000; this pinned engine adapter separately rejects cp values outside its observed ±35,281 range. Scores are neither clamped nor reinterpreted as mate. Mate sign is explicit, including `mate -0` and unknown distance. `modelId` remains the opaque alias `analysis-model-staging-v1`.
- The engine's own `bestmove` is recorded as `engineBestmove`. It must be a legal root move — otherwise the request fails as a protocol error — but it need not equal the first candidate of the returned block: a deeper partial iteration can legitimately reorder the root, so a disagreement keeps the completed candidates and terminal `ok`/`mate` without reordering or re-scoring.
- The driver reports a unique `engineEpoch`, `processId`, and `restartCount` in health and analysis responses. Search deadline is `movetime + 5,000 ms`; timeout sends `stop`, waits at most one second, reaps via SIGTERM then SIGKILL if needed, and starts a fresh, re-verified process. Restart and startup readiness attempts are bounded. Timeout returns `position_failed:engine_timeout`; `incomplete` means the search completed without a full initial iteration and is not a retry hint.
- `cloud/helper-sekirei` is a rules-only Rust binary pinned to sekirei-core revision `7fd1d9b42a85fbc5aeb222f8aa453d3e08f3c0ac`. It generates the complete legal root move set, verifies declaration-win board conditions, replays PVs for legality, and supports a separately budgeted 1/3-ply mate proof. It does not load a model or engine.

The driver reads `engine_options.txt` as data, not as shell or arbitrary USI commands. The reviewed file contains one setting, `FV_SCALE 40`; startup fails closed unless the file is exactly that allowlisted setting and the engine advertises `FV_SCALE`. It then sends `setoption name FV_SCALE value 40`. The driver also points the engine's `EvalDir` at `/opt/engine`, sets `Threads=1`, `USI_Hash=256`, and `GenerateAllLegalMoves=true`, disables ponder and the opening book, and changes `MultiPV` only to the helper-derived effective count. The `GenerateAllLegalMoves` setting is part of profile identity.

Health reports the USI engine identity, short binary, weight, and options SHA-256 prefixes, `engineEpoch`, `processId`, `restartCount`, `lastRestartReason`, CPU flags (including whether `avx2` is present), readiness, and best-effort process/cgroup statistics. Analysis responses carry the process epoch/PID that produced the result, even when a timeout then starts another process. Benchmark analysis also includes process peak/current RSS, cumulative engine CPU time, and cgroup memory when readable. Missing statistics are omitted and never fail a request.

The terminal values distinguish `ok`, `mate`, `incomplete`, `position_failed:<reason>`, `win`, `resign`, `none` / `no_legal_moves`, `cancelled`, and `failed`. `bestmove win` is only returned as `win` after the helper verifies the board-state conditions for an entering-king declaration; SFEN does not include clock state. The board checks follow the [Japan Shogi Association's declaration conditions](https://www.shogi.or.jp/faq/rules/), excluding the clock condition that is not encoded in SFEN. A zero-legal-move result records whether the side to move is in check. `bestmove resign` and `bestmove none` never receive a synthetic score.

## Async job API (W3, staging)

Owner-authenticated routes are `POST /v1/jobs`, `GET /v1/analysis-profiles`, `GET /v1/jobs/{id}`, `GET /v1/jobs/{id}/results?cursor=&limit=`, and `POST /v1/jobs/{id}/cancel`. `POST /v1/jobs` accepts exactly `{ idempotency_key, profile, initialSfen, moves }`, bounds the body to 256 KiB and moves to 511 (512 positions including the initial state), and rejects `label` and all unknown fields. `initialSfen` is index 0, then every successfully replayed USI move adds the resulting position. `moves: []` creates a single-position job. `tsshogi@2.3.4` validates/replays the input; an illegal move returns HTTP 400 and its zero-based `moveIndex`. The idempotency digest covers normalized `{ initialSfen, moves, profile }`. The old public `positions[]` input is rejected. New jobs return `202`; same-owner/key/payload replay returns `200`; same key with another payload returns `409`.

Profiles are server-fixed, both at version 2: `free-v1` uses `standard-2` (1 vCPU), 1,000 ms / MultiPV 2 / Threads 1 / Hash 256 MiB; `precision-v1` uses `standard-3` (2 vCPU), 2,000 ms / MultiPV 3 / Threads 2 / Hash 256 MiB. `GET /v1/analysis-profiles` returns each profile's public execution-identity components and hash, entitlement for the caller, and blocked state. Job and result envelopes carry the same `executionIdentityHash`; contract-v3 result bodies remain unchanged. The hash includes CPU type/count, all effective search options, full engine/weight/options/helper/driver SHA-256 digests from configuration and runtime provenance, engine/model IDs, parser, helper, proof, contract, and TT-reset/history revisions. Before dispatch, cache lookup, and commit, the Worker compares the full `/health` provenance and configured engine digest; missing or mismatched provenance fails closed. Update the `ANALYSIS_WEIGHT_SHA256`, `ANALYSIS_ENGINE_OPTIONS_SHA256`, `ANALYSIS_HELPER_SHA256`, and `ANALYSIS_DRIVER_SHA256` vars to the rebuilt image's values before enabling job admission. Cache keys include the identity hash; migration `0002` retains legacy cache rows but marks them quarantined and unreadable.

Admission order is: six new-key POSTs/minute per principal (same-key replays exempt), kill/profile-block/daily-cost-cap, at most ten queued/running/cancelling jobs globally, one active job per owner, then UTC-day owner quota. Free quota is 5 jobs / 1,024 positions; precision is 2 jobs / 512 positions; each job is limited to 512 analyzed positions (initial state plus up to 511 moves). GET/profile/results share 120 operations/minute per principal; cancel allows 30/minute. Every 429 carries `Retry-After`. Rejected admissions do not reserve daily quota. Owner quota usage remains consumed once admitted. Admission stores validation results, quota use, idempotency, every size-8 outbox row, and only the head chunk's cost envelope. The full-game reference estimate is informational. Outstanding reservations from all UTC days count against today's spend cap. Warning begins at $0.50 and the staging cap is $1.00 per UTC day. These are conservative estimates, not an invoice.

Admission atomically stores the job, positions, owner quota, head-chunk reservation parts, idempotency key, and every size-8 outbox row. Only the reserved head outbox is dispatchable. Queue processing, cron recovery, and same-key replay use the same serialized chunk transition: it settles every required phase, records unused phase allocations as zero-cost ledger events, and only then closes the current outbox and reserves/enables the next chunk. The final chunk uses the same path and finalizes the job only after its ledger is complete. A failed D1 batch leaves the transition retryable; the cron scan and Queue redelivery converge on that same transition.

Terminal cost finalization is shared by normal completion, cancellation, DLQ, protocol/failure-threshold stops, admin kill, runtime-budget quarantine, and recovery deadline. It uses durable attempts, readiness/restart intents, proof intents, and observations to charge executed or uncertain work conservatively, marks provably unused reservations as zero-cost settlements, and leaves `cost_finalized=0` for cron retry if any required D1 settlement fails. It never clears `jobs.cost_reserved` or daily reservations ahead of those settlements. The single search claim also checks for a matching reservation, so queue order and message delivery cannot start unreserved work. A `cost_cap` denial marks every remaining position failed and the job `partial` when any result was committed, otherwise `failed`; it retains results and consumed quota and does not wait for midnight. Queue sends increment `delivery_count`; engine dispatch increments `attempts` (maximum 2). The jobs queue uses `max_retries: 5` (up to six deliveries) so a chunk can reach the job-level failure threshold before its message enters the DLQ. Results are paged by `result_seq`, then displayed by `position_index`; every page returns `resumeCursor`, including an empty tail page (which echoes the supplied cursor). A one-minute `scheduled()` scan resends stale outbox heads, retries terminal cost finalization, resumes explicit-cancel and DLQ intermediate states, recovers expired leases only after `Container.destroy()` confirms process death, terminates jobs that exceed the no-progress deadline, and removes terminal jobs/results after 7 days and cache rows (including quarantine) after 30 days. Quota, attempt-cost, phase-cost, and daily aggregates are retained.

Only contract-v3 `ok` / `mate` are evaluation successes and cache eligible. `incomplete` and `resign` are failed position rows with evaluation-missing accounting, no retry and no contribution to the real-failure thresholds. Timeout/engine-exit/restart receive at most one fresh engine attempt. Illegal PV, illegal bestmove, unknown score, and other protocol/integrity errors stop the job as `failed` while retaining earlier committed results, and block that profile until an admin clears `/v1/internal/profiles/{profile}/clear-block`. Verified `no_legal_moves`, `none`, and `win` are committed `done` terminal states, not evaluations and not cached. Job counts separate `succeeded`, `incompleteOrMissing`, `failed`, and `terminal`; evaluation-missing rows do not inflate the real-failure count. Each successful evaluation (including ordinary cp results) calls the bounded `/prove` driver endpoint independently, with a 3-ply request and 10,000 helper budget. The shared proof schema validates result enum, budget version/value, nodes-used cap, actual proven plies, and representative legal USI line. It stores 1 or 3 plies; budget exhaustion is `unknown`, and engine PV/score cannot create a badge.

Cancellation writes `cancel_in_progress` before contacting the exact profile container's `/stop` endpoint. The stop request carries a job/epoch/position/attempt/lease fence, which the driver matches against its active search. It blocks new dispatch and fences results; if the process has not quiesced after 5 seconds, the worker calls `destroy()` and only settles `cancelled` after destruction is confirmed. Scheduled recovery resumes interrupted explicit cancellations. Cancellation before start completes immediately; terminal jobs keep their existing status. Stale/unknown DLQ messages are acknowledged. A current-epoch DLQ message records a distinct `dead_letter_in_progress` marker, destroys any active lease, preserves committed results and consumed cost, releases outstanding cost reservation and terminates the job as `partial` or `failed`; Queue redelivery and scheduled recovery resume interrupted DLQ handling.

`/v1/jobs/{id}` returns identity, counts, timestamps, stop reason, and `costEnvelopeVersion: 2`. `costs` distinguishes `fullJobReferenceEstimateUsd`, `currentOutstandingReservationUsd`, settled resource and service estimates, and `unobtainedInvoiceUsd: null`; older estimate and attempt aliases remain. Results contain committed `done` and terminal `failed` rows with identity, result, stats, proof, and separate delivery/attempt counts. Auth uses SHA-256 token digests in D1 `principals`; cross-owner IDs return 404. `ANALYSIS_ADMIN_TOKEN` protects internal kill, fault-arm, and profile-block clear routes. Fault fixtures are default-disabled (`ANALYSIS_FAULT_FIXTURES_ENABLED=0` in staging). In an explicitly enabled test environment the arm route requires the designated test principal and a pending job/epoch/position/attempt scope, and arms expire after ten minutes. `destroy-during` waits for the matching active fence and `searchStarted` health state before destroying the container. `sigstop` consumes its D1 arm before restarting the target container once with `MEESHOGI_TEST_SIGSTOP_ENGINE=1` and its matching fence passed to `startAndWaitForPorts` via per-start `envVars`. Admin DELETE clears any remaining arms. Both were exercised live on staging (see the W3-fix2 verification below).

### Cost envelope v2

Each chunk of up to eight positions reserves two attempts per position, proof up to 3 seconds, up to 5 seconds for each inter-position gap, up to 560 seconds for readiness (four 140-second calls), up to 420 seconds for engine restarts (three 140-second restarts), the active profile container's 30-second idle tail, and a 30-second idle allowance for the other fixed profile container. A trailing chunk uses its actual position count. The attempt cap is `profile movetime + 5,000 ms watchdog + 5,000 ms process cleanup + 500 ms response overhead`. Health, analysis, proof, stop, and destroy communications have explicit timeouts. Before health, analysis, and proof calls, the Worker persists a budget intent; an unresolved intent consumes its remaining bounded allowance after redelivery. The Worker checks the persisted per-chunk readiness and restart budgets before another unit of work. Search wall time, proof wall time, health readiness, restart, inter-position, and idle phases have separate ledger rows. Measurements are settled at their observed duration; if an observed duration exceeds its reservation, the ledger records the full cost and overrun, and the job stops before new dispatch. Unknown transport settles the finite attempt cap only after destruction is confirmed, with `engine_ms: null`. Unknown readiness/restart intents settle conservatively from their persisted bounds. Once runtime contact is observed, startup and final-idle reservations remain as measured or conservative spend instead of being released. The final 30-second tails are charged at their full cap when the chunk completes; `sleepAfter: 30s`, `onActivityExpired()`, `stop()`, and the persisted stop/sleep lifecycle events document the sleep path. Lifecycle records are first saved in the Container Durable Object's local SQLite and retried to D1; stop and destroy do not depend on the D1 log RPC. If stop fails, the container tries `destroy()` and the same full tail cap remains spent. A cache-only cold job still pays readiness and tail phases because cache lookup follows pre-dispatch health.

The per-job service allowance is `$0.003/job + $0.0015/chunk + $0.0005/position`; a separate `$0.03/UTC day` row is written once for cron/API control overhead. At the current D1 write rate, those amounts correspond to 3,000, 1,500, and 500 row/index write-equivalents respectively, plus the daily 30,000-write allowance. This assumption covers per-position ledger/status writes, chunk outbox/retry work, job state, cleanup, and bounded Workers/DO/Queue control overhead under the 5-job/1,024-position free quota, 2-job/512-position precision quota, `max_retries: 5` (six deliveries), and 7-day job / 30-day cache cleanup schedule. It assumes ordinary API traffic within the existing per-minute rate windows; those windows limit bursts but do not impose a total daily request count. The allowance is a fixed estimate, not a metered invoice. No included plan allowance is credited as an offset.

The resource estimate uses the published container rates of `$0.000020/vCPU-second`, `$0.0000025/GiB-second`, and `$0.00000007/GB-second` for the fixed `standard-2` / `standard-3` shapes. Service assumptions use current [Workers and D1 pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), and [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/). D1 row and index writes are counted individually; a Queue delivery is budgeted at the documented typical three operations, with retries adding reads; Durable Object RPC method calls and Workers requests/CPU are included in the fixed service allowance. The `daily_cost` row includes daily service allowance plus settled chunk service/resource amounts and all outstanding reservations, and drives the `$0.50` warning / `$1.00` staging cap.

Migration `0001_init.sql` creates the original tables. Additive `0002_async_jobs_hardening.sql` preserves admitted jobs, positions, owner quota, historical cost, and cached values, extends job state with `cancelling`, adds execution identity / result sequence / delivery / proof / reservation columns and new cost, slot, and fault tables, and marks old cache rows quarantined. `0003_recovery_cost_identity_faults.sql` adds persisted execution identity components, upgrades fault arms to owner/job/epoch/position/attempt scope with expiry, and marks legacy cancellation states for recovery. `0004_chunk_cost_ledger.sql` adds chunk-only reservation batches, per-phase reservation and settlement rows, durable container lifecycle and engine restart events, and the outbox dispatchable bit. `0005_cost_finalization_budgets.sql` adds durable terminal-finalization state and the runtime-budget stop bit; pre-existing terminal rows without reservation parts are marked finalized. Existing terminal jobs remain history. Because queued/running rows have no v2 identity, the migration closes them as `failed` or `partial` with `pre_identity_migration` and terminalizes their unfinished positions so an old Queue message cannot resume them under a new engine identity. Staging has migrations `0001`–`0005` applied remotely.

The existing staging database already has `0001`–`0005` applied. For a new staging database, apply all pending migrations with:

```sh
cd cloud
npx wrangler d1 migrations apply meeshogi-analysis-staging-db --remote --config wrangler.staging.jsonc
```

The config's `v3` DO migration adds `AnalysisContainerPrecision`; `v1` and `v2` are preserved. Tests use only `wrangler.test.jsonc`, an ephemeral local D1/Queue namespace, and two per-profile synthetic service bindings; they never target staging resources. The live record below predates this repair.

### Pre-repair live W3 verification (2026-09-23, version `9910c162` / standard-2 resting config)

Migration `0001_init.sql` applied to the remote D1; two principals seeded (`staging-main` with precision, `staging-free-only` free-only; tokens live only outside Git). Observed on the deployed Worker:

- End-to-end: POST job (3 positions, free-v1) → `queued` → `running` → `completed` in ~8 s; committed contract-v3 results (initial position depth 21, `engineBestmove=2g2f`); per-position cost ledger ~$0.00053 each.
- Idempotency: same key+payload → `duplicate:true`, original jobId; same key different payload → `409`.
- Authz: no token → `401`; cross-owner GET → `404`; free-only principal + `precision-v1` → `precision_not_enabled`; revoked path enforced by flag.
- Cancel: 12-position job cancelled mid-run → `cancelled` with 2 committed results preserved, rest pending.
- Deploy churn: worker redeployed mid-job → the 12-position precision job still completed 12/12 with zero failures (queue redelivery/recovery held).
- Cache: identical job resubmitted → all positions `cached:true`, `$0` cost, identical results — and a `precision-v1` resubmit on a different SFEN executed for real on the `standard-3` deployment (`cached:false`, cost ledger charged). Note: instance type is intentionally not part of the cache key.
- Kill switch: `POST /v1/internal/kill {mode:"admission"}` → new jobs refused `503 admission_disabled`; `DELETE` restored admission.
- Quota: fifth free job of the UTC day admitted, sixth POST → `daily_quota_exceeded`.
- Paging: `limit=4` pages returned stable position indexes 0–3 then 4–7 with `nextCursor`.

Not exercised live: true engine timeout/hang injection (no SSH/instance-delete on this account — synthetic driver tests cover kill/restart), Queue retry→DLQ path, and the 6-POST/min window (the per-owner/global active-job and quota gates reject first by design).

The 5-second comparison required by AC5 completed earlier on both instance types: `cloud/bench/results/ref5s-standard-2` and `ref5s-standard-3`, each 36/36 warm HTTP 200 on the original 12 fixtures (3 warm each) plus 3 cold samples — including `middlegame-150` at 5 s on both types, further contradicting the earlier deterministic-hang claim.

### Post-repair live W3 verification (2026-09-24, version `71a8d636` / image `sha256:b0818e4f`)

Migration `0002_async_jobs_hardening.sql` applied remotely to the existing staging D1 with zero active jobs at apply time; all 9 legacy jobs, both principals, and 26 legacy cache rows were preserved — the legacy cache rows sit under `quarantined=1` and are never read. Worker version `1fb61ef2` then `71a8d636` deployed with the v3 DO migration (`AnalysisContainerPrecision`), cron `* * * * *`, and the DLQ consumer. Operational note: the original principals (`staging-main`, `staging-free-only`) had exhausted their UTC daily quotas from earlier live tests, so two additional test principals (`staging-w3fix-verify`, `staging-w3fix-verify2`, precision-enabled) were seeded with SHA-256 token digests only — recorded per Director instruction; no further principals will be added to work around quota, and unneeded test credentials will be revoked after verification. Observed on the deployed Worker:

- Dual-container routing: `free-v1` job completed on `standard-2`/`vcpu:1` (4/4 positions); `precision-v1` job completed on `standard-3`/`vcpu:2` (3/3) — separate Container applications (`a03d6df2…` and `a03e1f19…`), separate engine epochs.
- Contract v3 end-to-end on new identity: `executionIdentityHash` per profile (free `605e3993…`, precision `4cfcfb12…`), results carry `resultSeq`, `deliveryCount`, `attempts`, proof envelope.
- Internal profile selector: `GET /v1/internal/health?profile=precision-v1` and `POST /v1/internal/analyze {profile:"precision-v1"}` reach the `standard-3` container; unknown profile → `400` before any container contact. The internal analyze envelope keeps the instrumentation label `fixed-sfen-staging-v2`; routing is proven by the responding container.
- Fault injection: `throw` arm ×4 on job `622689bb` → all 4 deliveries threw → message exhausted `max_retries:3` → DLQ consumer terminalized the job `failed` with `stopReason:"dead_lettered"` and the second outbox chunk never dispatched (head-only outbox held). `destroy` arm on job `bd577e48` → position 4's dispatch was destroyed and retried (`attempts:2`); job still completed 11/11.
- Cancel race: cancel at committed=2 → `cancelled`; the 2 committed results remain readable, 11 positions stay pending. A pre-start cancel completes immediately.
- Cache on new identity: repeat sequence positions returned `cached:true` (`attempts:0`) with `estimatedSavingsUsd` recorded — scoped by the new `executionIdentityHash` key, not the quarantined legacy rows.
- Mate proof: `mate-in-one` fixture → engine `R*3a` `scoreMate:1`, terminal `mate`; `/prove` returned `{"result":"proven","cost":97,"plies":3,"budget":10000,"revision":"sekirei-proof-ops-v1"}` stored in `proof_json` and the results payload.
- Kill mode: `{mode:"admission"}` → `503 admission_disabled` on new jobs; `DELETE` restored and the same submission was accepted.
- Idempotency/authz on the new backend: replay → `duplicate:true`; same key different payload → `idempotency_conflict`; cross-owner → `404`; no token → `401`; `illegal_move` input → `400` with `moveIndex`.
- Scheduled recovery: `wrangler tail` captured the `* * * * *` cron event invoking `JobCoordinator.recover` and `cleanup` each minute.
- Full-game observation: one complete public game (`fixtures/kif/kiou.kif`, 77 USI moves → 78 positions) as job `cb1421cf` on `free-v1`/`standard-2` — all 78 positions `done`, zero failures; wall time 3m52s created→completed (~3.0s per position including queue/chunk overhead on top of the 1000 ms engine time); `cost_attempt_ledger` recorded 72 engine attempts totalling 71,024 ms engine time (~987 ms each) and $0.038089 actual vs $0.063749 conservative estimate; 6 opening positions hit the new-identity cache (`attempts:0`, ~$0.0032 recorded savings); `costWarning:false`.

Not exercised live: SIGSTOP no-response injection (to be armed per-start via `startAndWaitForPorts` `envVars` in a follow-up change; currently covered by driver unit tests, with the live `destroy` arm covering the kill class), and the 6-POST/min admission window (per-owner/global gates reject first). Note the `throw` arm must land before the targeted delivery — an arm placed mid-job only affects deliveries not yet claimed. The Director's W3-fix review retained this section's evidence but withheld overall acceptance pending repairs W3F-01..W3F-06 (recovery mid-states, cost reservation consistency, mate-proof semantics, failure accounting, real fault injection with arm expiry, and identity/input tightening); the verification above is therefore a partial record, not completion of the W3 gate.

### W3-fix2 live verification (2026-09-24, image `sha256:3908907a…`, migrations 0001–0003 applied)

The W3F-01..06 repair (`a577ca1`) plus three live-discovered fixes were deployed across versions `4e0aca66` → `76d0330e` → `98e4213f` → `2e98b8a4` → `88158d98` → `9d0d2ef4`, then a deliberate-mismatch deploy `a46d2f48`, then the final candidate `8e239022` (correct digests, `ANALYSIS_FAULT_FIXTURES_ENABLED=0`). Fault verification ran under `ANALYSIS_FAULT_TEST_PRINCIPAL_ID=prn-main`. Observed on the deployed Worker:

- **Artifact-bound identity**: jobs carry a per-profile `executionIdentityHash` derived from the deployed engine-binary/weight/options/helper/driver digests (free `db3ab2e9…`, precision `446477ab…`) — a distinct namespace from the pre-artifact `605e3993…`.
- **Mate proofs**: mate-in-one → `plies:1`, `line:["G*5b"]`; mate-in-three → `plies:3`, `line:["3b4a+","5a6a","7h7a+"]`; `budgetVersion:"sekirei-proof-ops-v2"`. Actual proof depth and a legal representative line are stored, replacing the earlier requested-depth report.
- **Real destroy-during** (`2b73fd4` prerequisite): arm on position 3 attempt 1 → `Container.destroy()` mid-`go` → the in-flight `/analyze` resolved as a bare non-JSON 500 → classified as uncertain transport loss (`position_failed:driver_unreachable`), not a protocol error → quarantine + conservative cost ledger entry (`engine_ms` NULL, $0.0154) → attempt 2 completed; job finished 7/7 with the slot released and the arm consumed. Before `2b73fd4` the same sequence was misclassified `protocol_error` and set `profile_blocked:free-v1`.
- **Real SIGSTOP**: arm on position 1 attempt 1 → the container was restarted once with `MEESHOGI_TEST_SIGSTOP_ENGINE=1` via per-start `envVars` (no permanent image env) → the engine froze in `go` → watchdog `engine_ms:10084` → engine restart → attempt 2 completed; the arm was consumed and TTL-cleaned.
- **Cron recovery of lost work**: a job crafted into the admission-interrupted state (outbox rows `sent_at=NULL`) was picked up by the `* * * * *` scheduled scan and driven to `completed` with no client re-POST (`delivery_count:1`).
- **DLQ terminalization**: a crafted job plus a `throw` arm (remaining=8) → 6 failed deliveries (initial + `max_retries:5`) → DLQ consumer terminalized the job `dead_lettered`, released its cost reservation, and consumed the arm (6/8 used).
- **Cancellation**: an in-flight cancel fence-stopped the running position (reverted to `pending`) and settled `cancelled` with no zombie lease. A `cancelling` job left with `stop_reason=NULL` converged to `cancelled` on the next scheduled tick after the `9b3ef02` `COALESCE` fix — the wedge it closed was reproduced live.
- **Rate limits**: GET 120/minute then 429; cancel 30/minute then 429; the 7th POST within a minute → `rate_limit` (when not already stopped by the active-job gate).
- **Input validation**: body over 256 KiB → `invalid_request`; a `label` field → rejected; >511 moves → rejected; `illegal_move` → `moveIndex` returned.
- **Idempotency**: replay → `duplicate:true` with the original jobId; same key with a different payload → `idempotency_conflict`.
- **Runtime MISMATCH fail-closed**: deploy `a46d2f48` with a zeroed `ANALYSIS_HELPER_SHA256` → position 0 failed `position_failed:protocol_error` at runtime provenance verification (`attempts:0`, before engine dispatch) → job `failed` and `profile_blocked:free-v1` set; a reasonless-5xx transport loss does not produce this block. The flag was cleared after reverting to correct digests.
- **Historical configurable cost cap at `af0d453`**: the default was `$1` and staging was temporarily `$5`. That whole-game reservation policy was superseded by Cost envelope v2 above, which restores staging to `$1` and reserves one chunk at a time. The earlier conservative estimate priced a 78-position job at ≈$2.43 free / ≈$4.16 precision; those reference values describe the prior model, not the current head-chunk admission reservation.
- **Full-game observations** (public `fixtures/kif/kiou.kif`, 78 positions):
  - `free-v1` job `6aecc815` (`standard-2`): `partial` — 77/78 `done` plus 1 `incomplete` evaluation-missing position (W3F-04 classification, not an engine failure); 6 positions cache-hit; admission estimate $2.434441 vs settled attempt estimate $0.003354; recorded cache savings ≈$0.003174; identity `db3ab2e9…`.
  - `precision-v1` job `940d30b5` (`standard-3`, 2 vCPU): `completed` 78/78, zero failed/incomplete/terminal-only; 5 cached (≈$0.0039 savings); admission estimate $4.160881 vs settled $0.010596; wall ≈7m08s; identity `446477ab…`.
- **Fault-disabled final smoke**: candidate `8e239022` with `ANALYSIS_FAULT_FIXTURES_ENABLED=0` → the arm route returns `{"error":"not_found"}` (404); a free job (4/4) and a precision job (2/2, `standard-3`) completed normally.
- **Credential hygiene**: the two extra verification principals (`staging-w3fix-verify`, `staging-w3fix-verify2`) were revoked after this round — confirmed `unauthorized` on a live request. No production resources exist; all bindings target `meeshogi-analysis-staging-*` only.

### W3F-02 live verification (2026-09-24, version `0f0c33b6`, migration `0004` applied)

The rolling-reservation cost model (`c1adcf9`, Cost envelope v2) was deployed with the staging cap back at `$1`. Observed live on the 104-position public Asahi Cup final game (103 USI moves; job `98401ddc`, `precision-v1`/`standard-3`):

- **Head-chunk-only admission**: the job was admitted under cap `$1` while its informational `fullJobReferenceEstimateUsd` is `$1.096911`. Admission created a single `cost_reservation_batches` row `job:…:1:0:8` for positions 0–7 at `$0.087147`; only outbox chunk 0–8 was `dispatchable=1`/`sent`, and chunks 8–96 stayed `dispatchable=0`/`sent_at=NULL`.
- **Rolling reservation across chunks**: as each chunk finished, the next batch appeared — `1:8:16`, `1:16:24`, `1:24:32` … each ≈`$0.084147` — created only after the prior chunk completed. `currentOutstandingReservationUsd` stayed within one chunk (≈$0.072–0.087), never the full-game worst case.
- **Phase settlement, not just reservation**: `cost_phase_ledger` for this job records `engine_attempt` 99 rows/$0.016725, `mate_proof` 98/$0.00264, `inter_position_runtime` 91/$0.003542, `container_readiness` 313 observations settled at $0.008197 (cold start measured 6,156 ms then ~433 ms warm health checks), `container_restart` 13 settled at $0 (no restarts occurred — reserved portion released), `final_idle_to_sleep` 13/$0.023842, `dual_container_idle_overlap` 13/$0.013988, and `bounded_service_allowance` 13 chunks/$0.0745.
- **API v2 fields**: `fullJobReferenceEstimateUsd` `$1.096911`, `currentOutstandingReservationUsd` `0` at completion, `settledResourceEstimateUsd` `$0.068934`, `settledServiceEstimateUsd` `$0.0745`, `unobtainedInvoiceUsd: null`.
- **Container lifecycle evidence**: `container_lifecycle_events` for `precision-v1` recorded `first_contact`, `sleep_timer_elapsed`, and `sleep_confirmed` from the DO's own `onStart`/`onActivityExpired`/`onStop` hooks — the idle-to-sleep path is real, not assumed.
- **Job outcome**: `partial` — 103/104 `done` (5 cache hits, ≈$0.0039 recorded savings) plus 1 `incomplete` evaluation-missing position, zero hard failures; daily row `spent $0.243971 / reserved 0` for UTC 2026-09-24.
- **Quota interplay**: a free-only principal's parallel submission was correctly rejected `daily_quota_exceeded` (5 jobs/day already used); no additional principals were created — the remaining game×profile runs wait for the UTC rollover per plan.

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

The benchmark compares the same digest-pinned private image on one `standard-2` instance (1 vCPU / 6 GiB / 12 GB) and one `standard-3` instance (2 vCPU / 8 GiB / 16 GB). `max_instances` stays at 1. Both containers are bound by the same staging deployment, so no redeploy is needed between instance sizes: `--instance-type` selects which profile binding the runner targets (`standard-2` → `free-v1`, `standard-3` → `precision-v1`), and the runner sends that profile on the health and analyze requests. The runner serializes every request, waits between calls, retries a single 409 once after a gap, retries one 5xx once after a 5-second gap, and stops with a non-zero exit code if an error remains. It begins with three cold samples separated by 45 seconds of idle, then runs the warm matrix. Runs stay serial; do not run the two instance sizes at the same time.

The committed fixtures are synthetic legal positions generated from `startpos` by `cloud/scripts/gen-fixtures.mjs` using the root `tsshogi` dependency. Regenerate and review them with:

```sh
node cloud/scripts/gen-fixtures.mjs
```

From `cloud/`, Main deploys the dual-container staging config once, then runs the full matrix once per instance size:

```sh
MATRIX='{"movetimeMs":[100,250,500,1000,2000,5000],"multipv":[2,3],"threads":[1,2],"hashMb":[256]}'
STAGING_URL='https://meeshogi-analysis-staging.yuki-nakano-1020.workers.dev'
STAGING_TOKEN_FILE='/secure/path/staging-admin-token'
STAGING_IMAGE_DIGEST='sha256:<64-hex-digest-from-staging-config>'

npm run deploy:staging
STAGING_WORKER_VERSION='<version-id-from-wrangler-deploy>'

node ./bench/run-benchmark.mjs \
  --url "$STAGING_URL" --token-file "$STAGING_TOKEN_FILE" \
  --matrix "$MATRIX" --fixtures ./bench/fixtures.json \
  --out ./bench/results/standard-2 --warm 3 --cold-idle-seconds 45 \
  --cold-samples 3 --image-digest "$STAGING_IMAGE_DIGEST" \
  --worker-version "$STAGING_WORKER_VERSION" --instance-type standard-2

node ./bench/run-benchmark.mjs \
  --url "$STAGING_URL" --token-file "$STAGING_TOKEN_FILE" \
  --matrix "$MATRIX" --fixtures ./bench/fixtures.json \
  --out ./bench/results/standard-3 --warm 3 --cold-idle-seconds 45 \
  --cold-samples 3 --image-digest "$STAGING_IMAGE_DIGEST" \
  --worker-version "$STAGING_WORKER_VERSION" --instance-type standard-3
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
