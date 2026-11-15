import { StoreHoldPoint, type StoreMethod } from "./store-points.js";

/**
 * The checkpoint saver's hold points (#1090): a checkpoint (`put`) and a task's writes before the
 * next one (`putWrites`), keyed by their thread — the root's execution id, a child's own thread.
 */

type CheckpointArguments = readonly unknown[];

/** The config a checkpoint call is about. */
const configurableOf = (args: CheckpointArguments): Record<string, unknown> =>
  (args[0] as { readonly configurable?: Record<string, unknown> } | undefined)?.configurable ?? {};

/** What the history keeps of a checkpoint's config: its thread and namespace, never a payload. */
const threadFacts = (args: CheckpointArguments): unknown => {
  const { thread_id: threadId, checkpoint_ns: namespace } = configurableOf(args);
  return { threadId, namespace };
};

const threadOf = (args: CheckpointArguments): string | undefined => {
  const id = configurableOf(args).thread_id;
  return typeof id === "string" ? id : undefined;
};

/** The checkpoint saver's writes (#1090): a checkpoint, and a task's writes before the next one. */
export const CHECKPOINT_METHODS: Readonly<Record<string, StoreMethod>> = {
  put: {
    point: StoreHoldPoint.CheckpointPut,
    keyOf: threadOf,
    inputOf: threadFacts,
    outputOf: () => null,
  },
  putWrites: {
    point: StoreHoldPoint.CheckpointPutWrites,
    keyOf: threadOf,
    inputOf: threadFacts,
    outputOf: () => null,
  },
};
