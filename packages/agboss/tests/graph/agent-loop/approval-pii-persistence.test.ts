/**
 * #1295c: what the approval path keeps of a call's arguments. The flow's records (`approvals`) and
 * the decisions channel hold the arguments as the approver saw them — masked by the PII policies —
 * never the values the model gave; the tool still runs with the real ones after a resume.
 */
import { MemorySaver } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
import { PiiKind } from "../../../src/pii/kinds.js";
import { PiiPolicySet } from "../../../src/pii/policy-set.js";
import { runtimePolicyOf } from "../../../src/pii/runtime-policy.js";
import type { PiiPolicyMeta, PiiRule } from "../../../src/pii/pii-policy.decorator.js";
import {
  callTools,
  decision,
  harness,
  replyWith,
  runLoop,
  startInput,
  stateOf,
  write,
} from "./fixtures.js";

const EMAIL = "alice@example.com";
const OTHER = "bob@example.org";

const policySet = (...rules: PiiRule[]): PiiPolicySet =>
  new PiiPolicySet(
    [
      runtimePolicyOf({
        meta: {
          name: "contact-pii-policy",
          description: "d",
          rules,
          deps: [],
        } as never,
        instance: {},
        key: "k",
      }),
    ],
    "field-key",
  );

describe("#1295c: approval records never hold the model's raw arguments", () => {
  it.each([
    ["tokenize", PiiKind.Email.tokenize()],
    ["mask", PiiKind.Email.mask()],
  ])(
    "an approved call (%s): the record and the decisions hold no email; the tool got it",
    async (_name, rule) => {
      const saver = new MemorySaver();
      const h = harness(
        {
          moves: [callTools(write("w1", "a.ts", `mail ${EMAIL}`)), replyWith("done")],
          pii: policySet(rule),
        },
        saver,
      );
      await runLoop(h.graph, startInput(), "t");

      const end = await runLoop(h.graph, decision({ approved: true }), "t");

      expect(end).toEqual({ kind: "answered", reply: "done" });
      expect(h.effects).toEqual([`write a.ts=mail ${EMAIL}`]);
      const state = await stateOf(h.graph, "t");
      expect(state.approvals).toHaveLength(1);
      expect(JSON.stringify(state.approvals)).not.toContain(EMAIL);
      expect(JSON.stringify(state.decisions)).not.toContain(EMAIL);
    },
  );

  it("an approver's override: the decision keeps no typed arguments, the record shows the masked ones, the tool runs the override", async () => {
    const h = harness({
      moves: [callTools(write("w1", "a.ts", "fine")), replyWith("done")],
      pii: policySet(PiiKind.Email.tokenize()),
    });
    await runLoop(h.graph, startInput(), "t");

    await runLoop(
      h.graph,
      decision({ approved: true, overrideArguments: { path: "a.ts", content: `to ${OTHER}` } }),
      "t",
    );

    expect(h.effects).toEqual([`write a.ts=to ${OTHER}`]);
    const state = await stateOf(h.graph, "t");
    const kept = JSON.stringify([state.approvals, state.decisions]);
    expect(kept).not.toContain(OTHER);
    expect(JSON.stringify(state.approvals)).toMatch(/<email:[0-9a-f]+>/);
  });
});
