# ADR-0007 — Conversation memory as a FIFO queue of summaries

- **Status:** Accepted; amended by #120 PR 3 — the queue is now `CompactionStrategy.SummaryQueue`
  of a `@Compaction` (next to `SingleSummary` and `None`), it summarises what is older than the
  smallest `uncompactedTurns` among its readers, and a summary that does not fit
  `summaryMaxTokens` fails the execution with `CompactionError`; it runs before the next turn reads
  its thread, never after a turn (S132, [Memory Management](Memory-Management))
- **Issue:** #77

## Context

Readers saw only the last `historyLimit` turns verbatim: long conversations forgot their start, and
a larger limit made every turn more expensive. A rolling summary that re-summarises itself blurs
early details over time.

## Decision

- Every `every` turns, right after the answer, a model compacts them into one self-contained summary
  (full names, no outside pronouns). Input: its own turns + the raw turns of the previous window as
  read-only context. Summaries never read summaries.
- Summaries form a FIFO queue: readers see the latest `keep` (each reader has its own limit) plus the
  raw turns since the last compaction; older rows stay in the database.
- A compaction failure never fails the turn; its cost is the FinOps category `compaction`.

## Consequences

- ~`every × keep` turns of memory at the price of ~`keep` notes.
- The turn that compacts returns a few seconds later.
- References deeper than one window back are not resolved inside a summary.
