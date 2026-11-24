import type { InterruptMode } from "../app/interrupt-types.js";
import type { NewStatusTransition } from "../turns/index.js";
import {
  ExecutionLeaseRepository,
  type ExecutionIdentity,
  type ExecutionLease,
  type PauseMarks,
  type PauseRequest,
  type StopMark,
  type TreeMarks,
} from "../infrastructure/execution-lease.repository.js";
import type { ExecutionTree } from "../infrastructure/execution-tree.repository.js";
import type { Milliseconds } from "../units/index.js";
import type { LeaseGate } from "./leases.js";

/** The instance's lease store behind its gate: every call waits while the instance is frozen. */
export class GatedExecutionLeaseRepository extends ExecutionLeaseRepository {
  constructor(
    private readonly repository: ExecutionLeaseRepository,
    private readonly gate: LeaseGate,
  ) {
    super();
  }

  async ping(): Promise<void> {
    await this.gate.passed();
    return this.repository.ping();
  }

  async claimExecutionId(identity: ExecutionIdentity): Promise<boolean> {
    await this.gate.passed();
    return this.repository.claimExecutionId(identity);
  }

  async acquire(
    tenantId: string,
    rootExecutionId: string,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    await this.gate.passed();
    return this.repository.acquire(tenantId, rootExecutionId, duration);
  }

  async renew(
    executionLease: ExecutionLease,
    duration: Milliseconds,
  ): Promise<Milliseconds | undefined> {
    await this.gate.passed();
    return this.repository.renew(executionLease, duration);
  }

  async release(executionLease: ExecutionLease): Promise<void> {
    await this.gate.passed();
    return this.repository.release(executionLease);
  }

  async retire(executionLease: ExecutionLease): Promise<void> {
    await this.gate.passed();
    return this.repository.retire(executionLease);
  }

  async yield(executionLease: ExecutionLease): Promise<Milliseconds | undefined> {
    await this.gate.passed();
    return this.repository.yield(executionLease);
  }

  async reclaim(
    executionLease: ExecutionLease,
    duration: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    await this.gate.passed();
    return this.repository.reclaim(executionLease, duration);
  }

  async requestCancel(tree: ExecutionTree, transition?: NewStatusTransition): Promise<void> {
    await this.gate.passed();
    return this.repository.requestCancel(tree, transition);
  }

  async requestStop(
    tree: ExecutionTree,
    mode: InterruptMode,
    transition?: NewStatusTransition,
  ): Promise<void> {
    await this.gate.passed();
    return this.repository.requestStop(tree, mode, transition);
  }

  stopOf(tree: ExecutionTree): Promise<StopMark | undefined> {
    return this.repository.stopOf(tree);
  }

  async requestPause(
    tree: ExecutionTree,
    request: PauseRequest,
    transition?: NewStatusTransition,
  ): Promise<void> {
    await this.gate.passed();
    return this.repository.requestPause(tree, request, transition);
  }

  async unpause(tree: ExecutionTree, transition?: NewStatusTransition): Promise<void> {
    await this.gate.passed();
    return this.repository.unpause(tree, transition);
  }

  pauseOf(tree: ExecutionTree): Promise<PauseMarks> {
    return this.repository.pauseOf(tree);
  }

  override markedOf(tree: ExecutionTree): Promise<TreeMarks> {
    return this.repository.markedOf(tree);
  }

  isCancelRequested(tree: ExecutionTree): Promise<boolean> {
    // a read, not an ask for a lease: a frozen instance's frozen ask is the take's (#520), not this
    return this.repository.isCancelRequested(tree);
  }
}
