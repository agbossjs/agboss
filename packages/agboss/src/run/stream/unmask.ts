import type { PiiTokenMap } from "../../pii/tokens.js";

/**
 * Reveals PII tokens in a model's stream (#1007) as `revealedText` does in its whole answer: a
 * token the run's map knows becomes its value; one it does not know — a hallucinated one — is never
 * shown as written, only as its kind (`<email>`). A `<` starts a candidate that is held only while
 * what follows is still a prefix of `<kind:hex>` (`^<[a-z][a-z0-9-]*:[0-9a-f]{6,64}>$`), so the text
 * around it is not delayed: any other character flushes the candidate as it was written.
 */

/**
 * A buffer of two characters or more that is still a prefix of a token (`<` alone is never tested).
 * Its start anchor never decides: the buffer is a held candidate plus a character, and a candidate
 * held matched this pattern, so the only `<` it has is its first.
 */
// Stryker disable next-line Regex: the anchor cannot differ here, see above
const PREFIX = /^<[a-z][a-z0-9-]*(?::[0-9a-f]{0,64})?$/;
/**
 * A complete token. Its anchors never decide: a candidate that was held matched `PREFIX`, so it
 * starts with its only `<`, and ends with the `>` just read.
 */
// Stryker disable next-line Regex: the anchors cannot differ here, see above
const COMPLETE = /^<([a-z][a-z0-9-]*):[0-9a-f]{6,64}>$/;
/** The longest candidate held: `<` + a label + `:` + 64 hex digits + `>`, with room for the label. */
const LONGEST = 96;

export class Unmasker {
  #held = "";

  constructor(private readonly tokens: PiiTokenMap) {}

  /** The text that can be shown now, `text` being the next piece of the model's. */
  push(text: string): string {
    let shown = "";
    for (const character of text) shown += this.#read(character);
    return shown;
  }

  /** What is still held when the turn ends: an unclosed candidate is text. */
  end(): string {
    const rest = this.#held;
    this.#held = "";
    return rest;
  }

  #read(character: string): string {
    if (this.#held === "") {
      if (character !== "<") return character;
      this.#held = character;
      return "";
    }
    const next = this.#held + character;
    const label = COMPLETE.exec(next)?.[1];
    if (label !== undefined) {
      this.#held = "";
      return this.tokens[next] ?? `<${label}>`;
    }
    if (next.length <= LONGEST && PREFIX.test(next)) {
      this.#held = next;
      return "";
    }
    // it cannot be a token: what was held is text, and this character is read again
    const flushed = this.#held;
    this.#held = "";
    return flushed + this.#read(character);
  }
}
