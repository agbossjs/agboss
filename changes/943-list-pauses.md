---
section: Added
issue: 943
---

**`app.listPauses` and pause metrics** (#943): an operator lists a tenant's pauses by status
(default `Pending`), target, channel and `expiringBefore` (#1307e widened the filters), page by page
(`limit` 1 to 1000, default 100; `cursor` is the `nextCursor` of the page before, a position in the
order the pauses were made, so a pause that opens or closes between two pages never makes another
skipped or repeated). A pause is
shown as `result.pending` shows it — a `Channel` pause without its answering id, its `pauseKey`
always — with its `ask` masked by its workflow's observability policies; closed ones carry `reason`,
`closedAt` and who answered. New metrics on the instance's meter: `agboss.instance.pauses.opened`,
`.closed` (by `reason`), `.time_to_answer` (a histogram in seconds, human answers only),
`.timeout_changed`, `.reassigned`, `.answers_not_taken`, and the cluster gauges `agboss.cluster.pauses.notices.waiting` /
`.dead`. A custom `Metric` consumer sees a new instrument kind, `MetricKind.Histogram`.
