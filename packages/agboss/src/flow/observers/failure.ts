/**
 * What an observer event shows of a failure (#1343): the error's class name and its stable `code`,
 * never its message — a provider's or a project's error text can hold a prompt, a key or a person's
 * data, and the observability mask only reaches the strings an event carries as plain data.
 */
export interface ObservedFailure {
  /** The error's class name (`"ModelCallError"`, `"StepError.RerankFailed"`). */
  readonly name: string;
  /** Its stable code (`model.circuit-open`), when it has one. */
  readonly code: string | undefined;
}

/** The failure as an event shows it: the class name and the code, nothing else. */
export function observedFailureOf(error: unknown): ObservedFailure {
  if (!(error instanceof Error)) return { name: "Error", code: undefined };
  const code: unknown = Reflect.get(error, "code");
  return { name: error.name, code: typeof code === "string" ? code : undefined };
}
