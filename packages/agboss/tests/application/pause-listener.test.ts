/**
 * #940 AC5: an application-wide `@ChannelListener` hears every pause opened and closed — with the
 * safe context, the question and the answer masked — at least once, each notice under its own
 * `deliveryId` (the same on a redelivery). It gets a correlation key (`pauseKey`), never the
 * answering id of a channel pause unless it is declared `includePauseIds`; a thread owner's pause
 * id it always sees. Its `onInit` runs before its first notice, one instance hears every workflow,
 * and the assembly rules say what is wrong with a listener, each with its code.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionStatus } from "../../src/app/types.js";
import {
  PauseRespondent,
  PauseClosedReason,
  PauseKind,
  ChannelListener,
  type OnInit,
  type ChannelListenerClosedEvent,
  type ChannelListenerOpenedEvent,
} from "../../src/index.js";
import { pauseKeyOf } from "../../src/infrastructure/pause-record.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  InboxBudgetOwnerChannel,
  InboxSpendingLimitChannel,
  OwnerPurchaseWorkflow,
  OwnerPurchaseWorkflowStart,
  PurchaseWorkflow,
  PurchaseWorkflowStart,
  QuestionInbox,
} from "../flow/fixtures/questions.fixture.js";
import { execute } from "../helpers/flow.js";
import { manager, until } from "../channels/fixtures/pause-scripts.js";
import {
  DeskClerkAgent,
  DeskWorkflowStart,
  hooks,
  PausesApplication,
  RefundTool,
  resetPauses,
  seen,
} from "../channels/fixtures/pauses.workflow.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

const desk = testWith(PausesApplication);

beforeEach(resetPauses);

/** One notice a listener heard, with where it ran. */
interface Heard {
  readonly listener: string;
  readonly type: "opened" | "closed";
  readonly event: ChannelListenerOpenedEvent & Partial<ChannelListenerClosedEvent>;
  readonly initialisedBefore: boolean;
}

const heard: Heard[] = [];

@ChannelListener({ name: "ledger-pause-listener" })
class LedgerPauseListener implements OnInit {
  isReady = false;

  onInit(): Promise<void> {
    this.isReady = true;
    return Promise.resolve();
  }

  onPauseOpened(event: ChannelListenerOpenedEvent): Promise<void> {
    heard.push({ listener: "ledger", type: "opened", event, initialisedBefore: this.isReady });
    return Promise.resolve();
  }

  onPauseClosed(event: ChannelListenerClosedEvent): Promise<void> {
    heard.push({ listener: "ledger", type: "closed", event, initialisedBefore: this.isReady });
    return Promise.resolve();
  }
}

@Application({
  name: "listened-questions-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [PurchaseWorkflow, OwnerPurchaseWorkflow],
  budgets: TEST_BUDGETS,
  providers: [InboxSpendingLimitChannel, InboxBudgetOwnerChannel, LedgerPauseListener],
})
class ListenedQuestionsApplication {}

const questions = testWith(ListenedQuestionsApplication);
const ACME = { tenant: { tenantId: "acme" }, threadId: "refund-thread" };

beforeEach(() => {
  heard.length = 0;
});

describe("#940 AC5: what a listener hears", () => {
  desk(
    "AC5: opened carries every field of the base event, the question masked",
    async ({ app, mockModel }) => {
      mockModel(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));

      const paused = await execute(app, DeskWorkflowStart, { text: "refund order 7" }, ACME);

      await until(() => seen.heard.filter((one) => one.listener === "audit").length === 1);
      const [opened] = seen.heard.filter((one) => one.listener === "audit");
      expect(opened?.type).toBe("opened");
      expect(opened?.event).toEqual({
        deliveryId: expect.stringMatching(/^[0-9a-f]{32}$/),
        pauseKey: pauseKeyOf("acme", seen.asks[0]?.pauseId ?? ""),
        tenantId: "acme",
        rootExecutionId: paused.executionId,
        executionId: paused.executionId,
        threadId: "refund-thread",
        workflow: "desk-workflow",
        step: "desk-clerk-agent",
        kind: PauseKind.Approval,
        target: "refund-gate-tool-approval",
        channel: "finance-desk-refund-approval-channel",
        respondent: PauseRespondent.Delegate,
        toolCall: expect.objectContaining({ tool: "refund-tool" }),
        input: { orderId: "7" },
        trail: [expect.objectContaining({ action: "opened" })],
        askedAt: expect.any(String),
        expiresAt: expect.any(String),
      });
      // opened is told to listeners only: the channel sent the question itself
      expect(seen.closed).toEqual([]);
    },
  );

  desk(
    "AC5: a Channel pause: pauseKey and no pauseId; a trusted listener (includePauseIds) gets the id",
    async ({ app, mockModel }) => {
      mockModel(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      await execute(app, DeskWorkflowStart, { text: "refund order 7" }, ACME);

      await until(() => seen.heard.length === 2);

      const byListener = Object.fromEntries(seen.heard.map((one) => [one.listener, one.event]));
      expect(byListener.audit).not.toHaveProperty("pauseId");
      expect(byListener.audit?.pauseKey).toHaveLength(32);
      expect(byListener.trusted).toMatchObject({ pauseId: seen.asks[0]?.pauseId });
    },
  );

  questions("AC5: a ThreadOwner pause: its id is seen without includePauseIds", async ({ app }) => {
    const paused = await execute(
      app,
      PurchaseWorkflowStart,
      { text: "laptop for 900" },
      { threadId: "purchase-1", ownerId: "alice" },
    );
    expect(paused.status).toBe(ExecutionStatus.Paused);

    await until(() => heard.length === 1);

    expect(heard[0]?.event).toMatchObject({
      pauseId: paused.pending[0]?.pauseId,
      respondent: PauseRespondent.Owner,
      kind: PauseKind.ExternalTask,
      // the requester is `sensitive`: masked for the listener too
      input: { item: "laptop", priceUsd: 900, requester: expect.not.stringContaining("alice") },
    });
  });

  questions(
    "AC5: a two-workflow application: one listener instance hears the pauses of both, in order",
    async ({ app }) => {
      await execute(
        app,
        PurchaseWorkflowStart,
        { text: "laptop for 900" },
        { threadId: "purchase-1", ownerId: "alice" },
      );
      await execute(app, OwnerPurchaseWorkflowStart, { text: "desk for 700" });
      const pauseId = app.resolve(QuestionInbox).ownerAsked[0]?.pauseId ?? "";

      await app.resume({ pauseId, decision: { approved: true, limitUsd: 800 } }, manager);

      await until(() => heard.length === 3);
      expect(heard.map((one) => [one.event.workflow, one.type])).toEqual([
        ["purchase-workflow", "opened"],
        ["owner-purchase-workflow", "opened"],
        ["owner-purchase-workflow", "closed"],
      ]);
      expect(heard[2]?.event).toMatchObject({
        reason: PauseClosedReason.Answered,
        actor: { id: "manager-17" },
        answer: { approved: true, limitUsd: 800 },
      });
    },
  );

  questions("AC5: a listener's onInit ran before its first notice", async ({ app }) => {
    await execute(
      app,
      PurchaseWorkflowStart,
      { text: "laptop for 900" },
      { threadId: "purchase-1", ownerId: "alice" },
    );

    await until(() => heard.length === 1);

    expect(heard.every((one) => one.initialisedBefore)).toBe(true);
  });
});

describe("#940 AC5: deliveryId is the receiver's dedupe key", () => {
  desk(
    "AC5: the same on redelivery, different for every other notice",
    async ({ app, clock, mockModel }) => {
      hooks.listenerFailures = 1;
      mockModel(DeskClerkAgent).thenReturn(callTool(RefundTool, { orderId: "7" }));
      const paused = await execute(app, DeskWorkflowStart, { text: "refund order 7" }, ACME);
      await until(() => seen.heard.length >= 2);

      await clock.advance(seconds(5));
      await app.cancel(paused.threadId, { tenantId: "acme" });
      await until(() => seen.heard.filter((one) => one.type === "closed").length >= 2);

      const audit = seen.heard.filter((one) => one.listener === "audit");
      const ids = audit.map((one) => [one.type, one.event.deliveryId] as const);
      const opened = ids.filter(([type]) => type === "opened").map(([, id]) => id);
      // the first call failed, the retry carried the same id
      expect(new Set(opened).size).toBe(1);
      expect(opened.length).toBeGreaterThanOrEqual(2);
      const closed = ids.filter(([type]) => type === "closed").map(([, id]) => id);
      expect(closed[0]).toBeDefined();
      expect(closed[0]).not.toBe(opened[0]);
      expect(audit.find((one) => one.type === "closed")?.event).toMatchObject({
        reason: PauseClosedReason.Cancelled,
      });
    },
  );
});

describe("#940 AC5: the assembly rules", () => {
  const apply = (...listeners: unknown[]): Promise<unknown> => {
    @Application({
      name: "ruled-application",
      version: "1.0.0",
      workflows: [PurchaseWorkflow],
      budgets: TEST_BUDGETS,
      providers: [InboxSpendingLimitChannel, ...(listeners as never[])],
    })
    class RuledApplication {}
    return applicationOf(RuledApplication);
  };

  it("AC5: [name.not-kebab-case] a name that is not kebab-case", async () => {
    @ChannelListener({ name: "Ledger_Listener" })
    class BadName {
      onPauseOpened = (): Promise<void> => Promise.resolve();
      onPauseClosed = (): Promise<void> => Promise.resolve();
    }
    await expect(apply(BadName)).rejects.toThrow(/\[name\.not-kebab-case\]/);
  });

  it("AC5: [pause-listener.duplicate-name] two classes with one name", async () => {
    @ChannelListener({ name: "twin-pause-listener" })
    class One {
      onPauseOpened = (): Promise<void> => Promise.resolve();
      onPauseClosed = (): Promise<void> => Promise.resolve();
    }
    @ChannelListener({ name: "twin-pause-listener" })
    class Two {
      onPauseOpened = (): Promise<void> => Promise.resolve();
      onPauseClosed = (): Promise<void> => Promise.resolve();
    }
    await expect(apply(One, Two)).rejects.toThrow(/\[channel-listener\.duplicate-name\]/);
  });

  it("AC5: [channel-listener.missing-handler] a listener with none of the hooks", async () => {
    @ChannelListener({ name: "empty-pause-listener" })
    class Empty {}
    await expect(apply(Empty)).rejects.toThrow(/\[channel-listener\.missing-handler\]/);
  });
});
