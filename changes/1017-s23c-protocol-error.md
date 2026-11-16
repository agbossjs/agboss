---
section: Added
issue: 1017
---

**Scenario 23c: a COMMIT's answer replaced by a server error that is no reset** (#1017) — scenario 23
lost the COMMIT's answer only by a connection reset, which a store's blacklist of transport errors
reads as unknown; SQLSTATE 08P01 at the COMMIT (what PgBouncer sends when its server connection
breaks) was read as a definite failure and undid a charge that had committed. The fault suite's
`DatabaseProxy.answerAfter(answer, ...patterns)` forwards the matched bytes (the database applies
them), drops the database's answer, writes `answer` to the client and ends the link; `answersAfterWrite`
counts the answered links. The new scenario `s23c-commit-answer-protocol-error` puts a PostgreSQL
ErrorResponse (FATAL, 08P01) there: the store must read it as unknown, the pod hands the tree
over, the other pod replays the row, one charge. It skips on a set with no TCP link, on a set that
declares `resolvesCommitByRetry`, and on a database whose error frame the suite does not build
(MongoDB, Redis).
