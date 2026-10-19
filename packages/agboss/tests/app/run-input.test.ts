import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import { workflowOf } from "../../src/components/assemble.js";
import { PromptError } from "../../src/components/prompt-problems.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { execute, answerOf } from "../helpers/flow.js";
import {
  Apply,
  JobSearch,
  Lookup,
  resetSeen,
  SearchStart,
  Searcher,
  seen,
  ShortlistDto,
  TypoSearch,
  JobSearchApplication,
} from "./fixtures/run-input.workflow.js";

const approve = { approved: true };
const test = testWith(JobSearchApplication);

beforeEach(resetSeen);

describe("#236: the whole validated start input stays on the run", () => {
  test("AC1: a start field reaches code through its input, from the path scope", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Searcher).thenReturn(
      callTool(Lookup, { text: "rust" }),
      replyWith(ShortlistDto, { text: "2 jobs." }),
    );

    const done = await execute(app, SearchStart, { text: "rust jobs", limit: 5 });

    expect(done.status).toBe(ExecutionStatus.Finished);
    expect(seen.tools).toHaveLength(1);
    expect(seen.actions).toEqual([{ text: "rust jobs", limit: 5 }]);
  });

  test("AC2: the start input reaches the agent in its input message", async ({ app, mockLlm }) => {
    mockLlm(Searcher).thenReturn(replyWith(ShortlistDto, { text: "3 jobs." }));

    await execute(app, SearchStart, { text: "rust jobs", limit: 3 });

    expect(mockLlm(Searcher).onlyRequest.input).toContain('"limit": 3');
  });

  test("AC3: the input survives a pause and its resume — tools and input message", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(Searcher).thenReturn(
      callTool(Apply, { text: "job 1" }),
      replyWith(ShortlistDto, { text: "Applied." }),
    );

    const paused = await execute(app, SearchStart, { text: "apply", limit: 7 });
    const done = await app.resume(answerOf(paused, approve));

    expect(paused.status).toBe(ExecutionStatus.Paused);
    expect(done.status).toBe(ExecutionStatus.Finished);
    expect(seen.tools).toHaveLength(1);
    expect(seen.actions).toEqual([{ text: "apply", limit: 7 }]);
    expect(mockLlm(Searcher).requests.map((request) => request.input)).toEqual([
      expect.stringContaining('"limit": 7') as string,
      expect.stringContaining('"limit": 7') as string,
    ]);
  });

  test("AC3: the input survives a restart of the app while the run waits", async ({
    app,
    recoverApp,
    mockLlm,
  }) => {
    mockLlm(Searcher).thenReturn(
      callTool(Apply, { text: "job 1" }),
      replyWith(ShortlistDto, { text: "Applied." }),
    );

    const paused = await execute(app, SearchStart, { text: "apply", limit: 2 });
    const restarted = await recoverApp();
    await restarted.resume(answerOf(paused, approve));

    expect(seen.tools).toHaveLength(1);
    expect(seen.actions).toEqual([{ text: "apply", limit: 2 }]);
  });
});

describe("#270 Q51: instructions are static", () => {
  it("{{input.<field>}} in an agent's instructions fails assembly, naming the prompt", async () => {
    const error = await workflowOf(TypoSearch).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PromptError);
    expect((error as PromptError).problems).toEqual([
      {
        code: "prompt.input-in-instructions",
        message: expect.stringMatching(
          /typo-agent.*\{\{input\.limit\}\} — instructions are static/,
        ) as string,
      },
    ]);
  });

  it("a workflow without input variables assembles", async () => {
    await expect(workflowOf(JobSearch)).resolves.toBeDefined();
  });
});
