# Changelog

Breaking changes and notable additions, newest first. The API reports
(`packages/agboss/api/*.api.md`) hold the exact public surface of each entry.

## Unreleased — 0.1.1: every action checks its holder's fence right before it runs (#662)

- **Fixed**: an action's visit — a side path's undo action too — awaited `onActionStart` and ran
  with no fence check, so a holder held there past its lease ran the action again after another
  instance took the tree over and ran it (a refund or a charge paid twice when not fenced). The
  holder's fence is now checked right before `execute`, as #640 does for the automatic undo. No API
  change. [Guarantees across processes](Guarantees-across-processes).

## Unreleased — 0.1.1: the budget's exemptions hold only on their side path (#656)

- **Fixed**: once any limit had been handled, every later action of the execution skipped the
  budgets, and an action that is some open entry's undo skipped them on any visit. Now the side
  path that took a limit exempts its actions and what they lead to step by step, until a finish or
  a launch; an undo action is exempt only on a side path, undoing an entry open when it was
  entered. The side path is kept in the execution's checkpointed state (a takeover reads it as the
  first run did). No API change. [FinOps → Budgets](FinOps).

## Unreleased — 0.1.1: an answer-only agent answers with one call (#649)

- **Fixed**: an agent whose only tools are its answer tools sends `parallel_tool_calls: false` to
  OpenAI-compatible servers; several identical answer calls in one move are one answer, different
  ones are refused with "N different answers in one move" — never one picked. No API change.
  [Agents](Agents).

## Unreleased — 0.1.1: the packages ship the sources their maps name (#645)

- **Fixed**: `@agboss/core` and `@agboss/cli` ship `src/` beside `dist/`. Under `agbossTest()` vite
  reads the core's source maps, and every map named a `src/…ts` the tarball did not have: ~700
  "Sourcemap … points to missing source files" lines per `npm test` of a new project, and stack
  traces into files that did not exist. Now no warning, and a trace names a line of the installed
  package. `npm run check:packed` fails when it comes back. No API change.
  [Testing](Testing#the-vitest-preset-one-module-graph-497).

## Unreleased — 0.1.1: a Payments section — the gateway contract, every race, ten gateways (#653)

- **Added — [Payments](Payments)**, [Payment scenarios](Payment-scenarios) (PS1–PS23: what goes
  wrong, what AGBoss does, the guarantee, its assumptions, the boundary) and, on
  [Payment gateways](Payment-gateways), the capability table of ten gateways read 2026-11-01:
  supported — Stripe, Checkout.com, PayPal, Adyen (for 7 days), CardCom (charges); not supported —
  Braintree, Square, Tranzila, Grow, PayPlus, each with the reason. Gateways are named only to
  identify their public APIs; the notes are independent, not affiliated with or endorsed by any of
  them ([the notice](Payments#the-notice)). [Guarantees](Guarantees) gains A12, the retention a
  repeat must come within. No API change. Gaps found: #657, #658.

## Unreleased — 0.1.1: the ids kept from before include every execution that made an outbound call (#638)

- **Fixed**: on a SQLite file of before #591, `execution_ids` is filled from the outbound calls'
  executions as well as the leases, so a `ParentInstance` child of before — whose step-keyed call
  sent a key the gateway keeps — can no longer have its id minted again for a new execution that
  the gateway would answer with the old payment. agbossjs/postgres: migration `0019`. No API change.
  [App → Infrastructure](App#infrastructure).

## Unreleased — 0.1.1: the gate runs the fault suite or fails (#630)

- **Fixed**: one `make check` ran 587 files and not one of `tests/faults/` — vitest 3 skipped the
  `singleFork` project after a fork, held 60 s by a test's synchronous child process, timed out its
  report. `npm run coverage` now fails by name unless every file of `unit` and `faults` ran
  (`packages/agboss/test-run.json`, `scripts/check-test-run.mjs`); the core's tests await their child
  processes. No API change. [Testing](Testing#the-clock).

## Unreleased — 0.1.1: a minted thread id that never finds a free one is a typed error (#613)

- **Fixed**: after 100 minted thread ids the tenant all has, `execute` fails with
  `DuplicateThreadIdError` (`run.duplicate-thread-id`: `generator`, `tries`, never an id) instead of
  a plain `Error`, on every record store; `createThread` rejects instead of throwing. New:
  `idGeneratorNameOf`. [App → Infrastructure](App#infrastructure).

## Unreleased — 0.1.1: fault scenario 5d, a zombie between its payment's intent and its send (#608)

- **Added**: `s05d-zombie-recorded-not-sent`. The pod is frozen right after the outbound-call store
  recorded its payment's intent, before the gateway is called, and thawed after another pod took
  the tree over and paid. The new holder reconciles the pending intent and sends once; the zombie's
  renewal before its send is refused and it hands over. One request, one payment. Its sabotage: a
  lease store whose renewal says yes to a lease that is over fails it on `effects-once` and
  `linearizable`. [Guarantees across processes](Guarantees-across-processes).

## Unreleased — 0.1.1: a repeated execution id never joins another tree (#591)

- **Fixed**: an `IdGenerator` that repeats `newExecutionId()` gave a new root, child or recursion
  level an older execution's lease, fencing token, lease log and step keys, so a fenced effect or an
  outbound call replayed the other tree's result. Every minted execution id is now kept by the lease
  store before anything of its execution is written; an id any execution had is
  `DuplicateExecutionIdError` (`run.duplicate-execution-id`, never the id). [App → Infrastructure](App#infrastructure).
- **Breaking for stores outside the core**: `ExecutionLeaseRepository.saveExecutionIdIfAbsent({
  executionId, tenantId })` — an atomic insert-if-absent by the id alone, never removed, checked by
  the lease contract's `an execution's identity` cases. SQLite: `execution_ids`, filled from
  `execution_leases` on a file of an older version; agbossjs/postgres: migration `0018`.
  [Your own store](Your-own-store#what-must-be-atomic-per-contract).

## Unreleased — 0.1.1: every holder takes the same side path (#598)

- **Fixed**: a child's failure that crossed a takeover (its claimed failure, #596; its undo's mark,
  #340) or an instance (an `AnyInstance` child's queue row) kept its name and message only, so a
  parent's `.onError(PaymentDeclinedError, …)` on the child's own class through the cause was taken
  on the instance that saw the failure and not on the one that took the tree over, and for a remote
  child never. The failure's record (its class line by code, message and causes, no `details`) is
  now kept there and rebuilt as an error `.onError` routes as the original. A mark or a row written
  before has no record and routes as before, the same on every instance.
- **Changed**: a remote child's exhausted budget or failed undo passes its parent's boundary as it
  is (as a local child's), no longer wrapped in `ChildExecutionFailedError`.
  [Guarantees across processes](Guarantees-across-processes) · [ADR-0028](ADR-0028-Failures-cross-instances-as-their-records).

## Unreleased — 0.1.1: the guarantees, their assumptions and their proofs on one page (#533 item 6)

- Docs: a new page, [Guarantees](Guarantees). It covers the five guarantees of several instances
  (one owner per tree, one effect per business key, one send per attempt, no takeover of finished
  work, compensation only on real failure) and the eleven assumptions they rest on: store
  conformance, one transactional backend, a slewed database clock, the drift bound, no pause that
  stops both of the holder's clocks, `attemptTimeout`, the provider's G1–G6, a shared
  `pseudonymKey`, writes inside a step's frame, rate limits that are not money, and business rows in
  the store's database. Each assumption says what breaks when it does not hold. The page also lists
  each proof with what it checks and where it bites, and what no checker reaches.
## Unreleased — 0.1.1: mutation testing of the fencing modules (#533 item 3)

- **Added** (contributors): `npm run test:mutation -w @agboss/core` runs Stryker on the modules that
  carry the fencing guarantees: the lease store's base and live-lease rule, the fenced-effect and
  outbound-call stores, the clock, the held lease, the fence and the outbound-call protocol. It runs
  their tests, incrementally. The CI job `mutation` fails below 100 %: every mutant is killed by a
  test or ignored where it stands by a `Stryker disable` comment that says why it is equivalent.
  Now: 813 mutants, 760 killed, 6 timeouts, 47 justified. It found #574.
## Unreleased — 0.1.1: an id the project's own IdGenerator mints is a key's text (#578)

- **Fixed**: every id the framework mints through the application's `IdGenerator` — a root's, a
  child's or a recursion level's execution id, a new thread's id (at `execute`, a workflow run on
  its own, the eval runner) — is checked at the mint by `keyTextRuleOf`. One that breaks a rule, or
  is no string, is `InvalidMintedIdError` (`run.invalid-minted-id`: `generator`, `method`, `rule`,
  never the id), before it is used or stored. Before, `x\uD800` and `x\uDFFF` were one tree's lease
  on SQLite and PostgreSQL. The built-in generators are unaffected. [App → Infrastructure](App#infrastructure).
## Unreleased — 0.1.1: the linearizability checker (#533 item 5)

- **Added**: `faultViolationsOf` checks `linearizable`. Every fault run's store history must have an
  order, each operation at an instant of its span on the store's time, in which every answer is the
  sequential model's. `linearizabilityOf(history, { timeScale })` checks any history;
  `faultSuite({ storeTimeScale })` says how fast the store's own clock runs. The history keeps a
  lease's length, a claim's expected state and an ending's owner. Guarantees-across-processes →
  `linearizable`.

## Unreleased — 0.1.1: a root's end is heard once (#597)

- A root's `onExecutionEnd` / `onExecutionError` is announced only while its pass holds the tree's
  lease. Before, a holder that froze right after its tree's end became durable announced the end
  again when it thawed, though the instance that recovered the tree had announced it. Its
  `app.execute` resolved with the output. It now rejects with `ExecutionLeaseLostError`. Found in
  the acceptance of #562. Guarantees-across-processes.
## Unreleased — 0.1.1: an explorer search stops with its case and fails with what it explored (#590)

- Fixed: an interleavings search that outran its case's timeout went on in the background, since
  vitest does not cancel a timed-out case. It kept resetting the store under the cases after it. On
  PostgreSQL that looked like an epoch granted twice, finished work taken and `deadlock detected`
  in every later case. A search now takes its case's signal and `interleavings.timeLimit` (default
  8 min). Stopped, it fails with the schedules and states it explored and how many it left, never
  a pass; done, it logs its counts. Your-own-store.
## Unreleased — 0.1.1: an announced child failure stays the child's end (#596)

- A `ParentInstance` child's failure is claimed in the tree's store before it is announced
  (`@agboss/child-failure:<childExecutionId>`). One pass of all that see it announces it, and a
  re-entry that finds the claim repeats it without running the step. Before, when the holder froze
  after announcing, the instance that took the tree over ran the failed step again. If the step now
  succeeded, the child was heard failing and finishing, and the root ended. A child with an undo was
  heard failing twice. The repeated failure keeps the error's name and message, not its class.
  Found in the acceptance of #562. Guarantees-across-processes.
## Unreleased — 0.1.1: who calls is a key's text (#589)

- `app.execute`, `app.resume` and `app.cancel` refuse an `ownerId`, and `app.resume` a `Channel`
  pause's `answeredBy`, that is no key's text (`dto.invalid` naming the field and the rule, never
  the id; a value that is not a text: `length`), before anything is read or written. On SQLite and
  PostgreSQL an execute under `bob\uD800` created a thread owned by `bob\uFFFD` and was refused
  itself; the `bob\uFFFD` owner then had the thread. A blank `answeredBy` is still
  `PauseAnswererError`. Found in the acceptance of #568. Several-instances.
## Unreleased — 0.1.1: an empty fingerprint is not none (#574)

- Fixed: under a business key, a fenced effect with `fingerprint: ""` in flight on one instance
  beside one with no fingerprint was joined to it and got its result (`Joined`); made one after the
  other the pair was already `IdempotencyKeyConflictError`. Both are now refused, in flight too:
  any text is a fingerprint, `""` included, and none is none. `fencedEffectContract` (and so
  `storeConformance`) adds the group "an empty fingerprint is not none": a store must keep `""` as
  `""`, not as `NULL`. Found by #533's mutation testing. Several-instances.
## Unreleased — 0.1.1: what a runtime upgrade can do to a stored key (#587)

- Docs: the `unassigned` rule never refuses a key it accepted before, and NFC is stable. The other
  key-text rules read Unicode properties that a later Unicode may change for an assigned character
  (U+00AD `Pd` → `Cf` in 4.0). So a newer runtime may refuse a stored key: a refusal, never a second
  charge. Before, the docs said "a key accepted now stays a key on a newer runtime". Found in the
  acceptance of #556. Several-instances.
## Unreleased — 0.1.1: the fault suite proves the payment's fence and refuses an opted-out set (#584)

- **Added**: scenario 5c `s05c-zombie-reaches-payment-first`. A pod is frozen at its payment's
  intent while another takes the tree over; its stale write must be refused. Before, no scenario
  let a zombie reach the outbound-call store, and a store that recorded an intent under any token
  passed all twenty scenarios.
- **Added**: `faultSuite`'s case `fences atomically: no store declares
  LeaseCheck.WithoutDoubleChargeProtection` fails a set whose fenced-effect or outbound-call store
  opts out: `[fault-suite.opted-out-store]`, `FaultSuiteOptedOutError` naming the stores. Found in
  the acceptance of #484. Guarantees-across-processes.
## Unreleased — 0.1.1: a root execution id and the CLI's --tenant are keys' text too (#580)

- `app.leaseEventsOf` and `app.outboundCallsOf` refuse a `rootExecutionId` that is no key's text
  (`dto.invalid` naming `rootExecutionId` and the rule, never the id): on SQLite and PostgreSQL
  `r\uD800` read root `r\uFFFD`'s lease log. `agboss records export --tenant` and `agboss generate
  eval-case --tenant` refuse a tenant id that is no key's text (exit 2, `usage.option-value`)
  instead of reading nothing. Ids a project's own `IdGenerator` mints are not checked yet (#578).
## Unreleased — 0.1.1: what an execution interrupted by a stop says (#582)

- `ApplicationStoppingError` of an execution `app.close()` interrupts at its shutdown timeout says
  it stays running and the next take of its lease continues it — another instance, or this
  application once it starts again —, no longer "another instance continues it": on a lone instance
  there is none (#567's rule). Class, code and behaviour unchanged. Found in the acceptance of #567.


## Unreleased — 0.1.1: a child's end is heard once (#562)

- A child's `onExecutionEnd` / `onExecutionError` is announced only by the pass that ended it, and
  only while that pass holds the tree's lease. An `AnyInstance` child's finish now comes from the
  worker whose completion of its queue row won, **on that worker's instance** (before: on its
  parent's); a cancelled one whose row went with its tree, from the worker that stopped it (before:
  never). A parent that re-enters its step after a takeover only reads the end: before, the
  recovered parent heard it again (twice, three times after two takeovers).
- **The guarantee is at most once**: a holder lost between the child's durable end and the
  announcement leaves it unannounced
  ([Guarantees across processes](Guarantees-across-processes#what-a-reader-of-the-records-should-know)).
  The fault suite's `children-once` counts the observers' ends again, exactly one per finished child.
  Found by #484.


## Unreleased — 0.1.1: the interleaving explorer (#533 item 1)

- **Added**: `storeConformance` runs `interleavings (<name>)` on a set's fencing stores — a
  deterministic scheduler of simulated instances (every schedule of two up to a depth, seeded walks
  of three, the second's clock ± lease/2, ± lease, ± 10 × lease off the store's time), checking one
  live holder, no write at a stale token, one effect per key, one charge per business key and no
  takeover of finished work after every step, and printing the minimal schedule of a failure; and
  every two-outcome race of the contracts forced in both orders (AC7). A new option
  `storeConformance({ interleavings: { depth, walks, walkDepth, seed } | false })`. Your-own-store →
  Interleavings.

## Unreleased — 0.1.1: keys with invisible, private or unassigned characters are refused (#556)

- **Changed**: a business key, a thread id and a tenant id are refused when they hold a code point
  that renders as nothing (`Default_Ignorable_Code_Point`: the combining grapheme joiner, Hangul
  fillers, every variation selector — U+FE0E / U+FE0F too —, …) — `KeyTextRule.Ignorable` —, a
  private-use character or a noncharacter — `PrivateOrNoncharacter` —, a code point unassigned in the
  runtime's Unicode — `Unassigned` — or U+2800 — `Blank`. The same entry points and messages, the key
  never named; in `KeyTextRule`'s order after `spacing`, before `not-nfc`.
- **Migration:** drop variation selectors (an emoji without U+FE0F) and these characters where keys,
  thread ids and tenant ids are made.

## Unreleased — 0.1.1: what each way a lease ends says (#567)

- `ExecutionFencedError`'s message names a newer take and its holder only when a newer token was
  seen; a write the core's stores refuse for an expired, released or missing lease (the same token)
  says the lease is over — it expired, was released, or another instance took it — and that the next
  take continues. A holder whose lease ran out with no renewal confirmed no longer reads "another
  instance continues". Fields and codes unchanged. Found in the acceptance of #551.
## Unreleased — 0.1.1: a tenant id at the operator's reads and the mesh's dedupe (#568)

- `app.leaseEventsOf`, `app.outboundCallsOf` and `app.pendingOutboundCalls` refuse a tenant id that
  is no key's text (`dto.invalid` naming `tenantId` and the rule, never the id): on SQLite and
  PostgreSQL `t\uD800` read tenant `t\uFFFD`'s pending charges and lease log. A trusted A2A request
  or MCP call under such a tenant id is never deduplicated, and its `onExecutionRejected` names the
  tenant `"default"`, as the event's documentation says. Found in the acceptance of #552.

## Unreleased — 0.1.1: a fencing contract run alone shows its opt-out (#566)

- A fencing contract run on its own with `acceptWithoutDoubleChargeProtection: true` registers
  `gives NO double-charge protection: its store opted out of the lease check
  (acceptWithoutDoubleChargeProtection)`: passing for an opted-out store, failing
  `[store-conformance.opt-out-not-declared]` for one that does not opt out. `storeConformance`
  shows it once, in the set's suite, as before. Found in the acceptance of #543.

## Unreleased — 0.1.1: keys with look-alike spaces are refused (#547)

- **Changed**: a business key and a thread id are refused when they hold a space other than U+0020
  (`Zs`: U+00A0, U+1680, U+2000–U+200A, U+202F, U+205F, U+3000) or a line or paragraph separator
  (U+2028, U+2029) — `KeyTextRule.SpaceSeparator` — and when a U+0020 starts or ends them or two
  come in a row — `KeyTextRule.Spacing`. Checked where #538 checks, the key never named.
- **Migration:** trim keys and thread ids, collapse runs of spaces and make every space U+0020 where
  they are made.
- A text that breaks several rules is named by the first in `KeyTextRule`'s order (`length`,
  `lone-surrogate`, `control-character`, `format-character`, `space-separator`, `spacing`,
  `not-nfc`), wherever each breach stands; the enum is declared in that order (#547 acceptance).

## Unreleased — 0.1.1: an opted-out store and storeConformance (#543)

- **Breaking for stores outside the core**: a fencing store that declares
  `LeaseCheck.WithoutDoubleChargeProtection` fails every fencing case of `storeConformance` and its
  `store set` case (`[store-conformance.opted-out-store]`) unless the call says
  `acceptWithoutDoubleChargeProtection: true`. With the flag those cases are skipped with "store
  opted out of the lease check: no double-charge protection", and the set shows `gives NO
  double-charge protection for …`. Every other case still runs. Before, an atomic store with the
  flag on passed every case, and an honest one could pass none.
- The start's `[application.lease-check-not-atomic]` links
  [Your own store](Your-own-store#an-opted-out-store-and-storeconformance-543).
- **Migration:** add `acceptWithoutDoubleChargeProtection: true` to the `storeConformance` call of a
  set with an opted-out store.

## Unreleased — 0.1.1: the acceptance of #539 (#554)

- **Fixed**: the hint of `[application.store-backend-mismatch]` named a JavaScript function as the
  core store to list for a backend called like an object's own member (`"constructor"`,
  `"toString"`); such a backend is now a name with no core store, as `"postgres:billing"` is.
- **Tests**: a core kind on another database (`"sqlite:reports"`) is offered no core store either
  way; three stores of one contract, a subclass listed with its parent and two opted-out stores are
  each one `[di.ambiguous-implementation]` naming every one; `agboss check` prints the hint and the
  ambiguity with the mismatch in one run (#539 M1, M2).

## Unreleased — 0.1.1: the acceptance of #538 (#552)

- **Changed**: a tenant id is a key's text — refused at `app.execute`, `app.resume` and `app.cancel`
  when it breaks a rule of #538 (`dto.invalid`, `tenantId` and the rule named, never the id). A
  tenant id with a lone surrogate was stored as U+FFFD, so two tenants shared one thread, lease and
  business-key row, and its first execution failed with a raw `URIError` after binding the thread.
  `app.cancel` checks its thread id as `execute` does (`InvalidThreadIdError`, the id in neither the
  message nor `onExecutionRejected`).
- **Tests**: ids from the usual sources (UUIDs, ULIDs, Slack ts, e-mail addresses, phone numbers,
  provider ids, URLs) are keys; the accepted code point next to each refused range; a refused key in
  no log entry and no observer event; one fast-check seed per property file, logged (`FC_SEED`).
## Unreleased — 0.1.1: the fault suite's pods whose clocks disagree (#533)

- **New**: fault scenarios `s13-clock-ahead` and `s13-clock-behind` — a pod whose clock is ten
  leases ahead never takes a live pod's lease; one ten leases behind takes a frozen pod's tree over
  on time ([Guarantees across processes](Guarantees-across-processes)). `world.pod(name, {
  clockSkew: { offset, drift } })` skews a pod's wall time, monotonic time and sleeps; its stores
  keep the run's time, as a database's. A pod's clock scales its monotonic time with the run.

## Unreleased — 0.1.1: the store's time decides a lease's expiry (#533)

- **Breaking for stores outside the core**: `ExecutionLease.remaining` (required) — the time the
  store says the lease has left after its own instant of the take; `ExecutionLeaseRepository.renew`
  returns it (`Promise<Milliseconds | undefined>`, `undefined` once the lease is over) instead of a
  boolean; `acquire` and `reclaim` return it on the lease. A networked store decides expiry by its
  database's time inside each statement (PostgreSQL `clock_timestamp()`), unless a test injects its
  clock (`StoreClock.isDatabaseTime` false). **Migration:** return `remaining`
  (`remainingOf(expiresAt, now)`, both on the store's clock), take `StoreClock` in `deps`, build the
  contract target from `seam.storeClock` ([Your own store](Your-own-store#recipes-sql)).
- **Changed**: the holder fences itself on elapsed time — `sentAt + remaining − 1 s`
  (`LEASE_SAFETY_MARGIN`) from when it sent the request, counted on its `Clock.monotonicNow()` (new)
  and on its wall clock, the earlier ending it —, so an offset never moves its fence and a step or a
  suspend only ends it sooner; a holder trusts a fresh lease for 29 s, not 30 s, and a `remaining`
  that is not a finite number ≥ 0 not at all. An outbound call's `send` starts only while the
  holder's fence holds.
- **New**: `StoreClock` / `DatabaseStoreClock` (root), `TestStoreClock` (`@agboss/core/testing`);
  `testWith(App, { clockSkews })` with `ClockSkew` and `SkewedClock` (`@agboss/core/testing`); contract cases of the store's time as
  the authority, on real time, with the other instance's clock off by ± lease/2, ± lease and
  ± 10 × lease ([Several instances](Several-instances#the-execution-lease)).


## Unreleased — 0.1.1: the fault suite (#484)

- **Added — `@agboss/core/testing/faults`**: `faultSuite({ name, stores, database, timeScale?,
  scenarios? })`. Its 18 scenarios run the fixture application in real `node` processes on one
  database: SIGTERM, SIGKILL, SIGSTOP / SIGCONT, and the database stalled or dropped by a TCP proxy
  per pod. Each scenario checks six invariants (`one-owner`, `finished-work-untouched`,
  `children-once`, `effects-once`, `no-undo-on-hand-over`, `trees-finish`) through the public API
  and the history of every store operation. The core runs it on SQLite; agbossjs/postgres on
  PostgreSQL. Broken stores fail the scenario that targets them.
- **Added — store hold points for any store**: `withHoldPoints(Store)`, `StoreHoldPoint`,
  `HoldPoints` / `processHoldPoints`, and the history `OperationHistory` (each operation's invoke and
  complete, on the machine's monotonic clock: what #533's checkers read).
- **Added — [Guarantees across processes](Guarantees-across-processes)**: what the suite proves,
  scenario by scenario, and what is left to the application and the other systems.
- **Fixed — the kept record of an undo a takeover finished** (#541): it listed no undo action; it
  lists every one that ran, as `onExecutionError` does.
## Unreleased — 0.1.1: the acceptance of #534 (#551)

- **Changed**: `ExecutionLeaseLostError`'s message no longer says another instance took the lease.
  Since #534 a renewal or a reclaim at the expiry is refused whether or not one did, so a lone
  holder past its expiry heard of an instance that did not exist; it now says the lease is over —
  it expired, or another instance took it — and that the next take of the lease continues the
  execution. The remote-children reclaim's message likewise.
- **Docs**: one `clock.advance` of a whole lease or more over a running execution is its holder
  frozen past the lease ([Testing → The clock](Testing#the-clock)); the examples that taught one
  `advance(seconds(31))` over a live holder (`waitFor`, a quorum's deadline) advance in steps.
- **New contract cases** of the lease's boundary: a renewal or a reclaim racing another instance's
  take 1 ms before, exactly at and 1 ms after the expiry (exactly one wins); a renewal's new end
  counted from the renewal, not from the old end; a written key asked again at the expiry is
  refused, never replayed; `findByKey`, `markCompleted`, `markFailed` and `markPending` of an intent
  at each edge; `leaseStateOf` of a yielded lease, and racing the holder's renewal.

## Unreleased — 0.1.1: the store-backend errors say what to fix (#539)

- **Changed**: the hint of `[application.store-backend-mismatch]` names a lease store on the fencing
  store's own backend — the core's (`InMemoryExecutionLeaseRepository`,
  `SqliteExecutionLeaseRepository`) when it has one, else "a lease store declaring backend …" —
  and a fencing store on the leases' backend; it no longer suggests the SQLite stores for every
  backend.
- **New at assembly**: two listed stores of one fencing contract (fenced effects, outbound calls),
  or two lease stores, are `[di.ambiguous-implementation]`, naming both with their backends; before,
  only the first was checked and the second failed at its first use.

## Unreleased — 0.1.1: the acceptance of #520 and #526 (#542)

- **Fixed**: `store set (<name>)` compared each fencing store with the lease store of its own
  contract's target, so a set of in-memory leases and SQLite fenced effects passed every case and
  then failed assembly (`[application.store-backend-mismatch]`). It now compares each fenced-effect
  and outbound-call store with the set's `stores.executionLease` (an opted-out store excepted), and
  the lease store its contract ran on with it too.
- **New**: `[store-conformance.unknown-store]` — a key of `stores` that names no contract is refused;
  before, its store was counted as claimed and never tested.
- **New contract cases** of a finished lease (#520): a finish at an epoch a release, a new take or a
  reclaim moved on, of another holder's lease or of a key nobody took finishes nothing; a finished
  key is refused to every instance after any time, and a second finish changes nothing.

## Unreleased — 0.1.1: look-alike keys are refused (#538)

- **Changed — refused keys**: a business key and a thread id holding a C1 control (U+0080–U+009F),
  a format character (Unicode `Cf`: zero-width space and joiners, so emoji joined by U+200D too,
  bidi controls, U+FEFF, the soft hyphen, tags) or not in NFC are refused, never normalized
  silently — beside the empty or too long text, C0 controls and lone surrogates refused before.
  `InvalidBusinessKeyError` and `InvalidThreadIdError` carry `rule` (`KeyTextRule`,
  `keyTextRuleOf(text)` from the root) and name it, never the key; an invalid thread id is no
  longer echoed in `onExecutionRejected`. `InvalidBusinessKeyErrorOptions` takes `rule` instead of
  `problem`. **Migration:** normalize keys where they are made (`text.normalize("NFC")`).
- **Breaking for stores outside the core — new contract cases**: keys of many scripts come back
  byte for byte and are each their own row (fenced effects, outbound calls); a key built by hand
  breaking a rule is `InvalidBusinessKeyError` at every method — call `checkedBusinessKey(key)`
  beside `checkedEffectName(key.name)` at each method's entry.

## Unreleased — 0.1.1: a lease is over at its expiry, for its holder too (#534)

- **Changed — breaking for stores outside the core**: a lease is live while `expiresAt > now`, and
  only then, for every instance — its holder included. At `now >= expiresAt` the holder's `renew`
  and `yield` are `false`, its `reclaim` is `undefined`, `fence.confirmNow()` loses the lease and a
  fenced write or an outbound call's write at its token is `ExecutionFencedError`, whether another
  instance took it or not; the holder takes the tree again only by `acquire`, a takeover from
  itself. The in-memory and SQLite stores used to renew and reclaim an expired lease no one had
  taken; PostgreSQL refused it but for the exact instant (`>=`). One line now in every check:
  `acquire`, the renewals, the fence of a write, `leaseStateOf`, the local fence
  ([Several instances](Several-instances#the-execution-lease)).
- **New contract cases** at `expiresAt − 1 ms` (kept), exactly at it and `+ 1 ms` (refused) for
  `renew` of a held and of a yielded lease, `reclaim`, `yield`, the framework's `confirmNow()` and
  its renewal before a checkpoint write (its timers paused, as in a GC pause), a fenced write, the
  record of an outbound call's intent and `leaseStateOf`; the holder's way back by `acquire`; a take
  and a renewal at the instant of expiry never both win. Gone: "a lease renewed exactly at expiry,
  not taken meanwhile, is kept" and "a yielded lease reclaimed exactly at its expiry, not taken
  meanwhile, is the holder's again". **Migration:** match `expires_at > now` in `renew`, `yield` and
  `reclaim` ([Your own store](Your-own-store#recipes-sql)).
- **Tests**: one `clock.advance` of a whole lease (30 s) or more is a holder frozen past its expiry:
  its lease is lost even when no one took it, its call rejects with `ExecutionLeaseLostError` and
  recovery continues the tree. To let time pass for a live holder, advance in steps shorter than
  the lease (`seconds(10)`).

## Unreleased — 0.1.1: storeConformance and the guide for store authors (#526 PR 2)

- **Added — [Your own store](Your-own-store)**: what each contract must make atomic and why each
  step prevents a double charge or a second owner; recipes for SQL, MongoDB transactions, Redis Lua
  (and its durability caveat), DynamoDB conditional writes and Cassandra lightweight transactions
  (one partition); `storeConformance`; a checklist.
- **Added — `storeConformance({ name, reset?, stores, without? })`** in
  `@agboss/core/testing/contracts`: every contract a store set claims, as `<contract> (<name>)`,
  and `store set (<name>)` — each fencing store's `static backend` declared, one with its lease
  store's. A set with a lease store that leaves the fenced-effect, outbound-call or lease-log
  contract out (unless `without` says so) throws `StoreConformanceError`
  (`[store-conformance.missing-fencing-contract]`, `lease-store-required`, `without-implemented`,
  `invalid-without`, `empty`). The core's own in-memory and SQLite sets run it.
- **Breaking for stores outside the core — new contract cases**: the lease event contract's "every
  row the core writes" (each kind, reason, site, outcome and status, with the #508 fields
  `supersededLease`, `supersededBy`, `replayedFrom`); the fenced effect contract's "a key built by
  hand, a zombie" — an invalid name refused with `InvalidFencedEffectNameError` before anything
  (an empty name too, which was a `TypeError`), and a zombie's write racing the new holder's
  leaving one business row. A store on the pre-#508 row schema fails the first, a check-then-write
  store the last.

## Unreleased — 0.1.1: what the acceptance of 0.1.1 found (#529–#532)

- **Fixed — `circuitBreakerPolicy: null` is a missing policy** (#529): a JS project's `null` assembled,
  then `createApp` and `agboss check` threw a `TypeError`; it is now
  `[model-provider.circuit-breaker-required]`, as a policy left out is (#521).
- **Fixed — a lone surrogate is no business key or thread id** (#530): half of a surrogate pair
  passed the thread-id rule; SQLite and PostgreSQL keep text as UTF-8, where two such keys become one
  row, and the outbound call's key threw `URIError`. It is `InvalidBusinessKeyError` /
  `InvalidThreadIdError` now.
- **Fixed — `check:installs` and `check:real-time` miss no common form** (#531): `npm install-test`, a
  command continued with `\`, every `--package=` of an `npx`, npm spawned with `["i", …]` or a whole
  `"npm install …"` string; a duration through a second variable, a limit named by a constant.
- **Docs — [Payment gateways](Payment-gateways)**: `call.idempotencyKey` has no fixed length; a
  gateway with a shorter limit (Square: 45) gets a digest of it, never a key cut short (#532).

## Unreleased — 0.1.1: one transactional backend, checked at assembly (#526 PR 1)

- **Breaking for stores outside the core — `static backend`**
  ([Several instances](Several-instances#the-fenced-effect-500)): `ExecutionLeaseRepository`,
  `FencedEffectRepository` and `OutboundCallRepository` declare the backend their rows live in
  (`"in-memory"`, `"sqlite"`; `"postgres"`, `"postgres:billing"`). A listed fenced-effect or
  outbound-call store and the application's lease store must declare the same one:
  `[application.store-backend-mismatch]` names both classes and backends,
  `[application.store-backend-undeclared]` a store that declares none — it used to be skipped.
  `[application.fenced-effect-lease-store]` is gone; `static leaseRepository` only tells unit
  runners where to hold their lease. Migration: `static override readonly backend = "<backend>"` on
  your lease, fenced-effect and outbound-call stores.
- **Added — the opt-out `LeaseCheck.WithoutDoubleChargeProtection`** (`static leaseCheck`): the
  store reads the lease outside its write's transaction and is not checked; the start warns
  `[application.lease-check-not-atomic]` (an error under `agboss check --strict`). Rate limits, the
  child queue and the lease log are on any backend.
- **Added — the rules of a fenced key on the root entry**: `checkedEffectName`, `replayedFromOf`
  (`StoredKeyFacts`: a row's `null`s, a stored step checked), `storedKeyFactsOf`,
  `fencedKeyIdentityOf`, `pendingOutboundCallOf` — a store outside the core keeps no copy.
- **Fixed — a store's connection need not be listed** (found by agbossjs/postgres#8): with
  `OutboundCalls`, or a component that injects a store's own class, an unlisted `SqliteConnection` or
  `PostgresConnection` no longer fails assembly with `"…Connection" is not registered`.

## Unreleased — 0.1.1: finished work is never taken over (#520)

- **Fixed — a stale instance no longer re-claims the lease of an `AnyInstance` child another
  instance finished** ([Several instances](Several-instances#finished-work-is-never-taken-over-520)):
  a worker frozen while it reclaimed a child took the child's lease once it woke — a `RemoteChild`
  `Takeover` row for finished work — and kept it, renewed, until its instance stopped. A recovery
  sweep frozen after it listed a root wrote a `Recovered` (`Cancelled`, `Unwinding`) takeover of a
  tree that had finished meanwhile. Neither takes a lease nor writes a row now.
- **Breaking — `ExecutionLeaseRepository.finish(lease)`** (`Promise<void>`) is a new abstract
  member: a release for good — the work under the lease is over, and no later `acquire` of its key
  gets a lease, whoever asks and whenever; matched as `release` matches (another holder's lease is
  kept); a finished lease is renewed, yielded and reclaimed no more. The framework finishes an
  `AnyInstance` child's lease when the child answered or failed (a paused child's is released).
  Migration: a store of your own implements it — one atomic step, so an `acquire` racing the finish
  either took the lease first or is refused for good; `executionLeaseContract`
  (`@agboss/core/testing/contracts`) has the cases ("a finished lease", "the framework's take of
  finished work", races included). The in-memory store marks the row finished; SQLite writes
  `released = 3` (no migration: an existing file keeps working).

## Unreleased — 0.1.1: what a payment gateway must support (#508)

- **Added — [Payment gateways](Payment-gateways)**: the requirements G1–G6, what holds with and
  without each, and what Stripe, Adyen, PayPal, Braintree, Checkout.com and Square document (each
  cell with its source, read 2026-10-30).
- **Added — `FakeOutboundGateway`** (`FULL_GATEWAY_CAPABILITIES`, `FakeGatewayFault`,
  `FakeGatewayError`, `FakeGatewayErrorKind`) and **`outboundGatewayChecklist`**
  (`GatewayRequirement`, `GatewayCheckStatus`, `GatewayChecklistReport`) in `@agboss/core/testing`.

## Unreleased — 0.1.1: business idempotency keys (#508)

- **Added — `fencedEffectKeyOf(executionContext, name, { businessKey, fingerprint? })`**
  (`FencedEffectKeyOptions`) ([Several instances](Several-instances#business-idempotency-keys-508)):
  one fenced effect or outbound call per tenant, name and business key, whatever step, execution or
  thread; `FencedEffectKey.businessKey` / `fingerprint` / `origin`, `FencedEffectOrigin`,
  `FencedEffectOutcome.replayedFrom`, `OutboundCallOutcome.replayedFrom`, `OutboundCallRecord.businessKey`
  / `fingerprint` / `leaseExecutionId`.
- **Added — errors** `IdempotencyKeyConflictError` (`fenced-effect.key-conflict`, `effect`,
  `businessKeyHash?`) and `InvalidBusinessKeyError` (`fenced-effect.invalid-business-key`); a business
  key never appears in an error, only its handle — HMAC-SHA256 under the execution's PII key
  (`FencedEffectKey.businessKeyHash`), none without a key; `OutboundCallUnreconciledError.idempotencyKey`
  is `business-key:<handle>:<name>`.
- **Added — `OutboundCallRepository.leaseStateOf(lease)`** → `OutboundCallLeaseState` (`Live`,
  `Ended`, `Superseded`; `OutboundCallLease`): the state of the lease a pending business-key call
  was written under; an expired one is closed by the check in one atomic step — released at the
  token it was held at — so a late renewal and the check never both win (`outboundCallContract`'s
  races across leases). The close is an `OutboundCall` row `LeaseSuperseded` (**added**
  `OutboundCallEventOutcome.LeaseSuperseded`, `supersededLease`, `OutboundCallSupersededLease`) and a
  warning `outbound-call.lease-superseded`; the row marked closed by a check, not by its holder, so the next take is the very next token and
  a takeover from that holder and token (`takenOverFrom`, a `Takeover` row of the tree's lease log). A holder releases
  its lease only once its attempts settled and never yields it under one, both bounded by
  `@Application({ outboundCalls: { attemptTimeout } })` (**added**, default `minutes(2)`, from the
  attempt's start; `[application.outbound-calls-invalid]`) and its instance's stop — the call is in
  flight for `attemptTimeout` plus up to the lease's 30 s. A send still hung past this bound can coincide with a reconcile and a resend; the provider must deduplicate on `call.idempotencyKey` (G1).
- **Added — `OutboundCallResultNotStoredError`** (`outbound-call.result-not-stored`, a
  `StepFailedError`): a replay of a call whose result was not stored — nothing sent, never the
  marker as a result. Warnings `outbound-call.result-not-stored` and `outbound-call.text-redacted`;
  an error `outbound-call.answered-after-hand-over` for an answer fenced after its lease was
  handed over; `outbound-call.superseded` is written to the instance's log (`OutboundCalls` takes
  the `Logger` and the `Clock`, optional when built by hand), the newer attempt "unknown" when it
  cannot be read.
- **Changed — no read, record, export or event shows an intent's `fingerprint`**; rotating
  `pseudonymKey` changes every fingerprint, so an intent recorded before is a conflict for the same
  request after. An effect's name is checked again at every store method.
- **Added — `OutboundCallOutcomeStatus.Superseded`** and `OutboundCallEventOutcome.Superseded`
  (`supersededBy` on the event and its row, an error `outbound-call.superseded`); an answered call
  whose result cannot be stored ends `Completed` with a marker; `InvalidFencedEffectNameError`
  (`fenced-effect.invalid-name`); the key sent out encodes the business key; reads, records and
  `OutboundCallOutcome.idempotencyKey` show a business key by its handle only; a fingerprint is an
  HMAC under the application's `pseudonymKey` (`"agboss/fingerprint/v1"`); an unreconciled reason is
  masked.
- **Changed — `markCompleted(key, attemptOwner, result)` / `markFailed(key, attemptOwner, failure)`**
  return whether they ended the attempt: a compare-and-set on its owner, so a stale attempt never
  overwrites a newer one's outcome. The attempt's owner is live in the instance from before its
  intent is recorded or claimed, and nothing is sent once the step aborted.
- **Security — a business key's handle** is `HMAC(HMAC(piiKey, "agboss/business-key-handle/v1"),
  "business-key\0" + key)`: a subkey of its own (domain separation), never the PII key directly,
  so a handle never equals a PII token of the same text.
- **Added — `callTools(…)`** ([Testing](Testing)): one scripted move calling several tools at once.
- **Changed — the contract suites** carry the business-key cases; the SQLite stores add
  `fenced_effect_business_results` and the business-key index of `outbound_calls`.
- **Changed — flow-patterns' credit desk** charges once per credit application
  (`credit:<applicationId>`, `CreditOrderDto.applicationId`).

## Unreleased — 0.1.1: no CI install takes a release nobody reviewed (#523)

- **Changed — CI installs are reproducible** in agbossjs/agboss, agbossjs/postgres and
  agbossjs/agboss-examples: every workflow installs from its lockfile (`npm ci`); an install that
  resolves ranges — `npm run check:packed`'s probe project here — takes no release younger than three
  days (`npm install --before`, overridden by `AGBOSS_NPM_BEFORE` only by the maintainer, locally, at
  release time); an `npx` only at an exact version. `npm run check:installs` (in `make check`)
  enforces it ([Testing](Testing#the-vitest-preset-one-module-graph-497)). No API change.
- **Changed — no test asserts real elapsed time against a fixed number**: the model call and Jev
  timeout tests run on a `VirtualClock`; `npm run check:real-time` (in `make check`) fails on a new
  one ([Testing](Testing#the-clock)).

## Unreleased — 0.1.1: what a store outside the core needs (#521)

- **Fixed — a `@ModelProvider` without `circuitBreakerPolicy`** (a JavaScript project, a cast) no
  longer crashes `agboss check` and `createApp` with `Cannot read properties of undefined (reading
  'fallback')`: it fails assembly with **`[model-provider.circuit-breaker-required]`**, naming the
  provider, its class and the field — a breaker's `fallback` too
  ([Model providers](Model-providers#circuitbreakerpolicy)). The policy stays required, as its type says.
- **Added — `signedMeshEnvelope(options)`** (`@agboss/core/testing`, `SignedMeshEnvelopeOptions`):
  the `agboss-mesh` header a peer sends, signed by the framework's own encoder — a test signs
  envelopes through it instead of building the JWS by hand ([A2A](A2A#trusted-peers--signed-envelopes-398-pr-2)).
- **Added — `totalCost(records)`** on the root entry: the sum `CostLedgerRepository.saveAll` adds to
  each counter, for a ledger outside the core.
- **Fixed — a NUL character (U+0000) in a record's task, answer or stop reason, or in a summary,**
  came back cut at it from the in-memory and SQLite record stores (`node:sqlite` reads a TEXT value
  only up to a NUL): free text is now kept as JSON text; **migration 14** rewrites an existing
  file's rows, which read back as they were.
- **Added — a NUL case in every contract suite that keeps text or JSON**
  (`@agboss/core/testing/contracts`, [Several instances](Several-instances#on-the-public-surface-alone-511)):
  every store gives back what it is handed, U+0000 included. Migration: a store of your own runs the
  new cases — on PostgreSQL keep framework JSON as `text`, not `jsonb`.

## Unreleased — 0.1.1: a parent waiting for remote children keeps its tree (#516)

- **Fixed — a parent waiting for `ChildPlacement.AnyInstance` children is no longer taken over**
  ([Several instances](Several-instances#a-parent-waiting-for-remote-children-516)): the yield was a
  release plus a mark in the holder's process, so another instance's recovery sweep took the
  waiting root over and the caller of a successful `execute` got `ExecutionLeaseLostError` or
  "child execution … is no longer queued". The yielded lease now stays the holder's in the store,
  renewed; a dead holder's lease expires and the tree is recovered as before.
- **Breaking — `ExecutionLeaseRepository.yield(lease)`** (`Promise<boolean>`: `false` when the
  caller no longer holds it) and **`reclaim(lease, duration)`** (`Promise<ExecutionLease |
  undefined>`: the holder's lease at `leaseEpoch + 1`, held again) are new abstract members. A
  yielded lease is refused to every other `acquire` until it expires, `renew` keeps it, and once
  expired it is taken over with `takenOverFrom`. Migration: a store of your own implements both —
  `executionLeaseContract` (`@agboss/core/testing/contracts`) has the cases ("a yielded lease"); the
  in-memory and SQLite stores implement them (SQLite adds a `yielded` column to an existing file).
- **Changed —** a reclaim that finds the lease taken rejects with `ExecutionLeaseLostError` worded
  "expired while it waited for remote children and another instance took it".

## Unreleased — 0.1.1: calls that leave the system on SQLite, told (#505 PR 2)

- **Added — `SqliteOutboundCallRepository`** ([Several instances](Several-instances#calls-that-leave-the-system-505)):
  the intents in `outbound_calls` of the application's file, fenced in one transaction with the
  fenced effect's marks; listed with `SqliteExecutionLeaseRepository`, else
  `[application.fenced-effect-lease-store]`.
- **Added — `onOutboundCall`** (`OnOutboundCall`, `OutboundCallEvent`, `OutboundCallEventOutcome`:
  `Recorded`, `Sent`, `Replayed`, `Reconciled`, `NotSent`, `Unknown`, `Failed`, `Joined`)
  ([Observability](Observability#outbound-calls-505)), and **`OutboundCallEventRecord`**, the lease
  log's `OutboundCall` row ([Several instances](Several-instances#the-lease-log-501)) — never a payload.
- **Added — `ExecutionHistoryRecord.outboundCalls`** ([Execution history](Execution-history)):
  a kept execution carries its tree's intents, and so does `agboss records export`.
- **Changed — `OutboundCallRepository.markPending(key, expected, claim)`** is a compare-and-set
  (`OutboundCallState`: `status`, `attempt`, `attemptOwner`; `OutboundCallClaim`: `attempt`,
  `attemptOwner`) and returns whether it moved the intent; a caller that loses it sends nothing.
  **Added — `OutboundCallIntent.attemptOwner`**, the random id of the attempt's claimer;
  **`OutboundCallOutcomeStatus.Joined`** — the same call made meanwhile by this instance is joined,
  never reconciled or resent; **`OutboundCallInFlightError`** (`outbound-call.in-flight`) for a key
  another call holds — it replaces the `OutboundCallUnreconciledError` a second record of one key
  gave. `outboundCallContract` gains the new-attempt cases.
- **Changed — flow-patterns' travel desk** books its flight through `OutboundCalls`, reconciling by
  the booking desk's lookup.

## Unreleased — 0.1.1: calls that leave the system (#505 PR 1)

- **Added — `OutboundCalls`** ([Several instances](Several-instances#calls-that-leave-the-system-505)):
  `send(key, { target, operation, request, send, reconcile })` records an intent before the call
  and settles it after; an intent left pending is reconciled (`OutboundCallReconciliation.completed`
  / `.notSent()` / `.unknown({ reason })`), never sent again blindly. `OutboundCallOutcome`
  (`OutboundCallOutcomeStatus.Sent | Replayed | Reconciled`), `OutboundCall`, `OutboundCallLookup`.
- **Added — `OutboundCallRepository`** (infrastructure, every method but the listings fenced), its
  in-memory default `InMemoryOutboundCallRepository`, `OutboundCallRecord`, `OutboundCallStatus`,
  and `outboundCallContract` in `@agboss/core/testing/contracts`.
- **Added — `app.outboundCallsOf({ tenantId, rootExecutionId })`** and
  **`app.pendingOutboundCalls({ tenantId })`**.
- **Added — `@Application({ outboundCalls: { maxPayloadSize, retention } })`** (64 KB, a week),
  `OutboundCallSettings`, `[application.outbound-calls-invalid]`; errors `OutboundCallUnreconciledError`,
  `OutboundCallPayloadTooLargeError`, `OutboundCallUnmaskedError`.
- **Fixed — a `ChildPlacement.AnyInstance` child's frame** carries its workflow's PII mask, and a
  `ParentInstance` child's its own workflow's (it carried its parent's).
- **Moved —** `ApplicationStoppingError` to `core/errors.ts` (still a root export), and the
  internal `thread-map-key.ts` into `in-memory-database.ts`, for the root import's module budget.

## Unreleased — 0.1.1: core gaps found by @agboss/postgres (#511)

- **Added — `@Injectable({ environmentFields })`**, `EnvironmentField`, `EnvironmentFields`,
  `InjectableOptions` ([Environments](Environments)): a class declares the environment fields it
  reads; every class listed in `providers` and every class their `deps` reach is checked at assembly
  — `[environment.missing-field]` (now naming the class that reads it, `… (read by
  SqliteConnection)`), and the new `[environment.conflicting-field]`. `SqliteConnection` declares
  `sqlitePath` so.
- **Added — `VirtualClock.track(work)`** and `new VirtualClock(start, { settleTimeout })`
  ([Testing](Testing)): `advance` waits for tracked work, bounded by `UnsettledWorkError`
  (`test.unsettled-work`). The published contract suites track every store call of their targets, so
  a networked store needs no wait of its own around `advance`.
- **Added — the types the infrastructure contracts name**, exported by the root entry (`Tern`,
  `NewTern`, `TernOutcome`, `TernStatus`, `TernStep`, `Summary`, `NewSummary`, `ConfigSnapshot`,
  `VersionScore`, `ExecutionData`, `ScopeRecords`, `CompensationEntry`, `CompensationEntryStatus`,
  `WaitingPause`, `Compacted`, `CostReport`, `CostLine`, `CostCategory`, `CostSource`, `TokenUsage`,
  `ToolCallApprovalAskDto`, `JsonPrimitive`, `Brand`, `Milliseconds`, `Usd` — types only).
- **Changed — `checkpointSaverContract`**: `put` is given the changed channels' versions, as LangGraph
  passes them; LangGraph's `PostgresSaver` passes as it is
  ([Several instances](Several-instances#on-the-public-surface-alone-511)).
## Unreleased — 0.1.1: handover telemetry, the fenced effect told (#501 PR 3)

- **Added — `onFencedEffect`** (`OnFencedEffect`, `FencedEffectEvent`, `FencedEffectEventOutcome`:
  `Ran`, `Replayed`, `Joined`, `Refused`) ([Observability](Observability#fenced-effects-501)): every
  call of `FencedEffectRepository.saveResultIfAbsent` from a step, never its result.
- **Added — `FencedEffectRecord`**, the lease log's `FencedEffect` row
  ([Several instances](Several-instances#the-lease-log-501)): with the takeover and the hand-over,
  a refused zombie, one that never wrote and a replay are told apart from `app.leaseEventsOf` alone.
- **Moved — `FencedEffectAsyncWorkError`** to the SQLite store's module; still exported from the
  root entry.

## Unreleased — 0.1.1: handover telemetry, a step handed over (#501 PR 2)

- **Added — `onStepHandedOver`** (`OnStepHandedOver`, `StepHandedOverEvent`, `HandOverReason`,
  `HandOverSite`) ([Observability](Observability#hand-overs-501)): a step stopped by a lost lease, a
  fenced write or the app's stop is told once per error, at the innermost site — a step, a tool call,
  a tool interceptor, an undo, a branch, a child.
- **Added — `StepHandedOverRecord`**, the lease log's `HandedOver` row
  ([Several instances](Several-instances#the-lease-log-501)), written before the moving call rejects;
  `ExecutionLeaseEventRecord` is now `LeaseTakeoverRecord | StepHandedOverRecord` and `checkpointId`
  is the takeover's own field.
- **Added — `ExecutionHistoryRecord.leaseEvents`**: a kept execution carries its tree's rows of the
  lease log ([Execution history](Execution-history)), and so does `agboss records export`.

## Unreleased — 0.1.1: handover telemetry, the lease log (#501 PR 1)

- **Added — `ExecutionLease.takenOverFrom`** (`PreviousLeaseHolder`: `holderInstanceId`,
  `leaseEpoch`): `acquire` names the holder whose lease it took over after it expired — never after a
  release. Optional: an external `ExecutionLeaseRepository` still compiles; the published
  `executionLeaseContract` has two more cases, so a store that runs it reports it.
- **Added — `onExecutionLeaseTakeover`** (`OnExecutionLeaseTakeover`, `ExecutionLeaseTakeoverEvent`,
  `LeaseTakeoverReason`) ([Observability](Observability#lease-takeovers-501)).
- **Added — the lease log** ([Several instances](Several-instances#the-lease-log-501)): the
  infrastructure contract `ExecutionLeaseEventRepository` (`ExecutionLeaseEventRecord` =
  `LeaseTakeoverRecord`, `ExecutionLeaseEventKind`), its in-memory default,
  `SqliteExecutionLeaseEventRepository` (table `execution_lease_events`), the contract suite
  `executionLeaseEventContract`, `app.leaseEventsOf({ tenantId, rootExecutionId })` (`LeaseEventsQuery`)
  and `@Application({ leaseEventRetention })` (default `hours(24)`, removed by the recovery sweep).
  Readiness pings it.
## Unreleased — 0.1.1: the fenced effect (#500)

- **Added — `FencedEffectRepository<TTransaction>`** ([Several instances](Several-instances#the-fenced-effect-500),
  [ADR-0026](ADR-0026-Fenced-effects-check-the-lease-in-the-same-transaction)):
  `saveResultIfAbsent(fencedEffectKeyOf(executionContext, name), work)` makes a protected write once
  per step — the lease, the scope's mark and the key checked in the write's transaction;
  `FencedEffectStatus.Ran` / `Replayed` / `Joined`; a zombie gets `ExecutionFencedError`. The
  built-in `InMemoryFencedEffectRepository` and `SqliteFencedEffectRepository` (with
  `SqliteExecutionLeaseRepository`; its work synchronous, `FencedEffectAsyncWorkError` otherwise).
- **Added — `@Application({ fencedEffects: { maxResultSize, retention } })`** (64 KB, 24 h;
  `[application.fenced-effects-invalid]`), `FencedEffectSettings`, `FencedEffectResultTooLargeError`,
  `[application.fenced-effect-lease-store]` and `FencedEffectStoreMismatchError`; the recovery sweep
  removes the rows past the retention.
- **Added — `fencedEffectContract`** in `@agboss/core/testing/contracts`; unit runners hold their
  lease in the store's lease store.
- **Changed — flow-patterns' credit desk** charges through `SqliteFencedEffectRepository`:
  `PaymentService` and `PaymentKeyReusedError` are gone, `payment_charges` has no idempotency key.
- `agboss describe` lists `FencedEffectRepository` among the infrastructure contracts.

## Unreleased — 0.1.1: a vitest preset loads AGBoss in the test's module graph (#497)

- **Fixed — `workflowOf(W)` on the package installed from npm** ([Testing](Testing#the-vitest-preset-one-module-graph-497)):
  the application next to `W` was imported by Node, outside vitest — no decorators, or a second
  module graph. **Added — `@agboss/core/testing/vitest`**: `agbossTest(test?)`, the `test` options
  with `server.deps.inline` gaining `/@agboss\/core/` and `setupFiles` gaining
  `@agboss/core/testing/setup` (merged, never replaced). `agboss create` writes it.
- **Added — `TestSetupError` from `workflowOf(W)`** without the preset: `the application of
  <workflow> was loaded outside vitest's module graph; use agbossTest() from
  @agboss/core/testing/vitest in vitest.config.ts`, the original error as its `cause`.
- **Added — `npm run check:packed`** and CI's `packed-project` job: the packed packages in a project
  of their own, the positive run and the negative one; `RELEASE_CHECKLIST.md` runs it too.
- **Migration** — in an existing `vitest.config.ts`, wrap the `test` options:

  ```ts
  import { defineConfig } from "vitest/config";
  import { agbossTest } from "@agboss/core/testing/vitest";

  export default defineConfig({ test: agbossTest({ include: ["tests/**/*.test.ts"] }) });
  ```

  The `setupFiles: ["@agboss/core/testing/setup"]` entry may go; kept, it is not added twice.

## Unreleased — job-scout moves to agbossjs/agboss-examples (#489)

- **Removed — `examples/job-scout`** ([Example](Example),
  [ADR-0025](ADR-0025-Examples-live-in-agbossjs-agboss-examples)): it is
  [`08-job-scout`](https://github.com/agbossjs/agboss-examples/tree/main/08-job-scout) of
  agbossjs/agboss-examples, on the published `@agboss/core`, its history kept. `examples/flow-patterns`
  is the one in-repo example: the root's `npm run studio` and `npm run check:models` run on it (its
  new `check:models` script), and every core and CLI test that used job-scout uses it.
- **Added — a `check:docs` rule**: a link to `examples/job-scout` outside the ADRs and the Changelog
  fails the check, naming the doc, the line and where the folder went.
- **Added — `RELEASE_CHECKLIST.md` → Examples against the release candidate**: every example of
  agbossjs/agboss-examples runs locally against the packed candidate with real models before a
  release; their CI stays offline.

## Unreleased — the project layout in every skill snippet and in flow-patterns (#474)

- **Changed — the shipped skills** ([Components](Components#project-layout-474),
  [Naming](Naming#folders-one-domain-level-kind-folders-a-folder-per-workflow-474)): every snippet of
  `SKILL.md` and references 01–13 is one class per file, named by its `file=`, at the path
  `agboss generate` writes — `src/[<domain>/]<kind>/…`, `workflows/<w>/` with the workflow's starts
  and finishes, `agents/<n>/` (and every prompt-bearing kind) with its `<n>.prompt.md`, DTOs in
  `dto/`, the application and `environments/` at the `src/` root, `tests/` mirroring `src/`.
  `SKILL.md` allows one domain level (`src/billing/agents/refund/refund.agent.ts`); the "condensed"
  references are gone; `@ToolInterceptor` lives in `tool-interceptors/<n>.tool-interceptor.ts`.
- **Changed — `examples/flow-patterns`** ([Example](Example#flow-patterns-a-review-loop-and-a-code-router)):
  `dtos/` → `dto/`, each workflow in `<domain>/workflows/<w>/` with its starts and finishes, each
  agent, router, judge, arbiter, compaction and guardrail in its own folder; its tests mirror `src/`
  ([Testing](Testing#three-kinds-of-tests)), the cassette in
  `tests/desk/workflows/desk/__snapshots__/`. Component names, versions, cassettes, snapshots and
  eval baselines are unchanged.
- **Added — the layout check** (`packages/agboss/tests/docs/skills-layout.test.ts`): one class per
  block, a class block without `file=`, a workflow file outside `workflows/<w>/`, a flat prompt-bearing
  component, a `*.prompt.md` not beside its component, a domain with a loose file, a test outside the
  mirror — each named by file and line, over the skills, the example's real files and what
  `agboss generate` writes.

## Unreleased — published store contract suites (#481)

- **Added — `@agboss/core/testing/contracts`** ([Several instances](Several-instances#writing-your-own-store-the-published-contract-suites-481),
  [Testing](Testing#store-contract-suites--agbosscoretestingcontracts-481),
  [ADR-0024](ADR-0024-Published-store-contract-suites)): the core's store contract suites, one
  function per contract — `executionLeaseContract`, `executionRecordContract`,
  `executionTreeContract`, `childExecutionQueueContract`, `pausedExecutionContract`,
  `executionHistoryContract`, `costLedgerContract`, `rateLimitContract`, `meshRequestContract`,
  `checkpointSaverContract` — over a `ContractTarget` (`name`, `instance(seam)`, `reset?`, `close?`;
  `StoreSeam`: the suite's clock, `instanceId`, `application`). The in-memory and SQLite stores run
  the same suites; `@agboss/core/testing` does not re-export them.

## Unreleased — fencing external writes (#471)

- **Added — `executionContext.fence`** ([Several instances](Several-instances#fencing-external-writes-471),
  [ADR-0023](ADR-0023-Execution-fence-on-the-context)): the lease the step runs under — `scopeKey`,
  `tenantId`, `leaseExecutionId`, `token` (its `leaseEpoch`), `confirmedUntil`, `assertHeld()`,
  `confirmNow()`, `fenced(observedToken)`; `ExecutionFence` and `ExecutionFencedError`
  (`execution.lease-lost.fenced`, `extends ExecutionLeaseLostError`) in the root entry.
- **Changed — a fenced error is a hand-over everywhere**: found in a cause chain or an
  `AggregateError`, before the signal's reason — no `.onError`, no undo, no `onToolEnd`, nothing to
  the model, no failed record; the moving call rejects with it. A tool's or an interceptor's lost
  lease ends the agent's loop instead of reaching the model as a tool error.
- **Fixed — the remote-children wait** yields the root's lease only while no other step of the tree
  runs (a sibling `ParentInstance` branch used to run with the lease released, #333 PR 4).
- **Added — testing**: the `leases` fixture of `testWith` (`stall` / `resume`, `TestLeases`) and the
  `fence` option of every unit runner and `testExecutionContext` (`TestFenceOptions`, `clock`).

## Unreleased — pauses, lease yielding and per-child recovery across instances (#333 PR 4)

- **Added — pauses and `app.resume` in `ChildPlacement.AnyInstance` children**
  ([Workflow as a step](Workflow-as-a-step#on-any-instance-333-pr-2),
  [Several instances](Several-instances#children-on-any-instance-333)): when a remote child rests at a
  pause, its worker completes the queue row with `ExecutionRecordStatus.Paused` (`ChildExecutionEnd.status`
  now includes `ExecutionRecordStatus.Paused`) and the parent's node interrupts with a `remote: true`
  waiting marker so the pause appears in `result.pending` with its `childExecutionId` and `itemIndex`
  and records `PauseAnswerRecord` in `result.children[i].pauses` and `result.record.pauses`. On
  `app.resume` from any instance, the parent's node forwards the child's resume map through the queue
  so any instance continues only that child on `<parentThreadId>/child/<id>`.
- **Removed — `GraphRuleErrorCode` value `graph.remote-child-can-pause`**: remote children may now
  use tools that pause.
- **Changed — yielding the root lease and per-child crash recovery (#333 S7, S9)**: while a parent
  waits on remote children inside its step, it yields its root lease in `ExecutionLeaseRepository`
  and re-acquires it before continuing. Each worker holds a 30 s lease in `ExecutionLeaseRepository`
  under `(tenantId, childExecutionId)`; on a worker crash or a graceful stop past `shutdownTimeout`
  (S7), the queue row stays `Running`, and once the child's lease is free a live worker reclaims
  only that child and continues it from its last checkpoint on `<parentThreadId>/child/<id>` without
  re-running finished siblings.

## Unreleased — tree-wide slots, depth and budgets across instances (#333 PR 3)

- **Added — shared tree slots in `RateLimitRepository`** ([FinOps](FinOps#concurrency-of-a-tree-264),
  [Several instances](Several-instances#children-on-any-instance-333)): when a tree can launch a child
  with `ChildPlacement.AnyInstance`, its `maxConcurrentExecutions` cap (and any smaller subtree cap)
  is held as leases in `RateLimitRepository` (`tree:<tenantId>:<rootExecutionId>` and
  `:subtree:<executionId>`, renewed while held, polled on the `Clock`), so the cap holds across
  instances and a crashed instance's slot expires by itself. Local-only trees stay in-process.
- **Changed — immediate ledger recording for remote children** ([Workflow as a step](Workflow-as-a-step#on-any-instance-333-pr-2)):
  a worker running an `AnyInstance` child writes each superstep's usage to the root's budget counters
  in `CostLedgerRepository` as it streams, and the parent marks those records `isRecordedElsewhere`
  when folding in the child's state so nothing is counted twice. Depth (`maxDepth`) and the root's
  budgets are checked on the worker.

## Unreleased — flow-patterns drops its memory strategy (#459)

- **Example — `SameOrderMemoryStrategy` removed** ([Example](Example)): the helpline's agent no longer
  sets `memoryStrategy`, which is v1 memory. The example shows memory the v2 way: the desk's
  `CompactionStrategy.Custom` compaction and `historyOf` in the review loop. `@Agent({ memoryStrategy })`
  stays in the framework ([Memory management](Memory-Management)).

## Unreleased — documented: `instances: 2` on SQLite `:memory:` (#458)

- **Docs — several instances on SQLite** ([Several instances](Several-instances#testing-several-instances)):
  `testWith(App, { instances: 2 })` shares the in-memory defaults, but listed SQLite stores on
  `sqlitePath: ":memory:"` are one database per instance. A multi-instance test names a file. No
  code change.

## Unreleased — `A2ACallerRejectedError.wireCode` (#457)

- **Breaking — `A2ACallerRejectedError.code` is the class's code** ([A2A](A2A)): an instance's
  `code` is `a2a.caller-rejected`, like every `AGBossError`. The code the server sent
  (`a2a.caller-unauthenticated`, `a2a.caller-forbidden`) moves to the new field `wireCode`.
  Migration: read `error.wireCode` where you read `error.code` for the server's code, and in tests
  write `toFailWith(A2ACallerRejectedError, { httpStatus: 401, wireCode: "a2a.caller-unauthenticated" })`.

## Unreleased — child workflows on any instance (#333 PR 2)

- **Added — `ChildPlacement`** ([Workflow as a step](Workflow-as-a-step#on-any-instance-333-pr-2)):
  `{ placement: ChildPlacement.AnyInstance }` on `.toWorkflow(W, …)`, `.toParallelWorkflows(W, { …,
  placement })` and `route(W, …)` lets any instance of the application run the child; default
  `ChildPlacement.ParentInstance` (as before). The parent's node waits for it inside its step (#333
  S6) — `FailFast`, `app.cancel`, a lost lease and budgets as for a local child; its failure is
  `ChildExecutionFailedError` with the child's error chain as `RemoteChildFailure`s. New rule codes
  `[flow.conflicting-placement]` and, until #333 PR 4, `[graph.remote-child-can-pause]`.
- **Added — infrastructure `ChildExecutionQueueRepository`** (in memory;
  `SqliteChildExecutionQueueRepository`, table `child_execution_queue`) and
  `ExecutionRecordStatus.Queued` ([Several instances](Several-instances#children-on-any-instance-333)):
  queued children claimed atomically by instances with a free step slot (#332); the assembly warning
  `[application.in-memory-child-queue]`.

## Unreleased — the built-in model providers yield to an explicit claim (#454)

- **Changed — `OpenRouterModelProvider` and `DecisionsModelProvider` are catch-alls**
  ([Model providers](Model-providers#which-provider-serves-a-model)): each serves its models except
  those another listed provider claims by `serves`, so a project's provider for its own prefix (a
  transport on `harness/…`) is listed next to the built-ins with no narrowed `OpenRouterProvider`
  subclass. Before, that combination failed with `[model.ambiguous-provider]`; two of the project's
  own providers claiming one model still do. A subclass with its own `@ModelProvider` does not yield.
  The key check at start is unchanged. flow-patterns drops `FlowPatternsOpenRouterModelProvider`.

## Unreleased — the Mesh Hub: blast radius & federation (#401 PR 7)

- **Added — declared edges and the blast radius** ([Mesh Hub](Mesh-Hub#blast-radius--federation)):
  `agboss hub show` / `hub ui` draw every contract a snapshot declares as an edge consumer → producer
  (dashed when no record shows a call, red when broken), list the problems `agboss check
  --federation` finds between the newest snapshots — the same `checkFederation` — with their blast
  radius, and who calls an application whose latest eval run lost pass^k. `--json` adds
  `edges.declared` and `federation`; `hub ui` adds `/api/blast-radius`.

## Unreleased — the Mesh Hub served: `agboss hub ui` (#401 PR 6)

- **Added — `agboss hub ui <path…> [--port N]`** ([Mesh Hub](Mesh-Hub#served-agboss-hub-ui)): the Hub
  on 127.0.0.1 behind a printed token, on `agboss eval ui`'s own server (one local server, its token,
  `Host` and CSP rules), read-only: the page, `/records` — every export's executions searched, a page
  at a time — and `/api/mesh`, `/api/applications/<name>`, `/api/trees/<rootExecutionId>`,
  `/api/records`, `/api/radar`.

## Unreleased — the Mesh Hub: the crystallization radar (#401 PR 5)

- **Added — `ExecutionStepRecord.decision`** ([Observability](Observability)): what each visit
  decided — `route:<node>`, `launch:<node>,…`, `variant:<class>` or `answer:<hash>`; none when it
  gave nothing. Additive.
- **Added — the Crystallization Radar** on `agboss hub show` ([Mesh Hub](Mesh-Hub#crystallization-radar)):
  model steps ranked by spend × stability (the share of one decision for one `inputHash`); a
  candidate at ≥ 50 calls, stability ≥ 0.95 and no failing eval of its workflow. `--json`: `radar`.

## Unreleased — child workflows as runs of their own (#333 PR 1)

- **Changed (internal)** — [ADR-0022](ADR-0022-Child-workflows-as-runs-of-their-own), reversing #263
  S24: a child execution runs as a root graph on its own checkpoint thread
  (`<parentThreadId>/child/<childExecutionId>`), awaited in its parent's step; its launching task
  keeps a marker of it; a child resting at a pause makes its parent's node wait with a marker the
  drain follows ([Workflow as a step](Workflow-as-a-step#at-run-time)). No public change: paths,
  records, events, budgets, pauses and undo behave as before. A child that started before this
  version is continued the old way (one version).

## Unreleased — flow-patterns as the zero-cost harness: the desk's history (#419)

- `examples/flow-patterns`' desk keeps its executions (`executionRecordRetention`) and its
  `npm run check` runs `npm run records:check`: one offline run, `agboss records export`, and
  `agboss generate eval-case --from-execution --dry-run`.
  [Example](Example#flow-patterns-a-review-loop-and-a-code-router).

## Unreleased — "save as golden case" takes the run's own tenant (#397 PR 5b)

- **Changed — the run artifact is `schemaVersion` 4**: each run result keeps its `tenantId` (the
  tenant its turns ran for); versions 1 to 3 are still read
  ([Eval suites](Eval-Suites#the-run-artifact)).
- **Fixed** — *Save as golden case* reads the run's own execution: on the run's thread, of the run's
  `tenantId`; an execution id kept for several tenants no longer answers with a CLI hint
  (`--tenant`) — for a run from before version 4 it is `409`, worded for the page: run the suite
  again ([Eval suites](Eval-Suites#saving-a-run-as-a-golden-case-397-pr-5)).

## Unreleased — the Mesh Hub: execution trees across applications (#401 PR 4)

- **Added — Cross-Service Execution Trees** on `agboss hub show`'s page ([Mesh Hub](Mesh-Hub#execution-trees-across-applications)):
  each tree that crosses applications, stitched from their exports by each receiver's `origin` (the
  calling execution and its call's `idempotencyKey`, never the tenant); a receiver that exported
  nothing is a stub; `--json` lists the trees.

## Unreleased — the Mesh Hub: `agboss hub show` (#401 PR 3)

- **Added — `agboss hub show <path…> [--html <file>]`** ([Mesh Hub](Mesh-Hub)): many applications'
  `describe --json` snapshots, `agboss.eval-run` artifacts and `agboss.execution-record` exports read
  from files and folders, each by its marker, into one mesh — every application, the calls between
  them seen in the records (`remote` / `origin`, each counted once by its step's `idempotencyKey`),
  each one's health from its records and eval runs — and one self-contained page in the eval
  report's shell. No project, nothing runs, no network. `hub.input-schema`,
  `hub.duplicate-application`, `hub.input-not-found`, `hub.report-too-large`.

## Unreleased — "save as golden case" in `agboss eval ui` (#397 PR 5)

- **Added — *Save as golden case*** on a run of `agboss eval ui` with an execution
  ([Eval suites](Eval-Suites#saving-a-run-as-a-golden-case-397-pr-5)): its kept execution drafted
  as `agboss generate eval-case --from-execution` drafts it and written into the suite's file —
  atomically, only while the file's ETag is the page's (else 409), never over a case of the same
  name (409); without `executionRecordRetention` the page says why. `agboss eval ui` takes
  `--application` and `--env`.

## Unreleased — flow-patterns as the zero-cost harness: the remaining patterns (#419)

- `examples/flow-patterns` adds `src/intake/` (`joinQuorumGroups`, tested with
  `TestConcurrency.inOrder` and `failWith(ModelFailure.RateLimited)`), `historyOf` in the review
  loop, a pause resumed on a second instance (`instances: 2`), and in the helpline a stubbed
  `@McpServer` / `@McpTool` (`mcpOf`) and a custom memory strategy (`@agboss/core/memory`).
  [Example](Example#flow-patterns-a-review-loop-and-a-code-router).

## Unreleased — flow-patterns as the zero-cost harness: a VCR cassette recorded offline (#419)

- `examples/flow-patterns` replays the desk from a cassette recorded through its transport model
  provider with no key (#439), and its `npm run check` adds `agboss check --cassettes`.
  [Example](Example#flow-patterns-a-review-loop-and-a-code-router).

## Unreleased — `agboss generate eval-case --from-execution`: a case from a kept execution (#396 PR 8)

- **Added — `agboss generate eval-case <name> --from-execution <executionId> [--suite <name>]
  [--tenant <id>]`** ([Eval suites](Eval-Suites#a-case-from-a-kept-execution-agboss-generate-eval-case)):
  reads one execution from the application's history ([Execution history](Execution-history)) and
  adds a case to its suite — its input as the turn, its contexts, the thread's earlier finished turns
  as `history`, the calls it ran as `tools.required`, masked as kept, its classes imported; nothing
  runs. `records.not-found`, `records.ambiguous-execution`, `records.not-kept`,
  `[eval.case-start-mismatch]`.

## Unreleased — VCR records through a transport model provider (#439)

- **Fixed — a VCR test records through a transport `@ModelProvider`** ([Testing](Testing#vcr--recorded-runs)):
  `RECORD` and `RECORD_STALE` stopped with `its chat models are not loaded (chatExtensionsFor)`;
  the recording now builds the providers' gateway as `createApp` does — the chat extensions loaded,
  the transport created by the test app's container on its first call, with its lifecycle hooks.
  A replay still creates no provider.

## Unreleased — execution history: `ExecutionHistoryRepository`, `executionRecordRetention`, `agboss records export` (#401 PR 1)

- **Added — `@Application({ executionRecordRetention })`** ([Execution history](Execution-history)):
  unset → nothing is kept (as before); set, every root execution's `ExecutionHistoryRecord` — its
  `ExecutionRecord` with `executionId`, `rootExecutionId`, `threadId`, `tenantId`, `application`,
  `workflow`, `status` (`ExecutionHistoryStatus`), `startedAt` / `endedAt`, `start` + `input`,
  `finish` + `output`, `contexts`, `error` — masked like its traces, saved when its tree rests or
  ends and removed by the recovery sweep once it ended longer ago. On the built-in in-memory store
  it warns `[application.in-memory-execution-history]`.
- **Added — infrastructure `ExecutionHistoryRepository`** (in memory, `SqliteExecutionHistoryRepository`),
  additive: `ExecutionRecordRepository` is unchanged; readiness pings it.
- **Added — `agboss records export (--tenant <id> | --all-tenants) --out <file.jsonl> [--since]
  [--until]`**: JSON Lines, one `{ "kind": "agboss.execution-record", "schema": 1, … }` per line,
  read from the stores without running anything; `records.tenant-required`, `records.not-kept`.

## Unreleased — flow-patterns as the zero-cost harness: an offline eval suite (#419 PR 4)

- `examples/flow-patterns` adds `desk-eval-suite` with a code eval judge, run offline on a new
  `offline` environment by `npm run eval:check` — `eval run` against a checked-in baseline with
  `--fail-on-regression`, `eval show --html`, `eval calibrate` on checked-in labels — and runs its
  tests with `isolate: false` (62 s → 24 s). The desk's offline `agboss run` now takes
  `--env offline`. [Example](Example#flow-patterns-a-review-loop-and-a-code-router).

## Unreleased — flow-patterns as the zero-cost harness: two applications over A2A (#419 PR 3)

- `examples/flow-patterns` serves the desk over A2A from `src/desk.application.ts` (`@A2AExpose`, a
  caller resolver) to a new `src/helpline/` consumer (`@A2AAgent`); its `npm run check` adds
  `agboss check --federation` on both applications and `agboss describe --json`, and its tests the
  `a2aServer` fixture. [Example](Example#flow-patterns-a-review-loop-and-a-code-router).

## Unreleased — OpenRouter host routing: pinned hosts and quantizations, `servedBy` (#395 PR 6)

- **Breaking — `allow_fallbacks` is `allowFallbacks`** ([Model providers](Model-providers#pinning-the-host-and-the-precision-395)):
  the TypeScript API of OpenRouter's routing is camelCase everywhere; only the request body stays
  snake_case. Migration: in `requestFields: { provider: { … } }` rename `allow_fallbacks` to
  `allowFallbacks` (a compile error until you do).
- **Added — `quantizations: Quantization[]`** (`Quantization.Bf16`, `Fp8`, …) beside `only`,
  `ignore`, `order`, `sort` and `allowFallbacks` in `OpenRouterRouting`.
- **Added — `UsageRecord.servedBy`**: the host that served each call, from OpenRouter's answer
  (plain or streamed).
- **Added — `agboss check --models` checks the pins** ([CLI](CLI#run-inspect-evaluate)): a pinned
  host or quantization no endpoint of a served model has is `[model.no-matching-endpoint]`.

## Unreleased — flow-patterns as the zero-cost harness: the operational contracts and every unit runner (#419 PR 2)

- `examples/flow-patterns/src/desk/` adds a code `@Judge` on `toolCalls`, a `@Rag` knowledge base,
  a `PiiPolicyHandler` detector, an observer, a `@HealthCheck` and `maxConcurrentSteps`; the tests
  now run all ten unit runners and `replyWithInvalidAnswer` → `AgentAnswerInvalidError`.
  [Example](Example#flow-patterns-a-review-loop-and-a-code-router).

## Unreleased — flow-patterns as the zero-cost harness: the extension points (#419 PR 1)

- `examples/flow-patterns` gains `src/desk/` — a custom compaction, input and output code
  guardrails, a tool interceptor (`allow` / `replyToModel` / `block`, `afterToolCall`) — on a
  transport `@ModelProvider` that answers by the request, an offline `src/desk.application.ts`, its
  own `OpenRouterProvider` narrowed to `moonshotai/…`, and its own `eslint.config.js` with
  `@agboss/core/eslint`; tests for the trajectory matchers, invalid arguments and the unit runners
  `testToolInterceptor`, `testCompaction`, `testGuardrail` and `testTool`. [Example](Example#flow-patterns-a-review-loop-and-a-code-router).

## Unreleased — the LangGraph migration guide in the project skills (#424)

- **`references/13-migrating-from-langgraph.md`** — a skill reference for coding agents that move a
  LangGraph graph to AGBoss: the read / write matrix (one state → narrow DTOs per producer, routing
  flags → output variants or routes, reducers → joins, counters → `maxVisits`), a one-to-one table
  from `StateGraph`, `addConditionalEdges`, `Command`, `Send`, `interrupt`, subgraphs and
  checkpointers to AGBoss primitives, a compiled "before → after" example and the move to `testWith`.
  Routed from `SKILL.md` and the `AGENTS.md` that `agboss create` writes; the project skills are now
  `SKILL.md` and 13 references (`skills: … (14 files)`). [CLI](CLI#project-skills-for-coding-agents-305).


## Unreleased — `agboss eval run --metamorphic`: rewordings call the same tools (#396 PR 7)

- **Added — `agboss eval run --metamorphic`** ([Eval suites](Eval-Suites#under-rewordings---metamorphic)):
  each case's `variants` (its last turn reworded) run too, each on a thread of its own, and the check
  `metamorphic` — after the other checks, under the cascade — passes when every variant calls the
  same set of tool classes as the case's last turn and meets its `tools.required` again. The
  artifact's optional `metamorphic: true` (read by `evalRunReportOf`); a case's `caseHash` covers its
  variants only with the flag.

## Unreleased — `agboss check --federation`: declared contracts compared across applications (#398 PR 4)

- **`agboss check --federation <snapshot…>`** — the application's consumed and exported contracts
  against its neighbours' `agboss describe --json` files (or folders of them), no network:
  `[federation.missing-target]`, `[federation.incompatible-schema]` (a structural comparison of the
  JSON Schemas, field by field) with each problem's blast radius, `[federation.snapshot-schema]`,
  `[federation.duplicate-application]`, `[federation.version-not-bumped]` (a warning; `--strict`
  makes it an error). [A2A § 8](A2A#8-the-federation-check-398-pr-4).
- `describe --json`: each `application.contracts.imports` MCP entry gets `usedBy` too (the tools of
  the application's agents that reach its server).
- `check --json`: a problem may carry `blastRadius` (`{ application, workflow, tool }[]`).


## Unreleased — declared contracts: `@A2AExpose`, a typed `@A2AAgent`, the contract price, the envelope's audience, `describe --json` contracts (#398 PR 3)

- **Breaking — `@A2AAgent({ name, url, target, input, output, price?, deps })` and a typed
  `execute(input)`** ([A2A](A2A#7-declared-contracts-398-pr-3)): `target: { application, start }`,
  `input` and `output` are required (`[a2a.target-required]`); the class `extends A2AClient<In, Out>`
  and `execute(input, call?)` replaces `execute(input, OutputDto, call?)` — the input is validated
  before it is sent, the output when it comes. Names: `-a2a-agent` on a `…A2AAgent` class
  (`[name.kind-suffix]`). Migration: move the output DTO from each `execute` call into the decorator
  with `target` and `input`, rename the class `…A2AAgent`; a client built by hand passes `contract:
  { target, input, output }` (`A2AContract`) — without one `execute` throws `[a2a.no-contract]`.
- **Breaking — `a2aHttpListener(app, { expose, callerResolver, meshVerifier?, base? })`**: `expose`
  (an `@A2AExpose` listed in `@Application({ exposes })`, else `[application.expose-unlisted]`)
  replaces `start`; `POST <base>/execute` takes `start?` (`400 a2a.unknown-start` for a start it does
  not export, or none with several), and the call chain is checked once the body is read. The same
  for `testWith`'s `a2aServer({ expose, callerResolver })`. Migration: `@A2AExpose({ name:
  "<app>-a2a-expose", version, exports: [Start] })`, list it in `exposes`, pass it as `expose`.
- **Added — `@A2AExpose({ name, version, exports })`** (mirrors `@McpExpose`) and
  **`@Application({ exposes })`** (`@A2AExpose` / `@McpExpose`): `[application.expose-unknown-start]`,
  `[application.not-an-expose]`, `[application.duplicate-expose]`, `[name.kind-suffix]`
  (`-a2a-expose`, `…A2AExpose`).
- **Added — the contract price**: the calling tool's spend records the larger of `price` and a
  trusted peer's verified report (the price alone without one), `a2a:<application>`.
- **Added — the envelope's `audience`**: `target.application` (MCP: the new `@McpServer({ target: {
  application, expose } })`); a receiver of another name refuses it before its resolver — `401
  mesh.audience-mismatch` / an MCP error result; the client's error message starts with the code.
- **Added — `agboss describe --json` `application.contracts`**: `exports` (`@A2AExpose` starts with
  their input and finishes' outputs, `@McpExpose` tools), `imports` (`@A2AAgent`s with `target`,
  `usedBy`, `price`; `@McpServer` tools with `target` or `null`), every DTO with its `schemaHash`, and
  `schemas` with their JSON Schema.


## Unreleased — `agboss eval run --chaos`: failures injected into model calls (#396 PR 6)

- **Added — `agboss eval run --chaos <rate> --chaos-seed <n> [--chaos-failures <list>]`**
  ([Eval suites](Eval-Suites#under-failures---chaos)): 429s, timeouts and truncated answers injected
  into the run's model calls at the provider's HTTP client and a transport's `complete()`, under the
  retry policy, the rate limit and the breaker, on the real budgets; seeded, the rate and the seed
  together (`usage.missing-option` / `usage.option-value`).
- **Added — in `@agboss/core/eval`:** `ChaosFailure { RateLimited, Timeout, TruncatedResponse }` and
  `EvalRunChaos`; the artifact's optional `chaos` (read by `evalRunReportOf`). The injection is an
  option of `eval run`'s internal build path only, never of `createApp`.

## Unreleased — labelling runs in `agboss eval ui`: tags, scores, κ recomputed (#397 PR 4)

- **Added — labels in `agboss eval ui`** ([Eval suites](Eval-Suites#labelling-runs-397-pr-4)): a
  form per judge verdict on each run's page — passed / failed, a 1–4 score, failure tags, a note —
  saved to `eval/labels/<suite>.jsonl` in #396 PR 4's format (the same run, judge and labeler
  replaced, the file written atomically), and the run's calibration (`calibrateJudges`) on every
  load. New options `--labels-dir`, `--taxonomy`, `--labeler`; the failure taxonomy
  `eval/failure-taxonomy.yaml`; new code `eval.taxonomy-invalid`.

## Unreleased — `agboss eval ui`: a folder of runs, read-only, on 127.0.0.1 (#397 PR 3)

- **Added — `agboss eval ui [--dir <folder>] [--port N]`** ([Eval suites](Eval-Suites#browsing-runs-agboss-eval-ui-397)):
  the run artifacts of a folder (default `.agboss/eval`) served read-only — the runs newest first with
  each case's attempt dots, each run's report page — on 127.0.0.1 only, behind a token it prints,
  the `Host` checked; `eval.no-runs` for a missing folder.
- **Changed — the run artifact is `schemaVersion` 3**: `profile`, `agbossVersion`, `models`
  (`EvalModelUse`) and `piiPolicies`, shown in the report's header; versions 1 and 2 are still read
  (`… this agboss reads 1 to 3`). `EvalRunOptions.profile` names the profile for the artifact.

## Unreleased — `compare` in both orders, `[judge.same-model-family]` (#396 PR 5)

- **Changed — `agboss compare` / `compareProfiles` judge each pair in both orders**
  ([Profiles and comparisons](Profiles-and-comparisons#compare)): two sure verdicts for one side are
  a win or a loss, anything else a tie; a verdict for the same position both times is counted in
  `PairwiseResult.positionFlips` (new, required) and the table's `flips`. The A/B order is no
  longer randomised (the `random` argument of the internal `pairwise` is gone); each task costs two
  pairwise calls.
- **Breaking — `compareProfiles(Workflow, options)` → `compareProfiles(Application, { start, … })`**
  ([Testing suites and comparisons](Testing-Suites-And-Comparisons#from-code--compareprofiles)): the
  workflow a start of the application opens, assembled as `createApp` assembles it. Migration: pass
  the application and `start: <its start>`.
- **Added — the warning `[judge.same-model-family]`**
  ([Judges](Judges-And-Quality-Gates#judgesame-model-family)): a model judge of the judged agent's
  vendor (the slug's prefix), or a suite's judge of the vendor of an agent of its start's workflow;
  an error under `agboss check --strict`.
- **Fixed — the eval judge's prompts say "answer"** (`agboss eval score`, `compare`), not
  "replyWith".

## Unreleased — MCP dedupe by `_meta.callId`, origin on resume legs (#398 PR 2b)

- **Added — trusted MCP calls are deduplicated** ([MCP](Mcp#4-calls-between-agboss-applications--_meta-398)):
  a `tools/call` trusted by the session's `peer` with a `_meta.callId` runs once per
  `(tenant, peer, callId)` in `MeshRequestRepository` — a repeat gets the kept result, one in flight
  an error result with `_meta["agboss.dev/error"]` `mesh.request-in-progress`.
- **Fixed — `origin` on every leg**: a trusted request's execution events carry its `origin` on a
  resume and a recovery too (read from the checkpointed contexts), not only on its first leg.

## Unreleased — the run's timeline: traces in the artifact, the baseline diff, where attempts part ways (#397 PR 2)

- **Changed — the run artifact is `schemaVersion` 2** ([Eval suites](Eval-Suites#a-runs-trace-schemaversion-2-397)):
  each run keeps its last turn's `trace` (`EvalExecutionTrace` — steps with `inputHash`, model calls,
  tool calls, guardrail decisions, judge verdicts; handled errors, pauses, undo actions, children,
  the output — masked like the execution record) and each case its `expectation`
  (`EvalCaseExpectation`). The one reader (`evalRunReportOf`) reads versions 1 and 2; version 3 or
  any other is `eval.run-invalid` (`… this agboss reads 1 to 2`). New public types in `@agboss/core/eval`:
  `EvalExecutionTrace`, `EvalChildTrace`, `EvalStepTrace`, `EvalModelCallTrace`, `EvalToolCallTrace`,
  `EvalGuardrailDecisionTrace`, `EvalJudgeVerdictTrace`, `EvalHandledErrorTrace`, `EvalPauseTrace`,
  `EvalCompensationTrace`, `EvalTraceError`, `EvalCaseExpectation`, `EvalExpectedToolCallTrace`,
  `EvalRunSchemaVersion`.
- **Added — the HTML report shows each run's timeline**, each case's expectation, the comparison
  with a baseline (a run made with `--baseline`), and for an unstable case the node where its
  attempts part ways (`attemptDivergenceOf`, `AttemptDivergenceReason`); one value is cut at 2,000
  characters on the page. A page above 16 MB leaves out the timelines of cases with pass^k, then
  all, before `eval.report-too-large` (now only for a page too large without any timeline).

## Unreleased — mesh trust: signed envelopes, origin, the caller's budget and deadline, run reports, dedupe, `/cancel` (#398 PR 2)

- **Added — `@Application({ mesh: { signingKey?, peers?, idempotencyRetention? } })`**
  ([A2A](A2A#trusted-peers--signed-envelopes-398-pr-2)): `MeshOptions` / `MeshPeer` — the field of
  the application's Ed25519 private key (a `Secret`, PKCS #8 PEM) and each peer's public key field
  (text, SPKI PEM). Envelopes and run reports are signed (JWS `EdDSA`) with `issuedAt`, `expiresIn`,
  `bodyHash`, and the caller's `budget` / `deadline` claims; `origin.step.tool`. New rules
  `[mesh.signing-key-missing]`, `[mesh.unknown-peer-key]`, `[mesh.duplicate-peer]`; at start
  `[mesh.invalid-key]`. `maxMeshHops` is unchanged (flat).
- **Added — trusted peers**: `A2ACaller.peer?` (`A2APeer`) — the peer a resolver authenticated; a
  request is trusted when its envelope carries that peer's valid signature. Before the resolver the
  listener refuses a bad signature or an expired envelope (`401 mesh.signature-invalid` /
  `mesh.envelope-expired`), after it a body that is not the signed one (`401 mesh.body-mismatch`).
  `a2aHttpListener(app, { meshVerifier })` — a `MeshVerifier` (`verifyKeyOf(issuer)`) for peers'
  keys. MCP: `McpSessionOptions.peer`.
- **Added — what a trusted request gets**: the caller's remaining budget as the execution budget
  `caller-budget` (the receiver only lowers its own), its deadline, and its origin —
  `executionContext.origin`, `ExecutionRecord.origin`, `ExecutionEvent.origin` (`ExecutionOrigin`).
- **Added — `app.execute(…, { deadline })`** and `DeadlineExceededError` (`limit.deadline`:
  `deadline`, `deadlineAt`; a `LimitExceededError`): checked before every step and model call.
- **Added — run reports**: a trusted answer's `report` (A2A) / `_meta["agboss.dev/report"]` (MCP),
  a signed `MeshRunReport` (`MeshSpendReport`); the caller verifies it and records the spend
  (`a2a:<issuer>` / `mcp:<issuer>`) and `ToolCallRecord.remote` (`ToolCallRemote`). The
  `A2AExecutionResponse` gains `executionId` and `spend`.
- **Added — `MeshRequestRepository`** (infrastructure, in memory; `SqliteMeshRequestRepository`,
  table `mesh_requests`; `MeshRequestKey`, `MeshRequestRecord`): trusted `POST /execute` requests
  deduplicated by `(tenant, peer, idempotencyKey)` — a repeat gets the kept answer, one in flight
  `409 mesh.request-in-progress`; removed after `idempotencyRetention` (default 30 min) by the
  recovery sweep; pinged by readiness.
- **Added — `POST <base>/cancel { threadId }`** (`A2ARoute.Cancel`) and `A2AClient.cancel(threadId)`.
- **Changed — an invalid streaming body**: `400` JSON, as for a non-streaming one (it was an SSE
  failure event).

## Unreleased — `agboss eval calibrate`: a judge against people's labels (#396 PR 4)

- **Added — `agboss eval calibrate --report <run.json> [--labels <labels.jsonl>]`**
  ([Eval suites](Eval-Suites#calibrating-a-judge-agboss-eval-calibrate)): a saved run's judges against
  people's labels (`eval/labels/<suite>.jsonl` by default, one `EvalLabel` per line: `runId`,
  `executionId`, `judge`, `labeler`, `passed`, `score?`, `failureTags`, `note?`) — pairwise Cohen's κ
  (the judge with each labeler, the labelers with each other), a confusion matrix per labeler, the
  disagreements, and the rubric by the judge's `metrics` keys; runs nothing.
- **Added — public types in `@agboss/core/eval`:** `EvalLabel`, `EvalCalibration`, `EvalJudgeCalibration`,
  `EvalRaterAgreement`, `EvalConfusionMatrix`, `EvalDisagreement`, `EvalMetricGroup`,
  `EvalMetricValue`, `EvalScoreCounts`.
- **Added — codes** `eval.labels-not-found`, `eval.labels-invalid` (exit 2).

## Unreleased — `agboss eval run --baseline`: regressions per case, exit 5 (#396 PR 3)

- **Added — `--baseline <run.json> [--fail-on-regression]`** ([Eval suites](Eval-Suites#against-a-baseline-baseline-runjson)):
  each case against the same case of a run artifact (a run of `main`) — `CaseComparison {
  Regressed, Improved, Unchanged, FlakyOnBaseline, New, Removed, Changed }`; a changed `caseHash` is
  not compared, a case that flapped on the baseline is quarantined. The table and the counts, the
  artifact's `baseline` (`EvalRunComparison`). A baseline that is no run artifact of the suite is
  `eval.run-invalid` (no file: `eval.run-not-found`), exit 2 — read by the same one reader as
  `eval show` (#397 S4).
- **Added — exit 5 (`quality`)**: `--fail-on-regression` fails with `eval.regressed` when a case stable
  on the baseline regressed ([CLI](CLI#agboss-eval-subcommands-396)).
- **Added — the artifact's types are public** in `@agboss/core/eval`: `EvalRunReport`, `EvalCaseReport`,
  `EvalRunResult`, `EvalCheckResult`, `EvalRunError`, `EvalRunSummary`, `EvalRunComponent`,
  `EvalRunSpend`, `EVAL_RUN_KIND`, `EVAL_RUN_SCHEMA_VERSION`, `CaseComparison`, `EvalRunComparison`,
  `EvalCaseComparison`, `EvalCasePasses` (no longer in `@agboss/core/internal`).
- **Added — `agboss eval run --profile <name>`**: the suite on a profile of its workflow.
- **Changed — a case's history is `ExecutionRecordStatus.Written`** (new member): turns of their
  thread, read by its memory as before, but never scored by `agboss eval score` nor saved by
  `agboss golden add` (before, they were recorded as `answered`).

## Unreleased — join keys for every model component (#395 PR 5b)

- **Added — `modelComponents` in `agboss describe --json`** ([CLI](CLI#describe-268)): model judges
  (`schemaHash` of their `reply`), guardrails, arbiters, compactions that write summaries, model
  reply interpreters and model PII detection, each a `ComponentRecord` with its `promptHash` /
  `schemaHash`; `ComponentKind` gains `Compaction`, `ReplyInterpreter` and `PiiPolicy`.
- **Changed — stale cassettes cover them** ([Testing](Testing#stale-cassettes-395)): a recording of
  any of them whose hashes changed is `StaleCassetteError` / `[vcr.stale-cassette]`, re-recorded by
  `AGBOSS_VCR_MODE=RECORD_STALE npm test`.

## Unreleased — a self-contained HTML report: `eval run --html` and `eval show` (#397 PR 1)

- **Added — `agboss eval run … --html <file>`** ([Eval suites](Eval-Suites#the-html-report---html-and-agboss-eval-show-397)):
  the run as one self-contained HTML page — header, summary (pass@k, pass^k, cases, attempts,
  spend), unstable cases, every case with an attempt dot per run (passed, failed, error, limit) and
  each run's checks — no external request (a `Content-Security-Policy` of its own style and script),
  light and dark, phone width, keyboard; bounded at 16 MB (`eval.report-too-large`).
- **Added — `agboss eval show <run.json> [--html <file>]`**: a saved run artifact read back — its
  table, and the same page — without running anything; `eval.run-not-found`, `eval.run-invalid` for
  a file that is not an artifact this version reads.

## Unreleased — `agboss eval run`: suites, k runs, pass@k / pass^k, the cascade (#396 PR 2)

- **Breaking — `agboss eval` is made of subcommands** ([CLI](CLI#agboss-eval-subcommands-396)):
  today's scoring of recorded runs is `agboss eval score` (the same options); the bare `agboss eval`
  prints its subcommands and exits 2 (`usage.missing-argument`). Migration: add `score` after
  `eval` — `agboss eval score --start …` (job-scout's `npm run eval` does it).
- **Added — `agboss eval run [--suite <name>] [--runs <k>] [--report <run.json>] [--env <name>]`**
  ([Eval suites](Eval-Suites#running-a-suite-agboss-eval-run)): the application built as
  `createApp` builds it, an `@EvalSuite` assembled on it, each case run k times — its history
  written into its thread, its turns run with the case's tenant and execution values, the trajectory
  check over `result.toolCalls`, judges in the frame of the case's last execution, the cascade —
  pass@k / pass^k per case, `unstable` for pass@k without pass^k; the run artifact (`kind:
  "agboss.eval-run"`, `schemaVersion: 1`) with `--report`, the envelope's `result` with `--json`. A
  run ending at a finish its judge does not judge fails that check. New code `eval.unknown-suite`.
- **Added — `agboss check` checks eval suites** (Loop 0): every `eval-suites/*.eval-suite.ts` of the
  application assembled, its problems on its file, `eval-suites` in the checks.
- **Fixed — the generated types' context blocks are sorted**: two applications that declare their
  own contexts no longer make `.agboss/types.d.ts` depend on the order of the workflows.

## Unreleased — `testCompaction` (#395 PR 5)

- **Added — `testCompaction(Compaction, options?)`** ([Testing](Testing#unit-runners--one-component-on-its-own)):
  the tenth unit runner — a `CompactionRunner` that compacts one `CompactionInput`
  (`previousSummaries`, `turnsToCompact`) and gives a `CompactionResult` (`summaries`, `requests`:
  `CompactionRequest { instructions, input }` per model call) for `SummaryQueue` and `SingleSummary`
  on a scripted model, and for `CompactionStrategy.Custom` (#382) on its own container. It checks the
  request and the plumbing; survival of facts is an eval case.

## Unreleased — the mesh envelope: call chains, hop limits and loop detection (#398 PR 1)

- **Added — the mesh envelope** ([A2A](A2A#6-the-mesh--call-chains-hops-and-loops-398),
  [MCP](Mcp#4-calls-between-agboss-applications--_meta-398)): every `A2AClient` call made inside an
  execution sends `agboss-mesh` (`MeshEnvelope`: `schema`, `issuer`, `origin` — `MeshOrigin`,
  `MeshOriginStep` —, `callChain` of `MeshHop` / `MeshEntry`; an unsecured JWS, ids only) and a W3C
  `traceparent`; an `@McpServer` call sends `_meta.callId` (the step's idempotency key — before, the
  MCP client sent no `_meta` at all), `_meta["agboss.dev/mesh"]` and `_meta.traceparent`. Outside an
  execution, nothing.
- **Added — `A2ACallerRequest.envelope?`**: the envelope as the listener read it, a claim (not
  verified: never the tenant, a budget or a deadline); a malformed one is ignored.
- **Added — loops and hops refused before they run**: a request whose chain already lists the
  receiver's `(application, start)` → `409` / an MCP error result `limit.mesh-loop`; one whose chain
  already lists `@Application({ maxMeshHops })` applications (new, default 8,
  `[limits.max-mesh-hops-invalid]`) → `limit.hops`. New errors `MeshLoopDetectedError`
  (`entry`, `chain`) and `HopsLimitExceededError` (`entry`, `chain`, `maxMeshHops`, `hops`), both
  `LimitExceededError`s (`MeshLimitPlace` for their constructors); thrown by the client, and a tool
  that meets one fails its step with it — never an error result for the model.
- **Added — `A2AExecutionResponse.code` / `.details`**: a failed or limited run's error code (every
  `AGBossError`), and for the two mesh limits their facts, so the caller fails the same way.

## Unreleased — stale cassettes: cassette v2, `RECORD_STALE`, `check --cassettes` (#395 PR 4)

- **Added — cassette version 2 and `StaleCassetteError`** ([Testing](Testing#stale-cassettes-395)):
  every recorded call keeps its component and that component's `promptHash` / `schemaHash`; a replay
  of an agent or model router that changed since is `StaleCassetteError` (`vcr.stale-cassette`,
  `component`, `changes: CassetteChange[]`). Version 1 cassettes keep replaying, without stale
  detection, with a hint.
- **Added — `VCRMode.RECORD_STALE` and `AGBOSS_VCR_MODE`**: re-records only the stale components'
  calls; `AGBOSS_VCR_MODE=<member>` overrides every test's own mode (an unknown value fails the test
  naming the modes).
- **Added — `agboss check --cassettes`** ([CLI](CLI#run-inspect-evaluate)): the same verdict without a test.

## Unreleased — the model's invalid turns, scripted (#395 PR 3)

- **Added — `callToolWithInvalidArguments(Tool, args)`, `callToolWithTruncatedArguments(Tool,
  partialArgs)`, `replyWithInvalidAnswer(Dto, fields)`** ([Testing](Testing#scripted-models)): a
  validation retry is tested without a cast — an invalid or a cut tool call (recorded
  `ToolCallStatus.InvalidArguments`, counted in `step.validationAttempts`, the tool never runs) and
  an answer that does not fit its class (the third fails the step with `AgentAnswerInvalidError`).
  Replace `replyWith(Dto, { … } as never)` with `replyWithInvalidAnswer(Dto, { … })`.

## Unreleased — trajectory matchers on a run result (#395 PR 2)

- **Breaking — `mockLlm(X).toHaveCalledTools([…])` is `toHaveScriptedToolCalls([…])`**
  ([Testing](Testing#matchers)): the script matcher (the model's calls, exactly, in order) is
  renamed — replace the name in a test; `toHaveCalledTools` now asserts a run result.
- **Added — `expect(result).toHaveCalledTools([A, B])`** ([Testing](Testing#asserting-the-tool-calls)):
  each tool called at least once by the root execution's agents, in any order, whatever its
  status; `.not.toHaveCalledTools([…])` — none of them was.
- **Added — `expect(result).toHaveToolCallMatching(Tool, partialOrCheck)`**: some call of the tool
  has an input matching a deep partial or a check (`ToolCallExpectation<TInput>`, typed by the tool's
  input); `.not` — none does. `ToolCallMatchers` / `toolCallMatchers` in `@agboss/core/testing`.

## Unreleased — trajectories of failed visits, children's steps, unknown tools (#395 PR 1b)

- **Changed — a failed visit keeps its records** ([Observability](Observability#tool-calls-and-steps)):
  the tool calls, judge verdicts and guardrail decisions of an agent whose step fails
  (`QualityGateError`, `ToolBlockedError`, `GuardrailBlockedError`, a limit, any error) are in
  `result.toolCalls`, `record.toolCalls` and its `record.steps` entry when a side path takes the
  failure, in a failed branch's too, and in the `ChildExecutionRecord` of a child the failure ends.
- **Added — `ChildExecutionRecord.steps`**: each child's own `ExecutionStepRecord`s.
- **Added — `ToolCallStatus.UnknownTool`**: a call to a tool the agent does not have is recorded.

## Unreleased — a lazily created transport provider runs its lifecycle hooks (#385 S4)

- **Changed — transport providers' lifecycle** ([Model providers](Model-providers#a-custom-transport-completerequest-385)):
  created on its first call, a transport's `onInit` → `onStart` run, awaited, before that call's
  `complete()` — once under concurrent first calls; a failing hook fails that call with the start's
  error (`[di.hook-failed] X.onStart failed: …`) and the next call tries again; `app.close()` runs
  `onStop` / `onDestroy` for the transports that were created, none for the others. Before, a
  transport created on a call got no `onInit` / `onStart`.

## Unreleased — a2aHttpListener resolves each request's caller and tenant (#387)

- **Breaking — `a2aHttpListener(app, { start, callerResolver, base? })`** ([A2A](A2A)): built from
  the application (`A2AApp`: `createApp`'s or `testWith`'s `app`), not from an adapter; the
  positional form `a2aHttpListener(adapter, Start, base)` is removed. `callerResolver` is required —
  there is no default tenant: a single-tenant host returns `A2ACallerResolution.resolved({})`.
  Migration: `a2aHttpListener(new A2AAdapter(app), Start, "/a2a")` →
  `a2aHttpListener(app, { start: Start, callerResolver: MyCallerResolver, base: "/a2a" })`, with
  `MyCallerResolver` an `@Injectable` listed in `providers`.
- **Breaking — `thread` → `threadId`** on the wire (the request body, the response) and in the
  client: `A2AExecutionRequest.threadId`, `A2AExecutionResponse.threadId`, `A2AClientCall.threadId`,
  `A2ARequestSchema` / `A2AResponseSchema` (one field name per meaning: `app.execute`'s `threadId`).
- **Breaking — `IA2AAdapter.cancel(threadId, caller)`** (`A2ACallOptions`): cancels the caller's
  tenant's thread only; `cancel(thread)` is removed. `A2AAdapter` takes an `A2AApp`.
- **Added — the caller resolver**: `A2ACallerResolver<typeof Start>` (`resolveCaller({ route, http
  })`, `A2ACallerRequest`, `A2ARoute`), answered by `A2ACallerResolution.resolved(caller)` /
  `.unauthenticated({ reason, challenge? })` / `.forbidden({ reason })` (branded,
  `A2ACallerResolutionKind`, `ResolvedA2ACallerResolution`, `RejectedA2ACallerResolution`,
  `A2ACallerUnauthenticatedOptions`, `A2ACallerForbiddenOptions`); `A2ACaller<typeof Start>` is
  typed by the start's application. The resolver is an `@Injectable` in `@Application({ providers
  })` or a `@Workflow({ providers })`, taken from the container — not listed →
  `[a2a.caller-resolver-not-listed]` when the listener is built. Resolved before the body is read
  or a header written: `401` (+ `WWW-Authenticate`), `403`, `500` (`a2a.caller-unauthenticated`,
  `a2a.caller-forbidden`, `a2a.caller-resolution-failed`, body `{ code, error }`); a refusal runs
  nothing — no observer event, no record.
- **Added — `A2ACallerRejectedError`** (`a2a.caller-rejected`; `httpStatus`, the wire `code`):
  `A2AClient.send` on a `401` / `403` carrying an `a2a.caller-*` code.
- **Added — `testWith`'s `a2aServer({ start, callerResolver, base? })`** → `{ url }`
  (`A2AServerFixture`, `A2ATestServer`): the listener on `127.0.0.1:0`, the loopback open for the
  test, closed at its end; `TestApp.resolve(Class)` once the app is built (`test.app-not-ready`
  before).
- **Changed — `@Application({ providers })`** documents that ordinary `@Injectable` services may be
  listed there too (they always could be: one instance for every workflow).

## Unreleased — tool-call trajectories on results, records and `JudgeInput` (#395 PR 1)

- **Added — `result.toolCalls`, `result.record.toolCalls`, `ChildExecutionRecord.toolCalls`**
  ([Observability](Observability#tool-calls-and-steps)): one `ToolCallRecord` per tool call, in call
  order — `step` (the tool as its `component`, with `promptHash` / `schemaHash`; the agent's visit),
  `input`, `output`, `status: ToolCallStatus` (`Succeeded`, `Failed`, `InvalidArguments`,
  `Declined`, `TimedOut`; a tool interceptor's `Replied` and `Blocked`, #384), `error?`, `isResultTruncated`, `startedAt`, `endedAt`. The result's are
  real values, the record's masked. `toolCallsOf(Tool, toolCalls)` → `TypedToolCall` (one tool's
  calls, typed once narrowed by `status`: `SucceededToolCall`, `FailedToolCall`, `UncheckedToolCall`).
- **Added — `result.record.steps`**: one `ExecutionStepRecord` per visit — `step`, `inputHash`,
  `judgeVerdicts` (`JudgeVerdictRecord`), `guardrailDecisions` (`GuardrailDecisionRecord`), `spend`,
  `startedAt`, `endedAt`, `error?`.
- **Added — `JudgeInput.toolCalls`** ([Judges](Judges-And-Quality-Gates#a-judge-that-reads-the-tool-calls)):
  the visit's calls, every attempt's, real values; `JudgeInput<T>` is now `JudgedReply<T> & {
  toolCalls }`. `testJudge` takes `toolCalls` optionally (`[]`). A hand-made `JudgeInput` (calling
  `judge()` directly) needs `toolCalls`.
- **Fixed — a truncated tool call is no silent empty reply**: a call whose arguments are no JSON
  (the provider's `invalid_tool_calls`) is an `InvalidArguments` call the model reads about, counted
  in `validationAttempts` and in `maxToolCalls`; a truncated answer is an invalid answer (no more
  "answer with a tool, not with text").
- **Changed** — the agent loop's prompt texts gained the invalid-arguments message, so every
  agent's prompt version changes once.

## Unreleased — a custom transport for `@ModelProvider`: `ModelProviderHandler.complete(request)` (#385)

- **Added — transport providers** ([Model providers](Model-providers#a-custom-transport-completerequest-385)):
  a `@ModelProvider` class that `implements ModelProviderHandler` with `complete(request)` — no
  `baseUrl` / `apiKey`, its services through `deps`, created by the application's container on its
  first call (one instance, `TenantContext` read in the calling execution). New public names in
  `@agboss/core/models`: `ModelProviderRequest`, `ModelProviderResponse`, `ModelProviderMessage`,
  `ModelProviderMessageRole`, `ModelProviderToolDefinition`, `ModelProviderToolCall`,
  `ModelProviderUsage`, `ModelProviderFailureError` (`model.provider-failure`,
  `ModelProviderFailureOptions`: `retryAfter?`, `cause?`), `FinishReason`; `complete?` on
  `ModelProviderHandler`; `deps` on `@ModelProvider`; the rule `[model-provider.both-modes]`. Every
  policy of the gateway runs around it; `agboss describe` prints `transport: X.complete()`; part of
  `configHash` (only where there is one).
- **Changed — `ModelProviderHandler.capabilities` is optional** (required of an HTTP provider by the
  decorator's overload; a transport without it is not checked against its models).
- **Changed — `ModelProviderOptions`** is the union of the HTTP options and the transport options
  (`baseUrl` / `baseUrlField` / `apiKey` vs `deps`); `ModelProviderType` takes constructor
  arguments. Code that spreads one provider's options into another's decorator narrows them first.
- **Changed — a breaker's fallback is at the chat model**: while the primary's breaker is open the
  call goes to the fallback provider's own chat model (its own wire form, not the primary's request
  re-addressed), so HTTP and transport providers fall back to each other. Accounting is unchanged —
  the fallback's model, its prices.
## Unreleased — tool interceptors: `@ToolInterceptor` + `BeforeToolCall` / `AfterToolCall` (#384)

- **Added — `@ToolInterceptor`** ([Tools](Tools#tool-interceptors)): a class that implements
  `BeforeToolCall` (`beforeToolCall(call: ToolCallContext)` → `ToolCallDecision.allow()` /
  `.replyToModel({ message })` / `.block({ reason })`) and / or `AfterToolCall`
  (`afterToolCall(call: ToolCallResultContext)` → the result the model reads), listed in
  `toolInterceptors` of `@Application` → `@Workflow` → `@Agent` → `@Tool` / `@McpTool` (outer first),
  removed with `excludeToolInterceptors` on an agent or a tool. `replyToModel` answers the model
  without calling the tool; `block` fails the step with the new `ToolBlockedError`
  (`step.tool-blocked`, a `StepFailedError`); a throwing interceptor fails it with
  `AgentFailedError` (its error the `cause`). `beforeToolCall` reads the arguments PII-revealed; the
  result after `afterToolCall` is validated, cut at `maxResultSize`, then masked. Rule codes
  `[tool-interceptor.not-an-interceptor]`, `[tool-interceptor.exclude-not-inherited]`,
  `[tool-interceptor.missing-handler]`; `agboss describe` prints `tool interceptors`, `describe
  --json` each agent's chains, `configHash` covers them (a workflow without one keeps its hash);
  `testToolInterceptor` in `@agboss/core/testing`. Replaces the tool hooks removed in #120 S123.
- **Changed (internal)** — the framework's own per-call tool context is `ToolInvocationContext` now;
  `ToolCallContext` is the interceptor's (root entry).


## Unreleased — `@agboss/core/eval`: `@EvalSuite` and code judges (#396 PR 1)

- **Added — the entry `@agboss/core/eval`** ([Eval suites](Eval-Suites)): `@EvalSuite({ name, description,
  start, checks, cascade, cases })` in `eval-suites/<name>.eval-suite.ts` (`-eval-suite`), the case
  builders `evalCase`, `turn`, `pastTurn`, `toolCall`, `toolInvariant`, the checks
  `checkTrajectory()` and `judgedBy(Judge)`, the enums `EvalCascade { StopAtFirstFailure, RunAll }`
  and `CheckStatus { Passed, Failed, Skipped }`; types `EvalSuiteOptions`, `EvalSuiteMeta`,
  `EvalCase`, `EvalCaseOf`, `EvalTurn`, `EvalPastTurn`, `EvalValueOf`, `EvalCheck`,
  `TrajectoryEvalCheck`, `JudgeEvalCheck`, `EvalToolExpectations`, `ExpectedToolCall`,
  `ToolArgumentsOf`, `ToolInvariant`. Declarations only — nothing runs at import; the runner comes
  with PR 2. Assembly rules `[eval.unknown-start]`, `[eval.duplicate-case]`,
  `[eval.judge-wrong-reply]`, `[name.kind-suffix]`; case values → `EvalCaseInvalidError`
  (`eval.case-invalid`, root entry, with `EvalCaseIssue`).
- **Added — code judges** ([Judges](Judges-And-Quality-Gates#a-code-judge--decidedby-decidedbycode-396)):
  `@Judge({ decidedBy: DecidedBy.Code })` decides by `judge(input)` alone — no model, no cost — in
  an agent's quality gate and in an eval suite; `model` does not compile on it,
  `[judge.model-on-code-judge]` for a `model` or an injected `JudgeModel`; `testJudge` runs it
  without a `model` script. `decidedBy` is optional (`DecidedBy.Model` by default); new types
  `ModelJudgeMeta`, `CodeJudgeMeta`.
- **Changed — `JudgeMeta` and `JudgeOptions`** are unions discriminated by `decidedBy` (`JudgeOptions`
  is now a type alias, no longer an interface): code that reads `meta.model` narrows first.
## Unreleased — agboss/no-component-state knows every component decorator (#402)

- **Fixed — `agboss/no-component-state` missed components** ([Components](Components)): `this.x = …`
  outside the constructor is now reported for `@InputGuardrail` / `@OutputGuardrail`, `@Budget`,
  `@Arbiter`, `@ReplyInterpreter`, `@Compaction` and `@ModelProvider` too; the stale `Guardrail`
  name is gone. The decorators come from one list of the framework
  (`src/components/component-decorators.ts`), and a test fails when a class decorator a public
  entry exports is neither listed nor named as not a component — a new decorator cannot be
  forgotten. A project whose components kept state there now gets lint errors for it.

## Unreleased — agboss create ships a working ESLint config (#388)

- **Added — lint in a new project** ([CLI](CLI#create-and-generate-angular-like)): `agboss create`
  writes `eslint.config.js` and the `lint` script (`eslint .`, also in `npm run check`) with its dev
  dependencies — `typescript-eslint` (`strictTypeChecked`), `agboss/no-component-state` and
  `agboss/no-direct-time` on `src/` outside the tests, `@stylistic/newline-per-chained-call` on
  every `*.workflow.ts`; the project passes it as written.
- **Added — the entry `@agboss/core/eslint`** (#388 S2): `agbossPlugin` (`agboss/no-component-state`,
  `agboss/no-direct-time`) and `FLOW_CHAIN_RULE` for a project's ESLint config; the repository's
  own config uses it too (lint runs on the build). `@typescript-eslint/utils` is a new optional peer
  of `agboss`, needed only by this entry.
- **Changed — `agboss/no-direct-time`'s message** no longer says "framework code":
  `` `Date.now` reads the time directly: inject the application's Clock … ``.

## Unreleased — `RuleCode` holds only the codes a rule reports (#386)

- **Breaking — ten `RuleCode` members are removed**: `graph.two-next-steps`,
  `graph.router-not-last-in-chain`, `graph.cycle-without-router`, `graph.duplicate-node`,
  `router.self-without-agent-before`, `router.empty-route-text`, `router.unbounded-cycle` (the
  transition DSL before #272) and `batch.invalid-batch-size`, `batch.invalid-concurrency-limit`,
  `batch.strategy-not-decorated` (`batchParallel`, removed). No rule reported them; a project that
  names one (a `switch` over `RuleCode`, a test expecting it) no longer compiles — the codes that
  replaced them are `[graph.duplicate-node-name]`, `[router.no-prompt]` and
  `[graph.cycle-without-max-visits]`. The skill's error catalog (reference 11) drops its "reserved"
  entries; a test checks every `RuleCode` member is reported by some rule.

## Unreleased — a custom compaction strategy: `CompactionStrategy.Custom` + `CompactionHandler` (#382)

- **Added — `CompactionStrategy.Custom`**
  ([Memory management](Memory-Management#a-custom-compaction-compactionstrategycustom-382)): a
  `@Compaction` class that `implements CompactionHandler` — `compact({ previousSummaries,
  turnsToCompact })` (`CompactionInput`, each turn a `CompactionTurn`: `startName`, `input`,
  `finishName`, `output`) returns the summaries readers see from now on; `deps` injected by the
  container, run in the frame of the execution's start. Counted, run lazily, PII-masked and stored
  like the built-in strategies; `[compaction.missing-handler]`; `agboss describe` prints `strategy:
  custom (X.compact())`, the class is part of `configHash`.
- **Changed — `CompactionError.summaryMaxTokens`** is `SummaryMaxTokens | undefined`: `undefined`
  for a custom compaction.

## Unreleased — code guardrails: `decidedBy: DecidedBy.Code` + `GuardrailHandler` (#383)

- **Added — guardrails decided by code** ([Guards](Guards#decided-by-code)): `@InputGuardrail` /
  `@OutputGuardrail({ decidedBy: DecidedBy.Code })` — the class's `check(text)` (`implements
  GuardrailHandler`) returns `GuardrailVerdict.passed()` / `.blocked()` on the masked text; no
  model call, cost 0; the same refusal (text or `refusal()`), `GuardrailBlockedError` (`probability`
  1, `threshold` 1), levels, `excludeGuardrails`, events and `testGuardrail`; a throwing `check`
  fails closed (`GuardFailedError`, its error as `cause`); `[guardrail.missing-handler]`; `agboss
  describe` prints `decidedBy: code`. `decidedBy` is optional, `DecidedBy.Model` by default: every
  existing guardrail compiles and hashes as before. New public types `CodeGuardrailTextOptions`,
  `CodeGuardrailComputedOptions`; `GuardFailedError` takes an optional `cause`.

## Unreleased — the agboss skill: references 02, 06, 08, 09, 11, 12 and compensation (#305 PR 3)

- **Added — the rest of the coding-agent skill** in `packages/agboss/skills/agboss/references/`: 02
  (every flow form, with the rule codes each can hit, compensation on side paths and the automatic
  undo), 06 (budgets, model providers, retry, rate limits, tenant-fair queues, circuit breakers with
  a fallback), 08 (results, records, observers, the log, Langfuse), 09 (stores, several instances,
  health probes, the graceful stop, Kubernetes, deploys by config hash), 11 (every CLI command, its
  exit codes and JSON envelope, Studio as it is, and the full catalog — every `RuleCode` and the
  application warnings with a before → after fix; `check:docs` now checks the catalog is complete)
  and 12 (four multi-file recipes that compile and whose tests pass); compensation added to 03
  (`compensateWith`, `committedBy`, `compensationTimeout`, the hooks) and 10 (`toHaveCompensated`,
  `result.compensations`).

## Unreleased — an interrupted undo is finished by recovery; the record after the undo (#340 PR 4)

- **Added — durable automatic undo**
  ([Several instances](Several-instances#an-undo-interrupted-mid-way)): the reserved tree keys
  `@agboss/unwinding` (`{ reason, cause }`), `@agboss/unwinding:<childExecutionId>` and
  `@agboss/compensated/<compensationKey>`; an undo interrupted by a stop, a crash or a lost lease is
  finished by the instance that takes the tree over — recovery before its compatibility check, a
  resume at its lease take — the undos marked done skipped, then the tree ends failed with the
  recorded reason, without a pass (`compensation.recovered` in the log); a child re-entered mid-undo
  finishes its own before any step.
- **Changed — the root's record is written after its undo**
  ([Rollback](Rollback#an-execution-that-ends-without-a-finish)): `running` while the undo runs, then
  failed with the final error — `CompensationFailedError` when an undo failed (before, the record
  kept the original error).
- **Changed — `app.cancel` rejects with `CompensationFailedError`** when it ran the undo itself (a
  paused tree, or a paused tree of another instance's request) and an undo failed — the others ran,
  the tree is cancelled ([Cancellation](Saga-And-Cancellation#global-cancellation)); before, it
  returned `{ cancelled: true }`. **Breaking** for a caller that expected the cancel to resolve.

## Unreleased — project skills for coding agents, shipped with agboss (#305 PR 1)

- **Added — `skills/agboss/` in the `agboss` package** (`SKILL.md` and 12 references; 02, 06,
  08, 09, 11 and 12 stubs until #305 PR 3) — [CLI → Project skills](CLI#project-skills-for-coding-agents-305),
  [ADR-0021](ADR-0021-Project-skills-shipped-with-the-framework).
- **Added — `agboss create` writes `AGENTS.md`, a one-line `CLAUDE.md` and `.claude/skills/agboss/`**
  (with `.agboss-skills.json`), and `.claude/skills/agboss/` in the generated `.gitignore`.
- **Added — `agboss check` and `agboss generate` sync the skills folder** with the installed
  `agboss` (`skills: … installed | updated | repaired`), warnings `[skills.local-edit]`,
  `[skills.unmanaged-file]`, `[skills.sync-failed]`, `[skills.no-framework]` — never a changed exit
  code; `--json` has `result.skills`; `"agboss": { "skills": false }` turns it off.
- **Added — `check:docs` checks the skills**: their snippets compile, their version header, codes and
  matrix coverage ([Home](Home)).

## Unreleased — the agboss skill: SKILL.md and six references (#305 PR 2)

- **Added — the content of the coding-agent skill** shipped in `packages/agboss/skills/agboss/`:
  `SKILL.md` (the 10 invariants, the `npx agboss generate → check → describe` / `npm test` loop, the
  gate's rules, the routing table) and references 01 (composition and DTOs), 03 (components, DI,
  lifecycle), 04 (MCP and A2A), 05 (channels and pauses), 07 (guardrails and PII), 10 (testing, VCR,
  evals) — every ts block compiled by `check:docs`, every matrix name checked against the API
  reports (`tests/skills/coverage.ts`). CLAUDE.md and QUALITY.md say `reasoning`, not `thinking`.

## Unreleased — the automatic undo when an execution ends without a finish (#340 PR 3)

- **Added — the undo of an execution that ends without a finish**
  ([Rollback](Rollback#an-execution-that-ends-without-a-finish)): an uncaught failure or limit
  (`CompensationReason.ExecutionFailed`), a cancel or a launch's `FailFast` abort
  (`ExecutionCancelled`) undoes the execution's open undoable actions, newest first, before it
  ends — a child in its parent's step before its error is raised
  ([Workflow as a step](Workflow-as-a-step)), a root by its lease's holder before its keys are
  removed and `onExecutionError` is observed, after awaiting the tree's running step bodies up to
  `compensationTimeout` (one that returns later is undone at once, in process).
- **Changed — `app.cancel` of a paused tree** takes its lease, withdraws its pauses, undoes, then
  returns `{ cancelled: true }` ([Cancellation](Saga-And-Cancellation#global-cancellation)); a cancel
  request (#360) found at lease take undoes first, then ends the tree as before.
- **Changed — `CompensationFailedError` passes a child's boundary as it is**, never wrapped in
  `ChildExecutionFailedError`: no `.onError` / `.onJoinError` of the parent takes it, and the
  parent undoes its own open actions.
- **Added — `ExecutionErrorEvent.compensations`** ([Observability](Observability#automatic-undo)):
  the undo actions that ran for the failed execution. **Breaking** for a project that builds
  `ExecutionErrorEvent` objects itself (a test double of an observer): the field is required.
- **Changed — the undo's service spend** is written to the ledger at once when no state will hold
  it: a failed join that fails the execution, an execution ending without a finish
  ([FinOps](FinOps)).
- README: "declared action compensation (`compensateWith` / `committedBy`)" is back in the feature
  line.
## Unreleased — agboss check never prints ok without written types (#376)

- **Fixed — `agboss check` printed `ok` when type generation found no workflow** ([CLI](CLI)): an
  application module outside `src/` that does not export its workflows wrote no
  `.agboss/types.d.ts`. Now it is `[types.no-flow]` (a CLI problem, not a `RuleCode`), naming the
  application file and the fix — `export { MyWorkflow }` from it, or keep it in `src/` beside its
  `*.workflow.ts` files — exit 3, in the printed problems and in `--json`. How workflows are found
  is unchanged.
- **Fixed — a DTO name clash inside one workflow names both files**: `[dto.duplicate-name]` said
  "(unknown file)"; the diagnostic of type generation, which names the files, is kept instead.

## Unreleased — a DTO name clash fails agboss check (#371)

- **Fixed — `agboss check` printed `ok` without writing `.agboss/types.d.ts`** ([Workflow](Workflow#generated-types),
  [CLI](CLI)): two DTO classes of one name in two workflows (seen by no single workflow's rules)
  failed type generation silently. Now `[dto.duplicate-name]` names both files, in the printed
  problems and in `--json`, exit 3; any error that kept the file from being written is reported, and
  a failed write is `[types.not-written]` (a CLI problem, not a `RuleCode`). `createApp` / `testWith`
  are unchanged: they check DTO names per workflow.

## Unreleased — the shutdown grace (#367 PR 2)

- **Changed — `app.close()` / SIGTERM** interrupts the running executions a grace before the end
  of the shutdown timeout — `min(seconds(5), 20 %)` of it (`seconds(25)` → 5 s, `seconds(10)` →
  2 s) — and spends the grace on the step bodies they left running, then releases the leases and
  runs `onDestroy`: one `close()` now waits for those bodies, and the process always ends within
  `shutdownTimeout` ([App → app.close()](App#appcloseoptions),
  [Several instances](Several-instances#recovery)). Several calls: the stop ends at the earliest end
  any call set (before: the latest); `close({ timeout: 0 })` stops waiting for the bodies at once.
  The grace is not a setting; no public API change.

## Unreleased — committedBy needs compensateWith (#339)

- **Added — `[action.committer-without-compensator]`** ([Rollback](Rollback#what-agboss-check-proves)),
  an assembly error: an `@Action` with `committedBy` but no `compensateWith` — the option has no
  effect, since nothing undoes the action. The message names the action and its committer: add
  `compensateWith`, or remove `committedBy`. `RuleCode` gains the code.

## Unreleased — compensation records and the failed-join undo (#340 PR 2)

- **Added — compensation records** ([Rollback](Rollback#records-what-is-open-committed-undone-340)):
  every `@Action({ compensateWith })` that succeeds opens a record in the execution's state —
  committed by its `committedBy` action or a finish (a child's by its own finish), closed by its
  undo on a side path (`CompensationReason.SidePath`). `ExecutionOutput.compensations`,
  `ExecutionRecord.compensations`: `CompensationRecord { compensated, compensator, reason, status,
  error?, startedAt, endedAt }`; `CompensationReason`, `CompensationStatus`.
- **Added — a failed join undoes its finished branches** ([Rollback](Rollback#a-failed-join-undoes-its-finished-branches),
  [Parallel](Parallel)): before `.onJoinError` or the failure, newest first, after awaiting the
  launch's running branches — each undo in its own frame (key `<step key>:compensation`,
  `StepRecord.compensates`, a clean-up signal), no slot, no budget check
  (`CompensationReason.JoinFailed`). An undo that fails → the others still run, then
  `CompensationFailedError` (`compensation.failed`, `failures`, `cause`), taken by no side path.
- **Added — `@Application({ compensationTimeout })`** ([App](App)), default `seconds(15)`.
- **Added — observer hooks** `onCompensationStart` / `onCompensationEnd`
  ([Observability](Observability#automatic-undo)); **matcher** `toHaveCompensated(Action, { by,
  reason?, status? })` ([Testing](Testing#asserting-an-undo)); `agboss describe` marks a launched
  undoable action `(on a failed join: automatic)`.
- The undo of an execution that ends without a finish (a cancel, an uncaught failure or limit, an
  aborted child) came with #340 PR 3 (above).

## Unreleased — app.close() waits for interrupted step bodies (#367)

- **Fixed — `app.close()` / SIGTERM** no longer runs `onDestroy` or releases a tree's lease while a
  step body its interrupted pass left running still runs ([App → app.close()](App#appcloseoptions),
  [Several instances](Several-instances#recovery)): LangGraph rejects the pass before a body that
  ignores its signal returns, so a recovering instance could rerun the step with the same
  idempotency key at the same time. The instance now keeps the lease until the tree's bodies
  returned and starts `onDestroy` once every body did, at the latest at the end of the shutdown
  timeout; a body still running then is logged as `app.step-still-running` (`LogLevel.Warn`). The
  interrupted call still rejects with `ApplicationStoppingError`, once its lease is released. No
  public API change.

## Unreleased — declared compensation: compensateWith / committedBy and their checks (#339 PR 1)

- **Added — `@Action({ compensateWith, committedBy })`** ([Rollback](Rollback),
  [ADR-0020](ADR-0020-Declared-compensation), replacing ADR-0019's "no automatic compensation"):
  an action names the `@Action` that undoes it and, optionally, the one after which nothing undoes
  it. Checked at assembly: `[action.compensator-not-an-action]`, `[action.committer-not-an-action]`,
  `[action.self-compensation]`, `[action.compensator-compensates]`,
  `[action.invalid-compensator-input]`; an `.onError` / `.onJoinError` side path after an open
  undoable action reaches a finish only through its undo, newest first
  (`[flow.uncompensated-action]`, `[flow.compensation-out-of-order]`); with `committedBy` every path
  runs the committer or the undo (`[flow.uncommitted-action]`); a committer no path reaches is a
  warning (`[flow.committer-unreachable]`).
- **Added — `agboss describe`** prints each undoable action (`compensateWith … · committedBy …`),
  `--json` its node's `action` ([CLI](CLI#the-declarative-snapshot-268)).
- **Added — `examples/flow-patterns/src/hiring/`**: the send-offer workflow, its eighth workflow.
- Nothing runs automatically yet: the undo where no path can say it (a cancel, an uncaught failure,
  a failed join's finished branches) is #340.

## Unreleased — app.cancel from any instance stops an execution running on another (#360)

- **Fixed — `app.cancel(threadId)` on any instance** cancels the thread's execution running on
  another ([Several instances → Cancelling from any instance](Several-instances#cancelling-from-any-instance)):
  before, it returned `{ cancelled: false }` unless it reached the instance moving the tree. The
  cancel leaves a request under the reserved tree key `@agboss/cancel-request`; the holder stops
  with `ExecutionCancelledError` within one lease renewal (10 s, or its next checkpoint write), and
  a request made while the holder is down ends the execution at recovery — on an instance of any
  config version — instead of continuing it. No public API change.
- **Changed — tree keys starting with `@agboss/` are reserved** for the framework.
- A cancel from another instance before the execution's `running` record exists (its budgets, its
  thread's compaction) returns `{ cancelled: false }`.

## Unreleased — an instance's cap on steps, its queue and readiness (#332)

- **Added — `@Application({ maxConcurrentSteps })`** ([Several instances → An instance's cap on steps](Several-instances#an-instances-cap-on-steps-332)):
  how many agent, router and action steps (launch branches too) one application instance runs at
  once, over every tree and tenant — a whole number from 1 (`[limits.max-concurrent-steps-invalid]`);
  unset → no cap (no change). A step without a free slot waits in the instance's queue in the
  tree queue's order (closing a branch first, then the deepest, aged every 10 s on the `Clock`);
  a step in a provider's rate-limit queue keeps its slot; waiters at `app.close()` are interrupted
  at the shutdown timeout and recovered elsewhere.
- **Added — `HealthComponentKind.StepSlots`** ([Health checks](Health-checks#the-report)): the
  readiness component `step-slots` (only with a cap) — `Degraded` while every slot is busy, `reason`
  `"32 of 32 step slots busy, 7 steps waiting"`; liveness unchanged.
- **Changed — the recovery sweep** of a capped instance starts at most its free step slots' worth of
  recoveries per look (none when full) and goes on where a cut-short look stopped.
- `agboss describe` prints `maxConcurrentSteps`; `describe --json` has `application.maxConcurrentSteps`
  (`null` when unset).

## Unreleased — tool results bounded by maxResultSize (#336, PR 2)

- **Added — `maxResultSize`** ([Tools → Result size](Tools#result-size)): what a model reads of one
  tool result at most, in bytes of UTF-8 — on `@Tool` / `@McpTool` and in `defaults.tools` of
  `@Application` / `@Workflow` (the most specific wins), default 128 KB. A longer rendered result
  (an error's too, a knowledge base's search tool too) is cut before PII masking, at the last
  whitespace within the final 256 bytes, and ends with `\n[result truncated: N bytes, the first M
  kept]`; a context-mode knowledge block is bounded by the agent's value. `[tools.max-result-size-invalid]`
  at assembly.
- **Added — `kilobytes()` and `Bytes` in `@agboss/core/units`** (1 KB = 1,024 bytes).
- **Breaking — `ToolEndEvent.isResultTruncated: boolean`** is required: an object built as a
  `ToolEndEvent` (an observer test) sets it.
- **Changed — every workflow's `configHash`** once: the truncation marker is a framework text of
  the agent loop; a paused execution resumed on the new version is `IncompatibleResumeError` unless
  `onIncompatibleResume` accepts it.
- **Added — `agboss describe`** prints each tool's `maxResultSize` and where it came from;
  `describe --json` has `schemas.tools[name].maxResultSize` and each agent's `maxResultSize`.

## Unreleased — a decided quorum withdraws its waiting branches' pauses; channels may withdraw (#337)

- **Added — `withdraw(withdrawal)` on channels** ([Pauses → Taking a question back](Pauses#taking-a-question-back-withdraw-337)):
  the pair of `send` — a no-op on `ChannelOf` (a role's implementation writes `override`), optional
  on `ChannelHandler`; `ChannelWithdrawal<TRole>` (root entry) is `{ pauseId, value, resolution:
  PauseCancellation }`. Called once when a pause the channel sent closes without an answer —
  `Withdrawn` or `Cancelled` — in the pause's frame, under its tool's `timeout`; never for a pause
  decided at once or never sent. A throw or a timeout is the warning `channel.withdraw-failed`.
- **Fixed — a decided quorum withdraws its waiting branches' pauses**: an execution whose
  `.joinQuorum(…)` / `.joinQuorumGroups(…)` was decided while a branch waited on a channel rested
  paused (the join never ran); the pending pauses are now withdrawn (`PauseResolution.Withdrawn`)
  and the join runs in the same call. A deadline passing while the tree rests is acted on by its
  next pass ([Parallel](Parallel#pause-resume-recovery)).
- **Fixed — `FailFast` withdraws a paused sibling child's pause** under `.toParallelWorkflows(…)`
  (and inside a child's own launch): the execution failed to fail, resting paused. A pause record
  has `branchKeys` (the launch branches it waits under; `SqlitePausedExecutionRepository` keeps
  them in its JSON column, a record stored before reads with its own step's key).
- **Changed — `mockOf(Implementation)`** also replaces what a contract that resolves to that class
  gets (a channel role, any `extends`): before, only a dependency on the class itself got the mock.
- `PauseResolution.Withdrawn` reads "a `FailFast` sibling failed, or its launch's quorum was
  decided".

## Unreleased — a child workflow's change is part of its root's configHash (#336, PR 1)

- **Fixed — a root's `configHash` covers its child workflows**
  ([Terns and evaluation → What the config hash covers](Terns-and-evaluation#what-the-config-hash-covers-120-pr-4)):
  the snapshot adds `children` — every child reachable from the flow, recursively, each once by
  name, `ThisWorkflow` excluded. A run paused or running inside a child that a deploy changed is
  now `IncompatibleResumeError` / `recovery.incompatible`, decided by the root's
  `onIncompatibleResume`, instead of continuing silently on the changed child
  ([Several instances → Recovery](Several-instances#recovery)).
- **Breaking — hashes of workflows with children change once**: every workflow that launches a
  child gets a new `configHash` (records, events, `describe --json`; on durable records the first
  start after the upgrade warns once that its version changed without a bump); runs of such a
  workflow paused or running before the upgrade are incompatible with it unless its
  `onIncompatibleResume` says `"resume"`. Workflows without children keep their hash.
- **Breaking — `IncompatibleResumeError` is an `AGBossError`** with `static code =
  "resume.incompatible"` (the same string; its instance `code` is typed `string`), so
  `.onError(AGBossError, …)` and `error instanceof AGBossError` include it.

## Unreleased — the declarative snapshot and join keys (#268, PR 5)

- **Added — `agboss describe --json` is each workflow's declarative snapshot**
  ([CLI → The declarative snapshot](CLI#the-declarative-snapshot-268)): next to what the text
  prints, every entry of `workflows[]` has `configHash` (the full hash; `config` stays its first 8
  characters), `starts`, `finishes`, `nodes` (kind, hashes, `input` / `output` by DTO hash, an
  agent's model, provider, reasoning, limits, memory, tools, knowledge bases, the guardrails and PII
  policies in effect, judges and instructions; a router's `decidedBy`, model and routes with
  `spawn` / `failure`), `edges`, the `onError` table, `launches` (quorum, arbiters with their
  hashes) and `schemas` — every DTO by class and every tool by name with its `schemaHash` and JSON
  Schema.
- **Breaking — `ComponentRecord` is `{ name, kind, promptHash, schemaHash }`**
  ([Observability → Join keys](Observability#join-keys)): `kind` is the new `ComponentKind` enum
  (root entry); `promptHash` hashes what the component's model is told, `schemaHash` what it reads
  and writes (each DTO by its JSON Schema), each `undefined` when it has none — the values
  `describe --json` gives. It is every record that names a component: `event.step.component`,
  `executionContext.step.component`, `ExecutionOutput.finish`, `ExecutionEndEvent.finish`, child
  records' `start` / `finish`, `handledErrors`' `at` / `by`, `StepFailedError.component`,
  `VisitsLimitExceededError.component` (its constructor takes the record) and
  `BudgetExceededError.budget` (`kind: ComponentKind.Budget`; `BudgetBreach.budget` names it by
  `name` only). A test comparing one with `toEqual({ name })` compares with `toMatchObject`.
- **Breaking — `WorkflowRecord` has `configHash`**: the workflow's fingerprint, the one join key —
  in every execution event, `executionContext.workflow`, child records and limit errors; there is no
  `graphHash`.
- **Breaking — `StepRecord` has `toolLoopIteration` and `validationAttempts`**: an agent's model
  call in the visit (from 1, during the call and its move's tool calls; `undefined` elsewhere) and
  its answers and tool arguments that failed validation so far (`0` outside an agent's loop). The
  idempotency key's format is unchanged (#335). A pause keeps both and its agent's record:
  `record.pauses[].step` names the iteration that asked (a pause stored before reads as an agent's
  record without hashes, iteration unknown).
- **Not built — a branch's `{ verdict, status }` on `StepRecord`** (S93): its status and, under a
  quorum, its verdict are known only after the step ends; they stay in `result.launches` and
  `onQuorumDecided`, joined by `nodeId`, `copyNumber` and `itemIndex` (open question on #268).

## Unreleased — a PII key per root execution when the application sets none (#334)

- **Fixed — one value, one token across instances** ([Several instances → PII
  tokens](Several-instances#pii-tokens-across-instances)): without `@Application({ pseudonymKey })`
  the tokens of `sensitive` fields were made with a key of each instance, so after a pause resumed,
  a failover or a recovery on another instance one value got a second token in the same
  conversation. Now each root execution makes a key of its own at its start, keeps it in its
  checkpoint next to `piiTokens` and hands it to its child workflows; every instance that continues
  it gives one value the same token. With `pseudonymKey` (or under `testWith`, its fixed test key)
  nothing changes and no key is checkpointed; a checkpoint from before keeps the instance's key.
  No API change.
- **Changed — `[application.pii-instance-key]`**'s text: `no @Application({ pseudonymKey }):
  sensitive fields make PII tokens with a key of each execution — one value gets another token in
  each execution (in logs and traces: on each instance), so tokens compare across executions only
  with pseudonymKey` ([Environments → The PII key](Environments#the-pii-key)).

## Unreleased — generators and naming: full names, tool names, timeouts with units, Execution… (#268, PR 4)

- **Breaking — `agboss generate` takes full names** ([CLI](CLI#create-and-generate-angular-like)):
  the positional name ends with its kind (`billing-agent`, `escalation-router`, `refund-tool`,
  `policies-rag`, `valid-score-arbiter`, `onboarding-workflow`), `--workflow` is a workflow's full
  name (`desk-workflow`, found in the application of `package.json` or `--application`, its children
  included) — no more `--workflow src/x/x.workflow.ts` — and `--agent` an agent's (`billing-agent`).
  Nothing is completed: a short name is exit 2 with `Did you mean "billing-agent"?`, an unknown
  workflow or agent too, and nothing is written. `generate` takes `--application <path>`.
- **Breaking — `agboss generate workflow <name>-workflow`** writes the workflow beside the
  application file (`src/onboarding/`, with its test) and lists it in `@Application({ workflows })`
  — it no longer makes an application of its own; its scripts are `chat:<name>` / `run:<name>` by
  its start's full name. A name the application already has is a conflict (exit 4).
- **Breaking — `agboss create <project>`** writes the application at `src/<project>.application.ts`
  (its path in `package.json`) with, beside it, `environments/`, `config/budget.config.ts`,
  `model-providers/`, `guardrails/prompt-injection.guardrail.ts` (now the application's,
  `@Application({ guardrails, defaults: { guardrail } })`) and `services/api.service.ts`; the first
  workflow `<project>-workflow` in `src/<project>/`. `--agents` / `--tools` and the questionnaire take
  full names (`"triage-agent:Sorts requests"`, `"answerer-agent:search-orders-tool"`); the default
  agent is `<project>-assistant-agent`, the knowledge base `<project>-notes-rag`. The scripts run
  a start by its full name (`"chat": "agboss chat --start <project>-text-workflow-start"`).
- **Changed — generated code**: tools `name: "<name>-tool"`, knowledge bases `name: "<name>-rag"`
  (class `<Name>Rag`, the index in the project's git-ignored `.agboss/rag/`, not the home folder), MCP
  tools `<server>-<tool>-tool` with the server injected as `<server>Server`, MCP servers kebab-case,
  the OpenAPI client `<Name>ApiService` injected as `<name>ApiService`, OpenAPI tools
  `<operation>-tool`; no `models.ts`.
- **Breaking — tool names** ([Tools](Tools#names), [Naming](Naming)): a `@Tool` / `@McpTool` name is
  kebab-case ending with `-tool` (`[name.kind-suffix]` at assembly, with the name to use); every name
  a model sees fits `[a-zA-Z0-9_-]`, at most 64 characters (`[tool.name-too-long]`, new
  `[tool.name-invalid]`). A knowledge base's tool is `search-<rag name>-tool` (was `search_<name>`).
  Every tool of job-scout, flow-patterns and the docs is renamed (`order_status` →
  `order-status-tool`, `greenhouse_jobs` → `greenhouse-jobs-tool`, …); job-scout's knowledge base is
  `company-notes-rag`.
- **Breaking — timeouts have units**: `@Tool({ timeoutMs: 5000 })` / `@McpTool({ timeoutMs })` →
  `timeout: seconds(5)` (a `Milliseconds` value; default 30 s); a tool's timeout error reads
  `timed out after 5 s`. Internal: `DEFAULT_TOOL_TIMEOUT`, `JEV_TIMEOUT`.
- **Breaking — `Execution…`, not `run…`** ([Naming](Naming)): `ExecutionOutput.runId` →
  `executionId`; `IncompatibleResume` / `IncompatibleResumeError` `{ thread, runId }` →
  `{ threadId, executionId }`; `MemoryTurn.runId` → `executionId`; `RunId` → `ExecutionId`,
  `PausedRun` → `PausedExecution` (`PausedExecutionRepository`), `runAgent` → `executeAgent`,
  `RunDeps` → `AgentExecutionDeps`, `RunOptions` → `AgentExecutionOptions`, `runVersions` →
  `executionVersions`, `RunStreamEvent` → `ExecutionStreamEvent`, `RunTracing` → `ExecutionTracing`.
- **New — the [Naming](Naming) page**: kind suffixes, tool names, `Workflow…` vs `Execution…`, units,
  full names in the CLI.
## Unreleased — a budget breach in a parallel launch stops its siblings at once (#338)

- **Fixed — parallel branches overspending a `@Budget`** ([FinOps → At run time](FinOps#at-run-time)):
  every call of a tree is now counted the moment it is made — a live tally of the pass on this
  instance; the ledger is still written once per superstep and nothing is counted twice — so a
  branch of `.toParallelAgents`, `.toParallelActions`, `.toParallelWorkflows` or a quorum sees its
  siblings' spend while they run. The call that exhausts an execution, tenant or application budget
  aborts the in-flight model and tool calls of the other branches through `executionContext.signal`;
  they fail with that `BudgetExceededError` (their spend so far kept), and the launch fails with it
  into `.onJoinError(BudgetExceededError, toAction(…)… | toFinish(…))`, else the execution fails.
  Before, every branch checked only its own view (the spend at the launch plus the siblings that had
  ended), so N branches could each spend the whole remainder. The promise is now "a budget is
  exceeded by at most the calls in flight when it was exhausted"; an aborted call's partial cost is
  unknown and not recorded. A call that exhausts a budget also runs none of the tools its move asks
  for (an answer it gave is kept). Other instances still see the spend through the ledger only. No
  public API change.
## Unreleased — checks and fingerprints (#120, PR 4)

- **Changed — contracts are function-typed properties, checked on the decorator line**
  ([Components → Component rules](Components#component-rules)): `RagConnector`, `PiiPolicyHandler`,
  `PiiRefusal`, `GuardrailRefusal`, `BudgetHandler`, `HealthCheckHandler`, `ModelProviderHandler`,
  `ChannelHandler`, `ReplyInterpreterHandler`, `ActionHandler`, `RouterHandler`, `FinishHandler`
  declare `readonly method: (…) => …` instead of a method signature (`ToolHandler` and
  `JudgeHandler` already did), so a method that takes a narrower parameter than the contract no
  longer compiles — on `@Rag`, `@PiiPolicy` (a detector's `findMatches`, a declarative policy's
  `refusal(kind)`) and `@ModelProvider` whether or not the class `implements` it. Classes keep
  writing ordinary methods; nothing to migrate unless one relied on a narrower parameter.
- **Changed — prompts are normalised at load** ([Components → File conventions](Components#file-conventions)):
  no byte order mark, `\n` line breaks, no blank lines at the edges, Unicode NFC; inside kept as
  written; `promptUrls` parts joined with one blank line. Covers guardrails, compactions, reply
  interpreters, an arbiter's prompt and criteria and profile overrides. A prompt file's trailing
  newline is no longer sent.
- **Changed — the config hash covers what an element's model reads outside its decorator**
  ([Terns and evaluation](Terns-and-evaluation#what-the-config-hash-covers-120-pr-4)): per agent and
  model router the PII policies in effect, `uncompactedTurns` and the compaction, an agent's judges;
  and the framework's own texts. Every workflow's `configHash` changes once with this release, so a
  pause taken before it resumes only where `onIncompatibleResume` accepts it.
- **New — `agboss describe` shows a computed guardrail refusal as `ClassName.refusal()`** (tested;
  printed since #120 PR 2).

## Unreleased — lease fencing at expiry, unique tool-call ids (#335)

- **Fixed — a lease store down past the lease** ([Several instances → The execution lease](Several-instances#the-execution-lease)):
  the holder trusts its lease until the `Clock` read before its last confirmed renewal plus
  30 seconds; a store error before then lets the checkpoint write go on, at that moment the
  execution's signal aborts with `ExecutionLeaseLostError` — the agent's tool loop starts no further
  model or tool call, no `.onError`, the record stays `running` and another instance recovers the
  tree. Before, the background renewal retried forever and the holder kept calling tools after its
  lease had expired in the store. The error's message names the case (expired without takeover);
  no new field.
- **Fixed — a provider repeating a tool-call id within one move**
  ([Tools → Agents with tools](Tools#agents-with-tools)): each repeated id gets its position (`${id}:${index}`), so two calls
  no longer share a result slot and an idempotency key. The key format is unchanged; ids the provider
  gives once are kept as they are.

## Unreleased — describe and the check report: the worst case per start, check --env (#268, PR 2)

- **New — `agboss describe` describes the application** ([CLI](CLI#describe-268)): first its tree —
  the listed workflows with their starts and the child workflows they launch (by which step, one or
  per item with `maxItems` / `maxConcurrency`; `ThisWorkflow` marked with `maxDepth`) —, each
  contract's implementation and why, the model providers and why, each channel (a role's question →
  answer, who answers, its reply interpreter, its implementation and why), the budgets by scope and
  each workflow's execution budget, the observers, the warnings and the environment once; then each
  workflow, now with its PII policies and their refusals (`refusal: "…"` or `CardPiiPolicy.refusal()`)
  and `maxDepth` among its limits, and each agent's compaction with where it came from
  (`compaction conversation-compaction (job-scout-workflow)`: `(own)`, the workflow or the application). `describe --json`'s `application` carries the same as data
  (`tree`, `implementations`, `modelProviders`, `channels`, `budgets`, `executionBudgets`, …); a
  workflow's data no longer repeats the application, and gains `piiPolicies`.
- **New — the check report** ([CLI](CLI#the-check-report-268)): `agboss check` prints, per start,
  the worst case of one call — workflow executions, at the same time, agent and router steps of the
  whole tree, nesting depth — each with how it is made up, from the decorators only; `--json`:
  `result.report`. `describe` prints the same report under each workflow's limits (it was one line).
- **Changed — `agboss check --env <name>`** lists the variables as `prod environment needs 3 process
  variables:` with aligned `NAME  value | secret[, optional | , has a default]` lines — the field
  name is no longer printed, never a value ([Environments](Environments#the-cli)).
- **Breaking — `describeWorkflow` is removed from the public API** (it was a root export): describing
  is the CLI's — use `agboss describe [--json]`. It stays internal (the CLI and the framework's
  tests); the examples' tests that printed it now rely on the CLI's job-scout and flow-patterns
  describe tests. The root import loads no `describe/` module any more.
- **Internal (`@agboss/core/internal`)**: `describeApplication(assembled, { source, profile, environment })`,
  `describedApplicationOf(assembled)` (takes the assembled application; `executionBudgets` per
  workflow, `modelProviders`), `describedTreeOf`, `describedChannelsOf`, `describedPiiPoliciesOf`,
  `worstCaseReportLines` / `worstCaseRowsOf` (`WorstCaseMeasure`), `worstCaseLimitsOf`; a
  `WorstCase` carries its `workflow`, `isStepsCapped`, `treeSteps` and `children` (each edge into a
  child: `count`, `atOnce`, `maxItems`, `maxConcurrency`, `isRecursive`, the child's worst case).
- **job-scout**: a `prod` environment (`agboss check --env prod`).

## Unreleased — health checks: `@HealthCheck`, `app.checkLiveness()`, `app.checkReadiness()` (#300, PR 1)

- **New — the instance's probes** ([Health checks](Health-checks)): `app.checkLiveness()` (no I/O:
  the application — `Unhealthy`, `stopping`, from `app.close()` on — and the recovery loop —
  `Unhealthy` when its last sweep ended more than three sweep intervals ago) and
  `app.checkReadiness()` (liveness's components, every store's `ping()`, every model provider's
  circuit breaker — open → `Degraded`, never a model call — and the project's checks), each →
  `HealthReport { status, components }` with `HealthStatus` and `HealthComponentKind`. Checks run
  at once, each under its timeout on the `Clock`; one that throws or times out is that component's
  `Unhealthy` with its `reason` — neither call rejects. `testWith`'s `app` has both, also during and
  after `close()`. No HTTP server: the project's exposes them.
- **New — `@HealthCheck({ name, timeout, deps? })`** + `implements HealthCheckHandler`
  (`check(): Promise<HealthCheckResult>`, built only with `HealthCheckResult.healthy()` /
  `.degraded({ reason })` / `.unhealthy({ reason })`), listed in `@Application({ healthChecks })`;
  rules `[health.not-a-health-check]`, `[health.duplicate-name]`, `[name.kind-suffix]`
  (`-health-check`).
- **Breaking — every #265 store contract has `abstract ping(): Promise<void>`**
  (`CostLedgerRepository`, `ExecutionRecordRepository`, `PausedExecutionRepository`,
  `ExecutionLeaseRepository`, `ExecutionTreeRepository`, `RateLimitRepository`): the in-memory
  defaults resolve, the SQLite ones run `SELECT 1`. Migrating: a project's own implementation adds
  `ping()` — one fast round trip that rejects when the store is unreachable
  ([Several instances → Your own implementation](Several-instances#your-own-implementation)). A
  subclass of a framework implementation inherits it.
## Unreleased — the `IdGenerator` contract (#313)

- **New — `IdGenerator`** (root export, [App → Infrastructure](App#infrastructure)): an
  infrastructure contract like the `Clock` — `newThreadId()`, `newExecutionId()`; every thread id the
  framework mints and every execution id (roots, children, recursion levels) comes from it. The
  built-in `RandomIdGenerator` (root export) keeps the formats (random UUIDs); a class in
  `@Application({ providers })` that `extends IdGenerator` replaces it. A `pauseId` stays a random
  128-bit token outside it.
- **New — `SequentialIdGenerator`** (`@agboss/core/testing`): `testWith` runs on it unless the
  application lists its own generator — `thread-1`, … and `execution-1`, … per test
  ([Testing → Ids](Testing#ids)).
- **Breaking — the records repositories' `deps`:** `SqliteExecutionRecordRepository` takes
  `[SqliteConnection, Clock, ApplicationContext, IdGenerator]` (was `[SqliteConnection, Clock,
  NEW_THREAD_ID]`, an internal token), the built-in in-memory one `[Clock, IdGenerator]`;
  `NEW_THREAD_ID` is removed. A project now subclasses `SqliteExecutionRecordRepository` through
  public tokens only ([Several instances → Extending a SQLite
  implementation](Several-instances#extending-a-sqlite-implementation)).
- **Breaking — `createApp` / `createAppDeps` options:** the undocumented `newThreadId` and
  `newRunId` options are removed — list an `IdGenerator` instead.
- **Changed — execution ids under `testWith`:** `execution-1`, `execution-2`, … (were `run-1`, …).

## Unreleased — `agboss dev` and `agboss studio`: no `studio.ts`, children as subgraphs (#268, PR 3)

- **New — `agboss dev [--strict] [--env <name>]`** ([CLI](CLI#watch-mode-and-studio-268)): watch
  mode over the application's `src/` — every change runs `agboss check` in a short-lived child
  process (debounced, 200 ms; never two at once), so `.agboss/types.d.ts` is regenerated and the
  assembly problems are printed as they appear.
- **New — `agboss studio [--port N] [--env <name>]`**: every workflow of the application (the
  children too) in LangGraph Studio; the CLI writes `.agboss/studio.ts` and `.agboss/langgraph.json`
  (git-ignored, rewritten on every run) and starts `langgraphjs dev` on them. A child is a subgraph
  inside its parent, `.toParallelWorkflows(…)` included; an assembly problem or a missing variable
  stops it before the server starts (exit 3).
- **Breaking — `studioGraphOf` is removed from `agboss` (and from the deprecated `@agboss/core/core`)**, and
  the examples' `src/studio.ts` and the root `langgraph.json` are gone. Migrating: delete the
  project's `studio.ts` and `langgraph.json`, run `agboss studio` (job-scout: `npm run studio`).
  The graphs come from `studioOf(Application, { env })` in `@agboss/core/internal`, the CLI's.
- **Changed — `@langchain/langgraph-cli` is a dependency of `agboss-cli`** (it was the monorepo
  root's dev dependency), so `agboss studio` works in any project.

## Unreleased — flow-patterns runs with a real model, and an approvals pattern (#346)

- **New — `examples/flow-patterns/src/approvals/`** ([Example](Example#flow-patterns-a-review-loop-and-a-code-router)):
  `offsite-booking-workflow` — two buyers in one `.toParallelAgents(…)` launch, each `place_purchase`
  call waiting for the thread's owner through the `PurchaseApprovalChannel` role, answered in the
  terminal (`TerminalPurchaseApprovalChannel`); scripted tests: both pauses pending, both answers
  taken, a second answer `NotPausedError`, each question asked once.
- **Changed — flow-patterns runs with a real model:** its `dev` environment reads
  `OPENROUTER_API_KEY` (`openRouterApiKey`, a `Secret`) and, optionally, `OPENROUTER_BASE_URL`
  (`openRouterBaseUrl`) for the built-in providers; `test` is unchanged. Every store of its
  application is SQLite now (records, pauses, checkpoints, leases, tree keys, besides the ledger).
  `npm run check` also runs `agboss check --models --env test` (no key); `npm run answer` answers
  waiting pauses from another process. Its `README.md` says how to run the manual checks #263 M1,
  #264 M1 and #267 M1.

## Unreleased — compaction: `@Compaction`, strategies, `uncompactedTurns` (#120, PR 3)

- **New — `@Compaction({ name, description, prompt?, promptUrls?, model, strategy,
  turnsBetweenCompactions, summaryQueueLength?, summaryMaxTokens })`** ([Memory
  Management](Memory-Management)): `compactions/*.compaction.ts`, a `-compaction` name;
  `CompactionStrategy.SummaryQueue` (a queue of self-contained summaries, the latest
  `summaryQueueLength` kept), `SingleSummary` (one summary, rewritten), `None` (no model, no prompt,
  no parameters — the window only). A strategy that writes summaries without a `model`, or `None`
  with one, does not compile. Root exports: `Compaction`, `CompactionStrategy`, `TurnLimit`,
  `CompactionError`, the option types, `UncompactedTurns`, `SummaryMaxTokens`, `TokenLimit`.
- **New — `compaction` and `uncompactedTurns`: one setting each on `@Application`, `@Workflow`,
  `@Agent` and `@Router`** — the lowest level that sets one wins (AC4); `uncompactedTurns` defaults
  to 5, `TurnLimit.ALL` is every turn; on a code router neither compiles. A compaction summarises
  everything older than the **smallest** `uncompactedTurns` among the agents and routers that use
  it; a reader sees its window, every turn its compaction has not summarised yet, and only the
  summaries its turns do not cover.
- **New — `summaryMaxTokens`** is the summarising call's `max_tokens` (`TokenLimit.MODEL_MAX` allowed,
  thinking off): cut at it → one "shorter" retry, then **`CompactionError`** (code `compaction`;
  `compaction`, `summaryMaxTokens`; a failed model call is one too, as its `cause`) — never a cut
  summary.
- **Changed — compaction runs lazily, before a new execution's first read of its thread** (S132),
  never after a turn: a finished turn's answer is always kept, a thread that ends pays for none, and
  a `CompactionError` fails the new execution before any of its work (no model call, no step, no
  turn kept). Its spend is the new execution's; `result.compacted` says what ran before it.
- **Breaking — `TokenLimit.MODEL_MAX` replaces the `MODEL_MAX` constant** (S132), an enum next to
  `TurnLimit.ALL` (both from the root). Migrating: `maxTokens: MODEL_MAX` → `maxTokens:
  TokenLimit.MODEL_MAX`, `import { MODEL_MAX }` → `import { TokenLimit }`; the value is still
  `"max"`.
- **New — compaction behind the PII boundary** (S84 i): its model reads the turns through the
  application's and the workflow's PII policies; the summary is revealed before it is stored, and
  each reader's own policies mask it at its boundary.
- **New — assembly rules** `[compaction.not-a-compaction]`, `[compaction.invalid-setting]`,
  `[compaction.decision-model]`, `[compaction.uncompacted-turns-invalid]`; compaction models are
  checked against `serves` as `compactions.<name>`.
- **Breaking — removed: `defaults.history` (`limit`, `summaries`), `@Agent({ historyLimit,
  historySummaries })`, `@Workflow({ compaction: { every, keep, model }, compactionPrompt })`,
  the `mockCompaction` fixture and the types `HistoryDefaults`, `CompactionOptions` (the old one),
  `ModelOptions`.** Migrating: `defaults: { history: { limit: 8 } }` → `uncompactedTurns: 8` on the
  same decorator (outside `defaults`); `historyLimit: 3` → `uncompactedTurns: 3`; `compaction: {
  every: 5, keep: 10, model: { model } }` → a `@Compaction` class with `strategy:
  CompactionStrategy.SummaryQueue, turnsBetweenCompactions: 5, summaryQueueLength: 10, model,
  summaryMaxTokens` named by `compaction: ConversationCompaction`; `mockCompaction()` →
  `mockLlm(ConversationCompaction)`. A profile's `compaction:` is `compactions: { <name>: … }`,
  `defaults.history.limit` is `defaults.uncompactedTurns`.
- **Breaking — summaries are kept per compaction**: `ExecutionRecordRepository.uncovered`,
  `latestSummaries` and `summaryCount` take the compaction's name after `(tenantId, threadId)`, a
  `Summary` has `compaction` (SQLite migration 13; a summary written before it belongs to no
  compaction and is not shown again). `result.compacted` is a list (`{ compaction, fromTurn, toTurn,
  summaries, summaryQueueLength }`, one per compaction that ran); spend is `compaction:<name>`
  (category `compaction`).
- **Changed —** a compaction's model failure used to be swallowed (the next turn retried); it is now
  a `CompactionError` like a summary that does not fit (#77 AC5 replaced, ADR-0007 amended).

## Unreleased — the application path and starts: --start, --input, rag index (#268, PR 1)

- **Breaking — the CLI works on one application, set once** ([CLI](CLI#the-application-and-its-starts-268)):
  `"agboss": { "application": "src/job-scout.application.ts" }` in the project's `package.json`
  (relative to its folder), or `--application <path>`, which wins; neither → exit 3 saying where to set
  it. **`--workflow <path>` is gone** from `chat`, `run`, `describe`, `check`, `eval`, `replay`,
  `golden`, `compare` and `rag` (an unknown option, exit 2); the generators keep theirs until PR 4.
  Migrating: add the `agboss` field to `package.json` and drop `--workflow …` from the scripts
  (`"chat": "agboss chat"`); `agboss create` writes both.
- **New — `--start <full name>`** on `chat`, `run`, `eval`, `replay`, `golden add`, `compare`: the
  workflow is chosen by its start (`--start screening-workflow-start`); optional with one start in the
  application; with several and none given, exit 2 listing each start's name, description and
  workflow; an unknown name, exit 2 with `Did you mean "…"?` and the list — the lookup is exact,
  nothing runs under a guessed name.
- **Breaking — `agboss run --input` is JSON**: `--input '<json>'` / `--input-file <file>` give the
  start's input, checked against its `InputOf` (one DTO, a `listOf(…)`, a map of fields) before the
  app starts — every problem at once by field (`company.name: …; request.criteria: …`), exit 2; the
  task's words are the text of a start taking `WorkflowStartTextDto` (`--input <text>` was that before).
  `agboss chat` needs a start taking `WorkflowStartTextDto`.
- **Breaking — `agboss rag index [--rag <name>]`** (was `rag:index --kb`): every knowledge base of
  the application, each once; `--rag` takes the full name, an unknown one is exit 2 with a hint.
- **Changed — `describe` and `check` cover every workflow of the application**: `describe --json` is
  `{ application: { name, version }, workflows: [ … ] }`; `check` assembles the application as
  `createApp` does (its rules across workflows too) and its problems name the application's path
  (`ok: src/job-scout.application.ts — …`); `result.application` replaces `result.workflow`.
- **Internal (`@agboss/core/internal`)**: `loadApplicationClass(path)` loads the one exported
  `@Application` of a module (`ApplicationLoadError`, CLI code `application.load`) — the `--workflow`
  bridges `environmentOwnerOfFile`, `textStartOfWorkflow` and `workflowsOfApplication` are gone;
  new `startsOfApplication(App)` (`ApplicationStart`: name, description, workflow, class, input — from
  the decorators), `startInputIssuesOf(Start, payload)`, `applicationOf`, `environmentOwnerOf`;
  `applicationWarningsOf` takes the assembled application.

## Unreleased — the variant of a `oneOf` reply (#262, PR 5)

- **Breaking — `JudgeInput<TReply>` carries `variant`** (S125,
  [Judges → The variant of a `oneOf` reply](Judges-And-Quality-Gates#the-variant-of-a-oneof-reply)):
  the class the answer validated as, from the answer tool the agent used — never guessed from the
  answer's shape, never compared by name. For a `oneOf(A, B)` judge `JudgeInput<A | B>` is a
  discriminated union (`{ variant: typeof A; reply: A; task; attempt } | { variant: typeof B; … }`),
  narrowed by `isVariant(input, A)`; a single DTO, `listOf(XDto)` or `PlainTextDto` judge has
  `variant` as that one class. Migrating: a judge that told variants apart by their fields
  (`"salary" in reply`) uses `isVariant(input, OfferDto)`.
- **Breaking — a `listOf(oneOf(A, B))` judge reads `reply: readonly VariantOf<A | B>[]`**: each item
  `{ variant, value }`, as the answer's items are kept, narrowed by `isVariant(item, A)`; it has no
  `variant` of its own. Migrating: `implements JudgeHandler<readonly (A | B)[]>` becomes
  `JudgeHandler<readonly VariantOf<A | B>[]>` (the old form does not compile), each item read as
  `item.value`.
- **New — `VariantOf<T>`** (`@agboss/core/dto`, the root), **`JudgedValueOf<TShape>`** (what a judge of a
  `reply` shape reads) and **`JudgeInputOf<TJudge>`**; `isVariant(x, XDto)` also narrows anything
  that carries `variant` (a judge's input, a `VariantOf` item).
- **Breaking — `testJudge(J, …)({ variant, reply, task, attempt })`** takes `variant` too, typed the
  same way: a `variant` with another class's value does not compile.

## Unreleased — interpreter outcomes, a decision-model interpreter, child pause records (#267, PR 4)

- **New — a decision model may read an approval's reply** (S124 a, [Pauses](Pauses)):
  `@ReplyInterpreter({ decidedBy: DecidedBy.Model, model: "typesafe/jev-1.13" })` on an approval role
  (`approves`) makes one `Decision.noul("approved")` about the question and the reply — approved when
  P(yes) > 0.5, the answer `{ approved }`, never a `reason` or `overrideArguments`; counted under
  `reply-interpreter:<name>`, a model use of purpose decision (`decisions-model-provider`). A
  question role on a decision model stays `[reply-interpreter.decision-model]`, its message saying
  why (the answer DTO needs more than a yes / no). Tests: `mockLlm(X).thenReturn(decideWith({ approved: 0.9 }))`.
- **Breaking — a code interpreter returns its outcome** (S124 b): `ReplyInterpreterHandler<Self>.interpret`
  returns `ReplyInterpretation.understood(decision)` or `ReplyInterpretation.notUnderstood({ reason })`
  (sync or a promise; `ReplyInterpretationKind`, `UnderstoodReply`, `NotUnderstoodReply`); a plain
  object does not compile. `notUnderstood` → `UninterpretableReplyError` with that `reason`, the
  pause pending; a `throw` is a crash only (unreadable too, its error the `cause`). Migrating: wrap
  each returned decision in `ReplyInterpretation.understood(…)`, and replace a `throw` that declines
  with `return ReplyInterpretation.notUnderstood({ reason })`; a test's
  `mockOf(I).interpret.mockResolvedValue(decision)` becomes `mockReturnValue(ReplyInterpretation.understood(decision))`.
- **New — `UninterpretableReplyError.reason`** (every unreadable reply: the interpreter's reason, or
  its error's message); its constructor takes `{ reason, cause? }` (`UninterpretableReplyErrorOptions`).
- **New — `ChildExecutionRecord.pauses`** (S124 c, [Pauses → Who answered](Pauses)): each child's
  record in `result.children` and `result.record.children` lists the resolved pauses its own steps
  asked; the root's `record.pauses` keeps the whole tree's. `PauseAnswerRecord.executionId` names
  the execution a pause waited in (stored with each answer: a `pause_answers` row written before
  this change has none and fails to parse). The state's records are the internal `EndedChildRecord`
  (exported as a type; it is `ChildExecutionRecord` without `pauses`).
- **Rule — new runtime subsystems load lazily** (S124 d, #120 S123 c, `QUALITY.md` → Design): the
  decision-model and code reading are behind the lazily loaded reply reader; the root import stays
  under its 1,400-module budget (1,397).

## Unreleased — guardrails: @InputGuardrail / @OutputGuardrail, refusals, levels (#120, PR 2)

- **New — `@InputGuardrail` / `@OutputGuardrail({ name, description, prompt | promptUrls, model?,
  threshold, refusal?, deps? })`** ([Guards → Guardrails](Guards#guardrails)): a yes / no question on
  a decision model (`Decision.noul`) or a chat model (the answer tool `answer-guardrail`); `model`
  else `defaults.guardrail.model` (never the router's, `[guardrail.no-model]`). An input guardrail
  reads what an agent's or a model router's model reads — its input message, **masked** by that
  element's PII policies (S84 i) — before the call; an output guardrail reads an agent's answer. At
  P(yes) ≥ `threshold` the execution fails with `GuardrailBlockedError` (`guardrail.blocked`;
  `refusal`, `key: guardrails.<name>.threshold`, `probability`, `threshold`); a model that does not
  answer fails closed (`GuardFailedError`, `step.guard`).
- **New — the refusal:** a text in the decorator, or `refusal(): string | Promise<string>` of a class
  that `implements GuardrailRefusal` (its services and the execution through `deps`); neither does
  not compile (the decorator's overloads); at assembly `[guardrail.missing-refusal]`,
  `[guardrail.refusal-twice]`.
- **New — levels:** `guardrails` on `@Application`, `@Workflow`, `@Agent`, `@Router` add up,
  `excludeGuardrails` on an agent or a router removes an inherited one; a model router takes the
  input guardrails, a code router none. New rules: `[guardrail.not-a-guardrail]`,
  `[guardrail.exclude-not-inherited]`, `[guardrail.output-on-router]`, `[guardrail.no-model-call]`,
  `[guardrail.no-prompt]`, `[guardrail.threshold-invalid]`; names end with `-guardrail`.
- **New — `[application.pii-instance-key]`** (S94, [Environments → The PII key](Environments#the-pii-key)):
  no `@Application({ pseudonymKey })` and no policy that needs it → sensitive fields and keyless
  policies use a key of the instance; the start goes on with this warning in `app.warnings` and the
  start log (an error under `agboss check --strict`, silent in tests).
- **Breaking — `@Workflow({ guards })` is removed** with the framework's guard texts
  (`prompt_injection`, `pii`), `GuardOptions`, `GuardsOptions`. Migrating: one `@InputGuardrail` /
  `@OutputGuardrail` class per guard (`guardrails/*.guardrail.ts`), listed in `guardrails`. The guard
  that ran on the execution's input now runs on what each model reads (the router's first); the one
  on the output on each agent's answer.
- **Breaking — the `@Guardrail` hook classes are removed** (`beforeToolCall`, `afterToolCall`,
  `onChannelDecision`, `beforeAgentAnswer`, `GuardrailContext`, `overrideGuardrails`,
  `disableGuardrails`, `guardrails` on `@Tool`); checks of tool calls come back as tool-point judges
  (#123). `testGuardrail(G, options)(text, { element })` now checks a text and gives `{ isBlocked,
  probability, refusal? }` (`GuardrailCheck`); `GuardrailDecision` / `GuardrailHookResult` are
  removed.
- **Changed — observer events:** `GuardrailStartEvent.input` is `{ side: GuardrailSide, element,
  text }` (the masked text), `GuardrailEndEvent.update` is `GuardrailOutcome { isBlocked, probability
  }`. Spend: `guardrail:<name>` (category `guards`; was `router:guard:<name>`); tests script it with
  `mockLlm(G).thenReturn(decideWith({ blocks: 0.9 }))` — an unscripted guardrail passes. A VCR
  cassette records it as `decide guardrail:<name>`.
- `agboss describe` prints each guardrail (side, threshold, model and where it came from, refusal —
  the text or `Class.refusal()` —, the elements it guards); `agboss create` writes
  `guardrails/prompt-injection.guardrail.ts`.

## Unreleased — reply interpreters, pause answer records and retention (#267, PR 3)

- **Free-text replies** ([Pauses → free text](Pauses#answering-with-free-text-appresume-pauseid-reply--options)):
  `app.resume({ pauseId, reply }, options)` — `ResumeRequest` is now `DecisionResumeRequest |
  ReplyResumeRequest`, exactly one of `decision` / a non-empty `reply` (else `DtoValidationError`).
  The role's `replyInterpreter` — a **`@ReplyInterpreter`** class (`-reply-interpreter`):
  `DecidedBy.Model` (a chat model, one answer tool, static `prompt` / `promptUrls`) or
  `DecidedBy.Code` (`implements ReplyInterpreterHandler<Self>`, `interpret({ ask, reply })`, `deps`,
  created by the container) — reads the reply with the pause's question; its answer is validated
  like a decision. A model interpreter's call resolves its provider by `serves`, is checked against
  the tree's budgets first, counted in their ledger and in the execution's `spend` (once) and traced
  under `reply-interpreter:<name>`. Either kind reads in the pause's execution frame (its
  `ExecutionContext`: tenant, owner, the waiting step); a model one through the application's and
  the workflow's PII policies, its answer revealed before validation (an unknown token is a decline).
- **`UninterpretableReplyError`** (`pause.uninterpretable-reply`): a reply nobody can read — the
  interpreter declined, or its answer is invalid (the reason as `cause`); the pause stays `Pending`.
  **`ReplyInterpreterMissingError`** (`pause.no-reply-interpreter`): a `reply` for a role without an
  interpreter, the pause untouched.
- Assembly: `[reply-interpreter.not-an-interpreter]`, `[reply-interpreter.decision-model]`,
  `[reply-interpreter.no-interpret-method]`, `[name.kind-suffix]` for `-reply-interpreter`; model
  interpreters are model uses (`[model.unserved]`, `agboss check --models`: `replyInterpreters.<name>`).
- Tests: `mockLlm(Interpreter).when({ reply })` scripts a model interpreter
  ([Testing → Reply interpreters](Testing#reply-interpreters)); `mockOf(Interpreter)` a code one.
- **Who answered each pause** ([Pauses → who answered](Pauses#who-answered-resultrecordpauses), S107):
  `ExecutionRecord.pauses: PauseAnswerRecord[]` — every resolved pause of the tree in the order
  asked (`pauseId` — none for a `PauseAnswerer.Channel` pause —, `step`, `role`, `answeredBy`,
  `responder`, `resolution`, `askedAt`, `resolvedAt`, `decision` PII-masked, none when withdrawn or
  cancelled); **`enum PauseResolution { Decided, Replied, Withdrawn, Cancelled }`**. Written when a
  pause is resolved into the execution records — the permanent history, untouched by the retention:
  **new abstract methods on `ExecutionRecordRepository`** (a project's own implementation adds them)
  `savePauseAnswer(tenantId, rootExecutionId, answer)` and
  `findPauseAnswersByTenantIdAndRootExecutionId(tenantId, rootExecutionId)`; the built-in and SQLite
  ones keep them in a `pause_answers` table (migration 12 of the record store).
- **Retention**: `@Application({ pauseRecordRetention })`, default `hours(24)` — resolved records
  (`Taken`, `Cancelled`) are removed by the recovery sweep through
  `PausedExecutionRepository.deleteResolvedBefore(cutoff)`; within the window a late answer is
  `NotPausedError`, after it `UnknownPauseError`; `Pending` is never removed.
- **Breaking — `PausedExecutionRepository`** (a project's own implementation changes):
  `PauseRecord.resolution` (the decision and who answered) is now **`answer: PauseAnswer`**
  (`decision`, `answerer`, `usage?`) — the interface `PauseResolution` became `PauseAnswer`, and
  `PauseResolution` is the enum above; new record fields `copyNumber`, `askedAt`, `resolution`,
  `resolvedAt`. `resolveByTenantIdAndPauseId(tenantId, pauseId, answer, at)`,
  `cancelByTenantIdAndPauseId(tenantId, pauseId, resolution: PauseCancellation, at)`; new
  `decideByTenantIdAndPauseId` (a channel's `ChannelOutcome.decided(…)` closes its record as `Taken` /
  `Decided` instead of deleting it) and `deleteResolvedBefore(cutoff)`;
  `deleteByTenantIdAndPauseId` is removed. `SqlitePausedExecutionRepository` migrates a PR 2 file.

## Unreleased — judges see the answer as its DTO (#262, PR 4)

- **Breaking — `@Judge({ name, model, reply, deps })` + `JudgeHandler<TReply>`**
  ([Judges and Quality Gates](Judges-And-Quality-Gates)): a judge declares what it judges — `reply`
  is any shape of an agent's `output` — a DTO class, `oneOf(A, B)` (typed `A | B`), `listOf(XDto)`
  (`readonly XDto[]`, `listOf(oneOf(…))` the items' values) or `PlainTextDto` for a text agent — and
  `judge(input: JudgeInput<TReply>)` gets the agent's validated answer object (`{ text }` for a text
  agent), never a serialized string. `JudgeHandler` and `JudgeInput` take the reply's type.
- **Breaking — `JudgeVerdict.feedback` is `reason`**, and verdicts are built only with
  `JudgeVerdict.passed({ metrics? })` / `JudgeVerdict.failed({ reason, metrics? })` — a plain
  `{ passed, feedback }` object no longer compiles. The `reason` goes back to the agent for its
  retry. `QualityGateError.feedback` is `rejections: [{ judge, reason }]` (`JudgeFeedback` →
  `JudgeRejection`).
- **New rule `[judge.wrong-reply]`**: an agent whose `output` does not fit a listed judge's `reply`
  fails assembly (also `agboss check`) — a text agent with a DTO judge, a DTO agent with another
  class, a `oneOf` variant the judge does not cover, a list agent with a judge of one value or the
  other way round.
- **`testJudge(Judge, …)({ reply, task, attempt })`** is typed by the judge: `reply` is a plain
  object of its DTO; another shape does not compile.
- Migrating: add `reply` to every `@Judge`, write `implements JudgeHandler<XDto>` and
  `JudgeInput<XDto>`, read `reply.text` in a text agent's judge, and return
  `JudgeVerdict.passed()` / `JudgeVerdict.failed({ reason })`.

## Unreleased — `ThisWorkflow` typed per path (#264, PR 3)

- **`ThisWorkflow` is typed per workflow** ([Workflow as a step → Recursion](Workflow-as-a-step#recursion-264)):
  `agboss check` writes a `ThisWorkflowOutputs` entry per recursive workflow (`input`, `output`,
  `join`), keyed by its `name`; `[types.this-workflow-outputs]` is removed — recursive workflows
  with different finishes live in one project. No project code changes.
- **The `.returns(…)` after a `ThisWorkflow` launch** (`.toWorkflow`, `route`, `workflow`,
  `toWorkflow` as a side path, the join of `.toParallelWorkflows`) is checked by
  `@Workflow({ name, flow })`: a wrong class fails on `flow`, no longer at the `.returns(…)`.
- **Builder types** (API reports): every path head (`SourceHead`, `RouteHead`, `CaseHead`,
  `SideHead`, `GroupHead`) takes a `claims` type parameter; `.switch`, `.chooseOne`, `.onError`,
  `.onJoinError` and `.joinQuorumGroups` are generic over their sub-paths; `WorkflowOptions<TName,
  TFlow>` and `Workflow(…)` are generic; new `ThisWorkflowOutputs`, `ThisWorkflowCheck`,
  `ThisWorkflowStepClaim`, `ThisWorkflowJoinClaim`, `ClaimsOf`, `WithClaims`, `ChildLaunched`. The
  generated `ProducerOutputs`, `Inputs` and `JoinOutputs` no longer hold a `this-workflow` entry.

## Unreleased — the tree's concurrency cap (#264, PR 2)

- **`@Workflow({ maxConcurrentExecutions })`** works ([FinOps → Concurrency of a tree](FinOps#concurrency-of-a-tree-264)):
  the root's value (default 10) caps how many executions of its tree work at once; a step without a
  slot waits in the tree's queue — no error. A slot is held only while an agent, a router or an
  action runs (an execution's parallel branches share one); at a join, while its child runs or paused
  an execution holds none.
- **The queue's order**: a parent closing its branch, then the deepest; `seconds(10)` of waiting
  counts as one level deeper (the `Clock`). A child's own smaller cap limits its subtree.
- **A quorum's `deadline`** excludes the time its branches wait in the tree's queue; a
  `QuorumNotReachedError` past it names the effective deadline (`the deadline passed
  (2026-01-05T09:01:10.000Z: the ticket's deadline plus 40 s in the tree's queue)`).
- **New rules**: `[limits.max-concurrent-executions-invalid]` (not a whole number from 1, an error),
  `[limits.child-concurrency-above-parent]` (a child's cap above its parent's, a warning).
- `agboss describe` prints `maxConcurrentExecutions N (set | default)` for a workflow that launches
  children; `describe --json` limits carry `maxConcurrentExecutions` and `isMaxConcurrentExecutionsSet`.

## Unreleased — concurrency, instances and unit runners (#262, PR 3)

- **Parallel branches in tests** ([Testing → Parallel branches](Testing#parallel-branches--testconcurrency)):
  `testWith(App, { concurrency })` — **`TestConcurrency.Sequential`, the new default**: the branches
  of a launch run one at a time, in listed / item order; `TestConcurrency.Real` runs them as
  production does (within `maxConcurrency`); `TestConcurrency.inOrder([step(A), step(B, partial)])`
  makes them complete in that order through completion gates (`step(Node, partial?)` takes the
  matcher of `when(…)`). A step waiting at its gate is cancelled at once by a `FailFast`, a decided
  quorum or `app.cancel`; when no branch can move and the next step is not waiting, the execution
  fails at once with `test.unreachable-step`; a listed step never reached fails the test at its
  end. **Breaking for tests:** a test that relied on branches running at once (a sliding window, a
  surplus answer, an agent waiting for its siblings) sets `concurrency: TestConcurrency.Real`.
- **Unit runners** ([Testing → Unit runners](Testing#unit-runners--one-component-on-its-own)):
  `testTool`, `testAction`, `testRouter`, `testArbiter`, `testRag`, `testJudge`, `testGuardrail`
  and `testPii` — one component on its own container (`overrides: [override(Class,
  Replacement)]`, `environment`), every call in its step's frame (`executionContext.signal` with a
  `timeout` on the runner's `VirtualClock`, `run.clock`; `SpendRecorder` and its model calls into
  `spend`), its model by script (`model: decideWith(…)`, `replyWith(…)`, `routeTo(…)`); a call gives
  `{ output, spend }` and rejects as the component threw. The calls run for the tenant and execution
  values given — `{ tenantContext, tenant, executionContext, execution }`, as `testExecutionContext`
  takes them, validated the same way. `testPii([Policies])` checks the
  policies' own rules first (`-pii-policy`) and gives `mask(text)` / `reveal(text)`. The
  `agboss create` / `agboss generate tool` / `agboss generate openapi` tool tests use `testTool`.
- **`testWith(App, { instances: 2 })`** is the documented way to test across instances: one store
  set, one clock, a container each — a lease, a pause resumed on the other instance, a rate-limit
  slot ([Several instances](Several-instances#testing-several-instances)).
- **`testWith(App, { overrides: [override(Class, Replacement)] })`** (#267 S104): a class replaced
  by a class in the application's container, over any listed one — a channel role answered by
  `override(RefundApprovalRole, AutoApproveChannel)` (the replacement's `send` must fit the role).
  `AutoApproveChannel` / `AutoRejectChannel`'s `send` now gives `DecidedOutcome<AutoDecision>`
  (`approved`, `reason`), so they fit any role that approves a tool.
- `GuardrailContext` is exported from `agboss` (the context `testGuardrail`'s hooks take).
- New page [The test split](Test-split): unit tests with scripts → evaluation and golden sets →
  `make smoke`; no test calls a real model.

## Unreleased — recursion and the soft stop (#264, PR 1)

- **`ThisWorkflow`** ([Workflow as a step → Recursion](Workflow-as-a-step#recursion-264)): a workflow
  launches itself — `.toWorkflow(ThisWorkflow)`, `route(ThisWorkflow)`, `.toParallelWorkflows(ThisWorkflow,
  …)`; the node `this-workflow`, run from the registry (Studio: `recursive: maxDepth N`).
- **`@Workflow({ maxDepth })`** required on a recursive workflow (`[graph.recursion-without-depth]`);
  the root is depth 1, `ChildExecutionRecord.depth` and each child's trace metadata carry it.
- **The soft stop** on the last level: an agent's recursive variants leave its schema, a model
  router's recursive routes are hidden, a code router returning one is `RouterDecisionError`; every
  such branch keeps an exit (`[graph.recursion-without-exit]`).
- **`DepthLimitExceededError`** (`limit.depth`; `workflow`, `maxDepth`, `depth`): a launch by code
  past `maxDepth` does not start; the level above gets it as the `cause` of `ChildExecutionFailedError`.
- **`[graph.mutual-recursion]`**: mutual recursion, a flow naming its own class, a class undefined
  while the flow is built. **`[types.this-workflow-outputs]`**: recursive workflows of one project
  with different finish classes (removed in PR 3).
- `agboss describe`: the `recursive:` line, per-item child results counted (`this-workflow ×0–5`);
  the worst case counts the levels down to `maxDepth`.

## Unreleased — child workflows at run time (#263, PR 2)

- **Children run** ([Workflow as a step](Workflow-as-a-step#at-run-time)): `flow.child-not-runnable`
  is removed. A child is a node of its parent whose subgraph is the child's compiled graph (Studio
  draws it inside), on the parent's checkpoint thread under its task's `checkpoint_ns`; its own
  `executionId`, kept in its state across a pause, a restart and a crash (no second
  `onExecutionStart`); its own path, steps and `maxSteps`; no thread history; the parent's thread,
  `ownerId`, tenant and execution fields inherited; the root's budgets spent (a child workflow's own
  execution budget applies only as a root). A child need not be listed in
  `@Application({ workflows })`: collected transitively, it goes through every application rule a
  listed one does (names, models, DI and infrastructure, channel roles), budget coverage aside.
- **PII tokens** (#120): a child starts with its parent's tokens and gives its own back — with its
  value, or with its error (into the parent's state, never on the error) to the side path that
  takes it, a per-item child's too.
- **`ChildExecutionFailedError`** (`step.child`, a `StepFailedError`: `cause`, `childExecutionId`,
  `itemIndex`, `workflow`): an uncaught error of the child, its own `maxSteps` / `maxVisits`
  included; budgets and cancellation pass through unwrapped (S25). `PaidStepError` stays the base of
  `StepFailedError` (`step.failed`, #273 S71).
- **`toWorkflow(W)` side-path starter** (S85): `.onError(E, toWorkflow(W)…)`, also in `.onJoinError`.
- **Records**: `result.children` / `result.record.children` (`ChildExecutionRecord`,
  `ChildExecutionStatus`), `result.handledErrors` (`HandledErrorRecord`); observer events carry
  `parentExecutionId` / `rootExecutionId`; `executionContext.parent`, `root`, `depth`, `itemIndex`,
  `executionOf(W)` read the tree; `ExecutionTreeRepository` keys are the root's.
- **Pauses inside a child** (#267): the root's — in `result.pending` with `childExecutionId` and, per
  item, `itemIndex`; several children may wait at once; resumed by `pauseId` like any other.
- **Testing**: `toHaveChildExecutions(W, [...])`, `toHaveHandledError(E, { at, by })`.
- **The worst case** of a start counts its child executions (`maxItems` × the child's, at most
  `maxConcurrency` at once) and their depth.
- **Example**: `examples/flow-patterns/src/vendor/` — a child workflow per vendor.

## Unreleased — pauses and resume (#267, PR 2)

- **Several pauses at once** ([Pauses](Pauses)): a paused branch of a parallel launch does not stop
  its siblings; the execution rests when nothing else can move. **Breaking:**
  `ExecutionOutput.pause` → **`pending: readonly PendingPause[]`** (`pauseId?`, `answeredBy`,
  `agent`, `channel`, `itemIndex`, `childExecutionId`, `ask` — the `ToolCallApprovalAskDto`),
  empty unless paused; `ExecutionPauseEvent.pause` → `pending`, fired only when the execution
  rests (again after a partial resume).
- **Breaking — resume by pause id:** `app.resume(threadId, decision, { tenantId, ownerId })` →
  **`app.resume({ pauseId, decision }, { tenantId, ownerId | answeredBy })`** (`ResumeRequest`,
  `ResumeOptions = ThreadOwnerResumeOptions | ChannelResumeOptions`). The pause is found by
  `(tenantId, pauseId)` anywhere in the tree; unknown or another tenant's → **`UnknownPauseError`**
  (`pause.unknown`); with others left the execution pauses again with the rest. A
  `PauseAnswerer.ThreadOwner` pause lists its id and takes `ownerId`; a `PauseAnswerer.Channel` pause
  takes a non-empty `answeredBy` (recorded on the pause and in `onExecutionResume`, new field
  `answeredBy`) and its id is only in the channel's `ask.pauseId`; the other credential →
  **`PauseAnswererError`** (`pause.wrong-answerer`). A concrete `@Channel` named as is answers as the
  thread's owner. The CLI, the MCP `resume_workflow` tool (`{ pauseId, decision }`) and the A2A
  adapter (`resume({ pauseId, decision })`, `POST /resume { pauseId, decision }`, the response's
  `pauseIds`) follow.
- **Breaking — `ToolCallApprovalDecisionDto`** is `{ approved, reason?, overrideArguments? }`: `by`
  is gone (who answered comes from the resume), `feedback` → `reason`; `overrideArguments` only
  with `approved: true` and a valid input of the tool — on `resume` (the pause keeps waiting) and on
  `ChannelOutcome.decided(…)` (the step fails).
- **Breaking for your own `PausedExecutionRepository`** (#267 S35): `PausedRun` keeps the run and
  its versions only; each pause is a `PauseRecord` of its own, keyed by its step's idempotency key —
  `findOrCreateByStepKey`, `findByTenantIdAndPauseId`, `findAllByTenantIdAndRootExecutionId`,
  `markSentByTenantIdAndPauseId`, `resolveByTenantIdAndPauseId` (atomic `Pending → Resolved`),
  `cancelByTenantIdAndPauseId`, `markTakenByTenantIdAndPauseId`, `deleteByTenantIdAndPauseId`;
  `resolveByTenantIdAndThreadId` is removed. `PauseStatus` gains `Taken` and `Cancelled`.
  `SqlitePausedExecutionRepository` adds a `pauses` table and drops the old `status` / `decision`
  columns of `paused_executions` (a pause written before cannot be answered by id).
- **Concurrent answers** (Q58): one `Command({ resume })` per pass maps every answered pause;
  the holder drains decisions recorded meanwhile; a double click → `NotPausedError`; a reply that
  lands while `send` is returning is taken at once. **`FailFast` withdraws paused siblings'
  pauses** (`Cancelled`; a late answer → `NotPausedError`); so does `app.cancel` and the end of a
  tree. The join after a withdrawal gets the branch's own error object (`.onJoinError(E, …)` by
  class and cause chain); a channel's `send` that throws fails the agent's step (`AgentFailedError`,
  the channel's error as `cause`).
- **Spend while several loops are paused**: the execution's spend and the ledger hold every
  paused loop's spend, summed, each once; a resume records nothing twice.
- `resumeAgent(paused, resume, deps)` (internal wiring) takes the tree's answers (`TreeResume`)
  instead of one decision.

## Unreleased — scripts and matchers (#262, PR 2)

- **`when(…)`** on `mockLlm(X)` ([Testing](Testing#binding-turns-to-the-input--when)): turns bound to
  the node's input values, `PartialValues<InputOf<X>>` — values only, `undefined` for an absent
  field, lists by length and position, `variant(XDto, { … })` for a `oneOf` element (`variant` takes
  a partial value there). A call no script matches fails naming its input (`test.no-matching-script`).
- **Scripts are expectations**: a `thenReturn` turn no call took, a `when(…)` nothing matched or a
  scripted tool failure never caused fails a test whose body passed (`test.unused-script`;
  `thenReturnAlways` never does). **Breaking for tests** that scripted turns their run never reaches:
  drop them, or use `thenReturnAlways`.
- **Typed scripts**: `replyWith(XDto, fields)` must be a class of the agent's output and
  `routeTo(...targets)` follow `Route<R>` — one target after `.chooseOne(…)`, the `OnDemand`
  targets (or none, with an `Always` route) before `.toParallelAgents(…)`, which `routeTo(…)` now
  scripts too. The generated `RouterAnswers` has an entry for every router, model routers included.
- **`waitFor(duration)`**: the next turn answers only after that long on the test's clock.
- **A caller's own thread id** ([App](App)): `app.execute(Start, input, { threadId })` with an id
  the tenant does not have yet creates that thread — keyed by `tenantId` + `threadId` (the same id
  in another tenant is another thread), bound to `ownerId`, created only once the budgets pass.
  Before, it was `UnknownThreadError`; that stays for `cancel` of an unknown thread. A bad id
  (empty, over 200 characters, a control character) is the new `InvalidThreadIdError`
  (`run.invalid-thread-id`). **Breaking for your own `ExecutionRecordRepository`:**
  `createThread({ workflow, tenantId, ownerId?, threadId? }: NewThread)` takes one object and
  returns the thread's id; every read by thread names both values — `lastTerns(tenantId, threadId,
  limit)`, `uncovered(tenantId, threadId)`, `before(tenantId, threadId, ternId, limit)`,
  `turnNumber(tenantId, threadId, ternId)`, `latestSummaries(tenantId, threadId, limit)`,
  `summaryCount(tenantId, threadId)`; a `Summary` and a `MemoryTurn` carry `tenantId` next to
  `threadId`. The SQLite thread store's migration 11 keys threads by `(tenant_id, id)`
  (owners, Terns and summaries by `(tenant_id, thread_id)`); existing threads are `default`'s and
  keep their ids.
- **`mockAction(A)`** (the action still runs) and **`mockTool(T).thenFail(ToolFailure.Timeout)`**;
  the call matchers **`toHaveBeenCalledWith`**, **`toHaveBeenCalledTimes`**, **`toHaveReturned`** on
  `mockLlm(X)` / `mockAction(A)` (Vitest's own on anything else) and `mockLlm(X).inputs`.
- **Breaking — `toFailWith(ErrorClass, { …fields, cause })`** replaces `toFailWith({ code, node })`
  (`ExpectedFailure` removed): `toFailWith({ code: "step.action" })` →
  `toFailWith(ActionFailedError)`, `{ node: MainRouter }` → `toFailWith(RouterFailedError, {
  nodeId: nameOf(MainRouter) })`, a budget by its name → `toFailWith(BudgetExceededError, { budget:
  { name: "tenant-daily-budget" } })`. The root `ErrorClass` takes the error's type
  (`ErrorClass<TError>`).
## Unreleased — optional environment variables (#266 S87, S90)

- **`env.optional("X")`**, `env.integer.optional("X")`, `env.flag.optional("X")` — a variable that
  may be unset: typed `T | undefined`, unset → `undefined` (not a missing variable), a set value
  still checked; `agboss check --env` marks it `(optional)` ([Environments](Environments#the-environments)).
  New public type `EnvironmentValueReader<T>`; `EnvironmentVariableReader` extends it.
- **The base-URL field repeats no default**: `openRouterBaseUrl: env.optional("OPENROUTER_BASE_URL")`
  — unset → the decorator's `baseUrl` ([Model providers](Model-providers)); job-scout and
  `agboss create` declare it this way.

## Unreleased — PII policies and the model boundary (#120, PR 1)

- **`@PiiPolicy` is rebuilt** ([Guards → PII policies](Guards#pii-policies)): declarative
  `{ name, description, rules: [pii(PiiKind | PiiGroup, PiiAction.…)], detectWithModel?, pseudonymKey?:
  secret("…") }`, or a project's own detector `{ name, action, deps }` + `implements
  PiiPolicyHandler` (`findMatches(text)` → `PiiMatch { start, end }`). **Breaking:** the
  `PiiPolicy` interface (`mask` / `maskJson`) is removed; names end with `-pii-policy`.
- **Actions** `PiiAction.replaceWithKind()`, `replacePart({ keep… } | { pattern })`,
  `replaceWithToken()` (HMAC-SHA256), `blockWithRefusal({ refusal } | ())` + `PiiRefusal`;
  `PiiRefusedError` (`pii.refused`), `PiiDetectionFailedError` (`pii.detection-failed`).
- **Levels**: `@Application({ piiPolicies })` (new) → `@Workflow` → `@Agent` / `@Router`; the lists
  add up, `excludePiiPolicies` removes. **Breaking:** `overridePiiPolicies` / `disablePiiPolicies`
  are removed, and so are the PII policies of `@Tool` (a tool sees real values; its agent's
  policies close its result). Assembly rules `[pii.conflicting-rules]`, `[pii.exclude-not-inherited]`,
  `[pii.missing-refusal]`, `[pii.unused-refusal]`, `[pii.kind-needs-model]`, `[pii.not-a-policy]`.
- **The model boundary** masks everything a model reads and reveals its moves before validation;
  the token map is the execution state's `piiTokens` channel (S38, replaces #121's store).
- **Observability**: events, the log, Langfuse spans and `result.record` are masked by the
  application's and the workflow's lists ([Observability](Observability#pii-in-events-logs-traces-and-the-record));
  **breaking:** `onPiiPolicyStart` / `onPiiPolicyEnd`, `OnPiiPolicyStart` / `OnPiiPolicyEnd`,
  `PiiPolicyStartEvent` / `PiiPolicyEndEvent` and `PiiPolicyPayload` are removed — an observer that
  implements one of the hooks fails assembly with `[observer.unknown-hook]`; delete the method
  (there is nothing to migrate to: masking happens at the model boundary, not in a hook).
- **Breaking — `sensitive: true | { kind }`** is replaced by `sensitive: PiiAction.…` (masking
  actions) on DTO and context fields; `WorkflowStartTextDto.author` is `replaceWithToken()`; a channel
  shows such a field through its action instead of `***`.
- **`@Application({ pseudonymKey: "piiPseudonymKey" })`** names a `Secret` field of the environment
  ([Environments](Environments#the-pii-key)): the HMAC key of `sensitive` fields, project detectors and
  every policy without its own key (now optional) — one token per value on every instance. A
  policy's own key wins; a policy that needs the application's when none is set fails the start; a
  field the contract lacks is `[environment.missing-field]`.

## Unreleased — channel roles and discovery (#267, PR 1)

- **Channels are found through the tools that name them** ([Tools → Approval channels](Tools#approval-channels)):
  **breaking — `@Workflow({ channelClasses })` is removed**; one channel instance per application.
- **`@ChannelRole`** — a project's abstract class (`extends ChannelOf<Self>`) with `approves: XDto`
  or `ask` / `answer`, a required `answeredBy: PauseAnswerer.ThreadOwner | PauseAnswerer.Channel`
  and an optional `replyInterpreter`; its one implementation (`@Channel`, `extends` the role) is
  listed in `@Application({ providers })`. New assembly codes: `[channel.wrong-tool]`,
  `[channel.shared-interpreter]`, `[channel.role-form]`, `[di.missing-implementation]`,
  `[di.ambiguous-implementation]`; a `@Channel` in a workflow's `providers` is
  `[di.infrastructure-in-workflow]`.
- **Breaking — the channel contract**: one method, `send(ask: ChannelAsk<Role>): Promise<ChannelOutcome<Role>>`
  (`ask = { pauseId, value }`, typed by the generated `ChannelRoles`), returning
  `ChannelOutcome.awaitReply()` (pause) or `ChannelOutcome.decided(decision)` (no pause).
  `requestApproval`, `ChannelRequest` and `ChannelDecision` are removed.
- **Breaking — `InboundChannelAdapter` and `SemanticInboundChannelAdapter` are removed** (and
  `@Channel({ inboundAdapter })`): `app.resume(threadId, decision)` takes the
  `ToolCallApprovalDecisionDto` itself until free-text replies come with #267 PR 3.
- `AutoApproveChannel` / `AutoRejectChannel` now decide at once (`decided`) — no pause.

## Unreleased — rate limits and retries, provider keys in the environment (#266, PR 2)

- **`rateLimitPolicy`** on `@ModelProvider` ([Model providers](Model-providers#ratelimitpolicy)):
  `RateLimitPolicy.of({ maxConcurrentCalls?, perMinute?: { calls?, tokens? }, balancing? })` — one
  limit for the whole application, every execution, tenant and instance, its state in
  `RateLimitRepository`. A call without room waits (its signal ends the wait — `app.cancel` with `ExecutionCancelledError`; the attempt's `timeout`
  starts with the room); waiting tenants share free slots by `QueueBalancingStrategy`
  (`TenantRoundRobin` default, `TenantLeastInFlight`, `TenantWeighted` by `tenant.weight`, `Fifo`); a
  429 pauses the provider's whole queue for `Retry-After` (else the retry delay) on every instance,
  then halves the instance's concurrency, back by one a minute (AIMD). No policy → no limit.
- **`retryPolicy`** is the only backoff; a wait between attempts holds no slot.
- **`RateLimitRepository`** gets windows and pauses: `addToWindow`, `clearWindow`, `pauseUntil`,
  `pausedUntil` — abstract, so **breaking for your own implementation** (in memory and
  `SqliteRateLimitRepository` implement them; a SQLite file gets two new tables on open)
  ([Several instances](Several-instances#a-model-providers-rate-limit-across-instances-266)).
- **Breaking — the circuit breaker's state** is in `RateLimitRepository` (an open breaker holds on
  every instance) and on the application's `Clock`: `CircuitBreaker` takes
  `(provider, policy, { rateLimits, clock })` and its methods are async; `CircuitBreakers` and the
  process-wide breakers are removed.
- **Breaking — provider keys are `Secret`s of the environment**: `apiKey` names the field
  (`apiKey: "openRouterApiKey"`), set with `openRouterApiKey: secret("OPENROUTER_API_KEY")`;
  a base URL may come from a text field too (`baseUrlField: "openRouterBaseUrl"`,
  `env.optional("OPENROUTER_BASE_URL")` since S90). **`EnvironmentVariable`**, `MissingEnvironmentVariableError`,
  `SettingValue`, `OPENROUTER_API_KEY` and `OPENROUTER_BASE_URL_SETTING` are removed — `env()` /
  `secret()` are the one way to read a process variable ([Environments](Environments#secrets)).
- **`agboss check` without `--models` needs no secret values** (it reads the contract's shape);
  `--models` connects and fails on a missing secret, naming its variable.
- **Breaking — provider names end with `-model-provider`** (`[name.kind-suffix]`): the built-ins are
  `openrouter-model-provider` and `decisions-model-provider` (in `describe`, the startup log and
  model problems).

## Unreleased — quorums at run time (#279, PR 2)

- **Quorums run** ([Parallel → At run time](Parallel#at-run-time)): decided in the launch's
  superstep as answers arrive — each branch's arbiter chain in its slot and frame, the answer
  recorded at once (`BranchVerdict.Counted` with `acceptedSequence`, `Rejected` with `rejectedBy`,
  `Surplus`), the rest cancelled once the quorum is fixed; the join decides from the records (counted
  answers in counting order, the winning group's own path). `flow.quorum-not-runnable` is removed.
- **New errors**: `QuorumNotReachedError` (`step.quorum`) and `ArbiterError` (`step.arbiter`), both
  `StepFailedError`s, taken by `.onJoinError(E, …)`; `QuorumShortfall`.
- **Deadline** on the application's `Clock`: `deadlineAt` at dispatch, kept in the launch's ticket; a
  pause counts. After a resume or a crash the quorum is rebuilt from the finished branches' records;
  an expired deadline cancels the rest without running it.
- **Under a quorum** a branch's own step failure is `Skipped` (its place stays empty) whatever the
  route's failure policy; an `ArbiterError` or a limit fails the launch.
- **Model arbiters**: one decision per answer under `arbiter:<name>` (`answer-arbiter` on a chat
  model), budgets checked before each call; their prompts and criteria in the prompt version, their
  model a model use (`arbiters.<name>`). Code arbiters are created by the container at start.
- **Shown**: `LaunchRecord.isQuorumReached`, `LaunchRecord.group` (`QuorumGroupRecord`),
  `BranchRecord.verdict` / `acceptedSequence` / `rejectedBy`; trace entries; the hook
  `onQuorumDecided` (`OnQuorumDecided`, `QuorumDecidedEvent` — a node event, `step` the launching step).
- **Testing**: `mockLlm(ModelArbiter).thenReturn(decideWith({ counts: 0.9 }))`.
- **CLI**: `agboss generate arbiter <name> --workflow … [--agent …]` — a code arbiter with one
  `@OnAnswer` method per agent of a launch.

## Unreleased — logging, observers, describe (#261, PR 6; #269)

- **Breaking: observers are registered only in `@Application({ observers })`**
  ([Observability](Observability)); `@Workflow({ observers })` is removed (does not compile). One
  manager per application instance, for every execution of every workflow.
- **Breaking: hooks are named after executions** — `onExecutionStart`, `onExecutionEnd`,
  `onExecutionPause`, `onExecutionResume`, `onExecutionError`, `onExecutionRejected` replace
  `onWorkflowStart` / `End` / `Pause` / `Resume`, `onError` and `onRunRejected` (interfaces
  `OnExecution…`; events `ExecutionStartEvent`, `ExecutionEndEvent` — `finish`, `spend`, once per
  execution at a finish — `ExecutionPauseEvent`, `ExecutionResumeEvent`, `ExecutionErrorEvent`,
  `ExecutionRejectedEvent`).
- **Breaking: one event object per hook, no `AppState`** (removed): every execution event extends
  `ExecutionEvent` (`executionId`, `parentExecutionId`, `rootExecutionId`, `threadId`, `tenantId`,
  `workflow`); node events extend `NodeEvent` and add `step` (`StepRecord`). `ValuesOutdatedEvent`
  and `LaunchItemsTruncatedEvent` gain `tenantId`.
- **Breaking (#269): `ExecutionOperation.Execute | Resume | Cancel`** in
  `ExecutionRejectedEvent.operation` replaces the strings; the event carries `tenantId`.
- **Breaking: the untyped `executionContext` / `metadata` execute options are removed**, with
  `ChannelRequest.metadata` / `.executionContext`, `GuardrailContext.metadata` / `.executionContext`
  (no longer generic) and `RunContext.metadata`: components read the typed contexts through an
  injected `ExecutionContext`; `McpService.connect(transport, session?)` / `handleSse(res, endpoint,
  session?)` take `McpSessionOptions` (`tenant`, `execution`, `ownerId`); `A2ACallOptions` is
  `signal`, `ownerId`, `tenant`, `execution`.
- **New: the `Logger` contract** (infrastructure; `ConsoleLogger` by default, `LogLevel`,
  `LogEntry`, `formatLogEntry`) replaces `process.emitWarning` (`execution.recovered`,
  `recovery.incompatible`, `recovery.failed`, `app.close-failed`, `observer.failed`); in tests an
  unlisted logger is silent. `ExecutionObserverManager`'s default failure listener no longer warns.
- **Breaking: renames to executions** — `WorkflowObserver` → `ExecutionObserver`,
  `ObserverManager` → `ExecutionObserverManager`, `WorkflowCancelledError` →
  `ExecutionCancelledError` (code `workflow.cancelled` → `execution.cancelled`); `agboss migrate
  imports` rewrites the imports.
- **New: `nameOf(C)`** — the `name` of any AGBoss-decorated class (its literal type where the
  generated types brand it), for filtering serialized events and records.
- **New: the start log** — what started and the worst case of one call of each start; no
  `maxSpend()` at start, nothing per tenant; `testWith` logs none of it.
- **New: assembly warnings** `[application.in-memory-cost-ledger]`, `[application.in-memory-pauses]`
  — in `app.warnings` and the start log, errors under `agboss check --strict`; `agboss check` runs a
  new `application` check. The CLI's `run` / `chat` no longer print `app.warnings` themselves (the
  start log has them).
- **New in `agboss describe`**: the application — each contract's implementation and why, budgets
  by scope with their periods, the workflow's execution budget, observers, warnings — and a
  `limits` section (`maxSteps` set or default, `maxVisits`, worst cases); `--json` adds
  `application` and a richer `limits`.
- flow-patterns lists `SqliteCostLedgerRepository` (environment `sqlitePath`) so its strict check
  passes.

## Unreleased — quorums in the grammar and the analyser (#279, PR 1)

- **New: quorums** ([Parallel](Parallel)): after `.toParallelAgents(…)`,
  `.joinQuorum({ min, max, deadline })` (options always an object; `max` defaults to `min`) and
  `.joinQuorumGroups(group(A, B).priority(n).returns(…).to…(…), …, { deadline })` — every group
  continues its own path, nothing follows the groups but `.onJoinError(…)`. New builder names:
  `group`, `anyOf`; types `Quorums`, `QuorumJoined`, `GroupsJoined`, `GroupStart`, `GroupValues`,
  `GroupPath`, `GroupHead`, `AgentsLaunched`, `QuorumOptions`, `QuorumGroupsOptions`,
  `AnyOfArbiters`, `ArbiterChoice`; AST `QuorumKind`, `CountQuorum`, `GroupsQuorum`, `Quorum`,
  `QuorumGroup`, `AcceptedBy`, `ArbiterClass` (`LaunchStep.acceptedBy`, `JoinStep.quorum`).
- **New: `@Arbiter` and `@OnAnswer(Agent)`**, attached with `.acceptedBy(X)` (a chain is an AND,
  `anyOf(X, Y)` the first that accepts, S57): by model (`criteria` per agent) or by code (one
  method per agent class, typed by the decorator). New `@agboss/core/units`: `hours()`.
- **What `.returns(…)` may promise**: after `.joinQuorum({ min })` with `min` below the agents
  launched a single answer is `optional(XDto)` (compile error and `[flow.quorum-return-not-optional]`
  otherwise); a repeated class or a shared `output` is `listOf(XDto)` in every form; a group's
  agents are required in its `.returns(…)` (`JoinOutputs["<launch> group(<agents>)"]`).
- **New rules**: `[flow.quorum-impossible]`, `[flow.quorum-return-not-optional]`,
  `[arbiter.not-an-arbiter]`, `[arbiter.unhandled-agent]`, `[arbiter.unknown-agent]`,
  `[arbiter.duplicate-agent]`, `[arbiter.answer-method-on-model]`, `[arbiter.method-name]`;
  `[input.missing-on-path]` names the agent a quorum may leave out and the fix.
- `agboss describe` prints quorums and counts a quorum list's producers (`critic-agent ×1–2`).
- A workflow with a quorum did not assemble until #279 PR 2 (`flow.quorum-not-runnable`, removed there).
- `@QuorumRouter`, `QuorumStrategy`, `QuorumManager` and `.joinQuorum(n)` stay removed (AC11).
## Unreleased — budgets and limits at run time (#261, PR 5)

- **Budgets are checked** ([FinOps](FinOps#budgets)): every execution's budgets — its workflow's
  own execution budget (else the default), every tenant budget, every application budget — have
  their `maxSpend()` read once, at its start, in its `ExecutionContext`, and kept in its state for
  the whole execution (a resume and a recovery count against the same amounts). Before the first
  step an exhausted one **rejects** the execution (`BudgetExceededError`, `onRunRejected`) leaving
  no trace — no thread (a new thread is now created after the check), no record, no call; every model call's cost is then counted in all of them, and before every step and model
  call the first exhausted stops the execution. Nothing is reserved (#202's holds are gone): a small
  overrun on a race, or by one call, is accepted.
- **New assembly rules**: `[budget.execution-budget-required]`, `[budget.duplicate-execution-budget]`,
  `[budget.duplicate-default-execution-budget]`, `[budget.tenant-budget-required]`,
  `[budget.application-budget-required]` — every application lists an execution budget for every
  workflow (own or the default), a tenant and an application budget.
- **Breaking — `settings().limits` is removed**: `WorkflowSettings.builder().limits(…)`,
  `WorkflowLimits`, `PerRunLimits`, `PerDayLimits`, `PerRunLimitRequiredError`
  (`[limits.per-run-required]`), `WorkflowSettingsError`, `LimitKey`, `SpendAccount` and
  `RunOptions.account` are gone; money is `@Budget`s only. `settings()` keeps `onIncompatibleResume`.
- **Breaking — the limit errors** ([FinOps](FinOps#steps-and-visits)): `StepsLimitExceededError`
  (`limit.steps`: `workflow`, `maxSteps`, `steps`; `support-workflow took 41 steps; its maxSteps is
  40`) for `maxSteps`; `BudgetExceededError` names its budget — `budget` (`{ name }`), `scope`, `key`
  (the application's name, the `tenantId`, the execution's id), `maxSpend`, `spent`, a sentence
  (`tenant acme spent $40.05 today; tenant-daily-budget allows $40`) — instead of the keys
  `limits.perRun.cost` / `limits.perDay.cost`. `toFailWith({ code })` matches a budget by its name.
- **Breaking — `CostLedgerRepository`** counts per budget, scope key and period:
  `findSpentByCounter(counter)`, `saveAll(counters, records)`, `findMaxSpendByAccount(account)`,
  `saveMaxSpend(account, maxSpend)` (new types `BudgetAccount`, `CostCounter`; were
  `findSpentToday(key)` / `saveAll(key, records)`). The ledgers read no time any more — the runtime
  names each counter's period from the application's `Clock` — so `InMemoryCostLedgerRepository()`
  and `SqliteCostLedgerRepository(connection)` take no clock. `SqliteCostLedgerRepository` drops the old
  per-workflow day table of a file written before (#265 S69 e).
- **`maxSteps` and launches** (#273 S68 f): the default (agents + routers) × 3 must hold the worst
  case of a per-item launch (`maxItems` runs) — else `[limits.max-steps-too-low]`; set
  `@Workflow({ maxSteps })`. `.onError(StepsLimitExceededError, …)` (or a parent class) counts as a
  way out for the steps rules.
- **Eval / replay / compare** run within the application's budgets; the judge's calls count in the
  application budgets, held to their last known `maxSpend()` (the eval account `<workflow>:eval` is
  gone).
- `agboss describe`: `limits    steps 2–2 (maxSteps 12)` (no money there; budgets by scope come with
  PR 6).

## Unreleased — the clock (#262, PR 1)

- **`Clock` is public** (root `agboss`, an infrastructure contract): `now()` and
  `sleep(delay, signal?)`. Every time the framework reads and every wait it makes goes through the
  application's one clock — the ledger's day, records, leases and their renewals, the recovery
  sweep, the shutdown timeout, a tool's `timeoutMs`, a model call's timeout, retry backoff and
  `Retry-After` pauses. The system's clock unless `@Application({ providers })` lists a class that
  `extends Clock` (created first; it may not depend on the contexts); in a workflow's `providers`
  it is `[di.infrastructure-in-workflow]`. A component that needs the time injects it
  (`deps: [Clock]`). [Testing → The clock](Testing#the-clock).
- **`VirtualClock` is public** (`@agboss/core/testing`): the `clock` fixture and `app.clock` are one
  per test, the application's clock in every test (also when it lists its own); `new
VirtualClock(start?)` in unit tests. **Breaking:** the `TestClock` type is gone — `VirtualClock`
  in its place (`agboss migrate imports` rewrites the import); its `now` is a method, so
  `clock.now()` reads as before but `clock.now` is no longer a function to pass around.
- **Lint `agboss/no-direct-time`** fails `Date.now()`, `new Date()` / `Date()` without arguments,
  `performance.now()`, `setTimeout`, `setInterval`, `AbortSignal.timeout` and the `node:timers`
  modules in the framework's sources (`SystemClock` excepted).
- **`SqliteConnection` is a value export** (#265 S70): the DI token a subclass of a SQLite
  implementation names. **Breaking** for a project that constructs one of them itself: the
  constructors take `(connection, clock: Clock, applicationContext: ApplicationContext)` (the
  leases and rate-limit slots), `(connection, clock)` (the paused executions; the ledger takes `(connection)` since #261 PR 5) —
  [Several instances → Extending a SQLite implementation](Several-instances#extending-a-sqlite-implementation).
- **Breaking:** the `clock` option of `createApp` / `createAppDeps` (`AppOptions`, `AppDepsOptions`) is removed — one way to set the clock: list a `Clock` subclass in `@Application({ providers })`; tests get the `VirtualClock` from `testWith`.

## Unreleased — child workflows in the grammar and the analyser (#263, PR 1)

- **New: a workflow is a step** ([Workflow as a step](Workflow-as-a-step)): `.toWorkflow(W)`,
  `route(W)`, `workflow(W)` (the own path of a child reached from two places) and
  `.toParallelWorkflows(W, { maxConcurrency, maxItems })` (one child per item, `maxItems` required,
  joined like any launch; `WorkflowLaunchOptions`). Checked and typed by `agboss check`; a workflow
  with a child did not assemble until #263 PR 2 (`flow.child-not-runnable`, removed there).
- **The start is chosen per edge, by class**: one start → it; per item → the start taking the item;
  else the start taking the chain's current value, of several the one whose other required fields
  are on the path — `[graph.no-matching-start]` / `[graph.ambiguous-start]` otherwise, also compile
  errors through the child's `Inputs` entry. `agboss describe` prints each edge's start (`children`;
  `--json`: `children`).
- **The child's result** is its finishes' output classes (`ProducerOutputs`): `.returns(XDto)`, or
  `.returns(oneOf(…)).switch(…)` with one case per class; after a per-item launch the join gives
  `listOf(oneOf(…))` (`JoinOutputs` key `toParallelWorkflows(<child>) per item`). The child's scope
  starts with its start input only.
- **New rules**: `[graph.child-without-failure-finish]` (a warning, an error under `--strict`) and
  `[graph.limit-handler-uses-model]` — **breaking for flows that catch a limit**: an `.onError` /
  `.onJoinError` side path that can catch a `LimitExceededError` (its class, a subclass or a parent
  such as `AGBossError` / `Error`) now fails assembly when it reaches an agent, a router or a child.
- A workflow class mentioned as another kind (`toAgent(SomeWorkflow)`) is `[graph.wrong-kind]`, no
  longer `[graph.not-a-node]`.
- **New: `agboss check --strict`** — the analyser's warnings (`[flow.path-too-deep]`,
  `[graph.child-without-failure-finish]`) are errors (exit 3); flow-patterns' `npm run check` uses it.

## Unreleased — contexts (#261, PR 3)

- **The context levels** ([Context and Authorization](Context-And-Authorization#the-levels-261)):
  `ApplicationContext` (`name`, `version`, `instanceId`, `startedAt`, `environmentName`,
  `environment`, `host` — `HostContext`) → `TenantContext` (`tenantId`, `weight`, #266 S60) →
  `ExecutionContext` (new: `tenant`), each its type and its DI token. New public names:
  `ApplicationContext`, `HostContext`, `TenantContext`, `ContextValues<T>`, `TenantValues`,
  `TenantContextClass`, `ExecutionContextClass`, `CallOptions`,
  `ResumeOptions`, `ExecutionOptionsOf`, `ExecutionOptionsArgs`; `@agboss/core/testing`:
  `TestContextOptions`, `TestApplicationOptions`.
- **The project's subclasses**: `@Application({ tenantContext, executionContext })`; values per
  execution, `app.execute(Start, input, { tenant, execution })`, typed per start by the generated
  types (the `WorkflowStarts` entry names the start's `tenant` / `execution` classes, and a declared
  execution subclass's `tenant` is typed as the tenant subclass), validated before the first step
  (`dto.invalid`, `onRunRejected`), frozen, kept in the checkpoint. New rule codes:
  `[context.prompt-unused]`, `[context.not-declared]`.
- **Breaking — `ENV` is removed**: read the environment as `applicationContext.environment`
  (`deps: [ApplicationContext]`); `[di.missing-environment]` is gone (an application without a
  contract has an empty environment).
- **Breaking — the options are named like the context fields**: `app.execute(…, { threadId,
ownerId })` (was `thread`, `owner`), `app.resume(threadId, decision, { tenantId, ownerId })`,
  `app.cancel(threadId, { tenantId, ownerId })`; `ExecutionOutput.threadId` (was `thread`) and the
  new `ExecutionOutput.tenantId`.
- **Breaking — a thread belongs to its tenant**: its key is `tenantId` + `threadId`;
  `app.cancel` of a thread the tenant does not have throws `UnknownThreadError` (it answered
  `{ cancelled: false }`). The storage contracts take the tenant:
  `ExecutionRecordRepository.createThread(workflow, tenantId, owner?)`, `hasThread(workflow,
tenantId, threadId)`, `threadOwner(workflow, tenantId, threadId)`; every record carries
  `tenantId` (Tern store migration 10); `PausedExecutionRepository.findByTenantIdAndThreadId`,
  `resolveByTenantIdAndThreadId`, `deleteByTenantIdAndThreadId` (were `…ByThreadId`), keyed by the
  paused run's `tenantId`. Leases and tree keys use the execution's tenant (was always
  `"default"`); `holderInstanceId` is `ApplicationContext.instanceId`.
- **SQLite (#265 S69 e)**: `paused_executions` is keyed by `(tenant_id, thread_id)` and the
  `checkpoints` / `checkpoint_writes` rows carry `tenant_id` (the run's `configurable.tenant_id`); a
  file written before is migrated on first use, its rows in the tenant `"default"`.
  `SqliteConnection` reads `sqlitePath` from `applicationContext.environment`.
- **Traces carry the tenant**: a run's LangGraph `metadata` (`tenantId`, `executionId`,
  `rootExecutionId`, `threadId`, `workflowName`, `workflowVersion`) and `tags` (`tenant:<id>`), the
  Langfuse trace's tag `tenant:<id>` and metadata `tenantId`; `TraceContext.tenantId`.
- `testExecutionContext({ tenantContext, tenant, executionContext, execution, application })`.

## Unreleased — model providers as infrastructure (#266, PR 1)

- **Model providers are the application's** ([Model providers](Model-providers#register-them-in-the-application)):
  `@ModelProvider` classes are listed only in `@Application({ providers })` — none listed → the
  built-in `OpenRouterModelProvider` + `DecisionsModelProvider`; one listed → the list is complete,
  the built-ins are not added next to it. A `@ModelProvider` in a workflow's `providers` →
  `[di.infrastructure-in-workflow]`.
- **Breaking — no provider setting on a workflow**: `WorkflowSettings.builder().modelProviders(…)`,
  `.defaultModelProvider(…)` and `WorkflowSettings.models` are removed; move the list to the
  application's `providers`. `AssembledWorkflow.models` → `modelProviders` (the application's list).
- **Every model resolves to exactly one provider by `serves`, at assembly** — agents, model routers,
  the default router, guards, compaction, judges: new rule codes `[model.unserved]` and
  `[model.ambiguous-provider]` (all at once, before any model call). No default breaks a tie: one
  model through two providers is two model strings.
- **Breaking — `ModelProblemCode` `model.no-provider` → `model.unserved`**;
  `ModelProviderDirectory.of(classes)` takes no default provider (`byName`, `defaultProvider` gone).
- `agboss describe` prints `model: … → <provider>` for each model (`--json`: `models`);
  `agboss check --models` checks every model of every workflow of the application.

## Unreleased — parallel launches at run time (#273, PR 2)

- **Launches run** ([Workflow → Parallel launches at run time](Workflow#parallel-launches-at-run-time)):
  each branch is one LangGraph `Send` of one superstep, `maxConcurrency` a sliding window (a paused
  branch frees its slot), the join a node of its own reading only its launch's outcome records
  (launch id `${executionId}:${nodeId}:${visitNumber}`); the join's lists keep listed / item order.
  `flow.launch-not-runnable` is gone.
- **New: `StepFailedError`** (`step.failed`, #273 S22; lineage e.g. `[step.agent, step.failed, step]`) — a step's own failure, naming it: `component`,
  `nodeId` (`critic-agent#2` for a copy), `visitNumber`, `itemIndex`; `StepCoordinates`.
  **Breaking (class hierarchy)** — `AgentFailedError`, `GuardFailedError`, `RouterFailedError`
  (with `RouterDecisionError`) and `ActionFailedError` extend it instead of `PaidStepError`
  directly (still `PaidStepError`s); `AgentAnswerInvalidError`'s and `ActionFailedError`'s
  `component` / `nodeId` come from it, and every step error's record `details` now carries
  `visitNumber` (and `itemIndex` in a per-item run).
- **`FailFast` and `Skip`** (S21): a failed branch aborts its siblings (`BranchStatus.Cancelled`, their
  spend counted) and the join takes the most specific `.onJoinError(E, …)` by class and cause chain,
  else the execution fails with the branch's error; `FailurePolicy.Skip` drops only a
  `StepFailedError` — a limit in a `Skip` branch fails the launch; `app.cancel` during a launch
  cancels the whole execution (`WorkflowCancelledError`), never routed by the join.
- **One visit per launch**: every copy and item of a launch is the same visit of its node (the
  launch's `visitNumber`, told apart by `copyNumber` / `itemIndex`); `maxVisits` counts launches.
- **Router launches** (S23, #280 S47 f): a model router decides its `OnDemand` routes in one call —
  a `Decision.noul` per route on a decision model, one answer tool `answer-launch` with a boolean per
  route on a chat model; all no without an `Always` route → `RouterDecisionError`. A code router's
  `route()` list is launched beside its `Always` targets. Tests script both with
  `decideWith({ "<target>": P(yes) })` ([Testing → Parallel launches](Testing#parallel-launches)).
- **New: `result.launches`** (`ExecutionOutput.launches: LaunchRecord[]` — `launch`, `items`,
  `taken`, `branches: BranchRecord[]`), `BranchStatus`, and the hook `onLaunchItemsTruncated`
  (`OnLaunchItemsTruncated`, `LaunchItemsTruncatedEvent`) when a per-item launch dropped items past
  `maxItems` ([Observability → Parallel launches](Observability#parallel-launches)); a trace entry per
  ended branch (`critic-agent#2`, `company-check-agent[3]`), "launch items truncated" and "launch
  decision". Agent and action events name a copy by its copy id; `toFollowPath` takes the class for
  a copy. A list a join gathered from several agents names each element's producer
  (`ScopeValueRecord.elementProducers`).
- **Example**: `examples/flow-patterns/src/review/` — a section reviewer per section, a mapping
  action, then a style critic beside two fact checker copies.

## Unreleased — the SQLite implementations (#265, PR 3)

- **Every storage contract has a ready SQLite implementation**, enabled only by listing it in
  `@Application({ providers })`: `SqliteExecutionRecordRepository`, `SqliteCostLedgerRepository`,
  `SqlitePausedExecutionRepository`, `SqliteCheckpointSaver` (our own `BaseCheckpointSaver` on
  `node:sqlite`), `SqliteExecutionLeaseRepository`, `SqliteExecutionTreeRepository`,
  `SqliteRateLimitRepository` ([Several instances → SQLite](Several-instances#sqlite--several-instances-on-one-machine)).
  One connection per application instance on the environment's `sqlitePath` — required only when
  one is listed (`[environment.missing-field]`) — WAL, `busy_timeout`, atomic operations in
  `BEGIN IMMEDIATE`, time from the framework's clock.
- **Breaking for your own `ExecutionRecordRepository`**: a new abstract method
  `completeIfStatus(ternId, expected, outcome): Promise<boolean>` — a compare-and-set status write.
  A resume marks its paused record `running` with it, so a write that lands after the holder
  finished the tree no longer leaves a finished record `running` (#265 S66 h).
- **Cross-process persistence is back** for `--thread`, `agboss eval` / `replay` / `golden` when
  the application lists the SQLite implementations (#261 S49 b): a workflow run on its own
  (`createAppDeps`) now uses the infrastructure of the one application that lists it, not always
  the in-memory defaults. job-scout lists all seven (dev: `.agboss/job-scout.sqlite`,
  `AGBOSS_SQLITE_PATH`; tests: `:memory:`).

## Unreleased — parallel launches in the grammar and the analyser (#273, PR 1)

- **Launches** ([Workflow → Parallel launches](Workflow#parallel-launches)):
  `.toParallelAgents(A, B, B, { maxConcurrency })` and `.toParallelActions(…)`, a per-item launch
  (one target right after `.returns(listOf(XDto))`, `{ maxItems }` required), the mandatory
  `.join()`, `.onJoinError(ErrorClass, side path)` and `.join().returns(…)` — checked by the compiler
  against the new generated table `JoinOutputs` (`JoinOutputOf<Key>`) and by the analyser. New
  public types: `LaunchOptions`, `Launched`, `Joined`, `JoinErrorHandling`, `Launches`,
  `RouterLaunches`, `ValuesSource` / `StepValues` / `JoinValues`, the AST's `LaunchStep`,
  `JoinStep`, `JoinErrorHandler`, `LaunchTargetKind`; `StepKind.Launch`, `StepKind.Join`.
- **Breaking (types only) — `Returning<TSource, …>`** takes a values source (`StepValues<X>`,
  `JoinValues<Key>`) instead of a component instance; `AfterValue` and `RouterStep` have a new
  optional type parameter.
- **New rule codes**: `[launch.join-required]`, `[launch.max-items-required]`,
  `[launch.max-items-without-list]`, `[launch.item-not-read]`, `[launch.branch-continued]`,
  `[launch.branch-outdates-sibling]` ([Path scope → Parallel branches](Path-scope#parallel-branches),
  #271 AC9), `[router.spawn-required]`, `[router.prompt-on-always]`; `[router.no-prompt]` for an
  `OnDemand` route without prompt; `[router.all-routes-always]` now applies to router launches.
- **A model router states `spawn` on every route before a launch** (#273 S50,
  [Routing patterns → 6](Advanced-Routing#6-a-router-decides-who-is-launched)); a code router's
  `RouterAnswerOf<Self>` is a list when a launch follows it.
- `agboss describe` prints launches and joins; the steps checks count the copies that always run;
  the worst case of one call of each start is computed with the analysis.
- **Not run yet**: a workflow with a launch passed `agboss check`, but `createApp` stopped with
  `flow.launch-not-runnable` until #273 PR 2 (above).

## Unreleased — environments and defaults (#261, PR 4)

- **Breaking — environments are typed object literals**: the contract is a plain class with declared
  fields only (`environments/app.environment.ts`), declared once in
  `@Application({ environment: AppEnvironment })`; each environment is
  `export const environment: AppEnvironment = { … }` in `environments/<name>.environment.ts`.
  `defineEnvironment`, `fromEnv`, `FromEnv`, `FromEnvOptions`, `EnvironmentValues`,
  `EnvironmentDefinition` and the `declare module "@agboss/core" { interface Environment … }` contract are
  removed; `agboss check` writes `interface Environment extends AppEnvironment {}` into
  `.agboss/types.d.ts`, so `ENV` is typed by the contract ([Environments](Environments)).
- **New**: `env("X")`, `env.integer("X")`, `env.flag("X")` (each with `{ default }`), `secret("X")`
  and `Secret` (prints as `***` everywhere, `.reveal()` gives the value; a literal in a `Secret`
  field does not compile); `EnvironmentErrorCode` (`environment.not-found`,
  `environment.missing-variables`, `environment.invalid-value`, `environment.no-contract`). A missing
  variable fails the start as `DATABASE_URL is not set (AppEnvironment.databaseUrl, prod)`;
  `agboss check --env <name>` lists the variables it needs, marked value / secret.
- **Breaking — tests run on `test`**: `testWith(App)` loads `test.environment.ts` and fails without
  it (no fallback to `dev`); `testWith(App, { environment })` and `createApp(App, { environment })`
  are removed — name an environment with `env`. **Breaking — `@Application({ environment })` is
  required**: an application with no settings declares `environment: EmptyEnvironment` (new, a
  contract without fields), which needs no environment file (its environments are `{}`).
- **New assembly rules**: `[environment.contract-value]` (a value in the contract),
  `[environment.missing-field]` (a listed framework implementation's field missing from the
  contract), `[guardrail.no-model]`.
- **The `defaults` cascade**: `@Application({ defaults })` → `@Workflow({ defaults })` → the
  component's own field, merged field by field, the most specific level wins
  ([Configuration](Configuration#the-defaults-cascade--application--workflow--component-261)).
  **Breaking**: guards take `defaults.guardrail.model` (new), never `defaults.router.model` — a guard
  with no model anywhere fails with `[guardrail.no-model]`. `[router.no-model]` now reads
  `… uses DecidedBy.Model but has no model — set model or defaults.router.model`. `agboss describe`
  shows each router's model and each agent's temperature / maxTokens / history with where it came
  from (`(own)`, `(<application or workflow>)`, `(built-in)`).
- `loadWorkflow`, `studioGraphOf`, `compareProfiles` and `workflowOf` from `@agboss/core/testing` assemble a
  workflow in the application that lists it (its `*.application.ts` next to it or above): its
  providers and `defaults`.

## Unreleased — recovery and the graceful stop (#265, PR 2)

- **Recovery** ([Several instances → Recovery](Several-instances#recovery)): an execution's record
  is `ExecutionRecordStatus.Running` while its tree moves (new public enum, root entry: `Running`,
  `Answered`, `Guarded`, `Failed`, `Paused`); every instance looks for `running` roots at its start
  and every 30 s, takes the lease of one whose holder died or stopped and continues it from its
  last checkpoint (a resolved pause first) — only the interrupted step runs again. A root of another
  config is left to a compatible instance and logged once.
- **Breaking — `ExecutionRecordRepository`**: a new abstract `findByStatus(status, limit, after?)`
  (a page of the records with that status, oldest first). A record is now written when the run
  starts (`running`) and completed when it ends, instead of appended at the end.
- **Breaking — `WorkflowResumeEvent`** has a `reason: ResumeReason` (new public enum:
  `Answered` — `app.resume`; `Recovered` — recovery, `decision` only when it took one).
- **The graceful stop**: `app.close(options?)` stops the sweep, runs `onStop`, waits for the running
  executions up to the shutdown timeout — `@Application({ shutdownTimeout })`,
  `app.close({ timeout })` (`CloseOptions`), default `seconds(25)` — then interrupts them: the call
  rejects with `ApplicationStoppingError`, no `onError`, the lease released at once, the record
  left `running` for recovery ([App → app.close()](App#appcloseoptions)).
- **SIGTERM / SIGINT**: `createApp` calls `app.close()` on either (a second one interrupts at
  once); the listeners are removed when `close()` finishes, and the signal is raised again when
  nothing else listens. `testWith` never listens.

## Unreleased — the paths DSL revised: one value per `.returns`, `{ about }` in the flow, `historyOf` (#299)

- **Breaking — `.returns(value, options?)` names one value** (#272 S54): a DTO class, `optional(…)`,
  `listOf(…)` or `oneOf(…)`. Several values (a start's map of fields) are a chain,
  `.returns(CompanyDto).returns(optional(SearchRequestDto))`, in any order; `.returns(A, B)` does not
  compile (untyped code: `FlowSyntaxError`). `ReturnsStep` holds one `value`.
- **Breaking — a `oneOf` output is written before its switch**: `.returns(oneOf(A, B)).switch(…)`;
  a `.switch` without it, or with another `oneOf`, is `[flow.returns-mismatch]`.
- **Breaking — `about(TargetDto, shape)` is removed** (with `AboutWrapper`, `DeclaredOutput`):
  components declare a plain `output`; the flow says what a value is about —
  `.returns(CritiqueDto, { about: PlanDto })`, `{ about: [PlanDto, BudgetEstimateDto] }`, and for a
  `oneOf` on the case, `caseOf(ChangesRequestedDto, { about: OfferDraftDto })` (never on
  `.returns(oneOf(…))`). A value's `about` slots are kept on `ScopeValueRecord.about`.
  `{ about }` on a start's `.returns(…)` does not compile (`[io.about-on-start]` at assembly).
  `[io.ambiguous-cycle]` hints name the `.returns` / `caseOf` to write it on.
- **Breaking — no string tags** (#272 S56): `{ as: "before" }`, the tag slots, their labels
  (`DraftDto[before]#1`) and `[flow.unused-tag]` are removed. **New `historyOf(Dto, { limit })`** in
  `input` (root entry and `@agboss/core/dto`; `HistoryOf<T>`, `HistoryWrapper`, `HistoryOptions`): the field
  is `{ current, previous }` — the current value and the earlier versions oldest first, at most
  `limit` — typed `HistoryOf<Produced<Dto, P>>` in `InputOf`, shown in the input message
  (`### draft, earlier versions (oldest first)`) and by `describe`. It needs a current `Dto` on every
  path (`[input.missing-on-path]`); the replaced versions are never `[input.outdated-on-path]`; a
  `limit` that is not a positive integer → `[input.history-limit]`.
- **`[io.ambiguous-about]`** now: a producer whose values are `{ about: T }` reading `T` in two or
  more fields (with `historyOf(T)` the answers are about its current value);
  **`[flow.ambiguous-field]`**: two fields of one node that read one slot.
- **Breaking — `listOf(oneOf(A, B))` is one slot** (#272 S53): the filtered `list:ADto` / `list:BDto`
  slots are gone; a `listOf(ADto)` field after such a step is `[input.missing-on-path]`.
- [Path scope](Path-scope), [Workflow](Workflow), [Components](Components),
  [Standard DTOs](Standard-DTOs).

## Unreleased — the shared contracts and the execution lease (#265, PR 1)

- **New infrastructure contracts** (root entry), each with a built-in in-memory default, listed only
  in `@Application({ providers })` and found by inheritance: `ExecutionLeaseRepository`
  (`acquire(tenantId, rootExecutionId, lease)`, `renew`, `release`; `ExecutionLease { tenantId,
  rootExecutionId, holderInstanceId, leaseEpoch, expiresAt }`), `ExecutionTreeRepository`
  (`saveIfAbsent(key, value)` / `findById(key)` inside an execution; an implementation provides
  `saveIfAbsentInTree`, `findByIdInTree`, `deleteAllInTree`) and `RateLimitRepository`
  (`acquire(key, maxSlots, lease)`, `renew`, `release`; `RateLimitLease`). There is no
  `ExecutionSlotRepository` ([Several instances](Several-instances)).
- **The execution lease** (Q58): `app.execute` and `app.resume` move a tree only while holding its
  lease (`seconds(30)`, renewed every 10 s and before every checkpoint write, released when the pass
  ends). An instance that lost it stops, and its call rejects with `ExecutionLeaseLostError`
  (`execution.lease-lost`) — no `.onError`, no `onError`, no failed record: the new holder continues.
- **Breaking — `PausedExecutionRepository`**: a paused run has a `status` (`PauseStatus.Pending` /
  `Resolved`) and, once resolved, its `decision`; a new abstract `resolveByThreadId(threadId,
  decision)` turns a pending pause to resolved atomically. A resume records its decision first
  (a second resume of the same pause → `NotPausedError`), then waits for the tree's lease; the holder
  takes decisions resolved meanwhile and the waiting call returns the tree's current output.
- **Tree keys** of `ExecutionTreeRepository` are removed when the tree finishes, fails or is
  cancelled; a pause keeps them.
- **Testing**: `testWith(App, { instances: 2 })` with the fixtures `apps` and `clock`;
  `clock.advance` takes `seconds(…)` too and returns a promise — **`await` it** (the framework's
  waits sleep on the test clock) ([Testing](Testing)).

## Unreleased — `@Application`, infrastructure, the test entry (#261, PR 2)

- **Breaking — `@Application` is the one entry**: `@Application({ name, version, workflows,
  providers, budgets })` (`name` ends with `-application`, the class with `Application`), and
  `createApp(App, { env })` / `testWith(App)` take it. `createApp(Workflow)` and `testWith(Workflow)`
  are removed — they do not compile (the generated `.agboss/types.d.ts` brands every workflow) and
  fail at run time naming the fix. `app.execute(Start, …)` runs the workflow of that start (any
  workflow of the application); `resume` / `cancel` find the workflow of the thread; `app.name` /
  `app.version` are the application's. Environments are found next to the application file
  ([App](App), [Testing](Testing)).
- **New assembly rules** (`GraphRuleError`, all at once): `[application.no-workflows]`,
  `[application.not-a-workflow]`, `[application.duplicate-workflow]`, `[application.ambiguous-start]`
  (one start in two workflows), `[graph.duplicate-node-name]` across workflows,
  `[budget.not-a-budget]`, `[di.infrastructure-in-workflow]`, `[name.kind-suffix]` on the
  application and on budgets.
- **Infrastructure**: `CostLedgerRepository`, `ExecutionRecordRepository`,
  `PausedExecutionRepository` (new, root entry) and LangGraph's `BaseCheckpointSaver` — listed only in
  `@Application({ providers })`, found by inheritance, each with a built-in in-memory default.
  **Breaking**: `createApp({ stores, pausedRuns })`, `AppStores`, `PausedRunRepository` and
  `createSqlitePausedRunRepository` are removed, and **nothing is written to the home folder any
  more**: execution records (Terns) and the spend ledger were SQLite / JSONL files under
  `~/.langgraph-agents/` (`TERN_DB`, `SPEND_LEDGER_DIR`) and are now in memory — gone on restart,
  so `agboss eval` / `replay` only see records of their own process until the SQLite
  implementations of #265 are listed ([App → Infrastructure](App#infrastructure)).
- **Budgets, declarative**: `@Budget({ name, scope, period?, workflow?, deps? })` on a class that
  `implements BudgetHandler` (`maxSpend(): Usd | Promise<Usd>`), `BudgetScope.Application | Tenant |
  Execution`, `BudgetPeriod.Day | Week | Month`, all listed in `@Application({ budgets })`
  (`config/budget.config.ts`). They are components (injectable, `mockOf`-able); the checks at run
  time come with #261 PR 5 — until then `settings().limits` caps the money ([FinOps](FinOps#budgets)).
- **Tests**: every framework fixture and test runs through an `@Application`; `app.ready()` builds
  the test's application for a test that executes nothing; each test runs on the infrastructure the
  application lists (else the in-memory defaults), new per test.
- **CLI (until #268)**: `agboss run` / `chat --workflow <file>` run the application that lists the
  workflow — exported by its module, or by a `*.application.ts` in its folder or a folder above it —
  at that workflow's text start. `agboss create` / `generate workflow` write the workflow's
  `*.application.ts` and `config/budget.config.ts`.

## Unreleased — one container per application instance (#261, PR 1)

- **Breaking — no scopes**: one container per application instance, one instance per class (a class
  listed by two workflows is one instance). The `scope` option of every DI decorator, the `Scope`
  type, the run-scoped container and `[di.scope-mismatch]` / `[di.run-scope-outside-run]` are gone
  (against #184). Components keep no state: read the execution from `ExecutionContext`, keep data that
  outlive a step in the graph state, caches in your own service over external storage
  ([Components → Components keep no state](Components#components-keep-no-state)).
- **Breaking — lint**: `agboss/no-component-state` replaces `agboss/no-run-state-in-singleton` —
  `this.x = …` outside the constructor of any component is an error.
- **Lifecycle hooks**: `OnInit` (new in the root entry), `OnStart`, `OnStop`, `OnDestroy` — `onInit`
  (dependencies first) → `onStart` at start, `app.close()` → `onStop` → the running executions awaited
  → `onDestroy` (dependants first). A failing `onInit` / `onStart` stops the start
  (`[di.hook-failed] <Component>.<hook> failed: …`); failing stop hooks are collected into one
  `AggregateError`. After `app.close()` `execute` / `resume` reject with the new `ApplicationStoppingError`
  (`app.stopping`, an `onRunRejected`); `cancel` still works.
  **Breaking**: `AfterAssemble` is removed, `OnDestroy` now runs once at shutdown, not per run
  ([App → Lifecycle hooks](App#lifecycle-hooks)).
- **Implementation by inheritance**: a dependency on a contract gets the one listed class that extends
  it; two → `[di.ambiguous-implementation]`. One token with different values →
  `[di.conflicting-values]`; `provide(Class, …)` → `[di.instance-provider]` (no `new`: the container
  creates every instance) ([Components](Components)).
- `createAppDeps(…).close(executionsDone?)` takes what to wait for between `onStop` and `onDestroy`.

## Unreleased — code routers (#280)

- **`DecidedBy.Code`**: a router decided by its class — `implements RouterHandler<Self>`,
  `route(input: InputOf<Self>)` returns one of its targets (`Route<Self>`, generated; a target outside
  `routes` does not compile); `deps` in the constructor like an action, the execution through
  `deps: [ExecutionContext]`. No model call, cost 0, the same flow as a model router
  ([Routers → Routers decided by code](Routers#routers-decided-by-code),
  [Routing patterns](Advanced-Routing)).
- **`@Router` options are a union by `decidedBy`** (`ModelRouterOptions` / `CodeRouterOptions`):
  `model`, `prompt`, `promptUrls`, `promptVariables` and route `prompt`s only on a model router;
  `deps` only on a code router.
- **`spawn` / `failure` on routes** (`SpawnPolicy.Always | OnDemand`, `FailurePolicy.FailFast | Skip`),
  both kinds — the options of a parallel launch (#273). Defaults `Always` + `FailFast`; a code
  router's route `OnDemand`. With `.chooseOne(…)` an explicit one → `[router.policy-with-choose-one]`
  and `Route<R>` is every target; before a launch `Route<R>` leaves `Always` targets out and every
  route `Always` → `[router.all-routes-always]`. The generated `RouterAnswers` table types what
  `route()` returns.
- **Breaking — router errors (S19)**: `RouterFailedError` (`step.router`, the original as `cause`: a
  model call or `route()` failed) and `RouterDecisionError` (`step.router.invalid-decision`, now a
  `RouterFailedError`: an answer outside the routes, a list after `.chooseOne(…)`, an unreadable
  answer — never retried). Both carry `component`, `nodeId`, `visitNumber`. The instance codes
  `router.failed` / `router.unknown-route`, the type `RouterFailureCode` and the field `router` are
  gone (`router` → `nodeId`); an unreadable model answer is now `RouterDecisionError`, not a failure.
  `.onError(RouterFailedError, …)` takes both; `.onError(DomainError, …)` the error inside.
- `agboss describe` lists code routers as `code`; `mockLlm(CodeRouter)` throws (a code router calls
  no model — `mockOf()` its services).

## Unreleased — one call per line in flow chains (#289)

- **Style**: a flow chain has one call per line — `start(A)` / `.returns(B)` / `.toFinish(C)`, and
  `route(X)` / `.toFinish(F)` inside a `chooseOne(…)` ([Workflows](Workflow) → The grammar). In the
  repo, `*.workflow.ts` modules and the flow fixtures are left out of Prettier (which joins short
  chains), formatted by `make fmt` and checked by ESLint's `@stylistic/newline-per-chained-call`;
  the docs' and Wiki's ts snippets that build paths are checked by `npm run check:docs`
  (`doc:line: … (@stylistic/newline-per-chained-call)`). `agboss create` / `agboss generate` write
  workflow modules one call per line.
## Unreleased — outdating at run time (#271)

- **`scope` holds current values only**: a write moves the older value of its slot and everything
  built from it to `outdatedValues`, each with `outdated: { byValueId, reason }` — `byValueId` the
  root trigger, `reason` an `OutdatedReason` (`Replaced`, `AboutReplaced`, `BuiltFromReplaced`)
  ([Path scope → At run time](Path-scope#at-run-time)). `OutdatedValueRecord.outdated` gains
  `reason`.
- **`onValuesOutdated`** (`OnValuesOutdated`, `ValuesOutdatedEvent`): one event per cascade, never
  empty, no DTO values; with `ExecutionEvent`'s fields (`executionId`, `parentExecutionId`,
  `rootExecutionId`, `threadId`, `workflow` as a `WorkflowRecord`) and `step` (a `StepRecord`)
  ([Observability](Observability#outdated-values)); one "values outdated" trace entry per cascade.
- **Records**: `WorkflowRecord`, `StepRecord`, `ScopeValueReference`, `OutdatedValueReference`,
  `OutdatedMark`; `WorkflowDescriptor`, `StepDescriptor` and `ComponentDescriptor` extend them.
- **`agboss describe`** prints each `about(…)` output ([CLI](CLI)).

## Unreleased — the execution context (#280)

- **`ExecutionContext`**: the one context of an execution, injected through the constructor —
  `deps: [ExecutionContext]`, a parameter named `executionContext` — into tools, actions, judges and
  services ([Context and Authorization](Context-And-Authorization)). Read-only data: `executionId`,
  `threadId`, `ownerId`, `signal`, `workflow`, `step` (`idempotencyKey` =
  `${executionId}:${nodeId}:${visitNumber}[:${itemIndex}][:${callId}]`, `callId`, `visitNumber`, …)
  and the tree (`parent`, `root`, `depth`, `executionOf(W)`). A read outside an execution or after
  its step ended throws `ExecutionContextUnavailableError` (`context.unavailable`).
- **No `ctx` parameter**: `ToolHandler.run(input)`, `@McpTool` alike; `ToolContext` and `RunContext`
  are gone (`ctx.run.runId` → `executionContext.executionId`, `ctx.run.owner` → `.ownerId`,
  `ctx.run.signal` / `ctx.signal` → `.signal`, `ctx.callId` → `.step.callId`, side effects key on
  `.step.idempotencyKey`). `ctx.run.metadata` and `ctx.run.input` have no replacement in the context:
  domain data come through a node's `input`. `ctx.pause(question)` is **removed until #267**
  (questions as part of the graph; S44) — approval of a tool call through `@Tool({ channel })` keeps
  working. `ctx.reportCost(usd)` → `deps: [SpendRecorder]`, `spendRecorder.record({ service, cost })`
  (S43), counted in the money limits; a tool's `ROUTER_FACTORY` decisions are accounted as its
  spend by the framework.
- **A tool call's signal** (S45): in a tool call `executionContext.signal` aborts on the execution's
  cancel and at the tool's own `timeoutMs`.
- **Judges**: `judge(input: JudgeInput)` (`reply`, `task`, `attempt`) instead of
  `judge(reply, ctx: JudgeContext)`; the judge's model through `deps: [JudgeModel]`
  (`judgeModel.invoke` / `judgeModel.decide`).
- **Testing**: `testExecutionContext({ … })` replaces `testRunContext()`; `toolOf(tool).invoke(input)`
  takes no context; `app.tool(T).invoke(input)` runs the tool in an execution of its own.
- An exported tool called over MCP runs in an execution of its own; the client's `_meta.callId` is
  its `step.callId`.

## Unreleased — the flow as paths (#272, #270, #269)

- **Outdating** (#271, [Path scope](Path-scope)): a field reads only current values — a new value
  outdates everything built from the older one, and assembly proves no node reads an outdated value
  (`[input.outdated-on-path]`). In a cycle of classes built from each other the component that
  answers says what about: `output: about(DraftDto, oneOf(ApprovalDto, DraftChangesDto))`
  (`[io.ambiguous-cycle]`, `[io.ambiguous-about]`). A review loop written without `about` no longer
  assembles; the hint names the output to wrap.

- **The flow is a list of paths** ([Workflow](Workflow), [ADR-0019](ADR-0019-Flow-as-paths-with-path-scope)):
  `start(S).returns(Dto).toRouter(R).chooseOne(route(A)…)`, `.toAgent` / `.toAction` / `.toFinish`,
  `.switch(caseOf(…))`, `.onError(E, <side path>)`; own paths `agent(X)…` / `router(R)…` /
  `action(A)…` for shared nodes. Removed: `from(…).next(…)`, `from(R).routes()`, `chain`, `node`,
  `catchError` / `compensateWith`, `nextParallel` / `join`, `batchParallel`, `joinQuorum`,
  `@QuorumRouter`, `parallel(…)` / `optional(…)` route targets, `Self`, nested `@Workflow` nodes,
  sagas and `compensate`, the `agboss/concurrency` entry. Parallel launches return in #273, child
  workflows in #263, code routers in #280.
- **Generated types**: `agboss check` writes `.agboss/types.d.ts` (git-ignored) — what types the
  paths, `InputOf<X>` / `OutputOf<X>` and `app.execute(Start, input)`. A generated project runs it on
  install (`npm run types`); `declare readonly input` on a start is no longer needed.
- **Typed data on paths** ([Path scope](Path-scope)): `@Agent` / `@Action` / `@Router` /
  `@WorkflowFinish` take `input` fields and `output` shapes; wrappers `listOf`, `oneOf`, `optional`,
  `variant`, `isVariant` (`@agboss/core/dto`). Agents read an input message after static instructions and
  answer a structured `output` through answer tools; `{{item}}` and `{{input.…}}` in instructions are
  gone (`[prompt.input-in-instructions]`).
- **Names**: every component `name` ends with its kind (`main-router`, `scout-agent`,
  `chat-workflow-start`, `charge-action`, `job-scout-workflow`) and is unique in the application;
  DTO classes on paths end with `Dto` — the standard DTOs are renamed (`WorkflowStartText` →
  `WorkflowStartTextDto`, `Money` → `MoneyDto`, …, [Standard DTOs](Standard-DTOs)). LangGraph node ids
  are the names (no `<kind>.` prefix).
- `@WorkflowAction` → `@Action`, `execute(input)` with its fields from the path's scope
  (`ActionHandler<Self>`). `ctx.run`, `ctx.idempotencyKey` and `ctx.executionContext` are gone
  from actions — since #280 the execution comes through `deps: [ExecutionContext]` (above).
- **Limits**: `@Workflow({ maxSteps })` replaces `limits.perRun.steps`; `maxVisits` on routers and
  agents (`VisitsLimitExceededError`, catchable with `.onError`); money stays in `settings()`.
- **Results**: `ExecutionStatus.Finished | Paused`; `result.finish` is `{ name }`; `{ record: true }`
  adds the execution record. The thread's history keeps finished executions as
  `start <name>: <input>` / `finish <name>: <output>`.
- **Enums instead of strings** (#269): `Reasoning.…` instead of `thinking` strings on components,
  `RagMode.Tool | Context`, `ModelKind`, `ProviderSort`, `ImageDetail`, `ExecutionStatus`.
- `defaults.router` is `{ model }` (no `kind`); a `@Router` takes `decidedBy: DecidedBy.Model` and a
  required `input`.
- job-scout: one path per turn, names with their kinds, profiles and golden sets under
  `job-scout-workflow/` ([Example](Example)).
