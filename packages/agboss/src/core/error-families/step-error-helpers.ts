import type { ErrorDetails } from "../error-options.js";
import { currentFrame } from "../../flow/context/frame.js";
import {
  bareRecordOf,
  ComponentKind,
  plainRecordOf,
  type ComponentRecord,
} from "../../flow/runtime/records.js";
import {
  detailsOfStep,
  stepCoordinatesOf,
  type StepCoordinates,
} from "../../graph/step-coordinates.js";
import type { JudgeRejection } from "../../graph/step-coordinates.js";
import type { WorkflowRecord } from "../../flow/context/execution-context.js";
import type { VariantMore } from "./family.js";

/** The helpers of the `StepError` variants' specs: the step's coordinates, found in its frame. */

export type Coordinated = Partial<StepCoordinates>;
export interface Said {
  readonly cause?: unknown;
}

export const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** The coordinates a step error has: the given ones, else its frame's, else its component's at visit 0. */
const isNamed = (given: Coordinated): given is StepCoordinates =>
  given.component !== undefined && given.nodeId !== undefined && given.visitNumber !== undefined;

export function coordinatesOf(
  given: Coordinated,
  name: string,
  kind: ComponentKind,
): StepCoordinates {
  // the frame is asked only for what is not given: an error made with its step named needs none
  const given_ = Object.fromEntries(
    Object.entries<unknown>(given).filter(([, value]) => value !== undefined),
  );
  const base: StepCoordinates = isNamed(given)
    ? given
    : { ...stepCoordinatesOf(name, kind), ...given_ };
  // `itemIndex` is always there, none when no per-item launch made the step
  return {
    ...base,
    component: plainRecordOf(base.component),
    itemIndex: base.itemIndex,
  };
}

/** The `more` of a variant whose step is named by `nameOf(facts)` and is a `kind`. */
export function stepOf<T extends object>(
  kind: ComponentKind,
  nameOf: (facts: T) => string,
  rest: Omit<VariantMore, "keep" | "extra"> & {
    readonly details?: (facts: T) => ErrorDetails;
  } = {},
): VariantMore {
  const { details, ...more } = rest;
  return {
    ...more,
    keep: (facts: Coordinated) => coordinatesOf(facts, nameOf(facts as T), kind),
    extra: (facts: StepCoordinates) => ({
      ...detailsOfStep(facts),
      ...(details === undefined ? {} : details(facts as StepCoordinates & T)),
    }),
  };
}

/** The router's record: given, else its step's when it fails in its frame, else without hashes. */
function routerRecordOf(nodeId: string, given: ComponentRecord | undefined): ComponentRecord {
  if (given !== undefined) return given;
  const frame = currentFrame();
  const isOwn = frame !== undefined && !frame.isClosed() && frame.step.nodeId === nodeId;
  return isOwn ? plainRecordOf(frame.step.component) : bareRecordOf(nodeId, ComponentKind.Router);
}

type RouterFacts = Coordinated & { readonly router?: string };

/** A router's step: named by its node id, its record found in its frame as before. */
export const routerStep = (): VariantMore => ({
  keep: (facts: RouterFacts) => {
    const nodeId = facts.nodeId ?? facts.router ?? "";
    const own = coordinatesOf(
      { ...facts, nodeId, component: routerRecordOf(nodeId, facts.component) },
      nodeId,
      ComponentKind.Router,
    );
    return { ...own, router: facts.router ?? nodeId };
  },
  extra: (facts: StepCoordinates) => detailsOfStep(facts),
});

export const nameOf = (facts: { readonly nodeId?: string; readonly router?: string }): string =>
  facts.router ?? facts.nodeId ?? "";

export function qualityReason(rejections: readonly JudgeRejection[], retries: number): string {
  const said = rejections.map((r) => `[${r.judge}] ${r.reason}`).join("; ");
  return `quality gate not passed after ${String(retries)} retries: ${said}`;
}

export function fileLimitSaid(f: {
  limit?: string;
  actual?: number | string;
  allowed?: number | string;
}): string {
  return `${f.limit ?? ""}: ${String(f.actual ?? "")} is over ${String(f.allowed ?? "")}`;
}

/** A workflow as the record of its name and versions: what an error keeps, never its class. */
export const plainWorkflowOf = ({
  name,
  version,
  startedVersion,
  configHash,
}: WorkflowRecord): WorkflowRecord => ({ name, version, startedVersion, configHash });
