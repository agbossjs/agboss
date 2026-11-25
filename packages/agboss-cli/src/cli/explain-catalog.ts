import {
  ConfigError,
  DecisionError,
  ExecutionError,
  FileError,
  GuardrailError,
  IdempotencyError,
  LimitError,
  OutboundCallError,
  PauseError,
  PiiError,
  StepError,
  ValidationError,
} from "@agboss/core";
import { A2AError } from "@agboss/core/a2a";
import { explainedRuleCodes, ruleExplanationOf } from "@agboss/core/internal";
import { McpError } from "@agboss/core/mcp";
import { StoreError } from "@agboss/core/stores";

/**
 * What `agboss explain <code>` knows (#1325c): every assembly rule and check code of the skills'
 * catalog, and the code of every variant of every error family — `LimitError.Budget` is `limit.budget`.
 */

/** One code, explained. */
export interface Explanation {
  readonly code: string;
  /** `rule`: reported by `agboss check` before a run; `error`: thrown while it runs. */
  readonly kind: "rule" | "error";
  /** What it means, one or two sentences. */
  readonly means: string;
  /** How to fix it: `before → after`, when the catalog gives one. */
  readonly fix?: string;
  /** The error class that carries the code: `LimitError.Budget`. */
  readonly thrownAs?: string;
}

/** The error families, by name; each carries a constructor per variant, each with its `code`. */
const FAMILIES: Readonly<Record<string, object>> = {
  A2AError,
  ConfigError,
  DecisionError,
  ExecutionError,
  FileError,
  GuardrailError,
  IdempotencyError,
  LimitError,
  McpError,
  OutboundCallError,
  PauseError,
  PiiError,
  StepError,
  StoreError,
  ValidationError,
};

/** A constructor of a variant: its static `code`, and an instance's default sentence. */
const isVariant = (value: unknown): value is (new (options: object) => Error) & { code: string } =>
  typeof value === "function" && typeof Reflect.get(value, "code") === "string";

/** The sentence a variant says when it is thrown with no message of its own: the framework's, never made of a stored text. */
const sentenceOf = (variant: new (options: object) => Error): string => {
  const sentence = new variant({}).message;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}${sentence.endsWith(".") ? "" : "."}`;
};

/** The variants of every family: `{ code, thrownAs, sentence }`. */
function variantsOf(): readonly Explanation[] {
  return Object.entries(FAMILIES).flatMap(([family, constructor]) =>
    Object.entries(constructor).flatMap(([name, variant]): Explanation[] =>
      isVariant(variant)
        ? [
            {
              code: variant.code,
              kind: "error",
              means: sentenceOf(variant),
              thrownAs: `${family}.${name}`,
            },
          ]
        : [],
    ),
  );
}

/** Every code `agboss explain` knows, by code: a rule's row of the catalog, an error's family variant, or both. */
export function explanationsOf(): ReadonlyMap<string, Explanation> {
  const known = new Map<string, Explanation>();
  for (const code of explainedRuleCodes()) {
    const row = ruleExplanationOf(code);
    if (row === undefined) continue;
    known.set(code, { code, kind: "rule", ...row });
  }
  for (const variant of variantsOf()) {
    const row = known.get(variant.code);
    // the catalog's words win where it has the code; the class that throws it is added
    known.set(
      variant.code,
      row === undefined ? variant : { ...row, kind: "error", thrownAs: variant.thrownAs },
    );
  }
  return known;
}

/** The lines `agboss explain <code>` prints. */
export function explanationLines(explanation: Explanation): readonly string[] {
  const { code, kind, means, fix, thrownAs } = explanation;
  const where =
    kind === "rule"
      ? "an assembly rule: `agboss check`, `createApp` and `testWith` report it before any model call"
      : "an error: the framework throws it while a workflow runs";
  return [
    `${code} — ${where}`,
    "",
    means,
    ...(thrownAs === undefined
      ? []
      : [
          "",
          `Thrown as \`${thrownAs}\`: catch it with \`error instanceof ${thrownAs}\`, \`.onError(${thrownAs}, …)\` or \`switch (error.code)\`.`,
        ]),
    ...(fix === undefined ? [] : ["", "Before → after:", `  ${fix}`]),
  ];
}
