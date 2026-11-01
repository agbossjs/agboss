# Guarantees

What AGBoss promises when several instances move the same execution trees and their steps write to
databases and call other systems — each guarantee, the exact assumptions it rests on, what breaks
when an assumption does not hold, and the test or checker that proves it (#533). The mechanisms
are on [Several-instances](Several-instances), the store contracts on
[Your-own-store](Your-own-store), the provider's side on [Payment-gateways](Payment-gateways), the
fault scenarios on [Guarantees-across-processes](Guarantees-across-processes).

## The guarantees

| # | Guarantee | Said exactly |
| --- | --- | --- |
| **P1** | One owner per tree | At any moment at most one instance trusts a tree's lease; every epoch is granted once; no write is accepted under a superseded, released, finished or expired token. |
| **P2** | One effect per business key | A fenced effect runs its write once per step, or once per tenant, name and business key; a repeat replays the stored result; another fingerprint is `IdempotencyKeyConflictError`. |
| **P3** | One send per attempt | An outbound call sends an attempt only after it claimed it (a compare-and-set) and only while its lease holds; a pending attempt whose owner lives is never resent; the other system is charged once per business key. |
| **P4** | No takeover of finished work | Once a lease is finished, no `acquire` of its key gets it again: no instance takes finished work over, and the lease log has no Takeover row for it. |
| **P5** | Compensation only on real failure | An undo runs only when a step really failed or was cancelled — never because its lease was handed over. |

## The assumptions

Each guarantee holds while every assumption it lists holds.

| # | Assumption | Needed by | When it does not hold |
| --- | --- | --- | --- |
| **A1** | **Store conformance.** The stores pass `storeConformance` — every contract, the store set's cases and the interleaving explorer — and `faultSuite` against a real database. | P1–P5 | Whatever rule the store breaks: a second live holder, a stale write accepted, a double charge, finished work taken — and an undo on a hand-over (a lease store that grants one epoch twice makes scenario 5c undo a reservation that did not fail). A store only as good as the cases: a business-key column with an accent-insensitive collation passed them all until #620. |
| **A2** | **One transactional backend.** The fenced-effect and outbound-call stores declare the lease store's `backend` and check the lease in the write's own transaction (`LeaseCheck.Atomic`). | P1–P3 | A holder whose lease was just taken over can still write or record: a double charge or a second owner's write. The opt-out `LeaseCheck.WithoutDoubleChargeProtection` says so, and assembly warns. |
| **A3** | **The database's clock is slewed, never stepped** (NTP slew only), and it is one clock: a failover to a primary or replica whose clock differs is a step. | P1, P3 | A forward step expires live leases early: the store grants the tree to another instance while the holder still trusts its lease, for up to the step's size beyond the margin. Its fenced writes are refused (A2), but P1's "at most one instance trusts the lease" does not hold, and a send it already decided rests on the provider's G1 (A7). A backward step keeps a dead holder's lease alive longer: liveness only. No test steps the database's clock; the core's tests step the holder's wall clock. |
| **A4** | **Drift bound:** ρ_holder + ρ_store ≤ 1 s / 30 s (the safety margin over one lease). | P1, P3 | A holder whose clock runs slower than the bound trusts its lease past the store's expiry: another instance can take it while it still sends. |
| **A5** | **No pause that stops both of the holder's clocks while the database's time runs on.** The fence ends at whichever count runs out first, monotonic or wall: a host suspend stops `performance.now()`, but the wall clock ends the fence early. | P1, P3 | A pause that freezes both (some VM pauses) leaves the holder trusting an expired lease when it wakes: its next send can coincide with the new holder's. Its fenced writes are still refused (A2). |
| **A6** | **`attemptTimeout` + lease bound.** A send in flight keeps its lease renewed, bounded by `outboundCalls.attemptTimeout` (default 2 min) and the instance's stop; past it the holder stops renewing, so the call is in flight for at most `attemptTimeout` plus up to the lease's 30 s. | P3 | A send still hung past the bound can land after the next owner reconciled it and sent again: two charges unless the provider deduplicates (A7). |
| **A7** | **The provider's G1–G6** ([Payment-gateways](Payment-gateways)): it deduplicates on `call.idempotencyKey` (G1), can look a call up (G2), keeps keys long enough (G3), answers a repeat with the first response (G4), refuses another request under one key (G5), and tells late outcomes (G6). | P3 | Without G1 a send that A6 does not bound is a second charge. Without G2 or G6 a pending intent cannot be reconciled and needs manual review (`OutboundCallUnreconciledError`). |
| **A8** | **A shared `pseudonymKey`** across the instances (fingerprints, business-key handles). | P2, P3 | Without it each instance fingerprints with its own key: one request under one business key is a conflict between instances. Rotating it makes every earlier intent a conflict. |
| **A9** | **Writes and sends happen inside a step's frame**, under its lease. | P1–P3 | Frames without a lease (a reply interpreter, `maxSpend()`, an eval judge, an MCP-exported tool) have no fence: what they write or send is unfenced. |
| **A10** | **Rate-limit and tree slots are not money.** They are counted on the caller's clock. | — | A skewed instance may overshoot a rate limit or a tree's concurrency cap. It never double-charges: P1–P3 do not depend on them. |
| **A11** | **The other system is the only side effect.** Business rows live in the store's own database, written in the effect's transaction. | P2 | A row written elsewhere (another database, a file) is outside the transaction: it can be written twice or kept after a rollback. |

## Holds through

- **Clock offsets of any size.** The store decides expiry by its own time, and the holder's fence
  counts elapsed time from when it *sent* the request — the argument holds for any offset; the
  tests sample ± lease/2, ± lease and ± 10 × lease.
- **A late answer.** The fence counts from the request, so a delayed answer shortens what the
  holder trusts, never lengthens it.
- **A crash, SIGKILL, SIGSTOP, a cut database connection** at the fault suite's hold points: its 21
  scenarios stop a pod at fixed points of its store calls, not at every step.
- **Any order of the store operations** of two instances, up to the explorer's depth (8 by
  default; 4 on PostgreSQL), and seeded walks of three; both orders of each two-outcome race the
  explorer lists (`races.ts`, `store-races.ts`). Deeper schedules are sampled, not explored.

## The proofs

Each checker is shown to bite: a deliberately broken store, or a broken history, fails it.

| What | Proves | Where it bites |
| --- | --- | --- |
| **The store contracts** (`storeConformance`, #481, #526) | Every rule of each fencing contract, for any store | [`broken-store-set.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/testing/contracts/broken-store-set.test.ts): check-then-write, rows outside the transaction, a read-then-close `leaseStateOf` |
| **The interleaving explorer** (`interleavings (<name>)`, #533) | P1, P3, P4 and P2 for the step's own key over every schedule of two instances up to a depth, seeded walks of three, the second clock skewed; both orders of each listed two-outcome race. The fenced effect under a business key is not explored (its contract cases and property tests cover it). A search out of its `timeLimit`, or aborted, fails with the counts it explored, never a pass (#590); one stopped while it shrinks fails with the schedule as found (#618) | [`explorer-bites.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/testing/contracts/explorer-bites.test.ts): ten naive stores — a minimal schedule and the invariant each breaks, or (a claim that does not compare) the races it fails; none breaks `one-effect-per-key` |
| **Property tests** (fast-check, #533) | On sampled sequences (in memory and on SQLite): the outbound-call state machine is the sequential model's; fingerprints canonical with no collision found in 500–1000 runs, key identities one-to-one, replays, joins and conflicts as the model says — one business key and one tenant, so key text and tenants are the contracts' cases (#538, #620) | [`outbound-call-bites.property.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/properties/outbound-call-bites.property.test.ts), and the step-only store in [`business-key.property.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/properties/business-key.property.test.ts); a failure reproduces from `FC_SEED` |
| **Mutation testing** (Stryker, #533) | Every mutant of the core's in-memory fencing modules — the lease store's base and live-lease rule, the in-memory fenced-effect and outbound-call stores, the clock, the held lease, the fence and the outbound-call protocol — is killed by a test or ignored where it stands: 796 mutants, 781 killed, 6 timeouts, 9 ignored by 5 `Stryker disable` comments, each naming only mutators whose every mutant on its line is equivalent, with the reason (#619: the 11 comments that also hid non-equivalent mutants are gone, their lines rewritten so that no equivalent mutant is left — an invariant read with `definedOf`, not an `if` whose other side never runs). The SQLite and PostgreSQL stores, the business-key identity and the rest of the outbound-call protocol are not mutated (#626) | the CI job `mutation` (`npm run test:mutation -w packages/agboss`) fails below 100 %; it found #574 |
| **The linearizability checker** (`linearizable`, #533) | Every fault run's store history has an order the sequential model of the fencing stores explains, each operation taking effect within its own span, one nobody saw answer at any time after its invoke (#617) | [`linearizability.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/testing/faults/linearizability.test.ts): a double owner (also one behind a frozen holder's renewal, #617), a renewal or write after a newer grant, a stale `Live`, finished work taken, two won claims; [`recorded-history.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/testing/faults/recorded-history.test.ts): a recorded double-owner history; [`sabotage.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/faults/sabotage.test.ts): the recorded runs of three broken stores |
| **The fault suite** (`faultSuite`, #484) | P1–P5 under real processes, signals and a cut database, 21 scenarios at their hold points; P5 by `no-undo-on-hand-over` on every run (scenario 12 a real failure; no scenario cancels) | [`sabotage.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/faults/sabotage.test.ts): three broken stores fail 5b, 5c (P1) and 6b (P4); P5's check bites on a hand-built run ([`invariants.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/testing/faults/invariants.test.ts)); in process, a fenced undo is a hand-over ([`execution-fence.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/app/execution-fence.test.ts)) and a cancel undoes ([`compensation-cancel.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/app/compensation-cancel.test.ts)) |
| **Clock skew** (#533 item 4) | P1 and P3 with offsets, drift, a suspend, a stepped wall clock and late answers | [`lease-skew.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/app/lease-skew.test.ts), [`lease-skew-charge.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/app/lease-skew-charge.test.ts): stores on the caller's clock, a fence without the margin, a monotonic-only fence |
| **PostgreSQL** | The same explorer (every schedule 4 steps deep, 50 walks), checker and fault suite on PostgreSQL. The explorer gives the stores the test's clock as their time (`COALESCE($n, clock_timestamp())` takes the parameter): it explores the SQL, not database time; database time is proved by `tests/stores/clock-authority.test.ts` and `tests/processes/clock-skew.test.ts`, and the fault suite runs on it | agbossjs/postgres `tests/contracts/store-conformance.test.ts`, `tests/contracts/explorer-bites.test.ts` (two broken lease stores), `tests/faults/`, in its CI |

## What no checker reaches

- **Atomicity inside one store operation** (a check, a round trip, then a write) is outside the
  explorer: it never runs two operations at once. The contracts' race cases and the fault suite
  cover it.
- **The provider's own behaviour** beyond `outboundGatewayChecklist` (G1–G5) is the provider's: run
  the checklist against its sandbox.
- **A6's window.** A send hung past `attemptTimeout` plus the lease can still coincide with a
  resend. Only G1 closes it, and the explorer stops such a send at its sender's fence on purpose,
  so that it checks the stores and not the provider.
