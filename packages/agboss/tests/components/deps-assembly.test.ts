/**
 * #183 AC2/AC3: DI holes are assembly errors — a missing provider of any component kind, an
 * undecorated provider class, a tool shadowing a RAG search tool; a raw `useValue` literal is a
 * compile error.
 */
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/application/create-app.js";
import {
  Channel,
  InputGuardrail,
  Rag,
  type GuardrailRefusal,
} from "../../src/components/decorators.js";
import { ChannelOutcome } from "../../src/channels/channel-outcome.js";
import { PiiAction, PiiPolicy, type PiiMatch, type PiiPolicyHandler } from "../../src/pii/index.js";
import { Judge, JudgeVerdict, type JudgeHandler } from "../../src/components/judge-decorators.js";
import { type Provider } from "../../src/components/injection.js";
import {
  Action,
  Agent,
  InjectionToken,
  provide,
  RagMode,
  Tool,
  type ToolHandler,
} from "../../src/index.js";
import { PlainTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { start } from "../helpers/flow.js";
import { Text } from "../../src/dto/index.js";
import type { RagRetrieval } from "../../src/rag/types.js";
import {
  Chat,
  Done,
  offline,
  Plain as PlainAgent,
  applicationWith,
} from "./fixture/deps-contract.workflow.js";

const MISSING = new InjectionToken<string>("MISSING");
const notRegistered = (consumer: string): string =>
  `${consumer}: "MISSING" is not registered in @Workflow({ providers })`;

@InputGuardrail({
  name: "needs-guardrail",
  description: "Needs a missing value",
  prompt: "Is it bad?",
  model: "typesafe/jev-1.13",
  threshold: 0.9,
  deps: [MISSING],
})
class NeedsGuardrail implements GuardrailRefusal {
  constructor(readonly value: string) {}
  refusal(): string {
    return this.value;
  }
}

@PiiPolicy({ name: "needs-pii-policy", action: PiiAction.replaceWithKind(), deps: [MISSING] })
class NeedsPolicy implements PiiPolicyHandler {
  constructor(readonly value: string) {}
  findMatches(): readonly PiiMatch[] {
    return [];
  }
}

@Action({ name: "needs-action", description: "Needs", deps: [MISSING] })
class NeedsAction {
  constructor(readonly value: string) {}
  execute(): Promise<void> {
    return Promise.resolve();
  }
}

@Channel({ name: "needs-channel", deps: [MISSING] })
class NeedsChannel {
  constructor(readonly value: string) {}
  send(): Promise<ChannelOutcome<NeedsChannel>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

class Approved {
  @Text() id!: string;
}

/** A tool approved through the channel: the channel is found from it (#267). */
@Tool({
  name: "approved-tool",
  description: "d",
  input: Approved,
  output: Approved,
  channel: NeedsChannel,
})
class ApprovedTool implements ToolHandler<Approved, Approved> {
  run(input: Approved): Promise<Approved> {
    return Promise.resolve(input);
  }
}

@Agent({ name: "approving-agent", description: "d", model: "test/a", tools: [ApprovedTool] })
class ApprovingAgent {}

@Judge({ name: "needs-judge", model: "test/j", reply: PlainTextDto, deps: [MISSING] })
class NeedsJudge implements JudgeHandler<PlainTextDto> {
  constructor(readonly value: string) {}
  judge(): Promise<JudgeVerdict> {
    return Promise.resolve(JudgeVerdict.passed());
  }
}

@Agent({ name: "guarded-agent", description: "d", model: "test/g", piiPolicies: [NeedsPolicy] })
class PolicedAgent {}

@Agent({ name: "judged-agent", description: "d", model: "test/j", judges: [NeedsJudge] })
class JudgedAgent {}

const assemble = (application: Parameters<typeof createApp>[0]) =>
  createApp(application, offline());

describe("#183 AC2: a missing provider fails at assembly, naming the consumer and the token", () => {
  it.each([
    [
      "a workflow guardrail",
      applicationWith("g-workflow", { guardrails: [NeedsGuardrail] }),
      "NeedsGuardrail",
    ],
    ["an agent's PII policy", applicationWith("p-workflow", {}, PolicedAgent), "NeedsPolicy"],
    ["a tool's channel", applicationWith("c-workflow", {}, ApprovingAgent), "NeedsChannel"],
    ["an agent's judge", applicationWith("j-workflow", {}, JudgedAgent), "NeedsJudge"],
    [
      "a workflow action",
      applicationWith("a-workflow", {
        flow: [
          start(Chat)
            .returns(WorkflowStartTextDto)
            .toAction(NeedsAction)
            .toAgent(PlainAgent)
            .toFinish(Done),
        ],
      }),
      "NeedsAction",
    ],
  ])("%s", async (_kind, workflow, consumer) => {
    await expect(assemble(workflow)).rejects.toThrow(notRegistered(consumer));
  });
});

class Topic {
  @Text({ prompt: "the topic" })
  topic!: string;
}

@Rag({ name: "manuals", description: "Manuals", topK: 1 })
class Manuals {
  retrieve(): Promise<RagRetrieval> {
    return Promise.resolve({ results: [] });
  }
}

@Tool({ name: "search-manuals-tool", description: "Shadows", input: Topic, output: Topic })
class ShadowSearch implements ToolHandler<Topic, Topic> {
  run(input: Topic): Promise<Topic> {
    return Promise.resolve(input);
  }
}

@Agent({
  name: "reader-agent",
  description: "d",
  model: "test/r",
  tools: [ShadowSearch],
  rag: [{ use: Manuals, mode: RagMode.Tool }],
})
class Reader {}

describe("#183 AC3: tool names are unique over the exposed names", () => {
  it("a tool named like a RAG search tool (search-<rag>-tool) fails at assembly", async () => {
    await expect(assemble(applicationWith("shadow-workflow", {}, Reader))).rejects.toThrow(
      '[tool.duplicate-name] Duplicate tool name "search-manuals-tool" found in classes ShadowSearch and Manuals',
    );
  });
});

class Plain {
  readonly label = "plain";
}

class Defaulted {
  constructor(readonly label = "defaulted") {}
}

describe("#183: providers are decorated classes or provide() values", () => {
  it.each([
    ["a zero-argument class", Plain],
    ["a class whose constructor has only default parameters", Defaulted],
  ])("%s in providers fails at assembly", async (_kind, cls) => {
    await expect(
      assemble(applicationWith("undecorated-workflow", { providers: [cls] })),
    ).rejects.toThrow(
      `[di.undecorated-provider] @Workflow "undecorated-workflow": ${cls.name} in providers has no decorator`,
    );
  });

  it("a raw { provide, useValue } literal is a compile error; provide() builds the value", () => {
    // @ts-expect-error — a ValueProvider is built only by provide()
    const raw: Provider = { provide: MISSING, useValue: "x" };
    const built: Provider = provide(MISSING, "x");
    expect("provide" in built ? built.useValue : undefined).toBe("x");
    expect("useValue" in raw).toBe(true);
  });

  it("@Action deps are checked against the constructor by the compiler", () => {
    // @ts-expect-error — the constructor takes a string; MISSING gives a string, Plain an instance
    @Action({ name: "mismatch-action", description: "Mismatch", deps: [Plain] })
    class Mismatch {
      constructor(readonly value: string) {}
      execute(): Promise<void> {
        return Promise.resolve();
      }
    }
    expect(Mismatch.name).toBe("Mismatch");
  });
});
