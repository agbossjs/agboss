import { invalidParams } from "./a2a-wire-errors.js";

/**
 * A caller's structured answer never carries a file's descriptor (#900, after #859): a file's
 * descriptor is the server's, made when a file part is admitted — never written by the caller. A
 * pause's decision (`{ pauseId?, decision }`) is scanned at every depth for an object shaped as an
 * `A2AFileDto` — a `mediaType` with a `fileId`, `sha256`, `inline` or `url` — and one found is
 * `-32602 a2a.file-field-in-data`, as a start's data part naming a file field is. The walk is
 * iterative and bounded: deeper than `MAX_DEPTH`, or more than `MAX_NODES` values, is refused too
 * (`a2a.answer-shape`) — fail closed, no stack to blow, no unbounded work.
 */

/** The deepest nesting a decision is read to. */
const MAX_DEPTH = 64;

/** The most values (objects, arrays, scalars) one decision is read through. */
const MAX_NODES = 10_000;

/** The keys that make an object with a `mediaType` a file's descriptor. */
const SOURCE_KEYS = ["fileId", "sha256", "inline", "url"] as const;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a value is shaped as a file's descriptor. */
const isDescriptor = (value: Readonly<Record<string, unknown>>): boolean =>
  Object.hasOwn(value, "mediaType") && SOURCE_KEYS.some((key) => Object.hasOwn(value, key));

const tooDeep = () =>
  invalidParams("a2a.answer-shape", "the answer is nested too deep or is too large");

/** The values a value holds, one level down. */
const childrenOf = (value: unknown): readonly unknown[] => {
  if (Array.isArray(value)) return value as readonly unknown[];
  return isRecord(value) ? Object.values(value) : [];
};

/** Refuses a caller's answer that holds a file's descriptor at any depth (`-32602`). */
export function refuseFileDescriptorsIn(answer: unknown): void {
  const pending: { readonly value: unknown; readonly depth: number }[] = [
    { value: answer, depth: 0 },
  ];
  for (let seen = 0; pending.length > 0; seen += 1) {
    const next = pending.pop();
    // Stryker disable next-line ConditionalExpression: the loop's condition says one is there
    if (next === undefined) break;
    if (seen >= MAX_NODES || next.depth > MAX_DEPTH) throw tooDeep();
    if (isRecord(next.value) && isDescriptor(next.value))
      throw invalidParams("a2a.file-field-in-data", "a file is sent as a file part only");
    for (const child of childrenOf(next.value))
      pending.push({ value: child, depth: next.depth + 1 });
  }
}
