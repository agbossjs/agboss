/**
 * #533 item 2: the property tests' world — two instances' lease and outbound-call stores on one
 * backing store and a `VirtualClock`, the commands fast-check generates for them, and each command
 * run on the store and on the sequential model (`src/testing/contracts/models/`), its two answers
 * compared.
 */
import fc from "fast-check";
import { scopeKeyOf } from "../../src/app/lease-lost.js";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import type { ExecutionLease } from "../../src/infrastructure/execution-lease.repository.js";
import { fencedKeyIdentityOf } from "../../src/infrastructure/fenced-effect-key.js";
import type { FencedEffectKey } from "../../src/infrastructure/fenced-effect.repository.js";
import type { OutboundCallStatus } from "../../src/infrastructure/outbound-call.repository.js";
import { TEST_START, VirtualClock } from "../../src/testing/clock.js";
import type { ContractTarget, OutboundCallStores } from "../../src/testing/contracts/index.js";
import {
  callClaimed,
  callEnded,
  callFound,
  callSaved,
  type CallKeyFacts,
  type ReadCall,
} from "../../src/testing/contracts/models/call-model.js";
import {
  acquired,
  EMPTY_FENCING_STATE,
  leaseStateAt,
  released,
  renewed,
  treeOf,
  type FencingState,
} from "../../src/testing/contracts/models/lease-model.js";
import { TestStoreClock } from "../../src/testing/store-clock.js";
import { seconds } from "../../src/units/index.js";

export const LEASE = seconds(30);
const TENANT = "default";
const TREES = ["tree-1", "tree-2"] as const;
const OWNERS = ["owner-a", "owner-b", "owner-c"] as const;

/** One generated command of an instance (1 or 2), or the time moving. */
export type Command =
  | { readonly op: "acquire"; readonly instance: number; readonly tree: string }
  | { readonly op: "renew" | "release" | "find"; readonly instance: number }
  | { readonly op: "save"; readonly instance: number; readonly owner: string }
  | {
      readonly op: "claim";
      readonly instance: number;
      readonly expected: ReadCall;
      readonly owner: string;
    }
  | {
      readonly op: "end";
      readonly instance: number;
      readonly owner: string;
      readonly status: "completed" | "failed";
    }
  | {
      readonly op: "state";
      readonly instance: number;
      readonly tree: string;
      readonly token: number;
    }
  | { readonly op: "time"; readonly ms: number };

const instance = fc.constantFrom(1, 2);
const owner = fc.constantFrom(...OWNERS);
const tree = fc.constantFrom(...TREES);

/** The commands fast-check generates: small sets, so that keys, owners and states meet. */
export const commandArbitrary: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ op: fc.constant("acquire" as const), instance, tree }),
  fc.record({
    op: fc.constantFrom("renew" as const, "release" as const, "find" as const),
    instance,
  }),
  fc.record({ op: fc.constant("save" as const), instance, owner }),
  fc.record({
    op: fc.constant("claim" as const),
    instance,
    owner,
    expected: fc.record({
      status: fc.constantFrom("pending" as const, "failed" as const, "completed" as const),
      attempt: fc.constantFrom(1, 2),
      attemptOwner: owner,
    }),
  }),
  fc.record({
    op: fc.constant("end" as const),
    instance,
    owner,
    status: fc.constantFrom("completed" as const, "failed" as const),
  }),
  fc.record({ op: fc.constant("state" as const), instance, tree, token: fc.constantFrom(1, 2) }),
  fc.record({ op: fc.constant("time" as const), ms: fc.constantFrom(1, 10_000, 29_999, 30_000) }),
);

/** The live world of one run: its clock, the two instances' stores, their leases, the model. */
export interface PropertyWorld {
  readonly clock: VirtualClock;
  readonly stores: readonly OutboundCallStores[];
  readonly leases: Map<number, ExecutionLease>;
  state: FencingState;
}

/** Two instances of any store on `target`, reset first, on one new clock. */
export async function instancesOn<TStore>(
  target: ContractTarget<TStore>,
): Promise<{ readonly clock: VirtualClock; readonly stores: readonly TStore[] }> {
  const clock = new VirtualClock(new Date(TEST_START));
  await target.reset?.();
  const stores: TStore[] = [];
  for (const instanceId of ["instance-1", "instance-2"]) {
    const application = applicationContextOf({
      name: "property-application",
      version: "1.0.0",
      instanceId,
      startedAt: clock.now(),
      environmentName: "test",
      environment: NO_ENVIRONMENT_VALUES,
    });
    stores.push(
      await target.instance({
        clock,
        storeClock: new TestStoreClock(clock),
        instanceId,
        application,
      }),
    );
  }
  return { clock, stores };
}

/** A new world on `target`: reset, two instances built on the run's clock. */
export async function worldOn(target: ContractTarget<OutboundCallStores>): Promise<PropertyWorld> {
  const { clock, stores } = await instancesOn(target);
  return { clock, stores, leases: new Map(), state: EMPTY_FENCING_STATE };
}

/** The call key of `instance` under the lease it holds (token 0 without one: always fenced). */
function keyOf(
  world: PropertyWorld,
  instance: number,
): { readonly key: FencedEffectKey; readonly facts: CallKeyFacts } {
  const lease = world.leases.get(instance);
  const leaseTree = lease?.rootExecutionId ?? TREES[0];
  const key: FencedEffectKey = {
    scopeKey: scopeKeyOf(TENANT, leaseTree),
    tenantId: TENANT,
    leaseExecutionId: leaseTree,
    token: lease?.leaseEpoch ?? 1_000,
    idempotencyKey: `${leaseTree}:charge-action:1`,
    name: "charge",
    businessKey: "order:1",
    fingerprint: "f",
  };
  const facts = {
    tree: treeOf(TENANT, leaseTree),
    token: key.token,
    scope: key.scopeKey,
    identity: fencedKeyIdentityOf(key),
    leaseExecutionId: leaseTree,
  };
  return { key, facts };
}

/** A store's answer as the model gives it: the fence's refusal as `"fenced"`. */
export async function answerOf(call: Promise<unknown>): Promise<unknown> {
  try {
    const answer = await call;
    if (
      typeof answer === "object" &&
      answer !== null &&
      "status" in answer &&
      "attemptOwner" in answer
    ) {
      const { status, attempt, attemptOwner, token } = answer as {
        status: OutboundCallStatus;
        attempt: number;
        attemptOwner: string;
        token: number;
      };
      return { status, attempt, attemptOwner, token };
    }
    return answer ?? null;
  } catch (error) {
    if (error instanceof Error && error.name === "ExecutionFencedError") return "fenced";
    throw error;
  }
}

/** The holder name of `instance`. */
const holderOf = (instance: number): string => `instance-${String(instance)}`;

/** Runs a lease command on both sides; the two answers. */
async function leaseCommand(
  world: PropertyWorld,
  command: Command & { instance: number },
  now: number,
): Promise<readonly [unknown, unknown]> {
  const { leases } = world.stores[command.instance - 1] ?? never();
  const held = world.leases.get(command.instance);
  const holder = holderOf(command.instance);
  if (command.op === "acquire") {
    const step = acquired(world.state, treeOf(TENANT, command.tree), holder, LEASE, now);
    world.state = step.state;
    const lease = await leases.acquire(TENANT, command.tree, LEASE);
    if (lease !== undefined) world.leases.set(command.instance, lease);
    return [
      lease === undefined ? null : { epoch: lease.leaseEpoch, holder: lease.holderInstanceId },
      step.answer,
    ];
  }
  if (held === undefined) return [null, null];
  const at = treeOf(TENANT, held.rootExecutionId);
  if (command.op === "renew") {
    const step = renewed(world.state, at, holder, held.leaseEpoch, LEASE, now);
    world.state = step.state;
    const remaining = await leases.renew(held, LEASE);
    return [remaining === undefined ? null : remaining > 0, step.answer === null ? null : true];
  }
  const step = released(world.state, at, holder, held.leaseEpoch, false);
  world.state = step.state;
  await leases.release(held);
  return [null, step.answer];
}

/** Runs an outbound-call command on both sides; the two answers. */
async function callCommand(
  world: PropertyWorld,
  command: Command & { instance: number },
  now: number,
): Promise<readonly [unknown, unknown]> {
  const { calls } = world.stores[command.instance - 1] ?? never();
  const { key, facts } = keyOf(world, command.instance);
  const run = <T>(
    step: { readonly state: FencingState; readonly answer: T },
    call: Promise<unknown>,
  ) => {
    world.state = step.state;
    return answerOf(call).then((answer) => [answer, step.answer] as const);
  };
  switch (command.op) {
    case "find":
      return run(callFound(world.state, facts, now), calls.findByKey(key));
    case "save":
      return run(
        callSaved(world.state, facts, command.owner, now),
        calls.saveIfAbsent(key, intentOf(key, command.owner)),
      );
    case "claim":
      return run(
        callClaimed(
          world.state,
          facts,
          command.expected,
          { attempt: command.expected.attempt + 1, attemptOwner: command.owner },
          now,
        ),
        calls.markPending(key, command.expected as never, {
          attempt: command.expected.attempt + 1,
          attemptOwner: command.owner,
        }),
      );
    case "end":
      return run(
        callEnded(world.state, facts, command.owner, command.status, now),
        command.status === "completed"
          ? calls.markCompleted(key, command.owner, '"paid"')
          : calls.markFailed(key, command.owner, {
              name: "DeclinedError",
              code: "DeclinedError",
              message: "declined",
            }),
      );
    case "state": {
      const lease = { tenantId: TENANT, leaseExecutionId: command.tree, token: command.token };
      return run(
        leaseStateAt(world.state, treeOf(TENANT, command.tree), command.token, now),
        calls.leaseStateOf(lease),
      );
    }
    default:
      return leaseCommand(world, command, now);
  }
}

/** Runs `command` on the store and the model: `[store's answer, model's answer]`. */
export async function ran(
  world: PropertyWorld,
  command: Command,
): Promise<readonly [unknown, unknown]> {
  const now = world.clock.now().getTime();
  if (command.op === "time") {
    await world.clock.advance(seconds(command.ms / 1000));
    return [null, null];
  }
  return callCommand(world, command, now);
}

/** The first command whose store answer is not the model's, or nothing. */
export async function firstDifference(
  target: ContractTarget<OutboundCallStores>,
  commands: readonly Command[],
): Promise<string | undefined> {
  const world = await worldOn(target);
  for (const [at, command] of commands.entries()) {
    const [store, model] = await ran(world, command);
    if (JSON.stringify(store) !== JSON.stringify(model))
      return `command ${String(at + 1)} ${JSON.stringify(command)}: the store answered ${JSON.stringify(store)}, the model ${JSON.stringify(model)}`;
  }
  return undefined;
}

const intentOf = (key: FencedEffectKey, attemptOwner: string) => ({
  rootExecutionId: key.leaseExecutionId,
  executionId: key.leaseExecutionId,
  workflow: "property-workflow",
  target: "payments",
  operation: "charge",
  idempotencyKey: "default:order%3A1:charge",
  request: "{}",
  attempt: 1,
  attemptOwner,
  step: { nodeId: "charge-action", visitNumber: 1 },
});

const never = (): never => {
  throw new Error("no such instance");
};
