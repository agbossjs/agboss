# Changelog

All notable changes to the `@agboss/core` and `@agboss/cli` packages, one section per release, in the
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) form; versions follow
[Semantic Versioning](https://semver.org/) (before 1.0 a minor release may break the API).

This file is the summary of each release. The detailed log — one entry per merged pull request,
with every breaking change, its reason and the migration — is the Wiki's
[Changelog](https://github.com/agbossjs/agboss/wiki/Changelog); the exact public surface of each
entry point is in `packages/agboss/api/*.api.md`. Security fixes are announced here too
([`SECURITY.md`](SECURITY.md)).

## [Unreleased] — 0.1.1

### Added

- **Fault scenario 12b** (#607) — `s12b-marked-undo-not-again`: a pod frozen right after it marked
  its undo done, before it failed the tree. The next pod takes the tree over and ends it without
  undoing again: the reservation is released once. `StoreHoldPoint.TreeSaveIfAbsent` holds a tree
  key's write by its family; `no-undo-on-hand-over` also fails a declined order released twice. A
  tree store that forgets the done marks fails 12b.
- **Fault scenario 5d** (#608, the gap #584 left) — `s05d-zombie-recorded-not-sent`: a pod frozen
  right after recording its payment's intent and before sending it, thawed after another pod took
  the tree over. The new holder reconciles the pending intent and pays once; the zombie is refused
  at its renewal before the send and hands over: one gateway request, one payment. A lease store
  whose renewal says yes to a lease that is over fails it on `effects-once` and `linearizable`.
- **Mutation testing of the fencing modules** (#533) — Stryker on the leases, the holder's fence,
  the held lease, the fenced effect, the outbound call's protocol and store, and the store's clock,
  in a CI job of its own: every mutant is killed by a test or justified at the code; the job fails
  below 100 %.

- **The interleaving explorer** (#533) — `storeConformance` now runs `interleavings (<name>)` on a
  set's fencing stores: a deterministic scheduler of simulated instances that take, renew, yield,
  reclaim, release and finish a tree's lease, ask `leaseStateOf`, write the step's fenced effect and
  move an outbound call through its protocol, one operation at a time — every schedule of two
  instances up to a depth (each state once), seeded walks of three, the second instance's clock off
  by ± lease/2, ± lease and ± 10 × lease while the store keeps the run's time — and every
  two-outcome race of the contracts forced in both orders (`finish` against a take, a release, a
  `leaseStateOf`, a write against its hand-over, each compare-and-set of an intent). After each step
  it checks one live holder, no write at a superseded, closed or expired token, one effect per key,
  one charge per business key and no takeover of finished work; a failure prints the minimal
  schedule. Its budget is
  `storeConformance({ interleavings: { depth, walks, walkDepth, seed, timeLimit } })`
  (`AGBOSS_EXPLORER_SEED`), `false` to leave it out. A search that runs out of `timeLimit` (default
  8 min) or is aborted with its case stops and fails with what it explored — schedules, states and
  how many it left — never a pass, and never goes on resetting the store under later cases (#590).
  Wiki → Your-own-store.

- **The linearizability checker** (#533) — every fault run's store history is checked against the
  sequential model of the fencing stores (`faultViolationsOf` → `linearizable`): one order of the
  recorded operations, each at an instant of its span on the store's time, in which every answer is
  the model's; an operation nobody saw answer may or may not have taken effect. A part with none is
  reported with the longest order found and what could not follow it. `linearizabilityOf(history,
{ timeScale })` (`@agboss/core/testing/faults`) checks any history; `faultSuite({ storeTimeScale })`
  says how fast the store's own clock runs (1 for a database that decides by its clock). The history
  now keeps a lease's length, a claim's expected state and an ending's owner.

- **The guarantees page** (#533) — Wiki → Guarantees: the five guarantees of several instances
  (one owner per tree, one effect per business key, one send per attempt, no takeover of finished
  work, compensation only on real failure), the eleven assumptions they rest on with what breaks
  when one does not hold, every proof with where it bites, and what no checker reaches.

- **The fault suite** (#484) — `@agboss/core/testing/faults`, a published entry of its own (never
  loaded by the root): `faultSuite({ name, stores, database: { url, reset }, timeScale? })` runs
  the fixture application in real `node` processes on one database — SIGTERM, SIGKILL, SIGSTOP /
  SIGCONT, the database cut by a TCP proxy per pod — and checks after each of its 20 scenarios (#533:
  two of a pod whose clock is ten leases ahead or behind, `world.pod(name, { clockSkew })`)
  that each tree had one owner at a time, every child and every charge happened once, a hand-over
  undid nothing and every tree finished (`FaultInvariantError`, each invariant named). Store hold
  points for any store (`withHoldPoints(Store)`, `StoreHoldPoint`) force the order of operations
  across processes, and the run's history (`OperationHistory`) keeps every store operation's
  invoke and complete. The core runs it on SQLite; Wiki → Guarantees-across-processes.

- **Business idempotency keys** (#508) — `fencedEffectKeyOf(executionContext, name, { businessKey,
fingerprint? })`: one fenced effect or outbound call per tenant, name and business key, whatever
  step, execution or thread makes it; another fingerprint is `IdempotencyKeyConflictError`; a
  business key shows only by its keyed handle. A pending call under a business key is in flight
  while the lease that wrote it is live (`OutboundCallRepository.leaseStateOf`, an expired lease
  closed by the check in one atomic step); a holder waits for its attempts within
  `@Application({ outboundCalls: { attemptTimeout } })` (default `minutes(2)`, from the attempt's
  start) — a send still hung past this bound can coincide with a reconcile and a resend; the provider must deduplicate on `call.idempotencyKey` (G1). `OutboundCallResultNotStoredError`, `Superseded` outcomes and the
  `outbound-call.*` log codes; no read shows a fingerprint.

- **Handover telemetry: the lease log** (#501) — a takeover of a tree's lease is told and kept:
  `onExecutionLeaseTakeover` (`ExecutionLeaseTakeoverEvent`: the new holder and token, the expired
  holder when the store names it — `ExecutionLease.takenOverFrom`, optional for an external store —,
  `LeaseTakeoverReason`, the head checkpoint) and a `Takeover` row of the new infrastructure contract
  `ExecutionLeaseEventRepository` (in-memory default, `SqliteExecutionLeaseEventRepository`, the
  published `executionLeaseEventContract`), always written, read with `app.leaseEventsOf({ tenantId,
rootExecutionId })` and removed by the recovery sweep after `@Application({ leaseEventRetention })`
  (default `hours(24)`). A step handed over (a lost lease, a fenced write, the app's stop) is told
  and kept too: `onStepHandedOver` (`StepHandedOverEvent`, `HandOverReason`, `HandOverSite`) and a
  `HandedOver` row, once per error at the innermost site, written before the moving call rejects;
  a kept `ExecutionHistoryRecord` carries its tree's rows as `leaseEvents` (and so does
  `agboss records export`). Every call of a fenced effect from a step is told and kept as well:
  `onFencedEffect` (`FencedEffectEvent`, `FencedEffectEventOutcome`: ran, replayed, joined,
  refused — never the result) and a `FencedEffect` row, so the public log alone tells a zombie
  refused at its write from one that never reached it, and a replay from a new write.
  `FencedEffectAsyncWorkError` moved to the SQLite store's module (still exported from the root).

- **A store outside the core on the public surface alone** (#511, found by `@agboss/postgres`):
  `@Injectable({ environmentFields })` + `EnvironmentField` — a class declares the environment fields
  it reads, checked at assembly for every listed class and every class its `deps` reach
  (`[environment.missing-field]`, `[environment.conflicting-field]`; `SqliteConnection` declares
  `sqlitePath` so); `VirtualClock.track(work)` and `{ settleTimeout }` — `advance` waits for tracked
  work (`UnsettledWorkError`), and the published contract suites track every store call of their
  targets; every type an infrastructure contract names is exported by the root entry (`Tern`,
  `NewTern`, `TernOutcome`, `Summary`, `NewSummary`, `ConfigSnapshot`, `VersionScore`,
  `ExecutionData`, `CostReport`, `Usd`, …), a test enforces it.

### Changed — breaking for stores outside the core

- **A lease store keeps every execution id handed out** (#591) — `ExecutionLeaseRepository` has a
  new abstract `saveExecutionIdIfAbsent({ executionId, tenantId }): Promise<boolean>`: one atomic
  insert-if-absent by the id alone (across tenants: a step's idempotency key and the key an
  outbound call sends with no business key carry no tenant), `true` for a new id, `false` for one
  any execution ever had; never removed. The lease contract checks it (`an execution's identity`:
  once, across tenants, a race of eight claims on two instances with one winner, exact comparison,
  kept after the lease is released or finished). The SQLite store's `execution_ids` table is filled
  on a file of an older version, with its first new id, from `execution_leases` and (#638) from
  `outbound_calls` — the executions that made a call, a `ParentInstance` child's too: its step-keyed
  key reached the other system, which would answer a new execution of that id with the old call's
  response. **Migration:** a lease store of your own implements the method on its lease backend, its
  ids of before from its leases and its outbound calls (agbossjs/postgres: migrations `0018`, `0019`).

- **An opted-out store is never conformant for fencing** (#543) — `storeConformance` (and
  `fencedEffectContract` / `outboundCallContract`, `{ acceptWithoutDoubleChargeProtection }`) fails
  every fencing case of a store that declares `LeaseCheck.WithoutDoubleChargeProtection`
  (`[store-conformance.opted-out-store]`) unless the call says
  `acceptWithoutDoubleChargeProtection: true`; then those cases are skipped — never passed — with
  "store opted out of the lease check: no double-charge protection", every other case runs, and the
  set shows `gives NO double-charge protection for fenced effects | outbound calls`; a fencing
  contract run on its own with the flag shows `gives NO double-charge protection: its store opted
out of the lease check (acceptWithoutDoubleChargeProtection)` in its own suite — passing for an
  opted-out store, failing (`[store-conformance.opt-out-not-declared]`) for one that does not opt
  out —, so a report that hides skipped cases still says it (#543 acceptance). Before, an
  atomic store with the flag on passed every case and an honest one could pass none. The start's
  `[application.lease-check-not-atomic]` links Wiki → Your-own-store. **Migration:** a set with an
  opted-out store adds `acceptWithoutDoubleChargeProtection: true`.

- **One transactional backend, checked at assembly** (#526) — `ExecutionLeaseRepository`,
  `FencedEffectRepository` and `OutboundCallRepository` declare `static backend` (`"in-memory"`,
  `"sqlite"`; `"postgres"`, `"postgres:billing"` for a store of your own): a listed fenced-effect or
  outbound-call store and the application's lease store must declare the same one —
  `[application.store-backend-mismatch]` names both classes and backends, a store that declares none
  fails `[application.store-backend-undeclared]` (it used to be skipped). The explicit opt-out
  `static leaseCheck = LeaseCheck.WithoutDoubleChargeProtection` is not checked and warns
  `[application.lease-check-not-atomic]` (an error under `agboss check --strict`). Rate limits, the
  child queue and the lease log may be on any backend. `[application.fenced-effect-lease-store]` is
  gone; `static leaseRepository` now only tells unit runners where to hold their lease. **Migration:**
  add `static override readonly backend = "<your backend>"` to your lease, fenced-effect and
  outbound-call stores.
- **A lease is over at its expiry, for its holder too** (#534) — a lease is live while
  `expiresAt > now`, and only then: at `now >= expiresAt` `renew` (held or yielded) and `yield` are
  `false`, `reclaim` is `undefined`, `fence.confirmNow()` loses the lease and every fenced write and
  outbound-call write under it is `ExecutionFencedError` — whether another instance took it or not;
  the holder takes its tree again only by `acquire`, at a new epoch, a takeover from itself. The
  in-memory and SQLite stores renewed a lease past its expiry when nobody had taken it, PostgreSQL
  refused it (except at the exact instant); every store now draws the same line as `acquire`,
  `leaseStateOf` and the fence checks. New contract cases at `expiresAt − 1 ms`, exactly at it and
  `+ 1 ms` for `renew`, `yield`, `reclaim`, the framework's `confirmNow()` and renewal, a fenced
  write, an outbound call's intent and `leaseStateOf`; the cases "a lease renewed exactly at expiry,
  not taken meanwhile, is kept" and "a yielded lease reclaimed exactly at its expiry…" are gone.
  **Migration:** a store of your own matches `expires_at > now` (not `>=`, not holder and epoch only)
  in `renew`, `yield` and `reclaim`. In tests, one `clock.advance` of a whole lease (30 s) or more is
  a holder frozen past its expiry, so its lease is lost even when no one took it: to let time pass
  for a live holder, advance in steps shorter than the lease (`seconds(10)`).
  `ExecutionLeaseLostError`'s message no longer says another instance took the lease (#551): since
  #534 a renewal or a reclaim at the expiry is refused whether or not one did, so it says the lease
  is over — expired, or taken — and that the next take continues the execution. Nor do the other
  ways a lease ends (#567): a fenced write the core's stores refuse for an expired, released or
  missing lease (`ExecutionFencedError`, the same token seen) says the lease is over, not "another
  instance holds the lease" — only a newer token seen names a newer take and its holder — and a
  holder whose lease ran out here with no renewal confirmed (frozen, or its store not answering)
  says the next take continues, not "another instance continues". Fields and codes unchanged. An
  execution `app.close()` interrupts at its shutdown timeout (`ApplicationStoppingError`, #582)
  says it stays running and the next take of its lease continues it — another instance, or this
  application once it starts again — not "another instance continues it".
- **The store's time decides a lease's expiry; the holder fences itself on elapsed time** (#533) —
  instances whose wall clocks disagree no longer disagree on when a lease ends.
  `ExecutionLease.remaining` (new, required) is the time the store says the lease has left;
  `ExecutionLeaseRepository.renew` answers it (`Promise<Milliseconds | undefined>`, `undefined` once
  the lease is over) instead of `true` / `false`, and `acquire` and `reclaim` return it on the lease.
  The holder trusts its lease until `sentAt + remaining − LEASE_SAFETY_MARGIN` (1 s), `sentAt` its
  time when it sent the request, counted on its monotonic clock (`Clock.monotonicNow()`, new:
  `performance.now()` unless a clock overrides it) and on its wall clock, the earlier ending it — an
  offset moves neither, a step back is bounded by the monotonic count, a step forward or a host
  suspend by the wall count; a `remaining` that is not a finite number ≥ 0 is 0 (the holder fails
  closed), one above the lease asked for is that lease; the margin covers
  the drift of the holder's and the store's clocks over one lease, ≤ 1 s / 30 s together. The
  framework's renewal now reaches the store with 19 s of trust left (9 s after a failed one), and an
  outbound call's `send` starts only while the holder's fence holds. `StoreClock` (new; `TestStoreClock` in `@agboss/core/testing`) is the time a
  store decides by: a networked store's database time in production, the host's clock for in-memory
  and SQLite — and in `testWith` and the contract suites the test's clock, unskewed, injected through
  the seam (`StoreSeam.storeClock`). `testWith(App, { instances: 2, clockSkews: [ClockSkew.none,
ClockSkew.ahead(seconds(300))] })` (new) skews an instance's clock — wall time, monotonic time and
  sleeps — over the test's. New contract cases run on real time with the other instance's clock off
  by ± lease/2, ± lease and ± 10 × lease: a store that decides by the caller's clock fails them.
  **Migration:** return `remaining` (`remainingOf(expiresAt, now)`, both on the store's clock) from
  `acquire`, `renew` and `reclaim`; a networked store compares and writes `expires_at` with its
  database's time inside each statement (PostgreSQL `clock_timestamp()`) unless
  `StoreClock.isDatabaseTime` is false (a test's clock), and builds from `seam.storeClock` in its
  contract target. A test that expected a holder to trust its lease for the full 30 s counts 29 s.
- **The rules of a fenced key are exported** (#526) — `checkedEffectName`, `replayedFromOf` (a row's
  `null`s taken, a stored step checked: `StoredKeyFacts`), `storedKeyFactsOf`, `fencedKeyIdentityOf`
  and `pendingOutboundCallOf` from `@agboss/core`, so a store outside the core keeps no copy of them.
  `FencedEffectStoreMismatchError` and `FencedEffectResultTooLargeError` moved modules (still exported
  from the root).
- **A store's connection need not be listed** (#526, found by agbossjs/postgres#8) — with
  `OutboundCalls`, or a component that injects a store's own class, an unlisted `SqliteConnection` or
  `PostgresConnection` no longer fails assembly with `"…Connection" is not registered`: the workflow
  graph check takes an unlisted class under an infrastructure implementation as its own registration,
  as the container creates it.
- **`storeConformance`** (#526) in `@agboss/core/testing/contracts` — one call runs every contract a
  store set claims (`stores: { executionLease, fencedEffect, outboundCall, executionLeaseEvent, … }`)
  and the `store set (<name>)` cases (each fencing store declares its `static backend`, one with its
  lease store's); a set with a lease store that leaves a fencing contract out throws
  `StoreConformanceError` unless `without` says it has none. New contract cases, which a store
  outside the core must pass: every lease-log row kind and #508 field read back as it was, a
  fenced-effect key built by hand with an invalid name refused (`InvalidFencedEffectNameError`, also
  for an empty name, which was a `TypeError`), and a zombie's write racing the new holder's leaving
  one business row. The Wiki's [Your own store](https://github.com/agbossjs/agboss/wiki/Your-own-store)
  page: what each contract must make atomic, recipes for SQL, MongoDB, Redis, DynamoDB and Cassandra.

### Security

- **No CI install takes a release nobody reviewed** (#523): every workflow installs from its
  lockfile (`npm ci`); an install that must resolve ranges — `npm run check:packed`'s probe project
  — takes no release younger than three days (`npm install --before`, `AGBOSS_NPM_BEFORE` for the
  maintainer at release time); an `npx` only at an exact version. `npm run check:installs` (in
  `make check`) enforces it; the same in agbossjs/postgres and agbossjs/agboss-examples.
  `RELEASE_CHECKLIST.md` → Dependency installs states the policy.

### Fixed

- **No "Sourcemap … points to missing source files" under `agbossTest()`** (#645) — `@agboss/core`
  and `@agboss/cli` ship their `src/` beside `dist/`, so the source maps vite reads once the core is
  inlined find their TypeScript: a new project's `npm test` printed ~700 such lines, and a stack
  trace inside the core named files that did not exist; now it names lines of the installed
  package. `npm run check:packed` fails when a shipped map names a source the tarball lacks, when
  the probe project's test run prints the warning, or when a failure inside the core names a frame
  the package does not have.

- **An undo's fence was checked before its observers, not before the undo action** (#640, found
  in the acceptance of #605): the holder checked its lease, then awaited `onCompensationStart` and
  `onActionStart` — each event masked first, a model call with `detectWithModel`, and observers
  awaited one after another — before it ran the undo action. Held there past its lease, its tree
  taken over and undone by the new holder, it ran the undo a second time: a refund paid twice. The
  fence is now checked again right before the undo action, nothing awaited in between; the first
  check stays, so a holder already past its lease reports no `onCompensationStart`. #605's own test
  did not bite (its old holder was stopped at a checkpoint renewal before the undo); the new cases
  hold the old holder at the read of its undo's done mark, in `onCompensationStart` and in
  `onActionStart`, for a root's, a failed join's and a child's undo, and each check bites.

- **A failed join's undo ran again after a takeover** (#607): its undos wrote no done mark, so the
  instance that recovered the tree — from the checkpoint before the failure became durable — undid
  the booking a second time, a refund paid twice. Each undo of a failed join is now marked done
  (`@agboss/compensated/<key>`) before the next one starts and before the join's update or error is
  written; a recovering instance skips what is marked, and the join's update closes it so a side
  path's finish never commits it. Every automatic undo — a join's, a root's (failed, cancelled, out
  of budget), a child's on either placement, a recursion level's — is now proven to run to effect
  once across one and two takeovers.
- **The gate can no longer pass without the fault suite** (#630) — one run of `make check` ran 587
  files and not one of `tests/faults/`: vitest 3's forks pool skips a `singleFork` project whole when
  another fork of the pool rejects, and a test that held its fork 60 s with a synchronous child
  process made the fork's report to vitest time out. `npm run coverage` now holds vitest's JSON
  report against `packages/agboss/test-run.json` (`scripts/check-test-run.mjs`): every file of
  `unit` and `faults` ran a test, each at least its `minFiles`, else it fails naming the project and
  the files. The core's tests await their child processes (ESLint refuses `spawnSync`,
  `execFileSync` and `execSync` there). No API change.

- **An undo runs only while its holder holds the tree** (#605, found in the acceptance of #596 /
  #597) — a holder frozen right before its failed step's error reached the checkpointer, whose tree
  another instance took over and undid, ran the undo a second time when it thawed (a child's, or a
  root's own): its expiry timer had not fired yet, and nothing checked the lease before the undo
  action. Each undo action now runs only after the holder's own fence (`assertHeld`, #533): a holder
  past its lease hands over at the undo (`HandOverSite.Compensation`) and undoes nothing.
- **Wiki → Guarantees says what each proof bounds** (#625, found in the acceptance of #533) — a
  stepped database clock can make two instances trust one lease (A3); the explorer covers P2 for the
  step's key only, up to its depth and over its listed races; on PostgreSQL it explores the SQL on
  the test's clock, and database time is proved by agbossjs/postgres' clock tests; the mutation row
  names its scope and its over-broad comments; P5 rests on store conformance, with its proofs.
- **The linearizability checker places each operation inside its own span** (#617, found in the
  acceptance of #533) — it took an operation at the latest instant of an earlier one, past its own
  completion: a take of a live lease at 10 ms passed behind a frozen holder's renewal that answered
  at 40 s. An operation now takes effect within its span; the instants tried are the span's ends and
  just before and at each lease expiry inside it; one nobody saw answer may land any time after its
  invoke (a store applies a request whose caller is gone), so a take that landed after the expiry
  no longer fails a sound history.
- **The linearizability checker takes a renewal where the answers after it pin it** (#660, found in
  the acceptance of #617) — a renewal answered at 100 ms, then a take refused at 30 050 ms and the
  old token read as expired at 30 070 ms, is sound only with the renewal at 50–80 ms, which neither
  end of its span is: the checker failed it. An acquire, a renewal or a reclaim is now also tried
  where the expiry it sets meets another operation's span end.
- **An explorer case aborted while it shrinks a violation makes no store call after** (#618, found
  in the acceptance of #590) — the cutting down of a found schedule replayed it again and again,
  each replay resetting the store, after vitest had timed the case out and moved on. The cutting
  down, each replay and each walk now stop with the case's signal and time limit; the case still
  fails, with the schedule as found and why it was not shrunk.
- **The key-text cases catch an accent-insensitive collation** (#620, found in the acceptance of
  #533) — a store whose business-key column compares accent-blind (MySQL's `_ai_ci`, an ICU
  strength-1 collation, a unique index on `unaccent(key)`) and keeps each key as first given passed
  every case of `storeConformance`: "Zoë-17" found "Zoe-17"'s intent and replayed its payment. The
  round-trip keys now hold each one's accent-free twin ("café" and "cafe", "q̇" and "q", "straße"
  and "strasse"), each its own row.
- **A side path on a child's own error class is taken on every holder** (#598, found while fixing
  #596) — a child's failure that crossed a takeover (its claimed failure, #596; its undo's mark,
  #340) or an instance (an `AnyInstance` child's queue row) came back with its name and message
  only, so `.onError(PaymentDeclinedError, …)` matched on the instance that saw the failure and not
  on the one that took the tree over — a remote child's never. The failure's record (its class line
  by code, message and causes) is now kept there and rebuilt as a failure `.onError` routes as the
  original; a mark or a row written before this release routes as before, the same on every
  instance. A remote child's exhausted budget or failed undo now passes its parent's boundary as it
  is, as a local child's does.
- **A root's end is heard once** (#597, found in the acceptance of #562) — a root's holder that
  froze right after its tree's end became durable (its finish checkpoint, its failed step's error),
  whose tree another instance recovered and announced, announced the end again when it thawed, and
  its `app.execute` resolved with the output (or rejected with the tree's own error) as if it still
  held the tree. The end is now announced only while the pass holds the lease: the thawed holder
  stops at its own fence, rejects with `ExecutionLeaseLostError` and announces nothing.
- **An announced child failure stays the child's end** (#596, found in the acceptance of #562) — a
  `ParentInstance` child whose failure its parent's holder announced, the holder then frozen before
  its step was checkpointed, was run again by the instance that took the tree over: a step that
  now succeeded made the child heard failing and finishing and the root end instead of failing,
  and a child with an undo was heard failing twice. A child's failure is now claimed in the tree's
  store before it is announced (`@agboss/child-failure:<childExecutionId>`): one pass announces it,
  and a re-entry that finds the claim repeats it without running the step. A repeated failure keeps
  the error's name and message, not its class (as #340's unwinding mark): a side path on
  `ChildExecutionFailedError` / `StepFailedError` takes it again, one on the child's own error class
  by the cause chain does not.
- **Who calls is a key's text** (#589, found in the acceptance of #568) — an `ownerId` with a lone
  surrogate (`bob\uD800`, from `JSON.parse` of a token's `sub`) made `app.execute` on SQLite or
  PostgreSQL create a thread stored as `bob\uFFFD`'s, then refuse its own caller; the `bob\uFFFD`
  owner had the thread. `ownerId` at `execute`, `resume` and `cancel`, and a `Channel` pause's
  `answeredBy`, are now held to the key-text rules before anything is read or written:
  `dto.invalid` naming the field and the rule, never the id.
- **An empty fingerprint is not none** (#574, found by #533's mutation testing) — under a business
  key, a fenced effect with `fingerprint: ""` in flight on one instance beside one with no
  fingerprint was joined to it and got its result, though the pair made one after the other was
  `IdempotencyKeyConflictError`. Any text is a fingerprint, `""` too, and both orders are refused,
  in flight or stored; `fencedEffectContract` holds every store to keeping `""` as `""`.
- **The fault suite proves the payment's fence and refuses an opted-out set** (#584, found in the
  acceptance of #484) — no scenario let a zombie reach the outbound-call store after a takeover, so
  a store that recorded a payment's intent under any token passed all twenty; scenario 5c
  (`s05c-zombie-reaches-payment-first`) freezes a pod at its payment's intent while another takes
  the tree over and pays, and its stale write must be refused. And a set whose fenced-effect or
  outbound-call store declares `LeaseCheck.WithoutDoubleChargeProtection` passed the suite with no
  word of it: `faultSuite` now registers `fences atomically: no store declares
LeaseCheck.WithoutDoubleChargeProtection`, failing `[fault-suite.opted-out-store]`
  (`FaultSuiteOptedOutError`, naming the stores).
- **A child's end is heard once** (#562, found by #484) — a parent whose holder froze after its
  child ended, before its step was checkpointed, announced the child's `onExecutionEnd` (or
  `onExecutionError`), and the instance that took the tree over read the ended child again and
  announced it a second time (a third after a second takeover). An end is now announced only by the
  pass that ended the child, and only while that pass still holds the tree's lease: an
  `AnyInstance` child's finish by the worker whose completion of its queue row won, a cancelled one
  whose row went with its tree by the worker that stopped it, a child on its parent's instance by
  the parent's pass that ran it, a failure by the parent's pass that saw it happen (the undo runs
  there) — never by a parent that re-enters its step and only reads the end. The honest guarantee
  is at most once: a holder that freezes or crashes between the child's durable end and the
  announcement leaves it unannounced (Wiki → Guarantees-across-processes). The fault suite's
  `children-once` counts the observers' ends again — exactly one per finished child.

- **A minted thread id that never finds a free one is a typed error** (#613, found by #550's
  acceptance) — when the application's `IdGenerator` mints only ids the tenant already has (100
  tries), `execute` now fails with `DuplicateThreadIdError` (`run.duplicate-thread-id`: `generator`,
  `tries`, never an id) instead of a plain `Error` with no code, on every record store (PostgreSQL:
  agbossjs/postgres, the same error). `idGeneratorNameOf(generator)` (root entry) is the class a
  refusal names — the project's own, not the framework's check — for a store of your own.

- **A repeated execution id no longer joins another tree** (#591, found by #550) — an
  `IdGenerator` that repeats `newExecutionId()` (a sequential one restarted on a kept database, two
  tests on one file) gave a new root, child or recursion level the id of an older execution: one
  lease and fencing token, one lease log, one step key space — a fenced effect or an outbound call
  keyed by `<executionId>:<nodeId>:<visit>` replayed the other tree's stored result, and a finished
  tree's id could never take its lease. Every execution id the framework mints is now kept by the
  lease store before anything else of the execution is written (before its budgets' amounts, its
  thread, its lease, a child's marker): an id any execution had — of any tenant, running, paused,
  finished, failed or cancelled — is `DuplicateExecutionIdError` (`run.duplicate-execution-id`:
  `generator`, never the id), the root refused and a child's or a level's launch failed before it
  starts; of two instances minting one id at once, one runs. A resume or a recovery keeps its id and
  is not a create. A create that fails after its id was kept leaves the id taken, and nothing else.

- **An id the project's own `IdGenerator` mints is a key's text** (#578, found by #568) — the ids
  the framework mints (a root's, a child's or a recursion level's execution id, a new thread's id —
  at `execute`, a workflow run on its own and the eval runner) were never held to the key-text rules
  every id that comes in follows: a generator minting `x\uD800` and later `x\uDFFF` made two trees
  one lease, one lease log, one queue row and one fenced-effect scope on SQLite and PostgreSQL
  (both `x�` in UTF-8). Every minted id is now checked at the mint (`keyTextRuleOf`): one that
  breaks a rule (or is no string) is `InvalidMintedIdError` (`run.invalid-minted-id`: `generator`,
  `method`, `rule` — never the id), before it is used or stored. The built-in `RandomIdGenerator`
  and `SequentialIdGenerator` are unaffected; `app.resolve(IdGenerator)` gives the checked generator
  (`app.resolve(<its own class>)` the listed one).

- **A minted thread id is always a new thread** (#550, found by #533) — a store's `createThread`
  without a `threadId` handed out an id the tenant already had when its `IdGenerator` repeated one
  (two tests on one database both minting from `thread-1`): another workflow's thread, so the pass
  failed with `UnknownThreadError`, or another owner's thread of the same workflow, whose history the
  new execution joined. The core's stores mint the next id instead.

- **A tree whose undo a takeover finished keeps its undo actions** (#541, found by #484) — its kept
  record (`ExecutionHistoryRecord.compensations`, what `agboss records export` writes) listed none;
  it lists every undo action that ran, as its `onExecutionError` does.

- **The store-backend hint names no function** (#554) — a backend named like an object's own
  member (`"constructor"`, `"toString"`) made the hint of `[application.store-backend-mismatch]` print
  `(function Object() { [native code] })` as the core store to list; it is now a name with no core
  store, like `"postgres:billing"`.
- **`circuitBreakerPolicy: null`** (#529) is a missing policy: `[model-provider.circuit-breaker-required]`
  at assembly and in `agboss check`, never a `TypeError` in `createApp`.
- **A lone surrogate** (#530) is no business key or thread id (`InvalidBusinessKeyError`,
  `InvalidThreadIdError`): SQLite and PostgreSQL keep text as UTF-8, where two such keys were one
  row, and an outbound call's key threw `URIError`.
- **Keys with look-alike spaces are refused** (#547) — a business key and a thread id are refused
  when they hold a space other than U+0020 (Unicode `Zs`: U+00A0, U+1680, U+2000–U+200A, U+202F,
  U+205F, U+3000) or a line or paragraph separator (U+2028, U+2029) — `KeyTextRule.SpaceSeparator`,
  `space-separator` — and when a U+0020 starts or ends them or two come in a row —
  `KeyTextRule.Spacing`, `spacing`: `" order-1"`, `"order-1 "` and `"order  1"` were keys of their
  own beside `"order-1"` and `"order 1"`. The same entry points and messages as #538, the key never
  named. **Migration:** trim keys and thread ids, collapse runs of spaces and replace other spaces
  by U+0020 where they are made. A text that breaks several rules is named by the first in
  `KeyTextRule`'s order (`length`, `lone-surrogate`, `control-character`, `format-character`,
  `space-separator`, `spacing`, `not-nfc`), wherever each breach stands — the enum is declared in that
  order now (#547 acceptance).
- **Keys with invisible, private or unassigned characters are refused** (#556) — a business key, a
  thread id and a tenant id are refused when they hold a code point Unicode says renders as nothing
  (`Default_Ignorable_Code_Point`, whatever its category: the combining grapheme joiner U+034F, the
  Hangul fillers U+115F / U+1160 / U+3164 / U+FFA0, every variation selector — U+FE0E / U+FE0F too,
  so `"order:❤\uFE0F"` is refused —, the Mongolian free variation selectors and the property's reserved
  code points) — `KeyTextRule.Ignorable`, `ignorable` —; a private-use character or a noncharacter
  (U+FDD0–U+FDEF, U+xFFFE / U+xFFFF) — `private-or-noncharacter` —; a code point unassigned in the
  runtime's Unicode (`Cn`) — `unassigned`: a later Node may assign it a decomposition or make it a
  format character, refusing a key stored before; a code point never becomes unassigned again, so
  this rule never refuses a key it accepted (the categories the other rules read may change in a
  later Unicode — a refusal then, never a second charge, #587) — and U+2800 BRAILLE PATTERN BLANK — `blank`. The same entry points and
  messages, the key never named; in `KeyTextRule`'s order, after `spacing` and before `not-nfc`. During
  a rolling upgrade a key holding a character only the newer runtime's Unicode assigns is refused by
  an older instance — closed, nothing charged. **Migration:** drop variation selectors (an emoji
  without U+FE0F) and these characters where keys, thread ids and tenant ids are made.
- **A tenant id is a key's text too** (#552) — the rules of #538 hold a tenant id at
  `app.execute` (`tenant: { tenantId }`), `app.resume` and `app.cancel` (`dto.invalid`, the field
  and the rule named, never the id): a tenant id with a lone surrogate was written to SQLite and
  PostgreSQL as U+FFFD, so two tenants shared one thread, lease and business-key row, and its first
  execution failed with a raw `URIError` after binding the thread; an NFD or a zero-width tenant id
  was a second tenant of one customer. `app.cancel`'s thread id is checked as `execute`'s is
  (`InvalidThreadIdError`, the id kept out of the message and `onExecutionRejected`).
  So are the operator's reads (#568): `app.leaseEventsOf`, `app.outboundCallsOf` and
  `app.pendingOutboundCalls` refuse such a tenant id (`dto.invalid`) before the store is asked — on
  SQLite `t\uD800` read `t\uFFFD`'s pending charges and lease log —, and a trusted A2A request or MCP
  call under one is never deduplicated (its refusal was kept as the answer, under the merged key);
  its `onExecutionRejected` names the tenant `"default"`, as the event's documentation says, never
  the refused id. A tree's reads check its root execution id the same way (#580) (`dto.invalid` naming
  `rootExecutionId`: `r\uD800` read root `r\uFFFD`'s lease log), and `agboss records export
--tenant` and `agboss generate eval-case --tenant` refuse a tenant id that is no key's text (exit 2,
  `usage.option-value`, the rule named, never the id) instead of reading nothing.
- **Look-alike keys are refused, never charged twice** (#538) — a business key and a thread id
  are refused when they hold a C1 control (U+0080–U+009F, beside C0 and DEL), a format character
  (Unicode `Cf`: zero-width space and joiners — so emoji joined by U+200D too —, bidi controls,
  U+FEFF, the soft hyphen, tag characters) or are not NFC ("e" + U+0301; refused, never normalized
  silently, which would no longer replay a key stored before). `InvalidBusinessKeyError` and
  `InvalidThreadIdError` name the rule (`rule: KeyTextRule`, `keyTextRuleOf(text)` from the root),
  never the key; an invalid thread id is no longer echoed in `onExecutionRejected`. Checked by
  `fencedEffectKeyOf`, `OutboundCalls.send` and at every store's entry for a key built by hand
  (`checkedBusinessKey`, exported for a store of your own); new contract cases: keys of many scripts
  round-trip byte for byte and are each their own row, and a key built by hand breaking a rule is
  refused by every method. **Migration:** normalize a key where it is made (`text.normalize("NFC")`)
  and strip invisible characters from imported identifiers; `InvalidBusinessKeyErrorOptions` takes
  `rule` instead of `problem`.
- **`check:installs` and `check:real-time`** (#531) miss no common form: `npm install-test`, a line
  continued with `\`, every `--package=`, `["i", …]` and `"npm install …"` in scripts; a duration
  through a second variable, a limit named by a constant.
- **No test asserts real elapsed time against a fixed number** (#523, after #509): the model
  call and Jev timeout tests run on a `VirtualClock`; `npm run check:real-time` (in `make check`)
  fails on a new real-time threshold.

- **A parent waiting for `AnyInstance` children is no longer taken over by another instance**
  (#516) — while it waited, the parent released its lease and only its own process knew the tree
  was live, so another instance's recovery sweep took the root over and the caller of a successful
  `execute` got `ExecutionLeaseLostError` or a "no longer queued" error. The yield is now visible in
  the store: `ExecutionLeaseRepository` gains `yield(lease)` / `reclaim(lease, duration)` (a yielded
  lease stays its holder's, is renewed, is refused to every other `acquire` until it expires, and is
  taken back at the next `leaseEpoch`). A holder that dies while waiting stops renewing, so its
  lease expires and the tree is recovered as before. **Breaking for a store of your own**: implement
  the two methods; `executionLeaseContract` checks them. The in-memory and SQLite stores implement
  them (SQLite adds the `yielded` column to an existing file).
- **A test that hangs fails fast** (#509): `testWith` bounds each app's close at the end of a test to
  10 s of real time — a run still frozen there (a step, a stalled lease, a wait on the
  `VirtualClock` nobody advances) fails the test with `AppCloseTimeoutError` (`test.close-timeout`,
  `@agboss/core/testing`) instead of hanging the run: vitest bounds no fixture's teardown.
- `checkpointSaverContract`'s `put` passes the changed channels' versions, as LangGraph does: a saver
  that writes values only for those versions (LangGraph's `PostgresSaver`) passes as it is (#511).
- **`workflowOf(W)` on the package installed from npm** — the application next to `W` was imported
  by Node, outside vitest (no decorators). A vitest preset, `agbossTest()` from
  `@agboss/core/testing/vitest`, loads AGBoss and every file it loads by path through vite, in the
  test's module graph, and registers the matchers; `agboss create` writes it. Without it
  `workflowOf(W)` throws `TestSetupError` naming the fix. An existing project changes one line:
  `test: agbossTest({ … })` in `vitest.config.ts` (the `setupFiles` entry may go). CI checks the
  packed packages in a project of their own (`npm run check:packed`) (#497).

## [Unreleased] — 0.1.0 (`v0.1.0-rc` Pre-Release Candidate)

The first substantive release of the framework (`0.1.0`, prepared for manual owner publication; not yet published to `registry.npmjs.org`). Everything below is new compared with the `0.0.1` placeholder;
the Wiki's Changelog lists the breaking changes made between pull requests on the way.

### Added

- **Applications and dependency injection** — `@Application` with its workflows, infrastructure,
  budgets, defaults and environment contract; one container per application instance with
  constructor injection (`deps`), lifecycle hooks and `createApp(App)` → `app.execute` / `resume` /
  `cancel` / `close` (#261).
- **The flow as paths** — `@Workflow({ flow })` with `start(…)`, `.returns(…)`, `.toAgent` /
  `.toRouter` / `.toAction` / `.toFinish`, `.chooseOne`, `.switch(caseOf(…))`, `.onError`, typed by
  the generated `.agboss/types.d.ts`, every assembly rule reported at once before any model call
  (#272, #270, #299); outdated values tracked on the path scope (#271).
- **Components** — `@Agent` (its own tool loop), `@Router` decided by a model or by code (#280),
  `@Action`, `@Tool`, `@WorkflowStart` / `@WorkflowFinish`, DTO classes (`@agboss/core/dto`) for every
  value that crosses a boundary.
- **Parallel work** — parallel launches and joins (#273), quorums with arbiters (#279), child
  workflows (#263), recursion with `ThisWorkflow` and `maxDepth`, the tree's and the instance's
  concurrency caps (#264, #332).
- **Pauses and approvals** — channel roles, durable pauses answered by id, free-text replies read by
  reply interpreters, pause answer records (#267).
- **Declared compensation** — `compensateWith` / `committedBy`, checked at assembly, and the
  automatic undo of a failed join or a failed execution, finished by recovery (#339, #340).
- **Several instances** — the execution lease with fencing, recovery of interrupted executions, the
  graceful stop, SQLite implementations of every store, health checks (`app.checkLiveness()` /
  `app.checkReadiness()`) (#265, #335, #360, #367, #300). Execution history (#401): with
  `@Application({ executionRecordRetention })` every root execution's record — with its identity,
  masked like its traces — is kept in the new `ExecutionHistoryRepository` (in memory or
  `SqliteExecutionHistoryRepository`) and swept after it; `agboss records export` writes it as JSON
  Lines.
- **Models and FinOps** — model providers as infrastructure (OpenRouter and the Decisions API built
  in) with retry, rate-limit and circuit-breaker policies; `@Budget`s per execution, tenant and
  application; cost accounting of every model call (#266, #261, #338).
- **Safety and quality** — PII policies masked at the model boundary, input and output guardrails
  decided by a model or by code, judges on an agent's answer as its DTO, memory compaction with
  built-in or custom strategies (#120, #262, #382, #383).
- **Testing** — `testWith(App)` with scripted models, the virtual clock, deterministic ids, class
  matchers, recorded runs and unit runners for every component kind (#262, #313); tool-call
  trajectories on results, records and `JudgeInput`, and one record per step (#395).
- **Eval suites** — `@EvalSuite` (`@agboss/core/eval`) with typed cases, trajectory checks and code or
  model judges under a declared cascade; `agboss eval run --suite <name> --runs <k> --report
<run.json>` runs each case k times on the application and reports pass@k / pass^k per case, the
  unstable ones flagged, into a run artifact (`agboss.eval-run`); `agboss check` assembles the suites;
  `--baseline <run.json> --fail-on-regression` compares each case with a run of `main` and exits 5
  (`quality`, `eval.regressed`) when a stable case regressed — a case flaky there is quarantined
  (#396). `--html <file>` and `agboss eval show <run.json> --html <file>` render a run as one
  self-contained HTML page — summary, unstable cases, attempt dots and every run's checks (#397);
  the artifact (`schemaVersion` 2) keeps each run's trajectory, masked, and the page shows it as a
  timeline, with the baseline diff and the node where an unstable case's attempts part ways;
  `agboss eval ui` serves a folder of runs on 127.0.0.1 behind a token, where people label a judge's
  verdicts into `eval/labels/<suite>.jsonl` and see κ recomputed, and save a run's kept execution
  (on its thread, of its tenant — each run's `tenantId`, `schemaVersion` 4) as a golden case of its suite — written into the suite's file, refused on a duplicate name or a
  file changed since the page was made (#397).
  `agboss eval calibrate --report <run.json>` reads a run's judges against people's labels
  (`eval/labels/<suite>.jsonl`) — Cohen's κ per labeler and between labelers, the confusion and the
  disagreements by the judge's metrics (#396).
  `agboss compare` judges each pair in both orders (a flip is a tie, `positionFlips`), and a
  judge of its agent's own model family warns `[judge.same-model-family]` (#396). Breaking on the
  way: `compareProfiles(Workflow, …)` is `compareProfiles(Application, { start, … })`.
  `agboss eval run --chaos <rate> --chaos-seed <n>` injects 429s, timeouts and truncated answers
  into the run's model calls (`ChaosFailure`; `eval run` only, never a `createApp` option) (#396).
  `agboss eval run --metamorphic` runs each case's `variants` (its last turn reworded) and checks
  they call the same tools with the same required calls — the check `metamorphic` (#396).
  `agboss generate eval-case <name> --from-execution <executionId>` drafts a case from a kept
  execution (#401's history) into its suite — the turn, the contexts, the thread's earlier turns,
  the calls it ran as `tools.required` — masked as kept, nothing run (#396).
  `agboss hub show <path…> [--html <file>]` reads many applications' describe snapshots, eval runs
  and exported executions into one mesh — the applications, the calls between them, each one's
  health from its files — and one self-contained page; no project, nothing runs (#401).
  Its page shows each execution tree that crosses applications, stitched from their exports by each
  receiver's `origin` (the calling execution and its call's idempotency key) — a receiver that
  exported nothing is a stub (#401).
  Its crystallization radar ranks the mesh's model steps by spend × stability — how often one
  input gets one decision — and names the candidates to turn into code; each step record gains its
  `decision` (`route:` / `launch:` / `variant:` / `answer:<hash>`) for it (#401).
  `agboss hub ui <path…>` serves the Hub on 127.0.0.1 behind a token — `eval ui`'s own server and
  rules, read-only — with a search of the kept executions and a JSON API (#401).
  Both draw each contract the snapshots declare as an edge consumer → producer, and list the
  problems `agboss check --federation` finds between them — the same check — with their blast
  radius, and who calls an application whose latest eval run lost pass^k (#401).
- **The CLI** (`@agboss/cli`) — `agboss create`, `agboss generate`, `agboss check`,
  `agboss describe`, `agboss dev`, `agboss studio`, `agboss chat` / `agboss run`, evaluations and
  comparisons (#268). Breaking on the way (#396): the bare `agboss eval` is now `agboss eval score`
  (`agboss eval` lists its subcommands `run` / `score` and exits 2).
- **Skills for coding agents** — `SKILL.md` and thirteen references shipped in the package and synced
  into a project by `agboss check` (#305), among them a step-by-step guide to migrating LangGraph
  code — state, edges, `Send`, `interrupt` — to AGBoss (#424).

## [0.0.1] - 2026-10-10

### Added

- A placeholder published to npm to reserve the `@agboss/core` and `@agboss/cli` names; it holds no framework code.

[Unreleased]: https://github.com/agbossjs/agboss/commits/main
[0.0.1]: https://www.npmjs.com/package/@agboss/core/v/0.0.1
