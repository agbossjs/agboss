/**
 * #1366: what an `A2AClient` checks of a call before anything is sent or charged — the call's timeout (a timer's
 * bound), its key (an outbound call's charset), its contract's price — and what it reads of its class: the
 * origins it may fetch from, the typed contract both of whose DTOs it needs, the address it calls.
 */
import { describe, expect, it } from "vitest";
import {
  allowedOriginsOfClass,
  checkedCall,
  checkedCallTimeout,
  typedContractOf,
  urlOf,
} from "../../../src/a2a/client/a2a-client-options.js";
import { ComponentError } from "../../../src/components/metadata.js";
import { MAX_TIMEOUT } from "../../../src/units/timer-limits.js";

const refusal = (work: () => unknown): string | undefined => {
  try {
    work();
    return undefined;
  } catch (error) {
    return error instanceof ComponentError ? error.message : String(error);
  }
};

describe("#1366: a call's timeout and key are checked before it is sent", () => {
  it("a timeout up to the largest timer passes, one past it is [a2a.timeout-invalid], none is no check", () => {
    expect(refusal(() => checkedCallTimeout("agent", MAX_TIMEOUT))).toBeUndefined();
    expect(refusal(() => checkedCallTimeout("agent", undefined))).toBeUndefined();
    expect(refusal(() => checkedCallTimeout("agent", MAX_TIMEOUT + 1))).toMatch(
      /^\[a2a\.timeout-invalid\] agent: a call's timeout/u,
    );
  });

  it("checkedCall checks the timeout, the price and the key, and gives the key back", () => {
    expect(checkedCall("agent", { key: "second-call", timeout: 1000 }, 0.5)).toBe("second-call");
    expect(checkedCall("agent", {}, undefined)).toBeUndefined();
    expect(refusal(() => checkedCall("agent", { timeout: MAX_TIMEOUT + 1 }, undefined))).toMatch(
      /a2a\.timeout-invalid/u,
    );
    expect(refusal(() => checkedCall("agent", {}, -1))).toMatch(/a2a\.price-invalid/u);
  });

  it("a key is 1 to 40 of letters, digits, dot, underscore and dash, a letter or digit first", () => {
    const keyOf = (key: string) => refusal(() => checkedCall("agent", { key }, undefined));

    expect(keyOf("a")).toBeUndefined();
    expect(keyOf("a".repeat(40))).toBeUndefined();
    expect(keyOf("9._-x")).toBeUndefined();
    for (const bad of ["", "a".repeat(41), ".a", "-a", "_a", "a b", "a:b", "a/b"])
      expect(keyOf(bad)).toMatch(/^\[a2a\.call-key-invalid\] agent:/u);
  });
});

describe("#1366: what the client reads of its class", () => {
  it("a class with no @A2AAgent has no url and no origins: the url is refused by name", () => {
    class Plain {}

    expect(refusal(() => urlOf(Plain, "plain-client"))).toMatch(/^\[a2a\.no-url\] plain-client /u);
    expect(allowedOriginsOfClass(Plain)).toEqual([]);
  });

  it("a typed contract needs both DTOs: one alone, or none, is [a2a.no-contract]", () => {
    class Input {}
    class Output {}

    expect(typedContractOf("agent", { input: Input as never, output: Output as never })).toMatchObject({
      input: Input,
      output: Output,
    });
    expect(refusal(() => typedContractOf("agent", { input: Input as never }))).toMatch(
      /^\[a2a\.no-contract\] agent /u,
    );
    expect(refusal(() => typedContractOf("agent", { output: Output as never }))).toMatch(
      /^\[a2a\.no-contract\] agent /u,
    );
    expect(refusal(() => typedContractOf("agent", undefined))).toMatch(/^\[a2a\.no-contract\]/u);
  });
});
