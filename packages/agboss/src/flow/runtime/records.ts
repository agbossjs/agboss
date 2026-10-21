/**
 * What an execution keeps of its data, as plain JSON (#270 S5, #271 S11): one record per slot of
 * the path scope, keyed by the slot (`OfferDraftDto`, `list:CompanyScoreDto`).
 * A record is rebuilt into `Produced<T, P>` on read from the registries (producer by `name`, variant
 * by DTO class name), so it survives a serialising checkpointer.
 */

/** What kind of component a record names (#268 S93): its decorator, the suffix of its `name`. */
export enum ComponentKind {
  /** `@WorkflowStart`. */
  WorkflowStart = "workflow-start",
  /** `@WorkflowFinish`. */
  WorkflowFinish = "workflow-finish",
  /** `@Agent`. */
  Agent = "agent",
  /** `@Action`. */
  Action = "action",
  /** `@Router`, by model or by code. */
  Router = "router",
  /** A child workflow's node (#263), or the workflow itself. */
  Workflow = "workflow",
  /** `@Arbiter` (#279). */
  Arbiter = "arbiter",
  /** `@InputGuardrail` / `@OutputGuardrail` (#120). */
  Guardrail = "guardrail",
  /** `@Tool` / `@McpTool`. */
  Tool = "tool",
  /** `@Judge`. */
  Judge = "judge",
  /** `@Rag`: a knowledge base. */
  Rag = "rag",
  /** `@Budget` (#261). */
  Budget = "budget",
}

/**
 * A component as an execution record names it: by its `name`, never by its class (Q42), with its
 * join keys (#268 S93) — its kind and the hashes `agboss describe --json` gives for it, so a trace
 * or a record joins the declarative snapshot: `promptHash` of what its model is told (an agent's
 * instructions, a model router's prompt and routes), `schemaHash` of what it reads and writes (its
 * `input` fields and its `output`, each DTO by its JSON Schema). `undefined` when it has none.
 */
export interface ComponentRecord {
  /** Its `name` (`clerk-agent`). */
  readonly name: string;
  /** What it is: its decorator. */
  readonly kind: ComponentKind;
  /** The hash of the text its model is told; `undefined` for a component without a model. */
  readonly promptHash: string | undefined;
  /** The hash of what it reads and writes; `undefined` when it declares neither. */
  readonly schemaHash: string | undefined;
}

/** A record of a component without hashes: a budget, or a name the workflow does not know. */
export const bareRecordOf = (name: string, kind: ComponentKind): ComponentRecord => ({
  name,
  kind,
  promptHash: undefined,
  schemaHash: undefined,
});

/** A record as plain data: a step's component without its class. */
export const plainRecordOf = ({
  name,
  kind,
  promptHash,
  schemaHash,
}: ComponentRecord): ComponentRecord => ({ name, kind, promptHash, schemaHash });

/** One element of a `listOf(oneOf(…))` value: its class and the value (#271 S11, 2026-10-17). */
export interface VariantElement {
  readonly variant: string;
  readonly value: unknown;
}

/** The current value of one slot of the path scope. */
export interface ScopeValueRecord {
  /** `${nodeId}:${visitNumber}/${slot}` — deterministic, the same in tests and after a resume. */
  readonly valueId: string;
  readonly slot: string;
  /** The `name` of the component that gave the value. */
  readonly producer: string;
  /**
   * A list a join gathered from several components (#273): the `name` of each element's producer,
   * in the list's order. Absent when one component gave every element.
   */
  readonly elementProducers?: readonly string[];
  /** The DTO class name of a `oneOf` value. */
  readonly variant?: string;
  /** The value; a list slot holds an array (of `VariantElement`s for `listOf(oneOf(…))`). */
  readonly value: unknown;
  /**
   * The `valueId`s the producer read when it built the value (#271 rule 3): its `input` fields, or
   * every current value for an agent without `input`, and its `{ about }` targets — never an
   * answer about the value it writes. A renewal of one of them outdates the value.
   */
  readonly builtFrom: readonly string[];
  /**
   * The slots the value is about (`{ about }` of its `.returns` or `caseOf` in the flow, #299 S54):
   * a new value of one of them outdates it, and it never outdates them. Absent when it is about
   * nothing.
   */
  readonly about?: readonly string[];
}

/** Why a value left the scope (#271 S11). */
export enum OutdatedReason {
  /** A newer value was written into its slot. */
  Replaced = "replaced",
  /** It was built from a value that was outdated. */
  BuiltFromReplaced = "built-from-replaced",
  /** It is an answer about a value (`{ about: Target }`) that was outdated. */
  AboutReplaced = "about-replaced",
}

/** How a value was outdated: the root trigger of the cascade (the new value) and why. */
export interface OutdatedMark {
  /** The `valueId` of the new value that started the cascade, whatever path reached this one. */
  readonly byValueId: string;
  readonly reason: OutdatedReason;
}

/** A value moved out of the scope by the outdating step (S11): append-only, never read again. */
export interface OutdatedValueRecord extends ScopeValueRecord {
  readonly outdated: OutdatedMark;
}

/** A value of the scope named without its contents (observer events, S12). */
export interface ScopeValueReference {
  readonly valueId: string;
  readonly slot: string;
  readonly producer: string;
}

/** An outdated value named without its contents, with why it was outdated. */
export interface OutdatedValueReference extends ScopeValueReference {
  readonly reason: OutdatedReason;
}

/** The path scope of one execution: the current record of each slot. */
export type ScopeRecords = Readonly<Record<string, ScopeValueRecord>>;

/** The `valueId` of a slot written at a node's visit. */
export const valueIdOf = (nodeId: string, visitNumber: number, slot: string): string =>
  `${nodeId}:${String(visitNumber)}/${slot}`;
