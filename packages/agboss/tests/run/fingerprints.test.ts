/**
 * #120 PR 4 — what changes a model's input but lives outside its element's decorator is in the
 * workflow's fingerprint (`configHash`): the PII policies in effect at the element's model, its
 * window and compaction, its judges, and the framework's own texts. The same fingerprint from the
 * assembled workflow (`agboss describe`) and from its run dependencies.
 */
import { afterEach, describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { buildApplication, type BuiltApplication } from "../../src/application/create-app.js";
import type { Class } from "../../src/components/injection.js";
import { configSnapshot, executionVersions } from "../../src/run/versions.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { deskApplicationOf, type DeskVariant } from "./fingerprints.fixture.js";

const built: BuiltApplication[] = [];

afterEach(async () => {
  await Promise.all(built.splice(0).map((application) => application.app.close()));
});

/** The desk workflow's run dependencies in an application instance built for the variant. */
async function deskDepsOf(application: Class) {
  const offline = { processEnv: {}, gateway: createScriptedGateway(new ScriptBook()) };
  const instance = await buildApplication(await applicationOf(application), offline, {
    quiet: true,
  });
  built.push(instance);
  const [desk] = instance.workflows;
  if (desk === undefined) throw new Error("the desk workflow is missing");
  return desk.deps;
}

const configHashOf = async (variant: DeskVariant = {}): Promise<string> =>
  executionVersions(await deskDepsOf(deskApplicationOf(variant))).configHash;

/** The fingerprint's sub-tree of one element. */
async function elementOf(variant: DeskVariant, element: string): Promise<unknown> {
  const snapshot = configSnapshot(await deskDepsOf(deskApplicationOf(variant))) as {
    readonly elements: Readonly<Record<string, unknown>>;
  };
  return snapshot.elements[element];
}

describe("#120 PR 4: the fingerprint covers what an element's model reads outside its decorator", () => {
  it("one application built twice has one fingerprint", async () => {
    expect(await configHashOf()).toBe(await configHashOf());
  });

  it("each element's sub-tree: its policies, window, compaction and judges", async () => {
    expect(await elementOf({ judgeModel: "test/judge" }, "answer-agent")).toEqual({
      uncompactedTurns: 3,
      compaction: "queue-compaction",
      piiPolicies: [
        {
          name: "contact-pii-policy",
          rules: [{ target: "email", action: { kind: "replace-with-token" } }],
        },
      ],
      judges: [{ name: "polite-judge", model: "test/judge" }],
    });
    expect(await elementOf({ routerTurns: 1, isAgentExcludingPii: true }, "help-router")).toEqual({
      uncompactedTurns: 1,
      compaction: "queue-compaction",
      piiPolicies: [
        {
          name: "contact-pii-policy",
          rules: [{ target: "email", action: { kind: "replace-with-token" } }],
        },
      ],
    });
  });

  it("the effective PII policy: excluding it on one agent changes the fingerprint", async () => {
    const base = await configHashOf();

    expect(await configHashOf({ isAgentExcludingPii: true })).not.toBe(base);
    expect(await elementOf({ isAgentExcludingPii: true }, "answer-agent")).toEqual({
      uncompactedTurns: 3,
      compaction: "queue-compaction",
    });
  });

  it("a policy's action, a replacePart pattern by its text, changes the fingerprint", async () => {
    const partial = await elementOf({ isPolicyPartial: true }, "answer-agent");

    expect(await configHashOf({ isPolicyPartial: true })).not.toBe(await configHashOf());
    expect(partial).toMatchObject({
      piiPolicies: [
        {
          rules: [{ target: "email", action: { part: { pattern: "/[a-z]+@/g" } } }],
        },
      ],
    });
  });

  it("the compaction in effect and a reader's window change the fingerprint", async () => {
    const base = await configHashOf();

    expect(await configHashOf({ isLongerQueue: true })).not.toBe(base);
    expect(await configHashOf({ routerTurns: 1 })).not.toBe(base);
  });

  it("the judges attached to an agent change the fingerprint", async () => {
    const judged = await configHashOf({ judgeModel: "test/judge" });

    expect(judged).not.toBe(await configHashOf());
    expect(await configHashOf({ judgeModel: "test/other-judge" })).not.toBe(judged);
  });

  it("the framework's own texts are part of it: the agent loop's answer instructions", async () => {
    const snapshot = configSnapshot(await deskDepsOf(deskApplicationOf())) as {
      readonly frame: { readonly agentLoop: readonly string[] };
    };

    expect(snapshot.frame.agentLoop).toEqual(
      expect.arrayContaining([
        "Call regular tools first, and call exactly one answer tool when ready to finish — none of this message's tools ran.",
        "Finish with your answer as  items",
      ]),
    );
  });

  it("the assembled workflow gives the run's fingerprint (agboss describe and the run agree)", async () => {
    const application = deskApplicationOf({ judgeModel: "test/judge", routerTurns: 1 });
    const [bundle] = (await applicationOf(application)).workflows;
    if (bundle === undefined) throw new Error("the desk workflow is missing");

    expect(configSnapshot(bundle)).toEqual(configSnapshot(await deskDepsOf(application)));
  });
});

describe("#120 PR 4: the fingerprint hashes the prompt as it is sent, normalised", () => {
  it("blank lines at the edges, CRLF and a decomposed accent do not change it", async () => {
    const base = await configHashOf({ agentPrompt: "Answer the message, café." });

    expect(await configHashOf({ agentPrompt: "\n\r\n  \nAnswer the message, café.\r\n\n" })).toBe(
      base,
    );
    expect(await configHashOf({ agentPrompt: "  Answer the message, café." })).not.toBe(base);
  });
});
