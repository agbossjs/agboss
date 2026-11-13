/**
 * The reply is `text.trim()` (reply node): the stream drops the leading whitespace of an attempt and
 * holds trailing whitespace until text follows it, so the deltas joined are the reply (#1007).
 */
export class Trimmer {
  #started = false;
  #pending = "";

  /** The text that can be shown now. */
  push(text: string): string {
    let shown = "";
    for (const character of text) {
      const isSpace = character.trim() === "";
      if (!this.#started && isSpace) continue;
      this.#started = true;
      if (isSpace) {
        this.#pending += character;
      } else {
        shown += this.#pending + character;
        this.#pending = "";
      }
    }
    return shown;
  }

  /** The turn ends: trailing whitespace is dropped, as `trim()` drops it. */
  end(): void {
    this.#pending = "";
  }
}
