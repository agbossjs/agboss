/**
 * An error as a log may name it (#946): the class names along its cause chain — never a message,
 * which a channel or a store may fill with an id that is a capability.
 */
export function errorNamesOf(error: unknown): string {
  const names: string[] = [];
  for (let current: unknown = error; names.length < 5;) {
    if (!(current instanceof Error)) {
      names.push(typeof current);
      break;
    }
    names.push(current.name);
    if (current.cause === undefined) break;
    current = current.cause;
  }
  return names.join(" < ");
}
