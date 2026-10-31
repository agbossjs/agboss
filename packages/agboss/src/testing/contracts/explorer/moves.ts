import { scopeKeyOf } from "../../../app/lease-lost.js";
import { OutboundCallLeaseState } from "../../../infrastructure/execution-lease-event.repository.js";
import type { FencedEffectKey } from "../../../infrastructure/fenced-effect.repository.js";
import { seconds } from "../../../units/index.js";
import { callStep } from "./calls.js";
import type { ExplorerRun } from "./run.js";
import { leaseStep } from "./steps.js";
import {
  EXPLORED_BUSINESS_KEY,
  EXPLORED_TENANT,
  ExplorerInvariant,
  TimeStep,
  type ExplorerAction,
} from "./types.js";

/**
 * The explorer's actions beyond the lease's own (#533 item 1): `leaseStateOf`, the step's fenced
 * effect, the outbound call's next operation, the other system taking a request, and the time —
 * and the one entry that runs any action.
 */

/** `leaseStateOf` of `tree`'s current epoch, asked by `instance`. */
async function checked(run: ExplorerRun, instance: number, tree: string): Promise<string> {
  const truth = run.observer.trees.get(tree);
  const calls = run.storesOf(instance).calls;
  if (truth === undefined || calls === undefined)
    throw new TypeError(`nothing to check on ${tree}`);
  const token = truth.epoch;
  const state = await calls.leaseStateOf({
    tenantId: EXPLORED_TENANT,
    leaseExecutionId: tree,
    token,
  });
  if (state === OutboundCallLeaseState.Superseded) run.observer.superseded(tree, token);
  return `epoch ${String(token)} → ${state}`;
}

/** The step's fenced effect key on `tree` at `token`: one step, whoever runs it. */
export const effectKeyOf = (tree: string, token: number): FencedEffectKey => ({
  scopeKey: scopeKeyOf(EXPLORED_TENANT, tree),
  tenantId: EXPLORED_TENANT,
  leaseExecutionId: tree,
  token,
  idempotencyKey: `${tree}:charge-action:1`,
  name: "charge",
});

/** The fenced effect of `instance` at the last token it held on `tree`. */
async function written(run: ExplorerRun, instance: number, tree: string): Promise<string> {
  const now = run.now;
  const token = run.observer.tokenOf(instance, tree) ?? 0;
  const { effects, rows } = run.storesOf(instance);
  if (effects === undefined || rows === undefined) throw new TypeError("no fenced-effect store");
  run.writes.add(`${String(instance)}|${tree}|${String(token)}`);
  const row = `effect:${tree}:instance-${String(instance)}:${String(token)}`;
  const outcome = await effects.saveResultIfAbsent(effectKeyOf(tree, token), (transaction) => {
    const inserted = rows.insert(transaction, row);
    return inserted === undefined ? row : inserted.then(() => row);
  });
  run.observer.accepted(
    `instance-${String(instance)}'s fenced effect (${outcome.status})`,
    tree,
    token,
    now,
  );
  const committed = (await rows.committed()).filter((one) => one.startsWith(`effect:${tree}:`));
  if (committed.length > 1)
    run.observer.fail(
      ExplorerInvariant.OneEffectPerKey,
      `the step's fenced effect on ${tree} wrote ${String(committed.length)} business rows: ${committed.join(", ")}`,
    );
  return `at token ${String(token)} → ${outcome.status}`;
}

/** The next operation of `instance`'s call on `tree`. */
async function called(run: ExplorerRun, instance: number, tree: string): Promise<string> {
  const calls = run.storesOf(instance).calls;
  if (calls === undefined) throw new TypeError("no outbound-call store");
  const outcome = await callStep(
    {
      calls,
      observer: run.observer,
      instance,
      tree,
      token: run.observer.tokenOf(instance, tree) ?? 0,
      now: run.now,
      newOwner: () => run.newOwner(instance),
    },
    run.phaseOf(instance, tree),
  );
  run.setPhase(instance, tree, outcome.next);
  return outcome.label;
}

/** The other system takes `instance`'s request in flight. */
function delivered(run: ExplorerRun, instance: number, tree: string, isAccepted: boolean): string {
  const phase = run.phaseOf(instance, tree);
  if (phase.phase !== "flight") throw new TypeError("no request in flight");
  if (isAccepted)
    run.observer.charged(
      EXPLORED_BUSINESS_KEY,
      `instance-${String(instance)} attempt ${String(phase.attempt)}`,
    );
  run.setPhase(instance, tree, {
    phase: "end",
    attempt: phase.attempt,
    owner: phase.owner,
    isAccepted,
  });
  return `attempt ${String(phase.attempt)}`;
}

/** The end of the earliest live lease after now, if one is live. */
export function nextEndOf(run: ExplorerRun): number | undefined {
  const ends = [...run.observer.trees.values()]
    .filter((truth) => !truth.released && truth.expiresAt > run.now)
    .map((truth) => truth.expiresAt);
  return ends.length === 0 ? undefined : Math.min(...ends);
}

async function timed(run: ExplorerRun, step: TimeStep): Promise<string> {
  const end = nextEndOf(run);
  const target =
    step === TimeStep.Beat || end === undefined
      ? run.now + seconds(10)
      : step === TimeStep.End
        ? end
        : end - 1;
  const by = Math.max(0, target - run.now);
  await run.clock.advance(seconds(by / 1000));
  return `+${String(by)} ms`;
}

/** Runs one action; its printed text. */
export function stepOf(run: ExplorerRun, action: ExplorerAction): Promise<string> {
  switch (action.kind) {
    case "lease":
      return leaseStep(run, action.operation, action.instance, action.tree);
    case "check":
      return checked(run, action.instance, action.tree);
    case "write":
      return written(run, action.instance, action.tree);
    case "call":
      return called(run, action.instance, action.tree);
    case "deliver":
      return Promise.resolve(delivered(run, action.instance, action.tree, action.isAccepted));
    case "time":
      return timed(run, action.step);
  }
}
