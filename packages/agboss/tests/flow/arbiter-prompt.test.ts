/**
 * #1347 (conformance): a model arbiter's `prompt` is a `PromptSource` — a `./` file, `inline(…)` or a
 * list of them — read at assembly like every prompt, part of the prompt version, and what its model
 * is told.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Action,
  Agent,
  Arbiter,
  inline,
  listOf,
  PromptError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../src/index.js";
import type { PromptSource } from "../../src/components/prompt-source.js";
import { Text, WorkflowStartTextDto } from "../../src/dto/index.js";
import { executionVersions } from "../../src/run/versions.js";
import { workflowOf } from "../../src/testing/workflow-of.js";
import { arbiterPromptHashOf } from "../../src/flow/runtime/model-component-keys.js";
import { unitArbiterUsesOf } from "../../src/flow/runtime/launch/arbiter-prompts.js";
import { fakeDeps, testDefaults } from "../helpers.js";
import { onStart } from "../helpers/flow.js";

class AnsDto {
  @Text({ prompt: "a" }) a!: string;
}
class OutDto {
  @Text({ prompt: "o" }) o!: string;
}

/** A workflow with one model arbiter whose `prompt` is `prompt`. */
function workflowWith(prompt: PromptSource) {
  @Agent({
    name: "ans-agent",
    description: "A",
    prompt: inline("A."),
    model: "local/llama",
    output: AnsDto,
  })
  class AnsAgent {}

  @Arbiter({
    name: "ans-arbiter",
    model: "moonshotai/kimi-k2.6",
    prompt,
    criteria: [{ target: AnsAgent, prompt: "ok" }],
  })
  class AnsArbiter {}

  @WorkflowStart({
    name: "ans-start-workflow-start",
    description: "q",
    input: WorkflowStartTextDto,
  })
  class AnsStart {}

  @Action({
    name: "ans-finish-action",
    description: "f",
    input: { answers: listOf(AnsDto) },
    output: OutDto,
  })
  class AnsAction {
    execute(i: { readonly answers: readonly Produced<AnsDto, unknown>[] }): Promise<OutDto> {
      return Promise.resolve({ o: String(i.answers.length) });
    }
  }

  @WorkflowFinish({ name: "ans-finish-workflow-finish", description: "f", output: OutDto })
  class AnsFinish {}

  @Workflow({
    name: "ans-workflow",
    version: "1.0.0",
    defaults: testDefaults,
    flow: [
      onStart(AnsStart)
        .toParallelAgents(AnsAgent, AnsAgent)
        .acceptedBy(AnsArbiter)
        .joinQuorum({ min: 2 })
        .toAction(AnsAction)
        .toFinish(AnsFinish),
    ],
  })
  class AnsWorkflow {}
  return { workflow: AnsWorkflow, arbiter: AnsArbiter };
}

const versionOf = async (prompt: PromptSource): Promise<string> => {
  const bundle = await workflowOf(workflowWith(prompt).workflow);
  return executionVersions({
    ...(await fakeDeps({})),
    graph: bundle.graph,
    prompts: bundle.prompts,
    routers: bundle.routers,
    arbiters: bundle.arbiters,
  }).promptVersion;
};

describe("#1347: a model arbiter's prompt", () => {
  it("inline text is read at assembly, normalised, and carried on the arbiter's use", async () => {
    const bundle = await workflowOf(workflowWith(inline("\n  Count it.\n\n")).workflow);

    expect(bundle.arbiters?.map(({ name, prompt }) => [name, prompt])).toEqual([
      ["ans-arbiter", "  Count it."],
    ]);
  });

  it("a prompt file is read, its text (never its path) is in the prompt version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "arbiter-prompt-"));
    const file = join(dir, "judge.prompt.md");
    writeFileSync(file, "Count it.\n");
    const other = join(dir, "other.prompt.md");
    writeFileSync(other, "Count it.\n");

    expect(await versionOf(file as `/${string}`)).toBe(await versionOf(other as `/${string}`));
    expect(await versionOf(file as `/${string}`)).toBe(await versionOf(inline("Count it.")));
    expect(await versionOf(inline("Count it differently."))).not.toBe(
      await versionOf(inline("Count it.")),
    );
  });

  it("a missing file and a bare text are prompt problems, reported with the others", async () => {
    await expect(workflowOf(workflowWith("/nowhere/judge.prompt.md").workflow)).rejects.toThrow(
      PromptError,
    );
    await expect(workflowOf(workflowWith("Count it." as never).workflow)).rejects.toThrow(
      "[prompt.bare-text]",
    );
  });

  it("the describe hash follows the text", async () => {
    const one = workflowWith(inline("One."));
    const two = workflowWith(inline("Two."));
    const hash = async (made: ReturnType<typeof workflowWith>) =>
      arbiterPromptHashOf(made.arbiter, (await workflowOf(made.workflow)).arbiters);

    expect(await hash(one)).not.toBe(await hash(two));
  });

  it("a unit reads it as at assembly", async () => {
    const { arbiter } = workflowWith(inline("Count it."));

    expect(await unitArbiterUsesOf(arbiter)).toMatchObject([
      { name: "ans-arbiter", prompt: "Count it." },
    ]);
  });
});
