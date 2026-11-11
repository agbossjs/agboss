import { ExecutionAuditEventKind } from "../../../infrastructure/execution-audit-log.repository.js";
import type { FaultRun } from "../facts.js";
import { compareAt } from "../operation-history.js";
import { OutboundCallStatus } from "../../../infrastructure/outbound-call.repository.js";
import { StoreHoldPoint } from "../store-points.js";
import {
  acceptedWritesOf,
  finishesOf,
  grantsOf,
  unansweredWritesOf,
  type FencedWrite,
  type Grant,
} from "./store-history.js";
import { FaultInvariant, violation, type FaultViolation } from "./violations.js";

/**
 * One owner per tree (#484 invariant 1), from the store history and the audit log:
 * - every epoch of a lease key is granted once, and a key's epochs grow in the order granted;
 * - a write the store's lease check let through at token N (#840: any answer but an error) came from the instance that was granted epoch N — and a
 *   write at a token no grant of its key gave is a violation too (#840: a forged or unrecorded
 *   token fails closed, never passes for want of a grant to compare it with);
 * - no write is accepted at token N once epoch N + k was granted (its grant answered before the
 *   write was asked): the zombie's write is refused;
 * - a write never answered (#876: its pod died before the answer) that the store's rows hold — the
 *   fenced effects' stored tokens in the audit log, the outbound calls' rows — is checked as one
 *   accepted;
 * - the audit log has one takeover per token of an execution;
 * - no lease of finished work is granted again (#520).
 */

/** The grants of each key, in the order granted. */
const byKey = (grants: readonly Grant[]): ReadonlyMap<string, readonly Grant[]> => {
  const keys = new Map<string, Grant[]>();
  for (const grant of grants) keys.set(grant.key, [...(keys.get(grant.key) ?? []), grant]);
  return keys;
};

/** Each epoch once, and growing. */
function epochViolations(keys: ReadonlyMap<string, readonly Grant[]>): FaultViolation[] {
  return [...keys].flatMap(([key, grants]) =>
    grants.flatMap((grant, at) => {
      const earlier = grants.slice(0, at);
      if (earlier.some((other) => other.epoch === grant.epoch))
        return [
          violation(
            FaultInvariant.OneOwner,
            `epoch ${String(grant.epoch)} of ${key} was granted twice (the second to ${grant.holder})`,
          ),
        ];
      if (earlier.some((other) => other.epoch > grant.epoch))
        return [
          violation(
            FaultInvariant.OneOwner,
            `epoch ${String(grant.epoch)} of ${key} was granted after a higher one`,
          ),
        ];
      return [];
    }),
  );
}

/** What is wrong with a let-through `write`: not its epoch's holder's, or after a newer grant. */
function writeProblems(write: FencedWrite, keys: ReadonlyMap<string, readonly Grant[]>): string[] {
  const grants = keys.get(write.key) ?? [];
  const own = grants.find((grant) => grant.epoch === write.token);
  const found: string[] = [];
  if (own === undefined)
    found.push(
      `${write.operation} of ${write.key} at token ${String(write.token)} (${write.instanceId}, ${write.id}) was accepted, but no lease of ${write.key} was granted at epoch ${String(write.token)}`,
    );
  else if (own.holder !== write.instanceId)
    found.push(
      `${write.operation} of ${write.key} at token ${String(write.token)} was accepted from ${write.instanceId}, but ${own.holder} held that epoch`,
    );
  const newer = grants.find(
    (grant) => grant.epoch > write.token && compareAt(grant.at, write.invokedAt) < 0,
  );
  if (newer !== undefined)
    found.push(
      `${write.operation} of ${write.key} at token ${String(write.token)} (${write.instanceId}) was accepted after epoch ${String(newer.epoch)} was granted to ${newer.holder}: a stale write`,
    );
  return found;
}

/** Every accepted write is its epoch's holder's, and none follows a newer grant. */
function writeViolations(
  run: FaultRun,
  keys: ReadonlyMap<string, readonly Grant[]>,
): FaultViolation[] {
  return acceptedWritesOf(run.history).flatMap((write) =>
    writeProblems(write, keys).map((problem) => violation(FaultInvariant.OneOwner, problem)),
  );
}

/** A fenced effect's write, as the history names its operation. */
const FENCED_EFFECT_WRITE: string = StoreHoldPoint.FencedEffectWrite;

/** The state each outbound-call write leaves its row in: what tells which write the row's last is. */
const LEFT_AT: Readonly<Record<string, OutboundCallStatus>> = {
  [StoreHoldPoint.OutboundSaveIfAbsent]: OutboundCallStatus.Pending,
  [StoreHoldPoint.OutboundMarkPending]: OutboundCallStatus.Pending,
  [StoreHoldPoint.OutboundMarkCompleted]: OutboundCallStatus.Completed,
  [StoreHoldPoint.OutboundMarkFailed]: OutboundCallStatus.Failed,
};

/** A fenced write the store's rows hold (#876): the token it was written at, and whose it is. */
interface WrittenRow {
  readonly token: number;
  readonly holds: (write: FencedWrite) => boolean;
}

/**
 * The store's own record of its fenced writes, as the run's end read it, through the public API:
 * - each fenced effect's stored token, as the store answered it to a later call of the key (a
 *   audit-log row's `writtenToken`; a business key's replay of another step's write left out) — a
 *   write whose pod died is never checkpointed, so its step runs again on the next holder and the
 *   tree must finish (`trees-finish`): that call reads the row back;
 * - each outbound call's row: its token, its state and its attempt's owner are its last write's —
 *   what tells that write from the others of the call; a stale write a later one moved on from is
 *   out of reach here (the later write is checked on its own).
 * The fenced effects' rows are read as the store answered them to the step's next call, not from its
 * table (no store reads its results back but by key); a key nobody calls again is out of reach.
 */
function writtenRowsOf(run: FaultRun): readonly WrittenRow[] {
  return run.trees.flatMap((tree) => [
    ...tree.auditLog.flatMap((row): WrittenRow[] =>
      row.kind === ExecutionAuditEventKind.FencedEffect &&
      row.writtenToken !== undefined &&
      row.replayedFrom === undefined
        ? [
            {
              token: row.writtenToken,
              holds: (write) =>
                write.operation === FENCED_EFFECT_WRITE &&
                write.scopeKey === row.scopeKey &&
                write.idempotencyKey === row.step.idempotencyKey &&
                write.name === row.name,
            },
          ]
        : [],
    ),
    ...tree.outboundCalls.map((row): WrittenRow => ({
      token: row.token,
      holds: (write) =>
        LEFT_AT[write.operation] === row.status &&
        write.attemptOwner === row.attemptOwner &&
        write.key === row.leaseExecutionId &&
        write.name === row.name,
    })),
  ]);
}

/**
 * #876: a fenced write never answered — its pod died between the write and the record — that the
 * store's rows hold (written at its token, and no answered write of it at that token) is checked
 * as an accepted one. Several unanswered writes of it at that token: a violation only when none of
 * them could have been let through rightly (any one of them is the row). A row no write of the
 * history explains is left alone: a dying pod's invoke may be lost on its way to the test.
 */
function unansweredViolations(
  run: FaultRun,
  keys: ReadonlyMap<string, readonly Grant[]>,
): FaultViolation[] {
  const answered = acceptedWritesOf(run.history);
  const unanswered = unansweredWritesOf(run.history);
  const found = new Map<string, FaultViolation[]>();
  for (const row of writtenRowsOf(run)) {
    const atRow = (write: FencedWrite): boolean => write.token === row.token && row.holds(write);
    if (answered.some(atRow)) continue;
    const candidates = unanswered
      .filter(atRow)
      .map((write) => ({ write, problems: writeProblems(write, keys) }));
    if (candidates.length === 0 || candidates.some(({ problems }) => problems.length === 0))
      continue;
    for (const { write, problems } of candidates)
      found.set(
        write.id,
        problems.map((problem) =>
          violation(
            FaultInvariant.OneOwner,
            `${problem} (never answered: its pod died before the answer, and the store's row holds the write at token ${String(row.token)})`,
          ),
        ),
      );
  }
  return [...found.values()].flat();
}

/** One takeover row per token of an execution. */
function takeoverViolations(run: FaultRun): FaultViolation[] {
  return run.trees.flatMap((tree) => {
    const seen = new Set<string>();
    return tree.auditLog.flatMap((row) => {
      if (row.kind !== ExecutionAuditEventKind.Takeover) return [];
      const id = `${row.executionId}#${String(row.token)}`;
      if (!seen.has(id)) {
        seen.add(id);
        return [];
      }
      return [
        violation(
          FaultInvariant.OneOwner,
          `two takeovers of ${row.executionId} at token ${String(row.token)} in the audit log`,
        ),
      ];
    });
  });
}

/** No grant of a key after its lease was finished. */
function finishedViolations(run: FaultRun, grants: readonly Grant[]): FaultViolation[] {
  const finished = finishesOf(run.history);
  return grants.flatMap((grant) => {
    const at = finished.get(grant.key);
    if (at === undefined || compareAt(grant.at, at) <= 0) return [];
    return [
      violation(
        FaultInvariant.FinishedWorkUntouched,
        `the lease of ${grant.key} was granted again (epoch ${String(grant.epoch)}, to ${grant.holder}) after it was finished`,
      ),
    ];
  });
}

/** Every violation of one owner per tree, and of finished work left alone. */
export function oneOwnerViolations(run: FaultRun): FaultViolation[] {
  const grants = grantsOf(run.history);
  const keys = byKey(grants);
  return [
    ...epochViolations(keys),
    ...writeViolations(run, keys),
    ...unansweredViolations(run, keys),
    ...takeoverViolations(run),
    ...finishedViolations(run, grants),
  ];
}
