/**
 * #120 PR 3 — compaction (AC10, AC4): `@Compaction` and its strategies, `uncompactedTurns` (the
 * lowest set value; a compaction summarises what is older than the smallest window among its
 * readers), the "shorter" retry and `CompactionError`, and the compaction's model behind the PII
 * boundary (S84 i). Models answer by script; nothing reaches a network.
 */
import { describe, expect, it } from "vitest";
import {
  Agent,
  Compaction,
  CompactionError,
  CompactionStrategy,
  DecidedBy,
  Injectable,
  Router,
  TurnLimit,
  Workflow,
} from "../../src/index.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import type { Class } from "../../src/components/injection.js";
import { applicationOf } from "../../src/application/assemble.js";
import { compactionViolations } from "../../src/compaction/checks.js";
import { effectiveCompactions } from "../../src/compaction/levels.js";
import { memoryPlanOf, readerOf, windowOfCompaction } from "../../src/compaction/plan.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { SHORTER_SUMMARY_REQUEST } from "../../src/prompts/compaction.js";
import {
  failWith,
  ModelFailure,
  replyWith,
  routeTo,
  testWith,
  type ModelRequest,
  type ModelScript,
} from "../../src/testing/index.js";
import type { TestApp } from "../../src/testing/test-app.js";
import type { ExecutionOutput } from "../../src/app/types.js";
import { usd } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute, start } from "../helpers/flow.js";
import {
  AnswerAgent,
  ArchiveAgent,
  ContactAgent,
  DeskAnswer,
  DeskStart,
  HelpDeskApplication,
  HelpRouter,
  NoSummariesCompaction,
  NoteAgent,
  NoteCompaction,
  NotesDeskApplication,
  QueueCompaction,
  WindowDeskApplication,
  WindowRouter,
} from "./compaction.fixture.js";

const JEV = "typesafe/jev-1.13";

/** A request's text: what a compaction or an agent read, as one string. */
const textOf = (request: ModelRequest): string =>
  request.kind === "chat"
    ? request.messages
        .filter((line) => line.role === "human")
        .map((line) => (typeof line.text === "string" ? line.text : JSON.stringify(line.text)))
        .join("\n\n")
    : typeof request.input === "string"
      ? request.input
      : JSON.stringify(request.input);

/** The earlier turns (their start lines, #272 S8) a model saw in a request. */
const turnsSeen = (request: ModelRequest | undefined): string[] =>
  request === undefined
    ? []
    : [...textOf(request).matchAll(/^start desk-workflow-start: \{"text":"(.+?)"\}$/gmu)].map(
        (match) => match[1] ?? "",
      );

/** `count` turns on one thread — t1, t2, … unless given; every result, in order. */
async function conversation(
  app: TestApp,
  count: number,
  textOfTurn: (turn: number) => string = (turn) => `t${String(turn)}`,
): Promise<ExecutionOutput[]> {
  const results = [await execute(app, DeskStart, { text: textOfTurn(1) })];
  for (let turn = 2; turn <= count; turn++) {
    const threadId = results[0]?.threadId;
    results.push(await execute(app, DeskStart, { text: textOfTurn(turn) }, { threadId }));
  }
  return results;
}

/** `count` turns on one thread; the last result. */
async function converse(
  app: TestApp,
  count: number,
  textOfTurn?: (turn: number) => string,
): Promise<ExecutionOutput> {
  const results = await conversation(app, count, textOfTurn);
  const last = results.at(-1);
  if (last === undefined) throw new Error("a conversation has a turn");
  return last;
}

/** The help desk's router sends every message to the answer agent, which says "ok". */
function answerOk(mockLlm: (target: Class) => ModelScript): void {
  mockLlm(HelpRouter).thenReturnAlways(routeTo(AnswerAgent));
  mockLlm(AnswerAgent).thenReturnAlways(replyWith("ok"));
}

const violationsOf = async (application: object): Promise<string[]> => {
  try {
    await applicationOf(application as never);
    return [];
  } catch (error) {
    if (!(error instanceof GraphRuleError)) throw error;
    return error.violations.map((found) => `[${found.code}] ${found.message}`);
  }
};

@Compaction({
  name: "misnamed",
  description: "A name without its kind",
  model: "test/compactor",
  strategy: CompactionStrategy.SummaryQueue,
  turnsBetweenCompactions: 0,
  summaryQueueLength: 0,
  summaryMaxTokens: 1.5,
})
class MisnamedCompaction {}

@Compaction({
  name: "decision-compaction",
  description: "On a decision model",
  model: JEV,
  strategy: CompactionStrategy.SingleSummary,
  turnsBetweenCompactions: 1,
  summaryMaxTokens: 100,
})
class DecisionCompaction {}

// @ts-expect-error -- AC10: a strategy that writes summaries needs a model
@Compaction({
  name: "modelless-compaction",
  description: "No model",
  strategy: CompactionStrategy.SummaryQueue,
  turnsBetweenCompactions: 1,
  summaryQueueLength: 1,
  summaryMaxTokens: 100,
})
class ModellessCompaction {}

// @ts-expect-error -- AC10: `None` takes no parameters
@Compaction({
  name: "busy-none-compaction",
  description: "None with a model",
  strategy: CompactionStrategy.None,
  model: "test/compactor",
})
class BusyNoneCompaction {}

// @ts-expect-error -- AC10: a single summary has no queue
@Compaction({
  name: "queued-single-compaction",
  description: "A single summary with a queue length",
  model: "test/compactor",
  strategy: CompactionStrategy.SingleSummary,
  turnsBetweenCompactions: 1,
  summaryQueueLength: 3,
  summaryMaxTokens: 100,
})
class QueuedSingleCompaction {}

@Injectable()
class NotACompaction {}

@Agent({
  name: "odd-agent",
  description: "Settings no compaction takes",
  prompt: "Answer.",
  model: "test/odd",
  compaction: NotACompaction,
  uncompactedTurns: -1,
})
class OddAgent {}

@Workflow({
  name: "odd-workflow",
  version: "1.0.0",
  flow: [start(DeskStart).returns(WorkflowStartTextDto).toAgent(OddAgent).toFinish(DeskAnswer)],
  compaction: MisnamedCompaction,
  uncompactedTurns: 2.5,
})
class OddWorkflow {}

@Application({
  name: "odd-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OddWorkflow],
  budgets: TEST_BUDGETS,
})
class OddApplication {}

describe("#120 AC10: @Compaction at assembly", () => {
  it("the decorator's types: a model for SummaryQueue and SingleSummary, nothing for None", () => {
    // the @ts-expect-error lines above are the check; the classes still carry their options
    expect([ModellessCompaction, BusyNoneCompaction, QueuedSingleCompaction]).toHaveLength(3);
    Router({
      name: "code-window-router",
      description: "A code router with a window",
      decidedBy: DecidedBy.Code,
      input: { message: WorkflowStartTextDto },
      routes: [{ target: DeskAnswer }],
      // @ts-expect-error -- a code router reads no thread memory: no compaction, no window
      uncompactedTurns: 2,
    });
  });

  it("name ends with -compaction; counts are whole numbers from 1; a summary needs a chat model", () => {
    expect(compactionViolations([MisnamedCompaction, DecisionCompaction, QueueCompaction])).toEqual(
      [
        expect.objectContaining({ code: "name.kind-suffix" }),
        expect.objectContaining({
          code: "compaction.invalid-setting",
          message: "misnamed: turnsBetweenCompactions 0 — a whole number from 1",
        }),
        expect.objectContaining({
          code: "compaction.invalid-setting",
          message: "misnamed: summaryMaxTokens 1.5 — a whole number from 1, or MODEL_MAX",
        }),
        expect.objectContaining({
          code: "compaction.invalid-setting",
          message: "misnamed: summaryQueueLength 0 — a whole number from 1",
        }),
        expect.objectContaining({ code: "compaction.decision-model" }),
      ],
    );
  });

  it("every rule broken fails the application's assembly, all at once", async () => {
    const violations = await violationsOf(OddApplication);

    expect(violations).toEqual(
      expect.arrayContaining([
        "[compaction.uncompacted-turns-invalid] odd-workflow: uncompactedTurns 2.5 — a whole number from 0, or TurnLimit.ALL",
        "[compaction.not-a-compaction] odd-agent: compaction is NotACompaction, which is not a @Compaction class",
        "[compaction.uncompacted-turns-invalid] odd-agent: uncompactedTurns -1 — a whole number from 0, or TurnLimit.ALL",
      ]),
    );
  });
});

describe("#120 AC4: one setting on every level — the lowest set value wins", () => {
  it("compaction: an element's own over the workflow's over the application's", () => {
    const effective = effectiveCompactions({
      application: { compaction: QueueCompaction },
      workflow: { name: "w-workflow" },
      elements: [
        { name: "answer-agent" },
        { name: "note-agent", compaction: NoteCompaction },
        { name: "help-router" },
      ],
    });

    expect([...effective.byElement]).toEqual([
      ["answer-agent", QueueCompaction],
      ["note-agent", NoteCompaction],
      ["help-router", QueueCompaction],
    ]);
    expect(effective.classes).toEqual([QueueCompaction, NoteCompaction]);
    expect(
      effectiveCompactions({
        application: { compaction: QueueCompaction },
        workflow: { name: "w-workflow", compaction: NoSummariesCompaction },
        elements: [{ name: "answer-agent" }],
      }).byElement.get("answer-agent"),
    ).toBe(NoSummariesCompaction);
  });

  it("uncompactedTurns: the router's own (1), the agents' the application's (3)", async () => {
    const [workflow] = (await applicationOf(HelpDeskApplication)).workflows;
    if (workflow === undefined) throw new Error("the application has a workflow");
    const plan = memoryPlanOf(workflow.config, workflow.compactions);

    expect(readerOf(plan, "help-router").window).toBe(1);
    expect(readerOf(plan, "answer-agent").window).toBe(3);
    expect(readerOf(plan, "contact-agent").compaction?.name).toBe("queue-compaction");
  });

  it("a compaction's window is the smallest among its readers; ALL only when every reader sees all", async () => {
    const [workflow] = (await applicationOf(HelpDeskApplication)).workflows;
    if (workflow === undefined) throw new Error("the application has a workflow");

    expect(memoryPlanOf(workflow.config, workflow.compactions).compactions).toEqual([
      expect.objectContaining({ name: "queue-compaction", window: 1, summaryQueueLength: 2 }),
    ]);
    expect(windowOfCompaction([TurnLimit.ALL, 4, 2])).toBe(2);
    expect(windowOfCompaction([TurnLimit.ALL, TurnLimit.ALL])).toBe(TurnLimit.ALL);
  });
});

describe("#120 AC10: a queue summarises what is older than the smallest window", () => {
  const test = testWith(HelpDeskApplication);

  test("after turn 3 the two turns older than the router's window become one summary", async ({
    app,
    mockLlm,
  }) => {
    answerOk(mockLlm);
    mockLlm(QueueCompaction).thenReturn(replyWith("t1 and t2 were asked", { cost: usd(0.002) }));

    const [first, second, third] = await conversation(app, 3);

    expect(first?.compacted).toBeUndefined();
    expect(second?.compacted).toBeUndefined();
    expect(third?.compacted).toEqual([
      {
        compaction: "queue-compaction",
        fromTurn: 1,
        toTurn: 2,
        summaries: 1,
        summaryQueueLength: 2,
      },
    ]);
    expect(third?.spend.byCaller["compaction:queue-compaction"]).toBeCloseTo(0.002, 6);
    expect(third?.spend.byCategory.compaction).toBeCloseTo(0.002, 6);
    expect(textOf(mockLlm(QueueCompaction).onlyRequest)).toContain("Turns to compact:\nstart");
  });

  test("no one loses a turn: the router reads the summary and t3, the agent its three turns", async ({
    app,
    mockLlm,
  }) => {
    answerOk(mockLlm);
    mockLlm(QueueCompaction).thenReturn(replyWith("t1 and t2 were asked"));

    await converse(app, 4);

    const router = mockLlm(HelpRouter).lastRequest;
    expect(textOf(router)).toContain("Earlier in this conversation:\n[1] t1 and t2 were asked");
    expect(turnsSeen(router)).toEqual(["t3"]);
    // the larger window sees the summarised turns in full, so not the summary again
    const agent = mockLlm(AnswerAgent).lastRequest;
    expect(turnsSeen(agent)).toEqual(["t1", "t2", "t3"]);
    expect(textOf(agent)).not.toContain("t1 and t2 were asked");
  });

  test("the queue keeps its latest summaryQueueLength summaries: the oldest leaves first", async ({
    app,
    mockLlm,
  }) => {
    answerOk(mockLlm);
    mockLlm(QueueCompaction).thenReturn(replyWith("S1"), replyWith("S2"), replyWith("S3"));

    const seventh = await converse(app, 7);
    await execute(app, DeskStart, { text: "t8" }, { threadId: seventh.threadId });

    const router = textOf(mockLlm(HelpRouter).lastRequest);
    expect(router).toContain("[1] S2");
    expect(router).toContain("[2] S3");
    expect(router).not.toContain("S1");
  });

  test("a summary cut at summaryMaxTokens is asked once more, shorter", async ({
    app,
    mockLlm,
  }) => {
    answerOk(mockLlm);
    mockLlm(QueueCompaction).thenReturn(
      replyWith("a summary that goes on and", { truncated: true }),
      replyWith("short"),
    );

    const third = await converse(app, 3);
    await execute(app, DeskStart, { text: "t4" }, { threadId: third.threadId });

    const [first, shorter] = mockLlm(QueueCompaction).requests;
    expect(textOf(first ?? mockLlm(QueueCompaction).lastRequest)).not.toContain(
      SHORTER_SUMMARY_REQUEST,
    );
    expect(textOf(shorter ?? mockLlm(QueueCompaction).lastRequest)).toContain(
      SHORTER_SUMMARY_REQUEST,
    );
    expect(textOf(mockLlm(HelpRouter).lastRequest)).toContain("[1] short");
  });

  test("cut again: CompactionError, never a cut summary — the turns stay for the next one", async ({
    app,
    mockLlm,
  }) => {
    answerOk(mockLlm);
    mockLlm(QueueCompaction).thenReturn(
      replyWith("cut", { truncated: true }),
      replyWith("cut again", { truncated: true }),
      replyWith("t1 and t2 were asked"),
    );
    const second = await converse(app, 2);

    const third = execute(app, DeskStart, { text: "t3" }, { threadId: second.threadId });

    await expect(third).rejects.toFailWith(CompactionError, {
      code: "compaction",
      compaction: "queue-compaction",
      summaryMaxTokens: 200,
    });
    // the failed execution is no turn: the next one compacts t1 and t2 (the failed record read as none)
    const retried = await execute(app, DeskStart, { text: "t3" }, { threadId: second.threadId });
    expect(retried.compacted).toMatchObject([{ compaction: "queue-compaction", fromTurn: 1 }]);
    expect(turnsSeen(mockLlm(QueueCompaction).lastRequest)).toEqual(["t1", "t2"]);
  });

  test("a failed model call is a CompactionError with the failure as its cause", async ({
    app,
    mockLlm,
  }) => {
    answerOk(mockLlm);
    mockLlm(QueueCompaction).thenReturn(failWith(ModelFailure.ServerError));
    const second = await converse(app, 2);

    await expect(
      execute(app, DeskStart, { text: "t3" }, { threadId: second.threadId }),
    ).rejects.toFailWith(CompactionError, { compaction: "queue-compaction" });
  });
});

describe("#120 S84 (i): the compaction's model reads the turns masked, the summary is revealed", () => {
  const test = testWith(HelpDeskApplication);

  test("the compactor sees a token, the store keeps the address, each reader masks it again", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(HelpRouter).thenReturn(
      routeTo(AnswerAgent),
      routeTo(AnswerAgent),
      routeTo(AnswerAgent),
      routeTo(ContactAgent),
    );
    mockLlm(AnswerAgent).thenReturnAlways(replyWith("ok"));
    mockLlm(ContactAgent).thenReturn(replyWith("written"));
    mockLlm(QueueCompaction).thenAnswer((request) => {
      const token = /<email:[0-9a-f]+>/u.exec(textOf(request))?.[0] ?? "(no token)";
      return replyWith(`the user's address is ${token}`);
    });

    await converse(app, 4, (turn) =>
      turn === 1 ? "write to alice@example.com" : `t${String(turn)}`,
    );

    const compactor = textOf(mockLlm(QueueCompaction).onlyRequest);
    expect(compactor).not.toContain("alice@example.com");
    expect(compactor).toMatch(/<email:[0-9a-f]+>/u);
    // the router's policies mask the stored summary at its boundary
    const router = textOf(mockLlm(HelpRouter).lastRequest);
    expect(router).toMatch(/the user's address is <email:[0-9a-f]+>/u);
    expect(router).not.toContain("alice@example.com");
    // the contact agent excludes the policy: it reads the summary as stored, revealed
    expect(textOf(mockLlm(ContactAgent).onlyRequest)).toContain(
      "the user's address is alice@example.com",
    );
  });
});

describe("#120 AC10: a single summary is rewritten from the previous one and the new turns", () => {
  const test = testWith(NotesDeskApplication);

  test("the note covers the thread; its reader sees only the latest", async ({ app, mockLlm }) => {
    mockLlm(NoteAgent).thenReturnAlways(replyWith("ok"));
    mockLlm(NoteCompaction).thenReturn(
      replyWith("note 1"),
      replyWith("note 2"),
      replyWith("note 3"),
    );

    const third = await converse(app, 3);
    await execute(app, DeskStart, { text: "t4" }, { threadId: third.threadId });

    const [first, second] = mockLlm(NoteCompaction).requests;
    expect(mockLlm(NoteCompaction).requests).toHaveLength(3);
    expect(textOf(first ?? mockLlm(NoteCompaction).lastRequest)).toContain(
      "Current summary:\n(none yet)",
    );
    expect(textOf(second ?? mockLlm(NoteCompaction).lastRequest)).toContain(
      "Current summary:\nnote 1\n\nTurns to add:",
    );
    expect(third.compacted).toMatchObject([
      {
        compaction: "note-compaction",
        fromTurn: 2,
        toTurn: 2,
        summaries: 1,
        summaryQueueLength: 1,
      },
    ]);
    const agent = textOf(mockLlm(NoteAgent).lastRequest);
    expect(agent).toContain("[1] note 2");
    expect(agent).not.toContain("note 1");
    expect(turnsSeen(mockLlm(NoteAgent).lastRequest)).toEqual(["t3"]);
  });
});

describe("#120 AC10: None writes no summaries; TurnLimit.ALL sees every turn", () => {
  const test = testWith(WindowDeskApplication);

  test("the router sees its window only, the archive agent the whole thread", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(WindowRouter).thenReturnAlways(routeTo(ArchiveAgent));
    mockLlm(ArchiveAgent).thenReturnAlways(replyWith("ok"));

    const result = await converse(app, 8);

    expect(result.compacted).toBeUndefined();
    expect(turnsSeen(mockLlm(WindowRouter).lastRequest)).toEqual(["t7"]);
    expect(turnsSeen(mockLlm(ArchiveAgent).lastRequest)).toEqual([
      "t1",
      "t2",
      "t3",
      "t4",
      "t5",
      "t6",
      "t7",
    ]);
    expect(() => mockLlm(NoSummariesCompaction)).toThrow("compaction that writes summaries");
  });
});
