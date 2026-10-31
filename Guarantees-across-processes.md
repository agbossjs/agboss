# Guarantees across processes

The lease, fencing, recovery and the graceful stop are tested in one process and on one SQLite file
([Several instances](Several-instances)). This page is about what holds when **real processes** on one
database are stopped, killed, frozen or cut off. The fault suite (#484) proves it, and the same
suite runs on any store set ([Your own store](Your-own-store#faults-faultsuite-484)): the core runs
it on SQLite (several processes on one file), agbossjs/postgres on PostgreSQL.

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
  every expiry. agbossjs/postgres runs on the real clock.

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
| `children-once` | Every order of a batch is one child of it, finished. No execution ended twice. |
| `effects-once` | Each order execution that finished has one business row and at most one `Ran`; the other calls are `Replayed`, `Joined` or `Refused`. Each order was paid once at the gateway, reached it once, under one idempotency key, with at most one `Sent`. |
| `no-undo-on-hand-over` | A hand-over undoes nothing. A real failure undoes once. |
| `trees-finish` | Every order finished (a declined one failed), and every batch finished, within the scenario's bound. |

The checker has its own failing cases, one per invariant (`tests/testing/faults/invariants.test.ts`).

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
- **The platform's grace period.** Set `shutdownTimeout` below it (Cloud Run: 10 s; Kubernetes:
  `terminationGracePeriodSeconds`). Then a stopping pod hands its steps over in time (scenario 11).
  Above it, nothing is lost, but the tree waits for its lease to expire before it moves again
  (scenario 11b).
- **The store's atomic steps.** The suite runs your store under faults. The atomic steps themselves
  are proven by `storeConformance` ([Your own store](Your-own-store)), and the fencing stores must
  share one transactional backend.
- **Clocks.** The pods of a run share one clock. Pods with skewed clocks and the bound such skew
  needs are #533's.

### What a reader of the records should know

- An observer hears a tree's end (`onExecutionEnd`) **before** its kept record is saved. A reader
  that acts on the event and then reads the history may find the record not yet saved. The suite
  waits for the history store's `save` before it reads.
- An `AnyInstance` child's `onExecutionEnd` may be heard on the instance of its parent, not on the
  instance that ran it.

## For a store author

Run `faultSuite` beside `storeConformance`: [Your own store](Your-own-store#faults-faultsuite-484).
The run's history (`OperationHistory`: every store operation's invoke and complete) and the hold
points (`withHoldPoints`) are the tools #533's interleaving explorer and linearizability checker
build on.
