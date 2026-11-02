/**
 * #708 — every model the framework calls on an agent's behalf reads as that agent's own model
 * reads. The reading (`modelReadingMaskOf`): every text through the agent's policies, a block rule
 * refusing before any model reads it, the tokens kept for a reveal; none without policies. A model
 * judge's calls (`JudgeReading`): a text or messages, a decision's state and questions masked (an
 * image's data left as it is), a chat reply revealed for `judge()`. A model arbiter: the answer, its
 * criterion and instructions masked before its model reads them.
 */
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { componentOf } from "../../src/components/metadata.js";
import { JudgeReading } from "../../src/graph/agent-loop/judge-reading.js";
import { createArbiterModel } from "../../src/flow/runtime/launch/arbiter-model.js";
import { Decision } from "../../src/index.js";
import { PiiRefusedError } from "../../src/pii/errors.js";
import { modelReadingMaskOf, type ModelReadingMask } from "../../src/pii/model-reading.js";
import type { PiiPolicyMeta } from "../../src/pii/pii-policy.decorator.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { runtimePolicyOf } from "../../src/pii/runtime-policy.js";
import { decideWith } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import type { Class } from "../../src/components/injection.js";
import { CardPiiPolicy, ContactPiiPolicy } from "./pii.fixture.js";

const EMAIL = "alice@example.com";
const CARD = "4242 4242 4242 4242";
const TOKEN = /<email:[0-9a-f]{6,}>/u;

/** Policy classes as an agent's loop holds them (a fixed key, no model). */
function policies(...classes: Class[]): PiiPolicySet {
  const runtime = classes.map((cls) => {
    const component = componentOf(cls);
    if (component?.kind !== "pii-policy") throw new Error("not a policy");
    const meta: PiiPolicyMeta = component.meta;
    return runtimePolicyOf({ meta, instance: new (cls as new () => object)(), key: "k" });
  });
  return new PiiPolicySet(runtime, "field-key");
}

const contacts = (): ModelReadingMask => {
  const mask = modelReadingMaskOf(policies(ContactPiiPolicy, CardPiiPolicy));
  if (mask === undefined) throw new Error("a mask expected");
  return mask;
};

describe("#708: the reading of a model called on an agent's behalf", () => {
  it("none without policies: the texts go as they are", () => {
    expect(modelReadingMaskOf(undefined)).toBeUndefined();
    expect(modelReadingMaskOf(new PiiPolicySet([], "k"))).toBeUndefined();
  });

  it("every text masked, the tokens kept for a reveal", async () => {
    const read = await contacts()([`Write to ${EMAIL}`, "no contact here"]);

    expect(read.texts[0]).toMatch(TOKEN);
    expect(read.texts[0]).not.toContain(EMAIL);
    expect(read.texts[1]).toBe("no contact here");
    expect(Object.values(read.tokens)).toContain(EMAIL);
  });

  it("a block rule refuses with PiiRefusedError, whatever its place among the texts", async () => {
    const refused = await contacts()([`Write to ${EMAIL}`, `Card ${CARD}`]).catch(
      (error: unknown) => error,
    );

    expect(refused).toBeInstanceOf(PiiRefusedError);
    expect(refused).toMatchObject({ refusal: "Please do not send a card-number." });
  });
});

describe("#708: a model judge's calls", () => {
  it("a text and chat messages masked; the reply's tokens revealed for judge()", async () => {
    const reading = new JudgeReading(contacts());

    const text = await reading.input(`Is ${EMAIL} grounded?`);
    const messages = await reading.input([
      new SystemMessage("Judge it."),
      new HumanMessage(`Reply: write to ${EMAIL}`),
    ]);

    expect(text).toMatch(TOKEN);
    expect(JSON.stringify(messages)).not.toContain(EMAIL);
    const token = TOKEN.exec(String(text))?.[0] ?? "";
    expect(reading.revealed(`FAIL: ${token} is not in the sources`)).toBe(
      `FAIL: ${EMAIL} is not in the sources`,
    );
  });

  it("a decision's state and questions masked, an image's data left as it is", async () => {
    const reading = new JudgeReading(contacts());
    const image = "data:image/png;base64,iVBORw0KGgo=";

    const request = await reading.request({
      state: [`The answer names ${EMAIL}`, { type: "image", url: image } as never],
      questions: { grounded: Decision.noul(`Is ${EMAIL} in the sources?`) },
    });

    const sent = JSON.stringify(request);
    expect(sent).not.toContain(EMAIL);
    expect(sent).toMatch(TOKEN);
    expect(sent).toContain(image);
  });
});

describe("#708: a model arbiter's call", () => {
  it("its model reads the answer, criterion and instructions masked by the answering agent's policies", async () => {
    const book = new ScriptBook();
    book.scriptOf("arbiter:contact-arbiter").thenReturn(decideWith({ counts: 0.9 }));
    const gateway = createScriptedGateway(book);
    const model = createArbiterModel(
      "contact-arbiter",
      { kind: "jev", model: "typesafe/jev-1.13" },
      { gateway, chatDefaults: { temperature: 0 } as never },
    );

    const verdict = await model.judge(
      {
        agent: "contact-agent",
        answer: { owner: EMAIL },
        criterion: `Names ${EMAIL}'s team`,
        instructions: "Count an answer that names a team.",
      },
      contacts(),
    );

    expect(verdict).toMatchObject({ kind: "judged", passed: true });
    const sent = JSON.stringify(book.scriptOf("arbiter:contact-arbiter").lastRequest);
    expect(sent).not.toContain(EMAIL);
    expect(sent).toMatch(TOKEN);
  });
});
