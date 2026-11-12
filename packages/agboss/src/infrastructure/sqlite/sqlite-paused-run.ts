import { z } from "zod";
import type { AgentExecutionOutput } from "../../run/types.js";

/** A paused run in its row: JSON, read back checked (#261, #906). */

/** The fields a resume relies on; the rest of the stored run is passed through as written. */
const StoredRun = z.looseObject({
  status: z.literal("paused"),
  threadId: z.string(),
  // a run stored before tenants (#261) has none: it is the tenant "default"
  tenantId: z.string().optional(),
  runId: z.string(),
  // a run stored by 0.1.0 names its record `ternId` ("Tern" was a misspelling of "turn", #906)
  turnId: z.string().optional(),
  ternId: z.string().optional(),
  // Infinity when the run has no cost limit (z.number() rejects it)
  budgetUsd: z.custom<number>((value) => typeof value === "number" && !Number.isNaN(value)),
});

/** JSON keeps no `Infinity` (a run without a cost limit has `budgetUsd: Infinity`): tagged. */
const NonFinite = z.object({ $number: z.enum(["Infinity", "-Infinity", "NaN"]) });

/** A paused run as text, its non-finite numbers tagged. */
export const encodePausedRun = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "number" && !Number.isFinite(item) ? { $number: String(item) } : item,
  );

const decode = (text: string): unknown =>
  JSON.parse(text, (_key, item: unknown) => {
    const tagged = NonFinite.safeParse(item);
    return tagged.success ? Number(tagged.data.$number) : item;
  });

/** ` (tenantId acme, …)`, or nothing when no id is readable. */
const named = (ids: string): string => (ids === "" ? "" : ` (${ids})`);

/** The ids that name a stored run in an error: its thread and run, never its input. */
const idsOf = (value: unknown): string =>
  ["threadId", "runId"]
    .flatMap((key) => {
      const id: unknown =
        typeof value === "object" && value !== null ? Reflect.get(value, key) : "";
      return typeof id === "string" ? [`${key} ${id}`] : [];
    })
    .join(", ");

/**
 * Why a stored run is refused: the ids that name it and the field that failed — never the run
 * itself, whose `startInput` and `data` are the caller's (PII reaches the logs through a message,
 * #906 D4). The schema's own error, which names paths and expectations only, is the `cause`.
 */
/** The paths of the invalid fields, each once (`step.nodeId`), `(the value)` for the root. */
const pathsOf = (error: z.ZodError): string =>
  [...new Set(error.issues.map((issue) => issue.path.join(".") || "(the value)"))].join(", ");

function unreadableRun(value: unknown, error: z.ZodError | undefined): Error {
  const fields = error === undefined ? "turnId" : pathsOf(error);
  return new Error(
    `a stored paused run is not readable${named(idsOf(value))}: the field(s) ${fields} missing or not what the framework wrote`,
    { cause: error },
  );
}

/** A decoded run as `save` wrote it: an `AgentExecutionOutput` of a paused run. */
function storedRunOf(value: unknown): AgentExecutionOutput {
  const stored = StoredRun.safeParse(value);
  if (!stored.success) throw unreadableRun(value, stored.error);
  if ((stored.data.turnId ?? stored.data.ternId) === undefined)
    throw unreadableRun(value, undefined);
  return value as AgentExecutionOutput;
}

/** The run with its record's id as `turnId`: a run stored by 0.1.0 has it as `ternId` (#906). */
function withTurnId(run: AgentExecutionOutput): AgentExecutionOutput {
  const legacy: unknown = Reflect.get(run, "ternId");
  if (typeof legacy !== "string") return run;
  const turnId: unknown = Reflect.get(run, "turnId");
  const current = { ...run, turnId: typeof turnId === "string" ? turnId : legacy };
  Reflect.deleteProperty(current, "ternId");
  return current;
}

/** The run `encodePausedRun` wrote (one stored by 0.1.0 under `ternId` too), or why it is refused. */
export function decodePausedRun(text: string): AgentExecutionOutput {
  return withTurnId(storedRunOf(decode(text)));
}
