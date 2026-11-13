---
section: Changed
issue: 962
---

**A marked thread's latest checkpoint is one indexed read** (#962, from the tails audit of #682):
after the host's clock stepped back, the checkpointer reads a thread's latest by `(step, id)`, and
listed and sorted the whole namespace to do it, on every read for the thread's life. A checkpoint
saver can now have the optional `latestByStep(config)` (`LatestByStepCheckpointSaver`,
`@agboss/core/stores`; contract `StoreCapability.LatestByStep`, passed with
`checkpointSaverContract`): the checkpoint of a thread's namespace with the greatest
`metadata.step`, ties by the greatest `checkpoint_id` by code unit, a missing step counting as -2.
The in-memory default and `SqliteCheckpointSaver` have it (SQLite: a `step` column written with the
row, an index, and a backfill of old rows when the file is opened); a saver without it keeps the
scan, correct and slow. On 10 000 checkpoints a read went from 26 ms (in memory) and 120 ms
(SQLite) to under 0.1 ms. The scan's tie order is now by code unit, as every store's index.
