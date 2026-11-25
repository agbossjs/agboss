/**
 * #120 PR 3, #1303 — memory (AC10, AC4): `@Memory` and its compaction strategies, `uncompactedTurns` (the
 * lowest set value; a memory summarises what is older than the smallest window among its
 * readers), the "shorter" retry and `StepError.Memory`, and the compaction's model behind the PII
 * boundary (S84 i). Models answer by script; nothing reaches a network.
 */
import { Window2Memory } from "../helpers/window-memory.js";
import { describe, expect, it } from "vitest";
import {
  Agent,
  CompactionStrategy,
  DecidedBy,
  Injectable,
  Memory,
  Observer,
  Router,
  StepError,
  TurnLimit,
  Ttl,
  Workflow,
  inline,
} from "../../src/index.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import type { CompactionEndEvent, CompactionStartEvent } from "../../src/index.js";
import { Application } from "../../src/application/application.js";
import type { Class } from "../../src/components/injection.js";
import { applicationOf } from "../../src/application/assemble.js";
import { memoryViolations } from "../../src/memory/checks.js";
import { effectiveMemories } from "../../src/memory/levels.js";
import { memoryPlanOf, readerOf, windowOfCompaction } from "../../src/memory/plan.js";
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
import { execute, onStart } from "../helpers/flow.js";
import {
  AnswerAgent,
  ArchiveAgent,
  ContactAgent,
  DeskAnswer,
  DeskStart,
  EagerAgent,
  EagerMemory,
  EagerDeskApplication,
  HelpDeskApplication,
  HelpRouter,
  WindowOnlyMemory,
  NoteAgent,
  NoteMemory,
  NotesDeskApplication,
  NotesDeskWorkflow,
  QueueMemory,
  WindowDeskApplication,
  WindowRouter,
} from "./compaction.fixture.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

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

@Memory({
  name: "misnamed",
  description: "A name without its kind",
  ttl: Ttl.Forever,
  turnsBetweenCompactions: 0,
  compaction: {
    strategy: CompactionStrategy.SummaryQueue,
    model: "test/compactor",
    summaryQueueLength: 0,
    summaryMaxTokens: 1.5,
  },
})
class MisnamedMemory {}

@Memory({
  name: "odd-window-memory",
  description: "A window no memory takes",
  ttl: Ttl.Forever,
  uncompactedTurns: -1,
})
class OddWindowMemory {}

@Memory({
  name: "never-memory",
  description: "A ttl that is no duration",
  ttl: 0 as never,
})
class NeverMemory {}

// @ts-expect-error -- #1303: a declarative compaction and a compact() method are two ways to compact
@Memory({
  name: "both-memory",
  description: "A compaction in the decorator and a compact method",
  ttl: Ttl.Forever,
  compaction: { strategy: CompactionStrategy.SingleSummary, model: "test/compactor" },
})
class BothMemory {
  compact(): readonly string[] {
    return ["x"];
  }
}

@Memory({
  name: "queued-single-memory",
  description: "A single summary with a queue length",
  ttl: Ttl.Forever,
  // @ts-expect-error -- #1303: a single summary has no queue
  compaction: {
    strategy: CompactionStrategy.SingleSummary,
    model: "test/compactor",
    summaryQueueLength: 3,
  },
})
class QueuedSingleMemory {}

// @ts-expect-error -- #1303: a ttl is required
@Memory({ name: "ttl-less-memory", description: "No ttl" })
class TtlLessMemory {}

@Injectable()
class NotAMemory {}

@Agent({
  name: "odd-agent",
  description: "Settings no memory takes",
  prompt: inline("Answer."),
  model: "test/odd",
  memory: NotAMemory,
})
class OddAgent {}

@Workflow({
  name: "odd-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(DeskStart).toAgent(OddAgent).toFinish(DeskAnswer)],
  memory: OddWindowMemory,
})
class OddWorkflow {}

@Application({
  name: "odd-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [OddWorkflow],
  budgets: TEST_BUDGETS,
})
class OddApplication {}

describe("#120 AC10, #1303: @Memory at assembly", () => {
  it("the decorator's types: a ttl is required, a single summary has no queue", () => {
    // the @ts-expect-error lines above are the check; the classes still carry their options
    expect([TtlLessMemory, QueuedSingleMemory]).toHaveLength(2);
    Router({
      name: "code-window-router",
      description: "A code router with a window",
      decidedBy: DecidedBy.Code,
      input: { message: WorkflowStartTextDto },
      routes: [DeskAnswer],
      // @ts-expect-error -- a code router reads no thread memory
      memory: Window2Memory,
    });
  });

  it("name ends with -memory; counts are whole numbers from 1; a ttl is a duration or Ttl.Forever; compaction and compact() never both", () => {
    expect(memoryViolations([MisnamedMemory, QueueMemory, NeverMemory, BothMemory])).toEqual([
      expect.objectContaining({ code: "name.kind-suffix" }),
      expect.objectContaining({
        code: "memory.invalid-setting",
        message: "misnamed: turnsBetweenCompactions 0 — a whole number from 1",
      }),
      expect.objectContaining({
        code: "memory.invalid-setting",
        message: "misnamed: summaryMaxTokens 1.5 — a whole number from 1, or TokenLimit.ModelMax",
      }),
      expect.objectContaining({
        code: "memory.invalid-setting",
        message: "misnamed: summaryQueueLength 0 — a whole number from 1",
      }),
      expect.objectContaining({
        code: "memory.invalid-setting",
        message: "never-memory: ttl 0 — a duration above 0, or Ttl.Forever",
      }),
      expect.objectContaining({ code: "memory.conflicting-compaction" }),
    ]);
  });

  it("every rule broken fails the application's assembly, all at once", async () => {
    const violations = await violationsOf(OddApplication);

    expect(violations).toEqual(
      expect.arrayContaining([
        "[memory.uncompacted-turns-invalid] odd-window-memory: uncompactedTurns -1 — a whole number from 0, or TurnLimit.All",
        "[memory.not-a-memory] odd-agent: memory is NotAMemory, which is not a @Memory class",
      ]),
    );
  });
});

describe("#1303: one setting on every level — the lowest set value wins", () => {
  it("memory: an element's own over the workflow's", () => {
    const effective = effectiveMemories({
      workflow: { name: "w-workflow", memory: QueueMemory },
      elements: [
        { name: "answer-agent" },
        { name: "note-agent", memory: NoteMemory },
        { name: "help-router" },
      ],
    });

    expect([...effective.byElement]).toEqual([
      ["answer-agent", QueueMemory],
      ["note-agent", NoteMemory],
      ["help-router", QueueMemory],
    ]);
    expect(effective.classes).toEqual([QueueMemory, NoteMemory]);
    expect(
      effectiveMemories({
        workflow: { name: "w-workflow", memory: WindowOnlyMemory },
        elements: [{ name: "answer-agent" }],
      }).byElement.get("answer-agent"),
    ).toBe(WindowOnlyMemory);
  });

  it("a reader's window is its memory's: the workflow's shared one (1), the archive agent's own (all)", async () => {
    const [workflow] = (await applicationOf(HelpDeskApplication)).workflows;
    if (workflow === undefined) throw new Error("the application has a workflow");
    const plan = memoryPlanOf(workflow.config, workflow.memories);

    expect(readerOf(plan, "help-router").window).toBe(1);
    expect(readerOf(plan, "answer-agent").window).toBe(1);
    expect(readerOf(plan, "contact-agent").compaction?.name).toBe("queue-memory");
    const [window] = (await applicationOf(WindowDeskApplication)).workflows;
    if (window === undefined) throw new Error("the application has a workflow");
    expect(readerOf(memoryPlanOf(window.config, window.memories), "archive-agent").window).toBe(
      TurnLimit.All,
    );
  });

  it("a memory's window is the smallest among its readers (a profile may set an agent's own); ALL only when every reader sees all", async () => {
    const [workflow] = (await applicationOf(HelpDeskApplication)).workflows;
    if (workflow === undefined) throw new Error("the application has a workflow");

    expect(memoryPlanOf(workflow.config, workflow.memories).compactions).toEqual([
      expect.objectContaining({ name: "queue-memory", window: 1, summaryQueueLength: 2 }),
    ]);
    expect(windowOfCompaction([TurnLimit.All, 4, 2])).toBe(2);
    expect(windowOfCompaction([TurnLimit.All, TurnLimit.All])).toBe(TurnLimit.All);
  });
});

describe("#120 AC10: a queue summarises what is older than the smallest window", () => {
  const test = testWith(HelpDeskApplication);

  test("before turn 4 the two turns older than the router's window become one summary", async ({
    app,
    mockLlm,
  }) => {
    answerOk(mockLlm);
    mockLlm(QueueMemory).thenReturn(replyWith("t1 and t2 were asked", { cost: usd(0.002) }));

    const [first, second, third, fourth] = await conversation(app, 4);

    expect(first?.compacted).toBeUndefined();
    expect(second?.compacted).toBeUndefined();
    // S132: not after turn 3 — before turn 4 first reads its thread
    expect(third?.compacted).toBeUndefined();
    expect(third?.spend.byCategory.memory).toBe(0);
    expect(fourth?.compacted).toEqual([
      {
        memory: "queue-memory",
        fromTurn: 1,
        toTurn: 2,
        summaries: 1,
        summaryQueueLength: 2,
      },
    ]);
    expect(fourth?.spend.byCaller["memory:queue-memory"]).toBeCloseTo(0.002, 6);
    expect(fourth?.spend.byCategory.memory).toBeCloseTo(0.002, 6);
    expect(fourth?.spend.trace.map((line) => line.caller)[0]).toBe("memory:queue-memory");
    expect(textOf(mockLlm(QueueMemory).onlyRequest)).toContain("Turns to compact:\nstart");
  });

  test("no one loses a turn: the router and the agent read the summary and t3", async ({
    app,
    mockLlm,
  }) => {
    answerOk(mockLlm);
    mockLlm(QueueMemory).thenReturn(replyWith("t1 and t2 were asked"));

    await converse(app, 4);

    for (const reader of [mockLlm(HelpRouter).lastRequest, mockLlm(AnswerAgent).lastRequest]) {
      expect(textOf(reader)).toContain("Earlier in this conversation:\n[1] t1 and t2 were asked");
      expect(turnsSeen(reader)).toEqual(["t3"]);
    }
  });

  test("the queue keeps its latest summaryQueueLength summaries: the oldest leaves first", async ({
    app,
    mockLlm,
  }) => {
    answerOk(mockLlm);
    mockLlm(QueueMemory).thenReturn(replyWith("S1"), replyWith("S2"), replyWith("S3"));

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
    mockLlm(QueueMemory).thenReturn(
      replyWith("a summary that goes on and", { truncated: true }),
      replyWith("short"),
    );

    await converse(app, 4);

    const [first, shorter] = mockLlm(QueueMemory).requests;
    expect(textOf(first ?? mockLlm(QueueMemory).lastRequest)).not.toContain(
      SHORTER_SUMMARY_REQUEST,
    );
    expect(textOf(shorter ?? mockLlm(QueueMemory).lastRequest)).toContain(SHORTER_SUMMARY_REQUEST);
    expect(textOf(mockLlm(HelpRouter).lastRequest)).toContain("[1] short");
  });

  test("cut again: StepError.Memory, never a cut summary — the turns stay for the next one", async ({
    app,
    mockLlm,
  }) => {
    answerOk(mockLlm);
    mockLlm(QueueMemory).thenReturn(
      replyWith("cut", { truncated: true }),
      replyWith("cut again", { truncated: true }),
      replyWith("t1 and t2 were asked"),
    );
    const third = await converse(app, 3);

    const fourth = execute(app, DeskStart, { text: "t4" }, { threadId: third.threadId });

    await expect(fourth).rejects.toFailWith(StepError.Memory, {
      code: "step.memory",
      memory: "queue-memory",
    });
    // the failed execution is no turn: the next one compacts t1 and t2 (the failed record read as none)
    const retried = await execute(app, DeskStart, { text: "t4" }, { threadId: third.threadId });
    expect(retried.compacted).toMatchObject([{ memory: "queue-memory", fromTurn: 1 }]);
    expect(turnsSeen(mockLlm(QueueMemory).lastRequest)).toEqual(["t1", "t2"]);
  });

  // replaces #77 AC5 (a compaction failure swallowed, the next turn retrying): S132
  test("a failed model call is a StepError.Memory with the failure as its cause", async ({
    app,
    mockLlm,
  }) => {
    answerOk(mockLlm);
    mockLlm(QueueMemory).thenReturn(failWith(ModelFailure.ServerError));
    const third = await converse(app, 3);

    await expect(
      execute(app, DeskStart, { text: "t4" }, { threadId: third.threadId }),
    ).rejects.toFailWith(StepError.Memory, { memory: "queue-memory" });
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
    mockLlm(QueueMemory).thenAnswer((request) => {
      const token = /<email:[0-9a-f]+>/u.exec(textOf(request))?.[0] ?? "(no token)";
      return replyWith(`the user's address is ${token}`);
    });

    await converse(app, 4, (turn) =>
      turn === 1 ? "write to alice@example.com" : `t${String(turn)}`,
    );

    const compactor = textOf(mockLlm(QueueMemory).onlyRequest);
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
    mockLlm(NoteMemory).thenReturn(replyWith("note 1"), replyWith("note 2"));

    const [, , third] = await conversation(app, 4);

    // before turns 3 and 4 — none after the last turn
    const [first, second] = mockLlm(NoteMemory).requests;
    expect(mockLlm(NoteMemory).requests).toHaveLength(2);
    expect(textOf(first ?? mockLlm(NoteMemory).lastRequest)).toContain(
      "Current summary:\n(none yet)",
    );
    expect(textOf(second ?? mockLlm(NoteMemory).lastRequest)).toContain(
      "Current summary:\nnote 1\n\nTurns to add:",
    );
    expect(third?.compacted).toMatchObject([
      {
        memory: "note-memory",
        fromTurn: 1,
        toTurn: 1,
        summaries: 1,
      },
    ]);
    const agent = textOf(mockLlm(NoteAgent).lastRequest);
    expect(agent).toContain("[1] note 2");
    expect(agent).not.toContain("note 1");
    expect(turnsSeen(mockLlm(NoteAgent).lastRequest)).toEqual(["t3"]);
  });
});

describe("#120 S132: compaction runs before the next turn reads its thread, never after a turn", () => {
  const test = testWith(EagerDeskApplication);

  test("a failing compaction on turn 2 keeps turn 1 and fails turn 2 before its agent runs", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(EagerAgent).thenReturn(replyWith("answer 1"), replyWith("answer 2"));
    mockLlm(EagerMemory).thenReturn(
      replyWith("cut", { truncated: true }),
      replyWith("cut again", { truncated: true }),
      replyWith("t1 was asked"),
    );
    const first = await execute(app, DeskStart, { text: "t1" });

    const second = execute(app, DeskStart, { text: "t2" }, { threadId: first.threadId });

    await expect(second).rejects.toFailWith(StepError.Memory, { memory: "eager-memory" });
    expect(first.output).toEqual({ text: "answer 1" }); // a finished turn's answer is kept
    expect(mockLlm(EagerAgent).requests).toHaveLength(1); // no model call, no step of turn 2
    // turn 1 is still the thread's only turn: the retry compacts it, then answers
    const retried = await execute(app, DeskStart, { text: "t2" }, { threadId: first.threadId });
    expect(retried.output).toEqual({ text: "answer 2" });
    expect(turnsSeen(mockLlm(EagerMemory).lastRequest)).toEqual(["t1"]);
    expect(textOf(mockLlm(EagerAgent).lastRequest)).toContain("[1] t1 was asked");
  });

  test("a thread that ends never pays for a compaction after its last turn", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(EagerAgent).thenReturn(replyWith("answer 1"));

    const only = await execute(app, DeskStart, { text: "t1" });

    expect(only.compacted).toBeUndefined();
    expect(only.spend.byCategory.memory).toBe(0);
    expect(mockLlm(EagerMemory).requests).toEqual([]);
  });
});

describe("#120 AC10: None writes no summaries; TurnLimit.All sees every turn", () => {
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
    expect(() => mockLlm(WindowOnlyMemory)).toThrow("compaction that writes summaries");
  });
});

describe("#1303: onCompactionStart / onCompactionEnd", () => {
  const events: string[] = [];

  @Observer()
  class CompactionObserver {
    onCompactionStart(event: CompactionStartEvent): void {
      events.push(`start ${event.memory} ${String(event.turns)} ${event.workflow.name}`);
    }

    onCompactionEnd(event: CompactionEndEvent): void {
      events.push(`end ${event.memory} ${String(event.costUsd)} ${String(event.summaries)}`);
    }
  }

  @Application({
    name: "observed-notes-desk-application",
    modelProvider: TestModelProvider,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [NotesDeskWorkflow],
    observers: [CompactionObserver],
    budgets: TEST_BUDGETS,
  })
  class ObservedNotesDeskApplication {}

  const test = testWith(ObservedNotesDeskApplication);

  test("a compaction with turns due is announced before and after, with its spend", async ({
    app,
    mockLlm,
  }) => {
    events.length = 0;
    mockLlm(NoteAgent).thenReturnAlways(replyWith("ok"));
    mockLlm(NoteMemory).thenReturn(replyWith("note 1", { cost: usd(0.003) }));

    await conversation(app, 3);

    expect(events).toEqual(["start note-memory 1 notes-desk-workflow", "end note-memory 0.003 1"]);
  });
});
