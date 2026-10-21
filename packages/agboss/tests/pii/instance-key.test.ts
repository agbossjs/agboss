/**
 * #334: without `@Application({ pseudonymKey })` each root execution makes its field tokens with a
 * key of its own, kept in its checkpoint and handed to its children — a pause resumed, or a crash
 * recovered, on another instance gives one value the same token; the application's key (or the
 * test's) changes nothing and puts no key in the checkpoint.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionLeaseLostError } from "../../src/index.js";
import { TEST_PSEUDONYM_KEY } from "../../src/pii/application-key.js";
import { observabilityMaskOf } from "../../src/pii/observability-mask.js";
import { PiiPolicySet } from "../../src/pii/policy-set.js";
import { tokenOf } from "../../src/pii/tokens.js";
import { callTool, replyWith, testWith, type ModelRequest } from "../../src/testing/index.js";
import { withInstancePiiKeys } from "../../src/testing/pii-parts.js";
import type { TestApp } from "../../src/testing/test-app.js";
import { seconds } from "../../src/units/index.js";
import { answerOf, execute } from "../helpers/flow.js";
import { ends, kill, levers, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { requestText, tokensIn } from "./boundary.helpers.js";
import {
  DeskAgent,
  DeskNoteDto,
  DeskStart,
  FollowUpAgent,
  InstanceKeyApplication,
  LookupTool,
  resetSavedKeys,
  savedKeys,
  SlowLookupTool,
} from "./instance-key.fixture.js";

const AUTHOR = "zoe-7";
const MESSAGE = { text: "who is this?", author: AUTHOR };
const APPROVE = { approved: true };

const instanceKeyed = testWith(InstanceKeyApplication, withInstancePiiKeys({ instances: 2 }));
const testKeyed = testWith(InstanceKeyApplication);

beforeEach(() => {
  resetRecovery();
  resetSavedKeys();
});

/** The test's two instances. */
function pair(apps: readonly TestApp[]): readonly [TestApp, TestApp] {
  const [first, second] = apps;
  if (first === undefined || second === undefined) throw new Error("the test runs two instances");
  return [first, second];
}

/** The author tokens each request carried. */
const authorTokens = (requests: readonly ModelRequest[]): readonly (readonly string[])[] =>
  requests.map((request) => tokensIn(requestText(request), "author"));

/** The keys the checkpoints held, without repeats. */
const keysSaved = (): readonly (string | null)[] => [...new Set(savedKeys)];

describe("#334 AC1, AC3: a key per root execution, on any instance", () => {
  instanceKeyed(
    "a paused execution resumed on the other instance gives the same value the same token",
    async ({ apps, mockLlm }) => {
      const desk = mockLlm(DeskAgent).thenReturn(
        callTool(LookupTool, { author: AUTHOR }),
        replyWith(DeskNoteDto, { text: "found", author: AUTHOR }),
      );
      mockLlm(FollowUpAgent).thenReturn(replyWith("followed up"));
      const [first, second] = pair(apps);

      const paused = await execute(first, DeskStart, MESSAGE);
      const resumed = await second.resume(answerOf(paused, APPROVE));

      const [asked, answered] = authorTokens(desk.requests);
      expect(resumed.output).toEqual({ text: "followed up" });
      expect(asked).toHaveLength(1);
      expect(answered).toEqual(asked);
      expect(asked).not.toEqual([tokenOf("author", AUTHOR, TEST_PSEUDONYM_KEY, {})]);
    },
  );

  instanceKeyed(
    "a recovered execution (its lease expired) keeps its tokens",
    async ({ apps, clock, mockLlm }) => {
      const desk = mockLlm(DeskAgent).thenReturn(
        callTool(SlowLookupTool, { author: AUTHOR }),
        replyWith(DeskNoteDto, { text: "found", author: AUTHOR }),
      );
      mockLlm(FollowUpAgent).thenReturn(replyWith("followed up"));
      const [first, second] = pair(apps);
      await first.ready();
      await second.ready();
      const held = new Promise<void>((resolve) => {
        levers.holdStarted = resolve;
      });
      const dying = execute(first, DeskStart, MESSAGE);
      dying.catch(() => undefined);
      await held;

      kill("instance-1");
      await clock.advance(seconds(31));
      const recovered = await ends(2); // the child, then the root

      await expect(dying).rejects.toBeInstanceOf(ExecutionLeaseLostError);
      const [asked, answered] = authorTokens(desk.requests);
      expect(recovered.map((end) => end.finish)).toEqual([
        "follow-up-workflow-finish",
        "desk-workflow-finish",
      ]);
      expect(asked).toHaveLength(1);
      expect(answered).toEqual(asked);
    },
  );

  instanceKeyed(
    "two executions give one value two tokens: each has its own key, in its checkpoint",
    async ({ apps, mockLlm }) => {
      const turns = [
        callTool(LookupTool, { author: AUTHOR }),
        replyWith(DeskNoteDto, { text: "found", author: AUTHOR }),
      ] as const;
      const desk = mockLlm(DeskAgent).thenReturn(...turns, ...turns);
      mockLlm(FollowUpAgent).thenReturn(replyWith("one"), replyWith("two"));
      const [first, second] = pair(apps);

      await second.resume(answerOf(await execute(first, DeskStart, MESSAGE), APPROVE));
      await second.resume(answerOf(await execute(first, DeskStart, MESSAGE), APPROVE));

      const [one, , two] = authorTokens(desk.requests);
      expect(one).toHaveLength(1);
      expect(two).toHaveLength(1);
      expect(two).not.toEqual(one);
      const keys = keysSaved().filter((key) => key !== null);
      expect(keys).toHaveLength(2);
      for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}$/);
    },
  );
});

describe("#334 AC2: a child workflow makes its tokens with its root's key", () => {
  instanceKeyed(
    "a child's model sees the parent's token after a failover",
    async ({ apps, mockLlm }) => {
      const desk = mockLlm(DeskAgent).thenReturn(
        callTool(LookupTool, { author: AUTHOR }),
        replyWith(DeskNoteDto, { text: "found", author: AUTHOR }),
      );
      const followUp = mockLlm(FollowUpAgent).thenReturn(replyWith("followed up"));
      const [first, second] = pair(apps);

      const paused = await execute(first, DeskStart, MESSAGE);
      await second.resume(answerOf(paused, APPROVE));

      const [asked] = authorTokens(desk.requests);
      const [child] = authorTokens(followUp.requests);
      expect(asked).toHaveLength(1);
      expect(child).toEqual(asked);
    },
  );
});

describe("#334: the application's key (here the test's) changes nothing", () => {
  testKeyed(
    "testWith's tokens are the fixed test key's, and no key is checkpointed",
    async ({ app, mockLlm }) => {
      const desk = mockLlm(DeskAgent).thenReturn(
        callTool(LookupTool, { author: AUTHOR }),
        replyWith(DeskNoteDto, { text: "found", author: AUTHOR }),
      );
      mockLlm(FollowUpAgent).thenReturn(replyWith("followed up"));

      await app.resume(answerOf(await execute(app, DeskStart, MESSAGE), APPROVE));

      const fixed = [tokenOf("author", AUTHOR, TEST_PSEUDONYM_KEY, {})];
      expect(authorTokens(desk.requests)).toEqual([fixed, fixed]);
      expect(keysSaved()).toEqual([null]);
    },
  );
});

describe("#334: the key's seams", () => {
  const set = new PiiPolicySet([], "instance-key");

  it("a checkpoint without a key (null, or a task without one) keeps the set's key", () => {
    expect(set.withFieldKey(null)).toBe(set);
    expect(set.withFieldKey(undefined)).toBe(set);
    expect(set.withFieldKey("execution-key").fieldKey).toBe("execution-key");
  });

  it("a trace never shows the execution's key", async () => {
    const mask = observabilityMaskOf(set);
    const shown = await mask.traceData({ piiKey: "a".repeat(64), nested: { piiKey: null } });
    expect(shown).toEqual({ piiKey: "***", nested: { piiKey: null } });
  });
});
