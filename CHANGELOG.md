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
  schedule. Its budget is `storeConformance({ interleavings: { depth, walks, walkDepth, seed } })`
  (`AGBOSS_EXPLORER_SEED`), `false` to leave it out. Wiki → Your-own-store.

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
