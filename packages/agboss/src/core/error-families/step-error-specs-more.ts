import { timeText } from "./time-text.js";
import { plainly, type VariantMore } from "./family.js";
import type { WorkflowRecord } from "../../flow/context/execution-context.js";
import { ComponentKind } from "../../flow/runtime/records.js";
import { detailsOfStep, type StepCoordinates } from "../../graph/step-coordinates.js";
import {
  coordinatesOf,
  describe,
  fileLimitSaid,
  plainWorkflowOf,
  stepOf,
  type Coordinated,
  type Said,
} from "./step-error-helpers.js";

/** The sentences and the steps of the `StepError` variants that name a step of a workflow, a pause or a file. */
const childNameOf = (f: { workflow?: { readonly name: string } }): string => f.workflow?.name ?? "";
const childBase = stepOf(ComponentKind.Workflow, childNameOf, {
  details: (f: { workflow?: object }) =>
    f.workflow === undefined ? {} : { workflow: { ...f.workflow } },
});

/** A child's step: its workflow kept as the plain record of its name and versions, never the class. */
const childStep: VariantMore = {
  ...childBase,
  force: true,
  keep: (f: { workflow?: WorkflowRecord }) => ({
    ...(childBase.keep as (facts: object) => object)(f),
    ...(f.workflow === undefined ? {} : { workflow: plainWorkflowOf(f.workflow) }),
  }),
};

export const MORE_STEP_SPECS = {
  pauseExpired: plainly(
    [
      (f: { step?: string; target?: string; expiresAt?: Date }) =>
        `${f.step ?? ""}: its pause on ${f.target ?? ""} expired at ${timeText(f.expiresAt, "")}`,
      undefined,
      {
        keep: (f: Coordinated & { step?: string; stepKind?: ComponentKind }) =>
          coordinatesOf(f, f.step ?? "", f.stepKind ?? ComponentKind.Agent),
        extra: (f: Partial<StepCoordinates>) =>
          f.component === undefined ? {} : detailsOfStep(f as StepCoordinates),
      },
    ],
    ["step"],
    "a pause's deadline passed",
  ),
  arbiter: plainly(
    [
      (f: { arbiter?: string; nodeId?: string } & Said) =>
        `Arbiter "${f.arbiter ?? ""}" failed on the answer of ${f.nodeId ?? ""}: ${describe(f.cause)}`,
      undefined,
      stepOf(ComponentKind.Arbiter, (f: { arbiter?: string }) => f.arbiter ?? ""),
    ],
    ["arbiter"],
    "an arbiter failed",
  ),
  quorumNotReached: plainly(
    [
      (f: {
        nodeId?: string;
        counted?: number;
        min?: number;
        reason?: string;
        expired?: readonly string[];
      }) => {
        const expired = f.expired ?? [];
        const needed = f.min === undefined ? "no group complete" : `need ${String(f.min)}`;
        const lapsed = expired.length === 0 ? "" : `, ${String(expired.length)} expired`;
        return `The quorum of ${f.nodeId ?? ""}'s launch was not reached: ${String(f.counted ?? 0)} counted, ${needed}${lapsed} — ${f.reason ?? ""}`;
      },
      "step.quorum",
      {
        keep: (f: { expired?: readonly string[] }) => ({ expired: f.expired ?? [] }),
        extra: (f: Partial<StepCoordinates>) =>
          f.component === undefined ? {} : detailsOfStep(f as StepCoordinates),
      },
    ],
    ["counted"],
    "a quorum cannot be reached",
  ),
  child: plainly(
    [
      (
        f: {
          workflow?: { readonly name: string };
          childExecutionId?: string;
          itemIndex?: number;
        } & Said,
      ) => {
        const item = f.itemIndex === undefined ? "" : `, item ${String(f.itemIndex)}`;
        return `Child workflow "${f.workflow?.name ?? ""}" (execution ${f.childExecutionId ?? ""}${item}) failed: ${describe(f.cause)}`;
      },
      undefined,
      childStep,
    ],
    ["childExecutionId"],
    "a child workflow failed",
  ),
  guardrail: plainly(
    [
      (f: { guardrail?: string; reason?: string }) =>
        `Guard "${f.guardrail ?? ""}" failed: ${f.reason ?? ""}`,
      undefined,
      {
        ...stepOf(ComponentKind.Guardrail, (f: { guardrail?: string }) => f.guardrail ?? ""),
        cause: (f: { reason?: string }) => f.reason,
        // a model's text, not a fixed enum
        hidden: ["reason"],
      },
    ],
    ["guardrail"],
    "a guardrail's check failed",
  ),
  toolBlocked: plainly(
    [
      (f: { agent?: string; tool?: string; interceptor?: string; reason?: string }) =>
        `Agent "${f.agent ?? ""}": the call to ${f.tool ?? ""} was blocked by ${f.interceptor ?? ""}: ${f.reason ?? ""}`,
      undefined,
      {
        ...stepOf(ComponentKind.Agent, (f: { agent?: string }) => f.agent ?? ""),
        cause: (f: { reason?: string }) => f.reason,
      },
    ],
    ["agent"],
    "a tool call was blocked by an interceptor",
  ),
  rerankFailed: plainly(
    [
      (f: { rag?: string; reranker?: string } & Said) =>
        `Knowledge base "${f.rag ?? ""}": its reranker ${f.reranker ?? ""} failed (${describe(f.cause)}) — RerankFailurePolicy.FailStep fails the step`,
      undefined,
      stepOf(ComponentKind.Rag, (f: { rag?: string }) => f.rag ?? ""),
    ],
    ["rag"],
    "a reranker failed",
  ),
  modelFileLimit: plainly(
    [
      (f: {
        agent?: string;
        limit?: string;
        actual?: number | string;
        allowed?: number | string;
      }) => `Agent "${f.agent ?? ""}": its files are over a limit — ${fileLimitSaid(f)}`,
      undefined,
      {
        ...stepOf(ComponentKind.Agent, (f: { agent?: string }) => f.agent ?? ""),
        cause: fileLimitSaid,
      },
    ],
    ["agent"],
    "a file the model was given is over a limit",
  ),
  fileMaskingFailed: plainly(
    [
      (f: { agent?: string; reason?: string }) =>
        `Agent "${f.agent ?? ""}": a redacted copy of its file could not be made — ${f.reason ?? ""}`,
      undefined,
      {
        ...stepOf(ComponentKind.Agent, (f: { agent?: string }) => f.agent ?? ""),
        cause: (f: { reason?: string }) => f.reason,
      },
    ],
    ["agent"],
    "a file could not be masked before the model",
  ),
};
