import { MemorySaver } from "@langchain/langgraph";
import {
  Action,
  ApplicationContext,
  ExecutionContext,
  FencedEffectRepository,
  Injectable,
  SpendRecorder,
  fencedEffectKeyOf,
  oneOf,
  variant,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type ExecutionLeaseTakeoverEvent,
  type OnExecutionEnd,
  type OnExecutionError,
  type OnExecutionLeaseTakeover,
  type Produced,
} from "../../../src/index.js";
import { InMemoryExecutionTreeRepository } from "../../../src/infrastructure/execution-tree.repository.js";
import type {
  ExecutionTree,
  ExecutionTreeValue,
} from "../../../src/infrastructure/execution-tree.repository.js";
import {
  IN_MEMORY_DATABASE,
  type InMemoryDatabase,
} from "../../../src/infrastructure/in-memory-database.js";
import { usd } from "../../../src/units/index.js";
import { ItemDto, ItemResultDto } from "../../flow/runtime/fixtures/fan-out.workflow.js";
import { BookingDto } from "./finished-undo.workflow.js";

/**
 * #607 — every automatic undo durable once across takeovers. A booking whose undo refunds it in a
 * fenced effect keyed by the undo's own step key (`<step key>:compensation`), and the test's hook at
 * four points of one undo: in its action before and after the refund, before and once its done mark
 * (`@agboss/compensated/<key>`) is written. The checkpoints in memory every instance shares.
 */

/** Where the hook freezes the undo's holder. */
export enum UndoPoint {
  ActionBefore = "in the undo action, before its refund",
  ActionAfter = "in the undo action, after its refund",
  MarkBefore = "before the undo's done mark is written",
  MarkAfter = "once the undo's done mark is written",
}

/** What ran, on which instance (reset with `resetUndoOnce`). */
export const undoOnceSeen = {
  bookings: [] as string[],
  /** Every run of the undo action: its step key and instance. */
  undos: [] as { readonly key: string; readonly instanceId: string }[],
  /** Every refund that took effect, by booking. */
  refunds: [] as { readonly bookingId: string; readonly instanceId: string }[],
  /** Each root's end: its instance, its error (none at a finish), the undos its event lists. */
  roots: [] as {
    readonly instanceId: string;
    readonly error: string | undefined;
    readonly undone: readonly string[];
  }[],
  takeovers: [] as { readonly holder: string; readonly previous: string | undefined }[],
};

const shared = {
  saver: new MemorySaver(),
  hook: undefined as
    | {
        readonly at: UndoPoint;
        freezes: number;
        key: string | undefined;
        readonly run: (instanceId: string) => Promise<void>;
      }
    | undefined,
};

export function resetUndoOnce(): void {
  shared.saver = new MemorySaver();
  shared.hook = undefined;
  for (const list of Object.values(undoOnceSeen)) list.length = 0;
}

/** Calls `run` at `at` for the first `freezes` times one undo (by its key) gets there. */
export function atUndo(
  at: UndoPoint,
  freezes: number,
  run: (instanceId: string) => Promise<void>,
): void {
  shared.hook = { at, freezes, key: undefined, run };
}

async function reached(at: UndoPoint, key: string, instanceId: string): Promise<void> {
  const { hook } = shared;
  if (hook?.at !== at || hook.freezes === 0) return;
  if (hook.key !== undefined && hook.key !== key) return;
  hook.key = key;
  hook.freezes -= 1;
  await hook.run(instanceId);
}

@Action({
  name: "refund-booking-action",
  description: "Refunds the booking, once per undo key",
  input: { booking: BookingDto },
  deps: [ExecutionContext, FencedEffectRepository],
})
export class RefundBookingAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffectRepository: FencedEffectRepository<unknown>,
  ) {}

  async execute(input: { readonly booking: Produced<BookingDto, unknown> }): Promise<void> {
    const { instanceId } = this.executionContext.tenant.application;
    const key = this.executionContext.step.idempotencyKey;
    const { bookingId } = input.booking.value;
    undoOnceSeen.undos.push({ key, instanceId });
    await reached(UndoPoint.ActionBefore, key, instanceId);
    const effect = fencedEffectKeyOf(this.executionContext, "refund");
    // in memory the work runs inside the effect's one atomic step: run is taken effect
    await this.fencedEffectRepository.saveResultIfAbsent(effect, () => {
      undoOnceSeen.refunds.push({ bookingId, instanceId });
      return { refundId: `refund-${bookingId}` };
    });
    await reached(UndoPoint.ActionAfter, key, instanceId);
  }
}

@Action({
  name: "paid-booking-action",
  description: "Books the item (paid; refunded by its undo)",
  input: { item: ItemDto },
  output: BookingDto,
  compensateWith: RefundBookingAction,
  deps: [ExecutionContext],
})
export class PaidBookingAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<BookingDto> {
    const bookingId = `booking-${input.item.value.name}-d${String(this.executionContext.depth)}`;
    undoOnceSeen.bookings.push(bookingId);
    return Promise.resolve({ bookingId });
  }
}

/** Spends past every budget: the next step is refused with `BudgetExceededError`. */
@Action({
  name: "overspend-action",
  description: "Calls a paid service that costs more than the budgets allow",
  input: { item: ItemDto },
  output: ItemResultDto,
  deps: [SpendRecorder],
})
export class OverspendAction {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  execute(input: { readonly item: Produced<ItemDto, unknown> }): Promise<ItemResultDto> {
    this.spendRecorder.record({ service: "refund-test-api", cost: usd(5000) });
    return Promise.resolve({ name: input.item.value.name });
  }
}

/** One level deeper from the root; the second level fails. */
@Action({
  name: "level-item-action",
  description: "Goes one level deeper from the root, its booking made; fails on the level below",
  input: { item: ItemDto, booking: BookingDto },
  output: oneOf(ItemDto, ItemResultDto),
  deps: [ExecutionContext],
})
export class LevelItemAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: {
    readonly item: Produced<ItemDto, unknown>;
    readonly booking: Produced<BookingDto, unknown>;
  }): Promise<unknown> {
    const { name } = input.item.value;
    if (this.executionContext.depth > 1) throw new Error(`item ${name} failed on level 2`);
    return Promise.resolve(variant(ItemDto, input.item.value));
  }
}

/** The checkpoints in shared memory: every instance resumes from the same ones. */
@Injectable()
export class SharedCheckpointSaver extends MemorySaver {
  constructor() {
    super();
    this.storage = shared.saver.storage;
    this.writes = shared.saver.writes;
  }
}

const DONE = "@agboss/compensated/";

/** The shared tree keys, with the hook around each undo's done mark. */
@Injectable({ deps: [IN_MEMORY_DATABASE, ApplicationContext] })
export class HookedExecutionTreeRepository extends InMemoryExecutionTreeRepository {
  constructor(
    database: InMemoryDatabase,
    private readonly applicationContext: ApplicationContext,
  ) {
    super(database);
  }

  override async saveIfAbsentInTree(
    tree: ExecutionTree,
    key: string,
    value: ExecutionTreeValue,
  ): Promise<boolean> {
    const undo = key.startsWith(DONE) ? key.slice(DONE.length) : undefined;
    const { instanceId } = this.applicationContext;
    if (undo !== undefined) await reached(UndoPoint.MarkBefore, undo, instanceId);
    const saved = await super.saveIfAbsentInTree(tree, key, value);
    if (undo !== undefined) await reached(UndoPoint.MarkAfter, undo, instanceId);
    return saved;
  }
}

/** Every root's end or failure and every takeover, with its instance. */
@Injectable({ deps: [ApplicationContext] })
export class UndoOnceLog implements OnExecutionEnd, OnExecutionError, OnExecutionLeaseTakeover {
  constructor(private readonly applicationContext: ApplicationContext) {}

  onExecutionEnd(event: ExecutionEndEvent): void {
    if (event.parentExecutionId !== undefined) return;
    const { instanceId } = this.applicationContext;
    undoOnceSeen.roots.push({ instanceId, error: undefined, undone: [] });
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    if (event.parentExecutionId !== undefined) return;
    const { instanceId } = this.applicationContext;
    const undone = event.compensations.map((undo) => `${undo.compensated.nodeId} ${undo.status}`);
    undoOnceSeen.roots.push({ instanceId, error: event.error.name, undone });
  }

  onExecutionLeaseTakeover(event: ExecutionLeaseTakeoverEvent): void {
    const { holderInstanceId: holder, previousHolderInstanceId: previous } = event;
    undoOnceSeen.takeovers.push({ holder, previous });
  }
}
