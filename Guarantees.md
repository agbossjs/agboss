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
| **A1** | **Store conformance.** The stores pass `storeConformance` — every contract, the store set's cases and the interleaving explorer — and `faultSuite` against a real database. | P1–P4 | Whatever rule the store breaks: a second live holder, a stale write accepted, a double charge, finished work taken. |
| **A2** | **One transactional backend.** The fenced-effect and outbound-call stores declare the lease store's `backend` and check the lease in the write's own transaction (`LeaseCheck.Atomic`). | P1–P3 | A holder whose lease was just taken over can still write or record: a double charge or a second owner's write. The opt-out `LeaseCheck.WithoutDoubleChargeProtection` says so, and assembly warns. |
| **A3** | **The database's clock is slewed, never stepped** (NTP slew only). | P1, P3 | A forward step expires live leases early: an early hand-over, never two holders. A backward step keeps a dead holder's lease alive longer: liveness only. A step by more than the margin while a holder trusts its lease can let another instance take it. |
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
  counts elapsed time from when it *sent* the request. Proved with offsets of ± lease/2, ± lease and
  ± 10 × lease.
- **A late answer.** The fence counts from the request, so a delayed answer shortens what the
  holder trusts, never lengthens it.
- **A crash at any step, SIGKILL, SIGSTOP, a cut database connection.** The fault suite's
  scenarios.
- **Any order of the store operations** of a few instances. The interleaving explorer explores
  them, and forces both orders of every two-outcome race.

## The proofs

Each checker is shown to bite: a deliberately broken store, or a broken history, fails it.

| What | Proves | Where it bites |
| --- | --- | --- |
| **The store contracts** (`storeConformance`, #481, #526) | Every rule of each fencing contract, for any store | [`broken-store-set.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/testing/contracts/broken-store-set.test.ts): check-then-write, rows outside the transaction, a read-then-close `leaseStateOf` |
| **The interleaving explorer** (`interleavings (<name>)`, #533) | P1–P4 over every schedule of two instances up to a depth, seeded walks of three, the second clock skewed; both orders of every two-outcome race. A search out of its `timeLimit` fails with the counts it explored, never a pass (#590) | [`explorer-bites.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/testing/contracts/explorer-bites.test.ts): ten naive stores, each with its invariant and a minimal schedule |
| **Property tests** (fast-check, #533) | The outbound-call state machine is the sequential model's; fingerprints are canonical and collision-free, key identities one-to-one, replays, joins and conflicts as the model says | [`outbound-call-bites.property.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/properties/outbound-call-bites.property.test.ts), and the step-only store in [`business-key.property.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/properties/business-key.property.test.ts); a failure reproduces from `FC_SEED` |
| **Mutation testing** (Stryker, #533) | Every mutant of the fencing modules — the lease store's base and live-lease rule, the fenced-effect and outbound-call stores, the clock, the held lease, the fence and the outbound-call protocol — is killed by a test or justified where it stands: 800 mutants, 747 killed, 6 timeouts, 47 ignored by 18 `Stryker disable` comments that each give the reason (an equivalent mutant) | the CI job `mutation` (`npm run test:mutation -w packages/agboss`) fails below 100 %; it found #574 |
| **The linearizability checker** (`linearizable`, #533) | Every fault run's store history has an order the sequential model of the fencing stores explains | [`linearizability.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/testing/faults/linearizability.test.ts): a double owner, a renewal or write after a newer grant, finished work taken, two won claims; [`recorded-history.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/testing/faults/recorded-history.test.ts): a recorded double-owner history; [`sabotage.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/faults/sabotage.test.ts): the recorded runs of three broken stores |
| **The fault suite** (`faultSuite`, #484) | P1–P5 under real processes, signals and a cut database, 20 scenarios | [`sabotage.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/faults/sabotage.test.ts) |
| **Clock skew** (#533 item 4) | P1 and P3 with offsets, drift, a suspend, a stepped wall clock and late answers | [`lease-skew.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/app/lease-skew.test.ts), [`lease-skew-charge.test.ts`](https://github.com/agbossjs/agboss/blob/main/packages/agboss/tests/app/lease-skew-charge.test.ts): stores on the caller's clock, a fence without the margin, a monotonic-only fence |
| **PostgreSQL** | The same explorer, checker and fault suite on PostgreSQL | agbossjs/postgres `tests/contracts/store-conformance.test.ts`, `tests/faults/`, in its CI |

## What no checker reaches

- **Atomicity inside one store operation** (a check, a round trip, then a write) is outside the
  explorer: it never runs two operations at once. The contracts' race cases and the fault suite
  cover it.
- **The provider's own behaviour** beyond `outboundGatewayChecklist` (G1–G5) is the provider's: run
  the checklist against its sandbox.
- **A6's window.** A send hung past `attemptTimeout` plus the lease can still coincide with a
  resend. Only G1 closes it, and the explorer stops such a send at its sender's fence on purpose,
  so that it checks the stores and not the provider.
