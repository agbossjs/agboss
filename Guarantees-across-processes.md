# Guarantees across processes

The lease, fencing, recovery and the graceful stop are tested in one process and on one SQLite file
([Several instances](Several-instances)). This page is about what holds when **real processes** on one
database are stopped, killed, frozen or cut off. The fault suite (#484) proves it, and the same
suite runs on any store set ([Your own store](Your-own-store#faults-faultsuite-484)): the core runs
it on SQLite (several processes on one file), agbossjs/postgres on PostgreSQL. Every guarantee, the
assumptions it rests on and the checker that proves it are on [Guarantees](Guarantees).

## What the suite does

- **Pods.** Each pod is a `node` process running the fixture application on the store set under
  test. A pod shares nothing with the others but the database. The test drives each pod over its
  IPC channel, and every command is acknowledged.
- **Real faults:**
  - `SIGTERM` (a platform stopping the pod: it drains as `app.close()` does);
  - `SIGKILL` (no hook runs, no lease is released);
  - `SIGSTOP` / `SIGCONT` (a frozen pod: no timer, no renewal, no write — then it runs on, late);
  - database loss: a TCP proxy per pod pauses (stalls), drops and restores the pod's connections.
    A store with no network (SQLite) gets a store outage of the same two kinds instead.
- **The fixture application.** One order is three steps:
  - reserve, which has an undo (`compensateWith`);
  - charge, a fenced effect that writes one business row in the effect's transaction;
  - pay, a call to the test's payment gateway (`OutboundCalls`) under the order's business key.

  A batch runs one order per child on any instance (`ChildPlacement.AnyInstance`).
- **No sleep decides an order.** Each step of a scenario waits for an event of a pod: a held
  operation, a takeover, an end. Named **hold points** stop an operation where the scenario wants
  it, until the scenario releases it:
  - a step's point (`step.charge.before`, `step.charge.after`: committed but not checkpointed);
  - a store operation, before the store is asked or after it answered (`lease.acquire`,
    `lease.renew`, `lease.finish`, `fencedEffect.write`, `outboundCall.leaseStateOf`, …);
  - the gateway's answer.

  Every wait is bounded and fails with what it waited for and what came instead.
- **Time.** The pods run on the application's `Clock`, with the lease the core uses (30 s). The
  core's own run scales every pod's clock ten times, from one shared origin, so the pods agree on
  every expiry. agbossjs/postgres runs on the real clock on pushes to `main` and nightly, and five
  times faster on pull requests (since #533 the database's clock decides when a lease expires, so
  the wait for an expiry is real time there anyway).

## The invariants

After every scenario, the checker reads the facts **through the public API only**:
- every root's kept record (`ExecutionHistoryRecord`);
- every tree's lease log (`app.leaseEventsOf`) and outbound calls (`app.outboundCallsOf`);
- the business rows;
- the gateway's requests and payments;
- every pod's observer events;
- the **history**: every operation of the lease, fenced-effect, outbound-call, child-queue and
  history stores, as an invoke and a complete, each with the machine's monotonic time.

A run fails with `FaultInvariantError`, naming each invariant it broke:

| Invariant | What must hold |
| --- | --- |
| `one-owner` | Each epoch of a lease is granted once, and epochs grow. A write the store accepted at token N came from the holder of epoch N. **No write is accepted at token N after epoch N + 1 was granted.** One takeover row per token. |
| `finished-work-untouched` | No lease is granted for work whose lease was finished (#520). |
| `children-once` | Every order of a batch is one child of it, finished. Each child's queue row was completed once (`childQueue.complete` accepted once), and each finished child's end was heard once by the pods' observers (#562). |
| `effects-once` | Each order execution that finished has one business row and at most one `Ran`; the other calls are `Replayed`, `Joined` or `Refused`. Each order was paid once at the gateway, reached it once, under one idempotency key, with at most one `Sent`. |
| `no-undo-on-hand-over` | A hand-over undoes nothing. A real failure undoes once. |
| `trees-finish` | Every order finished (a declined one failed), and every batch finished, within the scenario's bound. |
| `linearizable` | The history has an order the sequential model of the fencing stores explains (#533). See below. |

The checker has its own failing cases, one per invariant (`tests/testing/faults/invariants.test.ts`).

### `linearizable`: the history against the sequential model (#533)

The history is checked in the Porcupine / Knossos way. Each store operation takes effect at one
instant between its invoke and its complete. The checker looks for one order of all of them, in
which every answer the store gave is the answer of the **sequential model** of the fencing stores
(`src/testing/contracts/models/`: the lease, its fence and scope mark, the fenced effect, the
outbound-call intents and their compare-and-sets). The property tests check the core's stores
against the same model.

- **Parts.** Operations that share no tree, scope or call are checked apart.
- **Unknown answers.** An operation that never completed (its pod was killed) or failed with
  anything but the fence's refusal may have taken effect or not.
- **Time.** The instants are read on the store's time: the machine's monotonic time times
  `storeTimeScale` (default the pods' `timeScale`; 1 for a database that decides by its own clock,
  as PostgreSQL's `clock_timestamp()` does). So an early take of a live lease is no order either.
- **Order.** An operation that completed before another was invoked took effect first: every pod
  records on the host's one monotonic clock, so this order is exact. A slack (5 ms × the scale)
  widens only the instant the store's own clock decides at, never this order.
- **A failure** names the part, the longest order found and the operations none of which can follow
  it.
- **`linearizabilityOf(history, { timeScale })`** checks any recorded history.
- **Proofs.** It passes every scenario, the clock-skew ones included. It fails on hand-written
  histories (`tests/testing/faults/linearizability.test.ts`: an epoch granted twice, a take of a
  live lease, a renewal or a write after a newer grant, a take of finished work, two won claims). It
  fails on the recorded history of scenario 5b on a store without the fencing check, naming the
  zombie's write (`tests/testing/faults/recorded-history.test.ts`). The sabotage runs (5b, 5c, 5d,
  6b) fail it too.

## What the suite proves, scenario by scenario

Each scenario is a test of `faultSuite`. In the core it is `packages/agboss/tests/faults/<file>`.

| # | Fault | What holds | Scenario (file) |
| --- | --- | --- | --- |
| 1 | `SIGTERM` during a step that ends within the shutdown timeout | It drains: the tree finishes on that pod, which exits by itself; nothing is taken over | `s01-sigterm-drains` (`s01-sigterm.test.ts`) |
| 1b | `SIGTERM` with a shutdown timeout shorter than the step | The step is handed over (`ApplicationStopping`), the pod exits, another pod takes the tree over; one charge | `s01b-sigterm-shorter-than-step` |
| 2 | `SIGKILL` mid-step | Once the lease expires another pod takes the tree over (`Recovered`, from the killed holder) from its last checkpoint: the reservation is not made again | `s02-sigkill-mid-step` (`s02-kill.test.ts`) |
| 3 | `SIGKILL` after the charge committed, before its checkpoint | The step runs again with the same key: `Replayed`, one business row | `s03-crash-after-charge` (`s03-crash-after-effect.test.ts`) |
| 3b | `SIGKILL` after the gateway answered, before the checkpoint | The payment replays; the gateway saw one request | `s03b-crash-after-payment` |
| 4 | A lease expires while its pod lives: its renewals stall at the store | Past its last confirmed renewal the pod stops the step without charging (`LeaseLost`); another pod takes the lease over; the stalled renewals are refused | `s04-lease-expires` (`s04-lease-expiry.test.ts`) |
| 5 | `SIGSTOP` at the charge's write, `SIGCONT` after the new holder charged | The zombie's write is refused by the store (`ExecutionFencedError`); it hands over; nothing is undone | `s05-zombie-write-refused` (`s05-zombie.test.ts`) |
| 5b | The same, the zombie's write reaching the store **before** the new holder's | Refused by the store's lease check; the new holder charges once | `s05b-zombie-reaches-charge-first` |
| 5c | The same at the payment: the zombie frozen at its intent (`outboundCall.saveIfAbsent`), reaching the outbound-call store before the new holder's (#584) | Refused by the outbound-call store's lease check: a zombie records no payment; one payment | `s05c-zombie-reaches-payment-first` |
| 5d | The zombie frozen **after** recording its payment's intent (`Pending`, held right after `outboundCall.saveIfAbsent` answered) and before sending it, thawed after the new holder finished the tree (#608) | The new holder finds the intent of a lease that is no longer live, reconciles it with the gateway (not sent) and pays once; the zombie's renewal right before its send (`confirmNow()`) is refused, so it hands over and never reaches the gateway: one request, one payment | `s05d-zombie-recorded-not-sent` |
| 6 | Scale-down (`SIGTERM`) while three children run on three pods | The stopped pod's child is reclaimed from its checkpoint by a live pod: no child lost, none run twice | `s06-scale-down-children` (`s06-children.test.ts`) |
| 6b | A pod frozen at its ask for another pod's child's lease, thawed after that child finished | The store refuses the finished child's lease in `acquire` itself; no takeover is written (#520 AC1) | `s06b-finished-child-not-taken` |
| 7 | A new pod joins while the busy pod's child waits in the queue | It claims and runs the waiting child; each child runs once | `s07-new-pod-claims-pending` (`s07-new-pod.test.ts`) |
| 8 | A pod loses its database (connections dropped) | It stops the tree it cannot renew and writes nothing; another pod takes it over | `s08-database-cut` (`s08-database-loss.test.ts`) |
| 8b | The database stalls until the lease expired, then comes back | The old pass does not continue; the tree is taken over again at a new token and charged once, at that token | `s08b-database-back-after-expiry` |
| 9 | `SIGKILL` after the request reached the gateway, before its answer | The next holder reconciles the pending call by its key (`Reconciled`); nothing is resent | `s09-crash-after-send` (`s09-crash-after-send.test.ts`) |
| 10 | One order paid by two executions, the first killed with its answer in flight | The second reconciles the first's pending call; the recovered first replays it: one payment, one request | `s10-one-order-two-executions` |
| 11 | A 10 s grace (Cloud Run) with `shutdownTimeout` below it | The pod hands over and exits in time; another finishes the tree | `s11-short-grace` (`s11-short-grace.test.ts`) |
| 11b | `shutdownTimeout` above the grace: the platform kills the pod mid-drain | Taken over once the lease expired; one charge | `s11b-shutdown-timeout-above-grace` |
| 12 | A real failure (the card declined), the pod killed mid-undo | The next pod finishes the undo (`Unwinding`): the reservation is released once, and the kept record lists it (#541) | `s12-real-failure-undone-once` (`s12-real-failure.test.ts`) |
| 13 | A pod whose clock is ten leases ahead of the others (#533) | It never takes the lease a live pod holds and renews; that pod finishes its own tree, one charge — the stores decide expiry by the database's time | `s13-clock-ahead` (`s13-clock-skew.test.ts`) |
| 13 | A pod whose clock is ten leases behind, the holder frozen (#533) | It takes the tree over on time, from the holder's last checkpoint | `s13-clock-behind` (`s13-clock-skew.test.ts`) |

**The scenarios bite.** A broken store must fail the scenario that targets it. These permanent
negative tests prove it (`tests/faults/sabotage.test.ts`):
- A fenced-effect store with **no fencing check on the business write**: its writes go in at the
  lease's current epoch. It fails 5b on `one-owner`, because the zombie's write was accepted after
  the new epoch was granted.
- A lease store whose **`finish` is a plain `release`**: it fails 6b on `finished-work-untouched`,
  because the frozen pod was granted the finished child's lease.
- An outbound-call store with **no fencing check on the payment's intent** (#584): it fails 5c on
  `one-owner`, because the zombie's intent was accepted after the new epoch was granted.
- A lease store whose **renewal says yes to a lease that is over** (taken over or expired, #608):
  it fails 5d on `effects-once` and `linearizable`. The zombie's `confirmNow()` right before its
  send passes, so the order reaches the gateway twice (the gateway's own idempotency key makes it
  one payment, but the framework sent twice), and the stale renewal fits no sequential order.

**A set that opts out fails the suite.** Before its scenarios `faultSuite` runs `fences atomically:
no store declares LeaseCheck.WithoutDoubleChargeProtection` (#584): a set whose fenced-effect or
outbound-call store declares the opt-out fails it with `[fault-suite.opted-out-store]`, naming the
stores. Its scenarios may well pass, since none of their races hits the gap, but such a set
protects no payment ([Your own store](Your-own-store)).

**What the suite leaves to `storeConformance`.** The scenarios look for a second owner, a second
charge, a lost or doubled child, an undo on a hand-over and a tree that never ends. A store that
breaks a rule without causing any of these passes them. Example: a fence or a `renew` that ignores
the lease's expiry while nobody has taken the lease yet. The holder's own fencing stops it first,
and no other owner exists at that moment. The boundary cases of `storeConformance` (#534) catch
such a store, so run both.

## What is left to the application and to downstream systems

The suite proves the framework's side under the faults above. These parts are yours:

- **The other system's idempotency.** A call through `OutboundCalls` is recorded before it is sent.
  It is never resent while its outcome is unknown: it is reconciled by its key instead (scenarios 9
  and 10). That needs a gateway that:
  - deduplicates on `call.idempotencyKey` (G1);
  - can be asked by that key (G2);
  - keeps the key longer than your longest outage (G3).

  See [Payment gateways](Payment-gateways). A send that hangs past `attemptTimeout` plus a lease
  can meet a reconcile and a resend; then only G1 prevents a second charge.
- **Side effects outside the fence.** A plain HTTP call, a mail or a write to another database in
  a step that does not go through a fenced effect or `OutboundCalls` happens **at least once**. A
  step runs again after a crash before its checkpoint (scenario 3). Make it idempotent at the other
  end, or put it behind a fenced effect.
- **Crash recovery is not saga compensation.** A crash, a stop, a lost lease or a refused write is
  a **hand-over**: the next holder continues the tree from its last checkpoint, and nothing is
  undone (scenarios 1–11). An undo runs only on a real failure: an uncaught error, a cancel, a failed
  join (scenario 12). Model "the payment failed" as a failure, never as a crash.
- **An undo runs only while its holder holds the tree** (#605). Each undo action runs after the
  holder's own fence (`assertHeld`, local, on its monotonic clock), as an outbound call's `send`
  does. A holder that froze while its step failed, whose tree another instance took over and undid,
  undoes nothing when it thaws, even before its expiry timer fires: it hands over at the undo
  (`HandOverSite.Compensation`). What is left is the same window as `send`: a holder frozen between
  that look and the undo's own write. An undo whose external system checks
  `executionContext.fence` closes it; the undo's key is `<step key>:compensation`.
- **The platform's grace period.** Set `shutdownTimeout` below it (Cloud Run: 10 s; Kubernetes:
  `terminationGracePeriodSeconds`). Then a stopping pod hands its steps over in time (scenario 11).
  Above it, nothing is lost, but the tree waits for its lease to expire before it moves again
  (scenario 11b).
- **The store's atomic steps.** The suite runs your store under faults. The atomic steps themselves
  are proven by `storeConformance` ([Your own store](Your-own-store)), and the fencing stores must
  share one transactional backend.
- **Clocks.** The pods of a run share one origin. Scenario 13 skews one pod's clock ten leases
  either way (#533). The stores decide expiry by the database's time, so the holder's fencing needs
  its clock to *run* at the right rate, not to be set right (Several instances → the lease).

### What a reader of the records should know

- An observer hears a tree's end (`onExecutionEnd`) **before** its kept record is saved. A reader
  that acts on the event and then reads the history may find the record not yet saved. The suite
  waits for the history store's `save` before it reads.
- A child's end is heard **at most once** (#562). It is announced only by the pass that ended the
  child, and only while that pass still holds the tree's lease:
  - an `AnyInstance` child's `onExecutionEnd` by the worker whose completion of the child's queue
    row won, on **that worker's instance**, not on its parent's;
  - an `AnyInstance` child the worker stopped because its tree was cancelled or ended, whose row went
    with the tree, by that worker (`onExecutionError`, `ExecutionCancelledError`);
  - a child on its parent's instance by the parent's pass that ran it to its finish or its failure;
  - a remote child's failure by the parent's pass that saw it happen; the child's undo runs there.

  A pass that re-enters the parent's step after a takeover finds the end already there and
  announces nothing. A holder whose lease is no longer live (frozen past it, taken over) stops at
  the announcement, as at any write.
- **A failure, once announced, is the child's end** (#596). Before announcing a child's failure, the
  pass claims it in the tree's store (`@agboss/child-failure:<childExecutionId>`,
  `saveIfAbsentInTree`: one caller wins) and checks its fence again after that round trip. Of every
  pass that sees the failure, only the winner announces it: the first, one that finished an
  interrupted undo, or a re-entry that ran the failed step again. A re-entry that finds the claim
  repeats the failure without running the step. A step that would now succeed (a dependency that
  recovered) never turns an announced failure into a finish, and the root's outcome follows the
  announced one. The repeated failure carries the error's durable record, as the undo's mark does.
- **Every holder takes the same side path** (#598). `.onError` matches a failure by its class's
  code line: the `static code` of the class and of each class above it, else the class name. A
  failure that crosses a takeover or an instance keeps that line with its message and causes (its
  record, `errorRecordOf` without `details`): a child's claimed failure, an undo's mark and an
  `AnyInstance` child's queue row. The instance that rebuilds it routes it as the instance that saw
  it did: a side path on `ChildExecutionFailedError`, on `StepFailedError` or on the child's own
  `PaymentDeclinedError` through the cause, whichever holder runs the parent. The rebuilt error is
  not an `instanceof` the project's class, so route on the class, never test it in a step. A cause
  chain is cut at 32 causes and at its first repeat, the same way wherever its record is made. A
  mark or a row written before 0.1.1 has no record: on every instance it is an error with the
  message only, which no project class matches. Give a class a side path routes a `static code`:
  a class name can change with a bundler, and two builds would then route apart.
- **The window.** A holder that freezes or crashes between the child's durable end and its
  announcement leaves the end unannounced: the new holder only reads it. That window is:
  - for an `AnyInstance` finish, between the worker's completion of the row and its observer call;
  - for a child on the parent's instance, between the child's last checkpoint (or the claim of its
    failure) and the parent's observer call. A failure nobody has claimed yet is no longer in the
    window (#596): the new holder runs the step again, sees the failure, claims it and announces it;
  - for a remote child's failure, the whole time from the failure until the waiting parent reads it,
    if its holder is lost meanwhile.

  The tree's own end is still heard: the root's `onExecutionEnd` or `onExecutionError` comes from
  the holder that ends the tree. It is heard **at most once** too (#597): announced only while that
  pass still holds the tree's lease. A holder that froze right after the tree's end became durable
  (its finish checkpoint, its failed step's error) finds its lease taken over when it thaws, stops
  at its own fence (`ExecutionLeaseLostError`, its call rejects) and announces nothing; the instance
  that recovered the tree announced it. The window is a holder frozen between that look and its
  observer call. An observer that must not miss a child's end reads the tree's
  record (`result.children`, `ExecutionHistoryRecord`) at the root's end.

## For a store author

Run `faultSuite` beside `storeConformance`: [Your own store](Your-own-store#faults-faultsuite-484).
The run's history (`OperationHistory`: every store operation's invoke and complete) and the hold
points (`withHoldPoints`) are the tools #533's interleaving explorer and linearizability checker
build on.
