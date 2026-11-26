import { plainly } from "./family.js";
import { ComponentKind } from "../../flow/runtime/records.js";
import type { PauseKind } from "../../infrastructure/pause-record.js";
import type { JudgeRejection } from "../../graph/step-coordinates.js";
import {
  describe,
  qualityReason,
  nameOf,
  routerStep,
  stepOf,
  type Said,
} from "./step-error-helpers.js";

/**
 * What the `StepError` variants do besides naming themselves (#1325b): a step error made inside its
 * step names it from its frame (`component`, `nodeId`, `visitNumber`, `itemIndex`) unless it is given
 * them; its sentence is made of its facts, and of its cause where the old class said so.
 */

/** The sentences and the steps of the variants that name a step by what they name. */
export const STEP_SPECS = {
  agent: plainly(
    [
      (f: { agent?: string } & Said) => `Agent "${f.agent ?? ""}" failed: ${describe(f.cause)}`,
      undefined,
      stepOf(ComponentKind.Agent, (f: { agent?: string }) => f.agent ?? ""),
    ],
    ["agent"],
    "an agent's loop failed",
  ),
  agentAnswerInvalid: plainly(
    [
      (f: { agent?: string; attempts?: number } & Said) =>
        `Agent "${f.agent ?? ""}" failed: no valid answer after ${String(f.attempts ?? 0)} attempts: ${describe(f.cause)}`,
      "step.agent.invalid-answer",
      stepOf(ComponentKind.Agent, (f: { agent?: string }) => f.agent ?? ""),
    ],
    ["agent"],
    "an agent's answer is not what its output declares",
  ),
  qualityGate: plainly(
    [
      (f: { agent?: string; rejections?: readonly JudgeRejection[]; retries?: number }) =>
        `Agent "${f.agent ?? ""}" failed: ${qualityReason(f.rejections ?? [], f.retries ?? 0)}`,
      "step.agent.quality-gate",
      {
        ...stepOf<{ agent?: string; rejections?: readonly JudgeRejection[] }>(
          ComponentKind.Agent,
          (f: { agent?: string }) => f.agent ?? "",
          {
            details: (f: { rejections?: readonly JudgeRejection[] }) => ({
              rejections: (f.rejections ?? []).map((r) => ({ ...r })),
            }),
          },
        ),
        cause: (f: { rejections?: readonly JudgeRejection[]; retries?: number }) =>
          qualityReason(f.rejections ?? [], f.retries ?? 0),
      },
    ],
    ["agent"],
    "an agent's reply still failed its judges after its retries",
  ),
  action: plainly(
    [
      (f: { action?: string } & Said) => `Action "${f.action ?? ""}" failed: ${describe(f.cause)}`,
      undefined,
      stepOf(ComponentKind.Action, (f: { action?: string }) => f.action ?? ""),
    ],
    ["action"],
    "an action failed",
  ),
  router: plainly(
    [
      (f: { router?: string; nodeId?: string } & Said) =>
        `Router "${nameOf(f)}" failed: ${describe(f.cause)}`,
      undefined,
      routerStep(),
    ],
    ["router"],
    "a router's model call or its route() failed",
  ),
  routerDecision: plainly(
    [
      (f: { router?: string; nodeId?: string; reason?: string }) =>
        `Router "${nameOf(f)}" decided wrongly: ${f.reason ?? ""}`,
      "step.router.invalid-decision",
      { ...routerStep(), hidden: ["reason"] },
    ],
    ["router"],
    "a router answered outside its routes",
  ),
  externalTask: plainly(
    [
      (f: { externalTask?: string } & Said) =>
        `Question "${f.externalTask ?? ""}" failed: ${describe(f.cause)}`,
      undefined,
      stepOf(ComponentKind.ExternalTask, (f: { externalTask?: string }) => f.externalTask ?? ""),
    ],
    ["externalTask"],
    "an external task failed",
  ),
};

/** The facts a step error fills in itself: its step's coordinates, from its frame. */
export interface StepDefaulted {
  Agent: "component" | "nodeId" | "visitNumber";
  AgentAnswerInvalid: "component" | "nodeId" | "visitNumber";
  QualityGate: "component" | "nodeId" | "visitNumber";
  Action: "component" | "nodeId" | "visitNumber";
  Router: ("component" | "nodeId" | "visitNumber") | "router";
  RouterDecision: ("component" | "nodeId" | "visitNumber") | "router";
  ExternalTask: "component" | "nodeId" | "visitNumber";
  PauseExpired: "component" | "nodeId" | "visitNumber";
  Arbiter: "component" | "nodeId" | "visitNumber";
  Child: "component" | "nodeId" | "visitNumber";
  Guardrail: "component" | "nodeId" | "visitNumber";
  ToolBlocked: "component" | "nodeId" | "visitNumber";
  RerankFailed: "component" | "nodeId" | "visitNumber";
  ModelFileLimit: "component" | "nodeId" | "visitNumber";
  FileMaskingFailed: "component" | "nodeId" | "visitNumber";
}

/** What a pause that expired adds to its step's failure. */
export interface PauseExpiredFacts {
  readonly step: string;
  readonly stepKind?: ComponentKind.Agent | ComponentKind.ExternalTask | undefined;
  readonly target?: string | undefined;
  readonly channel?: string | undefined;
  /** What the pause waited for (`PauseKind`; `kind` is the variant's own). */
  readonly pauseKind?: PauseKind | undefined;
  /** The deadline that passed; in the error's `details` an ISO 8601 text. */
  readonly expiresAt?: Date | undefined;
}
