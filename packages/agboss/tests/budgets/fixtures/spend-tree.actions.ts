import {
  Action,
  ApplicationContext,
  Budget,
  BudgetPeriod,
  BudgetScope,
  Injectable,
  listOf,
  oneOf,
  SpendRecorder,
  variant,
  type BudgetHandler,
  type ExecutionEndEvent,
  type OnExecutionEnd,
  type Produced,
} from "../../../src/index.js";
import { Text } from "../../../src/dto/index.js";
import type { CostCounter } from "../../../src/infrastructure/cost-ledger.repository.js";
import { InMemoryCostLedgerRepository } from "../../../src/infrastructure/cost-ledger.repository.js";
import type { UsageRecord } from "../../../src/finops/usage.js";
import { usd, type Usd } from "../../../src/units/index.js";

/**
 * #685 — a tree of paid steps planned by the test: every node of the plan pays a service through
 * `SpendRecorder` (in cents, so sums are exact) — a level of the tree, its children on this
 * instance and on any instance, a step after them, the next level. Every payment is written down
 * (`spendTree.paid`), so a test compares the ledger with what was really spent.
 */

export class SpendNodeDto {
  @Text({ prompt: "the node's path in the plan" })
  path!: string;
}

export class SpendItemDto {
  @Text({ prompt: "a child's path in the plan" })
  path!: string;
}

export class SpendRemoteItemDto {
  @Text({ prompt: "a remote child's path in the plan" })
  path!: string;
}

export class SpendNoteDto {
  @Text({ prompt: "what was paid" })
  note!: string;
}

/** One level of the plan: what it pays, its children here and on any instance, what follows. */
export interface SpendLevel {
  readonly cents: number;
  readonly local: readonly number[];
  readonly remote: readonly number[];
  readonly afterCents: number;
  /** Paid once the next level returned: a step checked right after a child that had remote ones. */
  readonly closeCents: number;
  readonly next?: SpendLevel;
}

/** The plan by path, every payment made, the execution's limit; a ledger read's delay. */
export const spendTree = {
  plan: new Map<string, number>(),
  levels: new Map<string, SpendLevel>(),
  paid: [] as number[],
  limitCents: 1_000_000,
  ledgerLag: 0,
  /** Holds every remote child after its payment until the test lets it go; how many held. */
  held: undefined as Promise<void> | undefined,
  holds: 0,
  /** The instance each hold ran on, in order. */
  holders: [] as string[],
  /** The roots that ended, on whichever instance: their ids and spend, in cents. */
  ended: [] as { readonly executionId: string; readonly cents: number }[],
};

export function resetSpendTree(root: SpendLevel, limitCents: number, ledgerLag = 0): void {
  spendTree.plan.clear();
  spendTree.levels.clear();
  spendTree.paid.length = 0;
  spendTree.limitCents = limitCents;
  spendTree.ledgerLag = ledgerLag;
  spendTree.held = undefined;
  spendTree.holds = 0;
  spendTree.holders.length = 0;
  spendTree.ended.length = 0;
  let level: SpendLevel | undefined = root;
  for (let depth = 1; level !== undefined; depth += 1, level = level.next) {
    const path = `L${String(depth)}`;
    spendTree.levels.set(path, level);
    level.local.forEach((cents, index) =>
      spendTree.plan.set(`${path}/local${String(index)}`, cents),
    );
    level.remote.forEach((cents, index) =>
      spendTree.plan.set(`${path}/remote${String(index)}`, cents),
    );
  }
}

const levelOf = (path: string): SpendLevel => {
  const level = spendTree.levels.get(path);
  if (level === undefined) throw new Error(`no level ${path} in the plan`);
  return level;
};

/** Pays `cents` through the step's recorder and writes it down. */
const pay = (spendRecorder: SpendRecorder, cents: number): void => {
  if (cents === 0) return;
  spendTree.paid.push(cents);
  spendRecorder.record({ service: "spend-api", cost: usd(cents / 100) });
};

@Action({
  name: "pay-level-action",
  description: "Pays the level's own cost; its children here",
  input: { node: SpendNodeDto },
  output: listOf(SpendItemDto),
  deps: [SpendRecorder],
})
export class PayLevelAction {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  execute(input: { readonly node: Produced<SpendNodeDto, unknown> }): Promise<SpendItemDto[]> {
    const { path } = input.node.value;
    const level = levelOf(path);
    pay(this.spendRecorder, level.cents);
    return Promise.resolve(
      level.local.map((_, index) => ({ path: `${path}/local${String(index)}` })),
    );
  }
}

@Action({
  name: "remote-items-action",
  description: "The level's children on any instance",
  input: { node: SpendNodeDto, notes: listOf(SpendNoteDto) },
  output: listOf(SpendRemoteItemDto),
})
export class RemoteItemsAction {
  execute(input: {
    readonly node: Produced<SpendNodeDto, unknown>;
  }): Promise<SpendRemoteItemDto[]> {
    const { path } = input.node.value;
    const level = levelOf(path);
    return Promise.resolve(
      level.remote.map((_, index) => ({ path: `${path}/remote${String(index)}` })),
    );
  }
}

@Action({
  name: "pay-after-action",
  description: "Pays what follows the children; the next level, else a note",
  input: { node: SpendNodeDto, notes: listOf(SpendNoteDto) },
  output: oneOf(SpendNodeDto, SpendNoteDto),
  deps: [SpendRecorder],
})
export class PayAfterAction {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  execute(input: { readonly node: Produced<SpendNodeDto, unknown> }): Promise<unknown> {
    const { path } = input.node.value;
    const level = levelOf(path);
    pay(this.spendRecorder, level.afterCents);
    const depth = Number(path.slice(1));
    if (level.next === undefined) return Promise.resolve(variant(SpendNoteDto, { note: path }));
    return Promise.resolve(variant(SpendNodeDto, { path: `L${String(depth + 1)}` }));
  }
}

@Action({
  name: "pay-close-action",
  description: "Pays the level's close once the next level returned",
  input: { node: SpendNodeDto, note: SpendNoteDto },
  output: SpendNoteDto,
  deps: [SpendRecorder],
})
export class PayCloseAction {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  execute(input: { readonly node: Produced<SpendNodeDto, unknown> }): Promise<SpendNoteDto> {
    // the node on the path is the next level's: this level is the one above it
    const path = `L${String(Number(input.node.value.path.slice(1)) - 1)}`;
    pay(this.spendRecorder, levelOf(path).closeCents);
    return Promise.resolve({ note: path });
  }
}

@Action({
  name: "pay-item-action",
  description: "Pays a child's cost",
  input: { item: SpendItemDto },
  output: SpendNoteDto,
  deps: [SpendRecorder],
})
export class PayItemAction {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  execute(input: { readonly item: Produced<SpendItemDto, unknown> }): Promise<SpendNoteDto> {
    const { path } = input.item.value;
    pay(this.spendRecorder, spendTree.plan.get(path) ?? 0);
    return Promise.resolve({ note: path });
  }
}

@Action({
  name: "pay-remote-item-action",
  description: "Pays a remote child's cost; half of it in its own child here",
  input: { item: SpendRemoteItemDto },
  output: SpendItemDto,
  deps: [SpendRecorder],
})
export class PayRemoteItemAction {
  constructor(private readonly spendRecorder: SpendRecorder) {}

  execute(input: { readonly item: Produced<SpendRemoteItemDto, unknown> }): Promise<SpendItemDto> {
    const { path } = input.item.value;
    const cents = spendTree.plan.get(path) ?? 0;
    pay(this.spendRecorder, cents - Math.floor(cents / 2));
    spendTree.plan.set(`${path}/half`, Math.floor(cents / 2));
    return Promise.resolve({ path: `${path}/half` });
  }
}

@Action({
  name: "hold-item-action",
  description: "Holds a remote child after its payment, until the test lets it go",
  input: { item: SpendItemDto },
  deps: [ApplicationContext],
})
export class HoldItemAction {
  constructor(private readonly applicationContext: ApplicationContext) {}

  async execute(): Promise<void> {
    spendTree.holds += 1;
    spendTree.holders.push(this.applicationContext.instanceId);
    await spendTree.held;
  }
}

/** Every root's end, on whichever instance ended it. */
@Injectable()
export class SpendTreeLog implements OnExecutionEnd {
  onExecutionEnd(event: ExecutionEndEvent): void {
    if (event.parentExecutionId !== undefined) return;
    const cents = Math.round(event.spend.totalUsd * 100);
    spendTree.ended.push({ executionId: event.executionId, cents });
  }
}

/** The ledger, delayed by `spendTree.ledgerLag` turns of the event loop on every read: a networked one. */
@Injectable()
export class SpendTreeLedger extends InMemoryCostLedgerRepository {
  override async findSpentByCounter(counter: CostCounter): Promise<Usd> {
    for (let turn = 0; turn < spendTree.ledgerLag; turn += 1)
      await new Promise((resolve) => setImmediate(resolve));
    return super.findSpentByCounter(counter);
  }

  override async saveAll(
    counters: readonly CostCounter[],
    records: readonly UsageRecord[],
  ): Promise<void> {
    for (let turn = 0; turn < spendTree.ledgerLag; turn += 1)
      await new Promise((resolve) => setImmediate(resolve));
    await super.saveAll(counters, records);
  }
}

@Budget({ name: "spend-tree-execution-budget", scope: BudgetScope.Execution })
export class SpendTreeExecutionBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(spendTree.limitCents / 100);
  }
}

@Budget({ name: "spend-tree-tenant-budget", scope: BudgetScope.Tenant, period: BudgetPeriod.Day })
export class SpendTreeTenantBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1_000_000);
  }
}

@Budget({
  name: "spend-tree-application-budget",
  scope: BudgetScope.Application,
  period: BudgetPeriod.Day,
})
export class SpendTreeApplicationBudget implements BudgetHandler {
  maxSpend(): Usd {
    return usd(1_000_000);
  }
}
