import { chai } from "vitest";
import type { DtoClass } from "../dto/types.js";
import { ActionCalls } from "./action-script.js";
import { ComponentScript } from "./component-script.js";
import { inputText, matchesInput, matchesPartial, type RecordedInput } from "./input-match.js";
import type { ReturnedValue } from "./script-book.js";

/**
 * The call matchers on `mockLlm(X)` and `mockAction(A)` (#262 AC9), under Vitest's names:
 * `toHaveBeenCalledWith(PartialValues<InputOf<X>>)` (the matcher of `when`),
 * `toHaveBeenCalledTimes(n)`, `toHaveReturned(XDto, partial?)`. They are layered over Vitest's own
 * mock matchers of those names: anything else — a `vi.fn()`, a `mockOf(…)` method — goes to them.
 */

/** What a matcher reads from a script or an action's calls. */
interface CallRecord {
  readonly what: string;
  readonly calls: number;
  readonly inputs: readonly RecordedInput[];
  readonly returned: readonly ReturnedValue[];
}

function callRecordOf(received: unknown): CallRecord | undefined {
  if (received instanceof ComponentScript) {
    const { inputs, returned } = received;
    return {
      what: `mockLlm(${received.label})`,
      calls: received.requests.length,
      inputs,
      returned,
    };
  }
  if (received instanceof ActionCalls) {
    const { inputs, returned } = received;
    return { what: `mockAction(${received.label})`, calls: inputs.length, inputs, returned };
  }
  return undefined;
}

/** A matcher's verdict: whether it passed, what it expected, what it saw. */
interface CallVerdict {
  readonly pass: boolean;
  readonly expected: string;
  readonly got: string;
}

const inputsText = (record: CallRecord): string =>
  record.inputs.map((input) => inputText(input)).join("; ") || "(none)";

const returnedText = (record: CallRecord): string =>
  record.returned.map((item) => `${item.dto.name} ${JSON.stringify(item.value)}`).join("; ") ||
  "(nothing)";

/** One call matcher: the record and the matcher's arguments in, its verdict out. */
type CallMatcher = (record: CallRecord, ...args: readonly unknown[]) => CallVerdict;

const callMatchers: Readonly<Record<string, CallMatcher>> = {
  toHaveBeenCalledWith: (record, partial) => {
    const expected = partial as RecordedInput;
    return {
      pass: record.inputs.some((input) => matchesInput(input, expected)),
      expected: `${record.what} to have been called with ${inputText(expected)}`,
      got: `its inputs: ${inputsText(record)}`,
    };
  },

  toHaveBeenCalledTimes: (record, times) => {
    return {
      pass: record.calls === times,
      expected: `${record.what} to have been called ${String(times)} time(s)`,
      got: `it was called ${String(record.calls)} time(s)`,
    };
  },

  toHaveReturned: (record, dto, partial) => {
    const wanted = dto as DtoClass;
    const pass = record.returned.some(
      (item) =>
        item.dto === wanted && (partial === undefined || matchesPartial(item.value, partial)),
    );
    const data = partial === undefined ? "" : ` ${JSON.stringify(partial)}`;
    return {
      pass,
      expected: `${record.what} to have returned ${wanted.name}${data}`,
      got: `it returned ${returnedText(record)}`,
    };
  },
};

type Original = (this: unknown, ...args: unknown[]) => unknown;

/** Installs the call matchers over Vitest's (the setup file does it once). */
export function installCallMatchers(): void {
  for (const [name, matcher] of Object.entries(callMatchers)) {
    chai.Assertion.overwriteMethod(
      name,
      (original: Original) =>
        function (this: Chai.AssertionStatic, ...args: unknown[]): unknown {
          const received: unknown = chai.util.flag(this, "object");
          const record = callRecordOf(received);
          if (record === undefined) return original.apply(this, args);
          const verdict = matcher(record, ...args);
          const said = `expected ${verdict.expected}, ${verdict.got}`;
          const negated = `expected not ${verdict.expected}, ${verdict.got}`;
          this.assert(verdict.pass, said, negated);
          return undefined;
        },
    );
  }
}
