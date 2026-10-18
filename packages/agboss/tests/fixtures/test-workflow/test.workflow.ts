import {
  Agent,
  DecidedBy,
  MODEL_MAX,
  Router,
  Tool,
  Workflow,
  type ToolHandler,
} from "../../../src/index.js";
import { Reasoning, ReasoningEffort } from "../../../src/models/index.js";
import { DateTime, TimeZone, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { route, start } from "../../helpers/flow.js";
import { NoAnswer, TestAnswer, TestChat } from "../test-flow/test.flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";

const price = { inputPerMTok: 0.5, outputPerMTok: 3, cacheReadPerMTok: 0.1 };
class ClockQuery {
  @TimeZone({ prompt: "IANA time zone, e.g. Asia/Tokyo", default: "UTC" })
  timeZone!: string;
}

class ClockTime {
  @DateTime()
  iso!: string;

  @TimeZone()
  timeZone!: string;
}

/** A test tool: the time, from an injected clock. */
@Tool({
  name: "current_time",
  description: "Current date and time in an IANA time zone (default UTC).",
  input: ClockQuery,
  output: ClockTime,
})
export class Clock implements ToolHandler<ClockQuery, ClockTime> {
  constructor(private readonly now: () => Date = () => new Date("2026-09-25T10:00:00Z")) {}
  run({ timeZone }: ClockQuery): Promise<ClockTime> {
    // an unknown time zone throws — the model sees it as a tool error
    new Intl.DateTimeFormat("en-GB", { timeZone })
      .format(this.now());
    return Promise.resolve({
      iso: this.now()
        .toISOString(),
      timeZone,
    });
  }
}

@Agent({
  name: "researcher-agent",
  description: "Finds, explains and summarizes facts",
  model: "test/researcher",
  price,
  tools: [Clock],
  promptUrls: ["./researcher.prompt.md"],
})
export class Researcher {}

@Agent({
  name: "coder-agent",
  description: "Writes, reviews and explains code",
  model: "test/coder",
  price,
  reasoning: Reasoning.on({ effort: ReasoningEffort.Low }),
  promptUrls: ["./coder.prompt.md"],
})
export class Coder {}

@Router({
  name: "main-router",
  description: "Sends the message to an agent, or ends",
  decidedBy: DecidedBy.Model,
  prompt: "Pick who handles the message.",
  model: "typesafe/jev-1.13",
  input: { message: WorkflowStartTextDto },
  maxVisits: 10,
  routes: [
    { prompt: "Stop without an answer: nothing to do", target: NoAnswer },
    { prompt: "Researcher work", target: Researcher },
    { prompt: "Coder work", target: Coder },
  ],
})
export class MainRouter {}

/** The framework's own test workflow (the framework ships no agents). */
@Workflow({
  name: "test-workflow",
  version: "1.0.0",
  defaults: {
    models: {
      temperature: 0,
      maxTokens: MODEL_MAX,
      reasoning: Reasoning.modelDecides(),
      cache: true,
    },
    router: { model: "typesafe/jev-1.13" },
    guardrail: { model: "typesafe/jev-1.13" },
    tools: { maxToolCalls: 8 },
    history: { limit: 5 },
  },
  guards: {
    input: { prompt_injection: { threshold: 0.7, refusal: "I can't help with that request." } },
    output: { pii: { threshold: 0.7, refusal: "Withheld." } },
  },
  flow: [
    start(TestChat)
      .returns(WorkflowStartTextDto)
      .toRouter(MainRouter)
      .chooseOne(
        route(NoAnswer),
        route(Researcher)
          .toFinish(TestAnswer),
        route(Coder)
          .toFinish(TestAnswer),
      ),
  ],
})
export class TestWorkflow {}

@Application({
  name: "test-application",
  version: "1.0.0",
  workflows: [TestWorkflow],
  budgets: TEST_BUDGETS,
})
export class TestApplication {}
