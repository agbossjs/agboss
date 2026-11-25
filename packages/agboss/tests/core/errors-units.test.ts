/**
 * #1366 (keys-and-calls shard) — the errors the framework throws and the rules of a key's text, each on its own: every
 * error is its class's name and its code, says what it was given to say (and never an id), carries its cause and facts
 * only when it has them; and the rules of a key's text are worded as an error shows them.
 */
import { describe, expect, it } from "vitest";
import {
  AGBossError,
  ApplicationStoppingError,
  causeOptionOf,
  DuplicateExecutionIdError,
  ExecutionCancelledError,
  InvalidMintedIdError,
  InvalidThreadIdError,
  KEY_TEXT_RULE_TEXT,
  KeyTextRule,
  ThreadIdsExhaustedError,
  ThreadOwnerError,
  UnknownThreadError,
} from "../../src/core/errors.js";

describe("#1366: the base of the framework's errors", () => {
  class OwnError extends AGBossError {
    static override readonly code = "own.error" as const;
  }

  it("is named by its class and has its class's code, also on the instance; the base's own is `agboss`", () => {
    const error = new OwnError("said");

    expect(error.name).toBe("OwnError");
    expect(error.code).toBe("own.error");
    expect(error.message).toBe("said");
    expect(new AGBossError("base").code).toBe("agboss");
    expect(new AGBossError("base").name).toBe("AGBossError");
    expect(AGBossError.code).toBe("agboss");
  });

  it("carries a cause and facts only when it was given them", () => {
    const cause = new Error("root");

    const bare = new OwnError("x");
    const full = new OwnError("x", { cause, details: { key: "k" } });

    expect(bare.details).toBeUndefined();
    expect("cause" in bare).toBe(false);
    expect(full.cause).toBe(cause);
    expect(full.details).toEqual({ key: "k" });
    expect(new OwnError("x", { cause: null }).cause).toBeNull();
    expect(new OwnError("x", { details: {} }).details).toEqual({});
  });

  it("the cause of a native error is an option only when there is one", () => {
    expect(causeOptionOf(undefined)).toBeUndefined();
    expect(causeOptionOf("why")).toEqual({ cause: "why" });
    expect(causeOptionOf(null)).toEqual({ cause: null });
    expect(causeOptionOf(0)).toEqual({ cause: 0 });
  });
});

describe("#1366: the errors of a run that is stopped or cancelled", () => {
  it("a cancel says it was cancelled externally unless it says more, and keeps its cause and facts", () => {
    const cause = new Error("root");

    const plain = new ExecutionCancelledError();
    const said = new ExecutionCancelledError({
      message: "by the user",
      cause,
      details: { by: "u" },
    });

    expect(plain.message).toBe("the execution was cancelled externally");
    expect(plain.name).toBe("ExecutionCancelledError");
    expect(plain.code).toBe("execution.cancelled");
    expect(ExecutionCancelledError.code).toBe("execution.cancelled");
    expect(said.message).toBe("by the user");
    expect(said.cause).toBe(cause);
    expect(said.details).toEqual({ by: "u" });
  });

  it("a request refused while the application stops is its own error", () => {
    const error = new ApplicationStoppingError({ message: "stopping" });

    expect(error.name).toBe("ApplicationStoppingError");
    expect(error.code).toBe("app.stopping");
    expect(ApplicationStoppingError.code).toBe("app.stopping");
    expect(error.message).toBe("stopping");
  });
});

describe("#1366: the errors of the ids a generator mints and a caller picks", () => {
  it("an id that is no key names the generator, the method and the rule, never the id", () => {
    const cause = new Error("root");

    const error = new InvalidMintedIdError({
      generator: "MyIds",
      method: "newThreadId",
      rule: KeyTextRule.Spacing,
      cause,
    });

    expect(error.name).toBe("InvalidMintedIdError");
    expect(error.code).toBe("run.invalid-minted-id");
    expect(error.message).toBe(
      `MyIds.newThreadId() minted an id that is no key (spacing): ${KEY_TEXT_RULE_TEXT[KeyTextRule.Spacing]} — fix the IdGenerator`,
    );
    expect(error.details).toEqual({ generator: "MyIds", method: "newThreadId", rule: "spacing" });
    expect([error.generator, error.method, error.rule]).toEqual([
      "MyIds",
      "newThreadId",
      "spacing",
    ]);
    expect(error.cause).toBe(cause);
  });

  it("an execution id another execution has names the generator", () => {
    const error = new DuplicateExecutionIdError({ generator: "MyIds" });

    expect(error.name).toBe("DuplicateExecutionIdError");
    expect(error.code).toBe("run.duplicate-execution-id");
    expect(DuplicateExecutionIdError.code).toBe("run.duplicate-execution-id");
    expect(error.message).toBe(
      "MyIds.newExecutionId() minted an execution id another execution already has — an IdGenerator never repeats an id over the life of the application's stores",
    );
    expect(error.details).toEqual({ generator: "MyIds", method: "newExecutionId" });
    expect(error.generator).toBe("MyIds");
  });

  it("thread ids all taken name the generator and how many were tried", () => {
    const error = new ThreadIdsExhaustedError({ generator: "MyIds", tries: 7 });

    expect(error.name).toBe("ThreadIdsExhaustedError");
    expect(error.code).toBe("run.thread-ids-exhausted");
    expect(ThreadIdsExhaustedError.code).toBe("run.thread-ids-exhausted");
    expect(error.message).toBe(
      "MyIds.newThreadId() minted 7 ids in a row that are threads the tenant has — an IdGenerator never repeats an id over the life of the application's stores",
    );
    expect(error.details).toEqual({ generator: "MyIds", method: "newThreadId", tries: 7 });
    expect([error.generator, error.tries]).toEqual(["MyIds", 7]);
  });

  it("a thread id that cannot be one names the rule", () => {
    const error = new InvalidThreadIdError({ rule: KeyTextRule.Length });

    expect(error.name).toBe("InvalidThreadIdError");
    expect(error.code).toBe("run.invalid-thread-id");
    expect(error.message).toBe(
      `Not a thread id (length): ${KEY_TEXT_RULE_TEXT[KeyTextRule.Length]}`,
    );
    expect(error.details).toEqual({ rule: "length" });
    expect(error.rule).toBe("length");
  });

  it.each([
    [UnknownThreadError, "UnknownThreadError", "run.unknown-thread"],
    [ThreadOwnerError, "ThreadOwnerError", "run.thread-owner"],
  ])("%s has its own name and code, and says what it was given", (ErrorClass, name, code) => {
    const error = new ErrorClass({ message: "no such thread", cause: "why" });

    expect(error.name).toBe(name);
    expect(error.code).toBe(code);
    expect(ErrorClass.code).toBe(code);
    expect(error.message).toBe("no such thread");
    expect(error.cause).toBe("why");
  });
});

describe("#1366: how an error words the rules of a key's text", () => {
  it("each rule is worded as an error says it", () => {
    expect(KEY_TEXT_RULE_TEXT).toMatchInlineSnapshot(`
      {
        "blank": "it contains a blank-looking symbol (U+2800 BRAILLE PATTERN BLANK)",
        "control-character": "it contains a control character (C0 U+0000–U+001F, U+007F or C1 U+0080–U+009F)",
        "format-character": "it contains a format character (Unicode Cf: zero-width space or joiner, a bidi control, U+FEFF, a soft hyphen, …)",
        "ignorable": "it contains a character that renders as nothing (Unicode Default_Ignorable_Code_Point: a variation selector, a Hangul filler, the combining grapheme joiner, …)",
        "length": "it must be 1 to 200 characters (UTF-16 code units)",
        "lone-surrogate": "it contains a lone surrogate (half of a UTF-16 pair, no character)",
        "not-nfc": "it is not in Unicode normalization form C (NFC): normalize it with text.normalize("NFC") where it is made",
        "private-or-noncharacter": "it contains a private-use character (Unicode Co) or a noncharacter (U+FDD0–U+FDEF, U+xFFFE, U+xFFFF)",
        "reserved-separator": "it contains the reserved child-thread separator (slash, child, slash)",
        "space-separator": "it contains a space other than U+0020 (Unicode Zs: a no-break, thin or ideographic space, …) or a line or paragraph separator (U+2028, U+2029)",
        "spacing": "it starts or ends with a space (U+0020), or has two in a row: a key's spaces are single and inside",
        "unassigned": "it contains a code point unassigned in this runtime's Unicode (Cn): a later version may give it another meaning",
      }
    `);
  });
});
