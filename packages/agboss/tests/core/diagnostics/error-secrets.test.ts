import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { AGBossError, BacktraceMode } from "../../../src/errors.js";
import { ValidationError } from "../../../src/index.js";
import { runInFrame } from "../../../src/flow/context/frame.js";
import { testFrame } from "../../helpers/frame.js";

/**
 * #1325c: a report never prints a secret, a PII value, a model text or a stored value that an error
 * carries as context — its `details`, its facts, a foreign cause's message, the values of the
 * execution it was made in. It prints the framework's own sentence, names, counters and code places.
 */

const SECRET = "sk-live-4242424242";
const PII = "jane.doe@example.com";
const MODEL_TEXT = "As an AI assistant, here is the customer's card number 4111111111111111";

class SampleError extends AGBossError {
  static override readonly code = "sample";
}

const MODES = [BacktraceMode.Off, BacktraceMode.Short, BacktraceMode.Full] as const;

/** Every way an error is shown: `format()` in each mode, `util.inspect`, the stack-free chain walk. */
const shownForms = (error: AGBossError): readonly string[] => [
  ...MODES.map((backtrace) => error.format({ backtrace })),
  inspect(error),
  inspect({ nested: [error] }, { depth: 5 }),
];

describe("what a report never prints", () => {
  it("details, facts of a variant and a foreign cause's message", () => {
    const foreign = new Error(`Bearer ${SECRET} for ${PII}: ${MODEL_TEXT}`);
    foreign.name = "ProviderSdkError";
    const error = new ValidationError.TenantRequired({
      operation: `charge ${SECRET}`,
      details: { apiKey: SECRET, customer: PII, completion: MODEL_TEXT },
      cause: foreign,
    });

    for (const text of shownForms(error)) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(PII);
      expect(text).not.toContain("4111111111111111");
      expect(text).toContain("ProviderSdkError (message withheld: not a framework error)");
    }
  });

  it("the details and facts of a framework cause deeper in the chain", () => {
    const inner = new SampleError("the settled key differs", {
      details: { key: SECRET, owner: PII },
      cause: new TypeError(SECRET),
    });
    const outer = new SampleError("step failed", { cause: inner });

    for (const text of shownForms(outer)) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(PII);
      expect(text).toContain("the settled key differs");
      expect(text).toContain("TypeError (message withheld");
    }
  });

  it("the values, tenant and ids of the execution it was made in", async () => {
    const frame = testFrame();
    const execution = {
      ...frame.execution,
      values: { cardNumber: SECRET, email: PII },
      ownerId: PII,
      threadId: `thread-${SECRET}`,
      executionId: `exec-${SECRET}`,
    };

    const error = await runInFrame({ ...frame, execution }, () =>
      Promise.resolve(new SampleError("inside a step")),
    );

    expect(error.spanTrace.length).toBeGreaterThan(0);
    for (const text of shownForms(error)) {
      expect(text).toContain("Span trace:");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(PII);
    }
  });

  it("a span trace field is a name or a counter, however long", async () => {
    const frame = testFrame();
    const workflow = { ...frame.execution.workflow, name: "w".repeat(500) };

    const error = await runInFrame({ ...frame, execution: { ...frame.execution, workflow } }, () =>
      Promise.resolve(new SampleError("x")),
    );

    expect(error.format({ backtrace: BacktraceMode.Off })).not.toContain("w".repeat(81));
  });

  it("the error's details stay on the error for logs and records, apart from the report", () => {
    const error = new SampleError("settled", { details: { key: "order-42" } });

    expect(error.details).toEqual({ key: "order-42" });
    expect(error.format()).not.toContain("order-42");
  });
});
