import { InjectionToken } from "../components/injection.js";
import type { ExecutionLeaseRepository } from "./execution-lease.repository.js";

/**
 * Where a lease store that keeps no ids of its own hands what must outlive it to a durable store
 * (#591, #891, #1198): it claims an execution id there, kept forever, never in a coordination store
 * (Redis), and it requests and reads the tree's cancel mark there (#1117: permanent, on the tree's
 * lease row). Any lease store of a durable backend is one (`PostgresExecutionLeaseRepository`,
 * `MongoExecutionLeaseRepository`, `SqliteExecutionLeaseRepository`); one that lacks a method does
 * not type-check as the value of `EXECUTION_ID_STORE`.
 */
export type ExecutionIdStore = Pick<
  ExecutionLeaseRepository,
  "claimExecutionId" | "requestCancel" | "isCancelRequested"
>;

/**
 * The token of the application's `ExecutionIdStore` (#891, #1198): `RedisExecutionLeaseRepository`
 * injects it for its execution ids and its cancel mark, and the application gives it a durable lease
 * store by class (`provide(EXECUTION_ID_STORE, PostgresExecutionLeaseRepository)`), created by the
 * container under this token only: no second lease store, no `new`.
 */
export const EXECUTION_ID_STORE = new InjectionToken<ExecutionIdStore>("EXECUTION_ID_STORE");
