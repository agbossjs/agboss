/** #118 AC5: tools and MCP servers on DTOs — validation at the edge, DTO-shaped data inside. */
import { describe, expect, it } from "vitest";
import { Agent, Workflow, Tool, type ToolHandler } from "../../src/index.js";
import { McpServer, McpServerClient } from "../../src/mcp/index.js";
import { mcpServerStub } from "../../src/testing/index.js";
import { toolOf, workflowOf } from "../../src/testing/index.js";
import { DtoError, Integer, ListOf, Nested, Text, Url } from "../../src/dto/index.js";
import { toolDefinitionOf, type ToolCallContext } from "../../src/tools/index.js";
import { testConfig, testDefaults } from "../helpers.js";
import { starOf } from "../fixtures/test-flow/star.js";

const ctx: ToolCallContext = { signal: new AbortController().signal, reportCost: () => undefined };

class Link {
  @Url({ prompt: "the job's link" })
  url!: string;
}

class JobPick {
  @ListOf(Link, { prompt: "the jobs to keep", minItems: 1 })
  jobs!: Link[];

  @Integer({ prompt: "how many at most", min: 1, default: 2 })
  count!: number;
}

class JobKept {
  @ListOf(Text)
  kept!: string[];
}

@Tool({ name: "keep-jobs-tool", description: "Keeps the jobs.", input: JobPick, output: JobKept })
class KeepJobs implements ToolHandler<JobPick, JobKept> {
  readonly seen: JobPick[] = [];
  run(pick: JobPick): Promise<JobKept> {
    this.seen.push(pick);
    return Promise.resolve({ kept: pick.jobs.slice(0, pick.count).map((job) => job.url) });
  }
}

describe("tools on DTOs (#118)", () => {
  it("AC5: valid model arguments → run gets the DTO-shaped object (defaults filled)", async () => {
    const keep = new KeepJobs();
    const result = await toolOf(keep).invoke({ jobs: [{ url: "https://a.io/1" }] }, ctx);

    expect(keep.seen).toEqual([{ jobs: [{ url: "https://a.io/1" }], count: 2 }]);
    expect(result).toEqual({ kind: "ok", value: { kept: ["https://a.io/1"] } });
  });

  it("AC5: invalid model arguments → the tool-error result with the indexed path; run is not called", async () => {
    const keep = new KeepJobs();
    const jobs = [{ url: "https://a.io/1" }, { url: "https://a.io/2" }, { url: "nope" }];

    expect(await toolOf(keep).invoke({ jobs }, ctx)).toEqual({
      kind: "error",
      message: expect.stringMatching(/^invalid input: jobs\[2\]\.url: /) as unknown,
    });
    expect(keep.seen).toEqual([]);
  });

  it("AC5: the model sees the DTO's JSON Schema — prompts as descriptions, no $schema", () => {
    const exposed = toolDefinitionOf(toolOf(new KeepJobs())).function.parameters;

    expect(exposed).toMatchObject({
      type: "object",
      properties: {
        jobs: { description: "the jobs to keep", minItems: 1 },
        count: { description: "how many at most", default: 2 },
      },
      required: ["jobs"],
    });
    expect(exposed).not.toHaveProperty("$schema");
  });

  it("AC5: a tool whose DTO has an undecorated field stops the workflow's assembly", async () => {
    class Loose {
      @Text() query!: string;
      extra!: string;
    }
    @Tool({ name: "loose-tool", description: "d", input: Loose, output: JobKept })
    class LooseTool implements ToolHandler<Loose, JobKept> {
      run(): Promise<JobKept> {
        return Promise.resolve({ kept: [] });
      }
    }
    @Agent({
      name: "a-agent",
      description: "d",
      model: "test/alpha",
      price: testConfig.agents.alpha.price,
      tools: [LooseTool],
      promptUrls: ["./fixture/greeter.prompt.md"],
    })
    class LooseAgent {}
    @Workflow({
      name: "loose-workflow",
      version: "1",
      defaults: testDefaults,
      flow: starOf(LooseAgent),
    })
    class LooseWorkflow {}

    await expect(workflowOf(LooseWorkflow)).rejects.toThrow(DtoError);
    await expect(workflowOf(LooseWorkflow)).rejects.toThrow(
      /dto\.undecorated-field: Loose: .*extra/,
    );
  });
});

class Ticket {
  @Text() id!: string;
}
class TicketState {
  @Nested(Ticket) ticket!: Ticket;
  @Text() state!: string;
}
const deskTools = { status: { input: Ticket, output: TicketState } };

@McpServer({ name: "desk", transport: "stdio", command: "desk", tools: deskTools })
class DeskServer extends McpServerClient<typeof deskTools> {}

describe("MCP servers on DTOs (#118)", () => {
  it("AC5: call is typed by the DTOs and returns what the server answered", async () => {
    const desk = mcpServerStub(DeskServer, {
      status: ({ id }) => Promise.resolve({ ticket: { id }, state: "open" }),
    });

    expect(await desk.call("status", { id: "T-1" })).toEqual({
      ticket: { id: "T-1" },
      state: "open",
    });
  });
});
