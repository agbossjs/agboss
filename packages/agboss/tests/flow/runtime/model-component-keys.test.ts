/**
 * #395 PR 5b: every component that calls a model has its join keys — model judges (their `reply`),
 * guardrails, arbiters, compactions, reply interpreters, PII policies that detect with a model —
 * in `agboss describe --json` (`modelComponents`) and in a VCR cassette, so a change of one makes
 * its recordings stale like an agent's.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../../src/application/assemble.js";
import type { Class } from "../../../src/components/injection.js";
import { modelComponentRecordsOf } from "../../../src/flow/runtime/model-component-keys.js";
import { ComponentKind, type ComponentRecord } from "../../../src/flow/runtime/records.js";
import { workflowSnapshotOf } from "../../../src/describe/snapshot.js";
import { describeServices } from "../../../src/describe/describe-workflow.js";
import type { Interaction } from "../../../src/testing/vcr-file.js";
import { CassetteChange } from "../../../src/testing/index.js";
import { cassetteHashesOf, changesOf } from "../../../src/testing/vcr-hashes.js";
import { JudgedDeskApplication } from "../../judges/fixtures/judged.workflow.js";
import { HelpDeskApplication } from "../../compaction/compaction.fixture.js";
import { ModelPanelApplication } from "../fixtures/quorum-runtime.fixture.js";
import { TreasuryApplication } from "../fixtures/replies.fixture.js";
import { SensitiveApplication } from "../../pii/sensitive.fixture.js";
import { DeskApplication } from "../../testing/fixtures/desk.workflow.js";

const HASH = /^[0-9a-f]+$/;

/** The model components of every workflow of an application. */
async function recordsOf(application: Class): Promise<readonly ComponentRecord[]> {
  const { workflows } = await applicationOf(application);
  return workflows.flatMap((workflow) => modelComponentRecordsOf(workflow));
}

const named = (records: readonly ComponentRecord[], name: string): ComponentRecord | undefined =>
  records.find((record) => record.name === name);

describe("each kind of model component has its join keys", () => {
  it("a model judge: the reply it judges (its questions are code)", async () => {
    const judge = named(await recordsOf(JudgedDeskApplication), "grounded");

    expect(judge).toMatchObject({ kind: ComponentKind.Judge, promptHash: undefined });
    expect(judge?.schemaHash).toMatch(HASH);
  });

  it("a model guardrail: its question", async () => {
    const guardrail = named(await recordsOf(DeskApplication), "prompt-injection-guardrail");

    expect(guardrail).toMatchObject({ kind: ComponentKind.Guardrail, schemaHash: undefined });
    expect(guardrail?.promptHash).toMatch(HASH);
  });

  it("a model arbiter: its prompt and criteria, the same hash describe gives its launch", async () => {
    const { workflows } = await applicationOf(ModelPanelApplication);
    const records = workflows.flatMap((workflow) => modelComponentRecordsOf(workflow));
    const arbiter = named(records, "panel-model-arbiter");

    expect(arbiter).toMatchObject({ kind: ComponentKind.Arbiter });
    expect(arbiter?.promptHash).toMatch(HASH);
    const [workflow] = workflows;
    const snapshot =
      workflow === undefined ? undefined : workflowSnapshotOf(workflow, describeServices);
    const launched = snapshot?.launches
      .flatMap((launch) => launch.acceptedBy)
      .flat()
      .find((one) => one.name === "panel-model-arbiter");
    expect(launched?.promptHash).toBe(arbiter?.promptHash);
  });

  it("a compaction that writes summaries: its prompt and strategy", async () => {
    const compaction = named(await recordsOf(HelpDeskApplication), "queue-compaction");

    expect(compaction).toMatchObject({ kind: ComponentKind.Compaction });
    expect(compaction?.promptHash).toMatch(HASH);
  });

  it("a model reply interpreter: its instructions and the answer it gives; a code one none", async () => {
    const records = await recordsOf(TreasuryApplication);

    const interpreter = named(records, "payout-reply-interpreter");
    expect(interpreter).toMatchObject({ kind: ComponentKind.ReplyInterpreter });
    expect(interpreter?.promptHash).toMatch(HASH);
    expect(interpreter?.schemaHash).toMatch(HASH);
    expect(named(records, "expense-reply-interpreter")).toBeUndefined();
  });

  it("a PII policy that detects with a model: the kinds it asks for", async () => {
    const policy = named(await recordsOf(SensitiveApplication), "names-pii-policy");

    expect(policy).toMatchObject({ kind: ComponentKind.PiiPolicy, schemaHash: undefined });
    expect(policy?.promptHash).toMatch(HASH);
  });
});

describe("in describe --json and in a cassette", () => {
  it("describe lists them as modelComponents", async () => {
    const { workflows } = await applicationOf(DeskApplication);
    const [workflow] = workflows;
    const snapshot =
      workflow === undefined ? undefined : workflowSnapshotOf(workflow, describeServices);

    expect(snapshot?.modelComponents.map((record) => record.name)).toContain(
      "prompt-injection-guardrail",
    );
  });

  it("a cassette's guardrail call with another question is stale", async () => {
    const { workflows } = await applicationOf(DeskApplication);
    const hashes = cassetteHashesOf(workflows);
    const recorded: Interaction = {
      kind: "chat",
      key: "guardrail:prompt-injection-guardrail",
      request: "0",
      reply: { content: "" },
      component: "prompt-injection-guardrail",
      promptHash: "0000000000000000",
    };

    expect(hashes.knows("prompt-injection-guardrail")).toBe(true);
    expect(changesOf(recorded, hashes)).toEqual([CassetteChange.Prompt]);
    const current = hashes.of(recorded.key).promptHash;
    expect(
      changesOf({ ...recorded, ...(current === undefined ? {} : { promptHash: current }) }, hashes),
    ).toEqual([]);
  });
});
