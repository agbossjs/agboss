import { HTTP_EXTENSION_HEADER, Message, TaskState, type AgentCard, type Task } from "@a2a-js/sdk";
import { serviceUsageOf } from "../../components/spend-recorder.js";
import { currentFrame } from "../../flow/context/frame.js";
import { MeshLoopDetectedError } from "../../mesh/mesh-errors.js";
import { TRACEPARENT } from "../../mesh/mesh-envelope.js";
import { takeRunReport, type RunReportIdentity } from "../../mesh/mesh-report.js";
import { currentCallChainOf, outboundMeshOfHash } from "../../mesh/outbound-mesh.js";
import type { LedgerKey } from "../../finops/ledger-mark.js";
import { usd, type Usd } from "../../units/index.js";
import { A2A_MESH_EXTENSION } from "../a2a-extension-uris.js";
import { meshBodyHashOf, meshReportTextOf } from "../a2a-mesh-message.js";
import { cardExtensionsOf, type A2ARemotePeer } from "./a2a-card.js";
import { A2AMesh, A2AMeshUnsupportedError } from "./a2a-guard-errors.js";

/**
 * What rides an A2A call beyond the core protocol (#809, design §4.2 "AGBoss guarantees ride as
 * the extension"): the AGBoss mesh — the envelope of the calling execution (its call chain, so a
 * loop or a chain past the receiver's `maxMeshHops` is refused there; its budget and deadline left;
 * its signature) in `message.metadata[mesh-uri]`, the extension activated by `A2A-Extensions`, and
 * the signed run report read back from `task.metadata[mesh-uri]`. A seam (P3 #810 extends it: the
 * step record's `mesh: false`, the echo header); explicit when it is not there: an agent without
 * the extension is refused under `A2AMesh.Required` (`A2AMeshUnsupportedError`), called without it
 * under `IfSupported` (`peer.mesh: false`) and charged the client's own `price`.
 */

/** What the seam knows of one call. */
export interface A2AMeshCall {
  readonly agent: string;
  readonly application: string | undefined;
  readonly skill: string | undefined;
  readonly mesh: A2AMesh;
}

/** What rides one message: its metadata entries, its request's service parameters (headers). */
export interface A2AMeshSigned {
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly serviceParameters: Readonly<Record<string, string>>;
  /** The `bodyHash` the envelope binds (#810); `undefined` when no envelope rides. */
  readonly bodyHash?: string;
}

/** The mesh of one call. */
export interface A2AMeshActivation {
  /** The peer as the call treats it: `mesh: true` once an envelope rode one of its messages. */
  readonly peer: A2ARemotePeer;
  /** What rides `message` (as it is sent, without the mesh entries): signed once per attempt. */
  sign(message: Message): A2AMeshSigned;
  /**
   * Charges the call to the calling step once it is accepted: the client's price, at once — the
   * spend is in the step's ledger before the wait, so a crash during the wait loses none of it.
   * Charged on every pass that reaches the accept, a replayed one too (#810, AC5), under the call's
   * own ledger identity: the ledger adds it once.
   */
  charge(price: Usd | undefined, charged: A2ACharged): void;
  /**
   * At the task's end: what a verified run report says above the price, charged too — on every
   * pass, under its own ledger identity (#810), so a takeover that waits again charges it once.
   */
  settle(answer: Task | Message | undefined, price: Usd | undefined, charged: A2ACharged): void;
}

/** What makes one call's charges the same on every pass (#810): its accept as stored. */
export interface A2ACharged {
  /** The call's messageId: one per call, ever (the tenant and the step's key). */
  readonly messageId: string;
  /**
   * When the agent accepted it (ISO 8601), as stored — the price entry's date; for an accept that
   * stored none (a foreign agent's reconciled reply), when this pass took it.
   */
  readonly acceptedAt: string;
  /** The envelope's `bodyHash`, as stored: what the report must bind; `undefined` unmeshed. */
  readonly bodyHash: string | undefined;
  /** The task the report must name as its execution. */
  readonly taskId: string | undefined;
  /** The caller's time when it settles, on its `Clock`: the latest date of the report's charge. */
  readonly now: Date;
}

/**
 * The ledger identity of a call's price (#810), dated by its accept as stored (a `Date` at the
 * ledger's boundary, #817: one that is no date is refused there, nothing added).
 */
const priceLedgerKeyOf = (charged: A2ACharged): LedgerKey => ({
  id: `a2a:${charged.messageId}:price`,
  madeAt: new Date(charged.acceptedAt),
});

export interface A2AMeshSeam {
  /** The mesh of a call to the agent of `card`; refuses it before anything is sent when it must. */
  activate(card: AgentCard, peer: A2ARemotePeer, call: A2AMeshCall): A2AMeshActivation;
}

const NOTHING: A2AMeshSigned = { metadata: {}, serviceParameters: {} };

/**
 * The price alone, charged to the calling step's budgets as the service `a2a:<who>`, under the
 * call's own ledger identity (#810): a pass that replays the accept charges the same entry.
 */
function chargePrice(call: A2AMeshCall, price: Usd | undefined, charged: A2ACharged): void {
  if (price === undefined || price <= 0) return;
  const service = `a2a:${call.application ?? call.agent}`;
  const ledgerKey = priceLedgerKeyOf(charged);
  currentFrame()?.services.reportUsage?.({
    ...serviceUsageOf({ service, cost: usd(price) }),
    ledgerKey,
  });
}

/** No mesh: the core protocol only, said in the peer. */
const withoutMesh = (peer: A2ARemotePeer, call: A2AMeshCall): A2AMeshActivation => ({
  peer: { ...peer, mesh: false },
  sign: () => NOTHING,
  charge: (price, charged) => {
    chargePrice(call, price, charged);
  },
  settle: () => undefined,
});

/** Whether the agent's card declares the mesh extension. */
const declaresMesh = (card: AgentCard): boolean =>
  cardExtensionsOf(card).some((extension) => extension.uri === A2A_MESH_EXTENSION);

/**
 * A call to an entry the calling tree already passed through is a loop: refused before sending,
 * whatever the agent would check (the same `MeshLoopDetectedError` its refusal rebuilds).
 */
function refuseLoop(call: A2AMeshCall): void {
  const chain = currentCallChainOf();
  if (chain === undefined || call.application === undefined || call.skill === undefined) return;
  const entry = { application: call.application, start: call.skill };
  const isLoop = chain.some(
    (hop) => hop.application === entry.application && hop.start === entry.start,
  );
  if (isLoop) throw new MeshLoopDetectedError({ entry, chain });
}

/**
 * A meshed call's end (#810): a trusted peer's signed spend, verified against this call's body —
 * the body the accept stored, so a pass that replays it verifies the report of what was sent —,
 * charged above the price. A completed task with no report this caller verifies is charged the
 * price alone, said in the step's record (`remote.report: false`, #844) — never silently.
 */
function settleReport(
  call: A2AMeshCall,
  answer: Task | Message | undefined,
  price: Usd | undefined,
  charged: A2ACharged,
): void {
  const { bodyHash, taskId } = charged;
  if (bodyHash === undefined) return;
  const application = call.application ?? call.agent;
  const contract = price === undefined ? undefined : { application, price };
  const isReported = takeRunReport(
    "a2a",
    // #860: a direct reply's report rides its message's metadata as a task's does
    meshReportTextOf(answer),
    bodyHash,
    contract,
    price ?? 0,
    reportIdentityOf(charged),
  );
  if (!isReported) recordUnreported(application, answer, taskId);
}

/** What makes a call's report its own (#810): its ledger id, its task, the caller's window. */
const reportIdentityOf = (charged: A2ACharged): RunReportIdentity => ({
  id: `a2a:${charged.messageId}:report`,
  ...(charged.taskId === undefined ? {} : { executionId: charged.taskId }),
  // dated inside the caller's own window, never by the peer's word alone
  notBefore: charged.acceptedAt,
  now: charged.now,
});

/** A completed task of no verified report: `remote.report: false` in the step's record (#844). */
function recordUnreported(
  application: string,
  answer: Task | Message | undefined,
  taskId?: string,
): void {
  const isCompleted =
    answer !== undefined &&
    "status" in answer &&
    answer.status?.state === TaskState.TASK_STATE_COMPLETED;
  if (!isCompleted || taskId === undefined) return;
  currentFrame()?.services.meshCall?.recordRemote({
    application,
    executionId: taskId,
    report: false,
  });
}

/**
 * The mesh as it rides one call: the envelope per attempt, the report at the end. Signed and
 * addressed to `call.application` only — a call with no application sends the envelope as an
 * unsigned claim (its chain checked by the receiver, nothing of it trusted), never a signed one an
 * agent could replay elsewhere. Under `A2AMesh.Required` a step that has no envelope to send (no
 * call chain) is refused: the mesh would not ride.
 */
function withMesh(peer: A2ARemotePeer, call: A2AMeshCall): A2AMeshActivation {
  return {
    // the mesh as the call can have it: signed to an application; whether it rode is the accept's
    peer: { ...peer, mesh: call.application !== undefined },
    sign: (message) => {
      const hash = meshBodyHashOf(Message.toJSON(message));
      const outbound = outboundMeshOfHash(hash, call.application);
      if (outbound === undefined) {
        if (call.mesh === A2AMesh.Required && currentFrame() !== undefined) {
          throw new A2AMeshUnsupportedError({ agent: call.agent, application: call.application });
        }
        return NOTHING;
      }
      return {
        metadata: { [A2A_MESH_EXTENSION]: { envelope: outbound.envelope } },
        serviceParameters: {
          [HTTP_EXTENSION_HEADER]: A2A_MESH_EXTENSION,
          [TRACEPARENT]: outbound.traceparent,
        },
        bodyHash: hash,
      };
    },
    charge: (price, charged) => {
      chargePrice(call, price, charged);
    },
    settle: (answer, price, charged) => {
      settleReport(call, answer, price, charged);
    },
  };
}

/** The AGBoss mesh over the A2A extension: the default of every client. */
export const AGBOSS_MESH: A2AMeshSeam = {
  activate: (card, peer, call) => {
    if (!declaresMesh(card)) {
      if (call.mesh === A2AMesh.Required) {
        throw new A2AMeshUnsupportedError({ agent: call.agent, application: call.application });
      }
      return withoutMesh(peer, call);
    }
    refuseLoop(call);
    return withMesh(peer, call);
  },
};
