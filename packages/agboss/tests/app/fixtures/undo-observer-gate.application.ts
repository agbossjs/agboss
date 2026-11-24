/**
 * #605 / #640 — where an undo's holder is held while its lease runs out: the tree store's read of the
 * undo's done mark (`@agboss/compensated/…`, #607: the last store call before the undo, after the
 * holder's last lease renewal), the undo's `onCompensationStart`, or its undo action's
 * `onActionStart` (an observer, or the PII mask of its event — a model call with `detectWithModel` —
 * taking long). The first arrival at the armed place is held until the test lets it go; every
 * `onCompensationStart` is kept with its instance.
 */
import {
  ApplicationContext,
  EmptyEnvironment,
  Injectable,
  type ActionStartEvent,
  type CompensationStartEvent,
  type OnActionStart,
  type OnCompensationStart,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import {
  InMemoryExecutionTreeRepository,
  type ExecutionTree,
  type ExecutionTreeValue,
} from "../../../src/infrastructure/execution-tree.repository.js";
import {
  IN_MEMORY_DATABASE,
  type InMemoryDatabase,
} from "../../../src/infrastructure/in-memory-database.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import { EndOnceLog } from "./child-end-once.workflow.js";
import { UndoLocalWorkflow } from "./child-failure-once.workflow.js";
import { FinishLog, MatrixCheckpointSaver } from "./end-once-matrix.workflow.js";
import { UndoChildWorkflow } from "./finished-undo.workflow.js";
import { JoinUndoWorkflow } from "./join-undo.workflow.js";

/** Where the holder is held. */
export enum UndoHold {
  /** The read of the undo's done mark: before the holder's first fence check (#605). */
  DoneMarkRead = "at the read of its done mark",
  /** Its `onCompensationStart`: after the first check, before the undo action (#640). */
  CompensationStart = "in onCompensationStart",
  /** Its undo action's `onActionStart`: the last await before `execute` (#640). */
  ActionStart = "in its undo action's onActionStart",
}

/** The armed place, who was held there, how to let it go, and every undo's start heard. */
export const undoStartGate = {
  at: undefined as UndoHold | undefined,
  held: [] as string[],
  release: (): void => undefined,
  started: [] as string[],
};

export function armUndoStartGate(at: UndoHold): void {
  undoStartGate.at = at;
  undoStartGate.held.length = 0;
  undoStartGate.started.length = 0;
  undoStartGate.release = () => undefined;
}

/** Holds the first arrival at `at` (then disarms), on whichever instance. */
function heldAt(at: UndoHold, instanceId: string): Promise<void> | undefined {
  if (undoStartGate.at !== at) return undefined;
  undoStartGate.at = undefined;
  undoStartGate.held.push(instanceId);
  return new Promise((resolve) => {
    undoStartGate.release = resolve;
  });
}

/** The undo action of the fixtures' bookings. */
const UNDO_ACTION = "cancel-booking-action";

/** Keeps every undo's start; holds the armed one. */
@Injectable({ deps: [ApplicationContext] })
export class UndoStartGate implements OnCompensationStart, OnActionStart {
  constructor(private readonly applicationContext: ApplicationContext) {}

  onCompensationStart(_event: CompensationStartEvent): Promise<void> | undefined {
    const { instanceId } = this.applicationContext;
    undoStartGate.started.push(instanceId);
    return heldAt(UndoHold.CompensationStart, instanceId);
  }

  onActionStart(event: ActionStartEvent): Promise<void> | undefined {
    if (event.name !== UNDO_ACTION) return undefined;
    return heldAt(UndoHold.ActionStart, this.applicationContext.instanceId);
  }
}

/** The shared tree keys; the first read of an undo's done mark held when armed there. */
@Injectable({ deps: [IN_MEMORY_DATABASE, ApplicationContext] })
export class DoneMarkHeldTreeRepository extends InMemoryExecutionTreeRepository {
  constructor(
    database: InMemoryDatabase,
    private readonly applicationContext: ApplicationContext,
  ) {
    super(database);
  }

  override async findByIdInTree(
    tree: ExecutionTree,
    key: string,
  ): Promise<ExecutionTreeValue | undefined> {
    if (key.startsWith("@agboss/compensated/"))
      await heldAt(UndoHold.DoneMarkRead, this.applicationContext.instanceId);
    return super.findByIdInTree(tree, key);
  }
}

@Application({
  name: "undo-observer-gate-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [UndoChildWorkflow, JoinUndoWorkflow, UndoLocalWorkflow],
  observers: [EndOnceLog, FinishLog, UndoStartGate],
  providers: [RecordingLogger, MatrixCheckpointSaver, DoneMarkHeldTreeRepository],
  budgets: TEST_BUDGETS,
})
export class UndoObserverGateApplication {}
