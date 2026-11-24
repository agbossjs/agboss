import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  Agent,
  Application,
  DecidedBy,
  defineEnv,
  EmptyEnvironment,
  env,
  inline,
  InputGuardrail,
  PromptError,
  Router,
  secret,
  Workflow,
} from "../../src/index.js";
import { PromptLoader } from "../../src/components/prompt-render.js";
import { loadedGuardrailOf } from "../../src/guardrails/assembly.js";
import { executionVersions } from "../../src/run/versions.js";
import type { AssembledReplyInterpreter } from "../../src/channels/discovery.js";
import { fakeDeps } from "../helpers.js";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class } from "../../src/components/injection.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { testConfig, testDefaults } from "../helpers.js";
import { onStart, route } from "../helpers/flow.js";
import { NoAnswer, TestAnswer, TestChat } from "../fixtures/test-flow/test.flow.js";

/** #1347c: `promptVariables` cascade (application → workflow → component), `env(…)` values, no secrets. */

const SECRET_VALUE = "sk-live-do-not-leak";
const appEnv = defineEnv({
  company: env("PROMPT_COMPANY"),
  tone: env("PROMPT_TONE"),
  apiKey: secret("PROMPT_API_KEY"),
  maybe: env.optional("PROMPT_MAYBE"),
  limit: env.integer("PROMPT_LIMIT", { default: 3 }),
});
const ENV: NodeJS.ProcessEnv = {
  PROMPT_COMPANY: "Acme",
  PROMPT_TONE: "dry",
  PROMPT_API_KEY: SECRET_VALUE,
};

const price = testConfig.agents.alpha.price;

interface Levels {
  readonly application?: Readonly<Record<string, unknown>>;
  readonly workflow?: Readonly<Record<string, unknown>>;
  readonly agent?: Readonly<Record<string, unknown>>;
  readonly prompt?: string;
  readonly guardrail?: Readonly<Record<string, unknown>>;
}

/** One flow whose agent's prompt is `prompt`; the variables sit at the levels given. */
function applicationWith(levels: Levels): Class {
  @Agent({
    name: "scout-agent",
    description: "Scouts",
    model: "test/alpha",
    price,
    prompt: inline(levels.prompt ?? "You work for {{company}}."),
    promptVariables: levels.agent as never,
  })
  class Scout {}

  @Router({
    name: "main-router",
    description: "Routes",
    decidedBy: DecidedBy.Model,
    prompt: inline("Pick."),
    model: "typesafe/jev-1.13",
    input: { message: WorkflowStartTextDto },
    maxVisits: 4,
    routes: [
      { prompt: "Scout", target: Scout },
      { prompt: "Stop", target: NoAnswer },
    ],
  })
  class Main {}

  @Workflow({
    name: "variables-workflow",
    version: "1.0.0",
    defaults: testDefaults,
    flow: [
      onStart(TestChat)
        .toRouter(Main)
        .chooseOne(route(Scout).toFinish(TestAnswer), route(NoAnswer)),
    ],
    promptVariables: levels.workflow as never,
  })
  class Variables {}

  @Application({
    name: "variables-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [Variables],
    budgets: TEST_BUDGETS,
    promptVariables: levels.application as never,
  })
  class VariablesApplication {}

  return VariablesApplication;
}

async function promptOf(levels: Levels, processEnv: NodeJS.ProcessEnv = ENV): Promise<string> {
  const assembled = await applicationOf(applicationWith(levels), { processEnv });
  const prompt = assembled.workflows[0]?.prompts["scout-agent"];
  if (typeof prompt !== "string") throw new Error("no prompt");
  return prompt;
}

async function problemsOf(levels: Levels, processEnv: NodeJS.ProcessEnv = ENV): Promise<string[]> {
  const error: unknown = await applicationOf(applicationWith(levels), { processEnv }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof PromptError)) throw new Error(`expected a PromptError: ${String(error)}`);
  return error.problems.map((problem) => `[${problem.code}] ${problem.message}`);
}

describe("#1347c: the cascade", () => {
  it("an application's variable reaches a prompt; the workflow's wins over it, the component's over both", async () => {
    expect(await promptOf({ application: { company: "App Inc" } })).toBe("You work for App Inc.");
    expect(
      await promptOf({ application: { company: "App Inc" }, workflow: { company: "Flow Inc" } }),
    ).toBe("You work for Flow Inc.");
    expect(
      await promptOf({
        application: { company: "App Inc" },
        workflow: { company: "Flow Inc" },
        agent: { company: "Agent Inc" },
      }),
    ).toBe("You work for Agent Inc.");
  });

  it("a defineEnv reference is read from the process environment at assembly, at every level", async () => {
    expect(await promptOf({ application: { company: appEnv.company } })).toBe("You work for Acme.");
    expect(
      await promptOf({
        prompt: "{{company}}, {{tone}}",
        application: { company: "x" },
        workflow: { company: appEnv.company },
        agent: { tone: appEnv.tone },
      }),
    ).toBe("Acme, dry");
  });

  it("an unset variable fails assembly naming the variable, never a value", async () => {
    const problems = await problemsOf({ application: { company: appEnv.company } }, {});

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("[prompt.invalid-variable]");
    expect(problems[0]).toContain("PROMPT_COMPANY is not set");
  });

  it("a reference that is no text (an optional, a number) is a problem", async () => {
    const problems = await problemsOf({
      workflow: { company: appEnv.maybe, limit: appEnv.limit },
    });

    expect(problems.filter((line) => line.startsWith("[prompt.invalid-variable]"))).toHaveLength(2);
  });
});

describe("#1347c: a secret never reaches a prompt", () => {
  it.each(["application", "workflow", "agent"] as const)(
    "a SecretRef in the %s's promptVariables fails closed",
    async (level) => {
      const problems = await problemsOf({ [level]: { company: appEnv.apiKey } });

      expect(problems.some((line) => line.startsWith("[prompt.secret-in-instructions]"))).toBe(
        true,
      );
      expect(problems.join("\n")).not.toContain(SECRET_VALUE);
    },
  );

  it("an optional secret and a resolved Secret fail the same way", async () => {
    const optional = await problemsOf({ workflow: { company: secret.optional("PROMPT_API_KEY") } });
    const plain = await problemsOf({ workflow: { company: secret("PROMPT_API_KEY") } });

    for (const problems of [optional, plain]) {
      expect(problems.map((line) => line.split("]")[0])).toContain(
        "[prompt.secret-in-instructions",
      );
    }
  });

  it("the secret's value is in no error, whichever level, and the text is not rendered", async () => {
    const error: unknown = await applicationOf(
      applicationWith({ workflow: { company: appEnv.apiKey } }),
      { processEnv: ENV },
    ).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(PromptError);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SECRET_VALUE);
    expect(String(error)).not.toContain(SECRET_VALUE);
  });

  it("the loader renders nothing while a variable has a problem", async () => {
    const loader = new PromptLoader({ company: appEnv.apiKey }, { env: ENV });

    const text = await loader.load({
      label: '@Agent "a"',
      options: { prompt: inline("Hi {{company}}") },
      source: undefined,
    });

    expect(text).toBe("Hi {{company}}");
    expect(() => {
      loader.throwIfAny();
    }).toThrow(PromptError);
  });
});

describe("#1347c: [prompt.unused-variable]", () => {
  it("a component's key no {{key}} uses is a problem naming the key", async () => {
    expect(await problemsOf({ agent: { company: "x", spare: "y" } })).toEqual([
      '[prompt.unused-variable] @Agent "scout-agent": promptVariables.spare is not used — no {{spare}} in its prompt',
    ]);
  });

  it("workflow and application keys may serve other prompts: never unused", async () => {
    expect(
      await promptOf({ application: { spare: "a" }, workflow: { company: "b", other: "c" } }),
    ).toBe("You work for b.");
  });

  it("a key used only in a file is used", async () => {
    const dir = await mkdtemp(join(tmpdir(), "prompt-variables-"));
    await writeFile(join(dir, "p.md"), "Hello {{tone}}\n");
    const loader = new PromptLoader({}, { env: ENV });

    await loader.load({
      label: '@Agent "a"',
      options: { prompt: [join(dir, "p.md")] },
      source: join(dir, "a.agent.ts"),
      variables: { tone: "dry" },
    });

    expect(() => {
      loader.throwIfAny();
    }).not.toThrow();
  });

  it("a router's key used by one route only is used", async () => {
    const loader = new PromptLoader();
    const variables = { board: "x" };
    const owner = { label: '@Router "r"', source: undefined, variables };

    await loader.load({ ...owner, options: { prompt: inline("Pick.") } });
    await loader.load({
      ...owner,
      label: '@Router "r" route "a"',
      variablesLabel: '@Router "r"',
      options: { prompt: inline("Scout {{board}}") },
    });

    expect(() => {
      loader.throwIfAny();
    }).not.toThrow();
  });

  it("a guardrail's own variables count the same", async () => {
    @InputGuardrail({
      name: "tone-guardrail",
      prompt: inline("Is it rude to {{company}}?"),
      promptVariables: { company: "Acme", spare: "x" },
      threshold: 0.5,
      refusal: "No.",
      model: "typesafe/jev-1.13",
    })
    class Tone {}
    const loader = new PromptLoader();

    const [loaded] = await loadedGuardrailOf(Tone, undefined, loader);

    expect(loaded).toMatchObject({ prompt: "Is it rude to Acme?" });
    expect(() => {
      loader.throwIfAny();
    }).toThrow(/promptVariables\.spare is not used/);
  });
});

describe("#1347c: a model reply interpreter's instructions are in the prompt version", () => {
  const interpreter = (instructions: string, model?: string) =>
    ({
      channel: "ask-channel",
      name: "ask-interpreter",
      model,
      instructions,
    }) as unknown as AssembledReplyInterpreter;
  const versionsOf = async (interpreters?: readonly AssembledReplyInterpreter[]) =>
    executionVersions({ ...(await fakeDeps({})), replyInterpreters: interpreters });

  it("changing its text changes promptVersion and configHash", async () => {
    const one = await versionsOf([interpreter("Read the reply.", "test/alpha")]);
    const two = await versionsOf([interpreter("Read the reply twice.", "test/alpha")]);

    expect(two.promptVersion).not.toBe(one.promptVersion);
    expect(two.configHash).not.toBe(one.configHash);
  });

  it("a workflow with none, or only code ones, keeps its hash", async () => {
    const none = await versionsOf();
    const code = await versionsOf([interpreter("", undefined)]);

    expect(code.promptVersion).toBe(none.promptVersion);
    expect(code.configHash).toBe(none.configHash);
  });
});
