---
section: Breaking
issue: 1321
---

**Store listings page with `Page` / `PageQuery`** (#1321b): `ExecutionRecordRepository.findByStatus({ status, cursor?, limit? })` gives a `Page<Turn>` (it was `findByStatus(status, limit, after?)` giving an array); `ExecutionHistoryRepository.findAllByStartedAtBetween({ from, to, cursor?, limit? })` and `findAllByTenantIdAndStartedAtBetween({ tenantId, from, to, cursor?, limit? })` give a `Page<ExecutionHistoryRecord>`. `ExecutionHistoryPage` ({ offset, limit }) is removed; `ExecutionRecordStatusQuery`, `ExecutionHistoryQuery` and `TenantExecutionHistoryQuery` are added. A cursor is the `nextCursor` of an earlier page, never one a caller builds: a store that cannot read it refuses it. Store follow-up: Postgres, MongoDB and Redis implement the new shapes (the contract cases in `execution-record.contract.ts` and `execution-history.contract.ts` page through three records by cursor).
