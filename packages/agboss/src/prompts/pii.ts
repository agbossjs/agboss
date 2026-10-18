/** The texts of a `@PiiPolicy`'s model detection (`detectWithModel`, #120). */

/** The instructions: which kinds to find, and the answer's shape. */
export const piiDetectionInstructions = (kinds: readonly string[]): string =>
  [
    "You find personal data in a text. Look only for these kinds:",
    kinds.map((kind) => `- ${kind}`).join("\n"),
    'Answer with JSON only: {"found":[{"kind":"<one of the kinds>","text":"<the exact text as it appears>"}]}.',
    'Copy each text exactly, character for character. Nothing found: {"found":[]}.',
  ].join("\n");

/** What the agent reads when its answer used a token no value stands for (S9). */
export const unknownTokenMessage = (tokens: readonly string[]): string =>
  `Tool error: ${tokens.join(", ")} ${tokens.length === 1 ? "is" : "are"} not a token of this conversation — use only the tokens you were given, exactly as written.`;
