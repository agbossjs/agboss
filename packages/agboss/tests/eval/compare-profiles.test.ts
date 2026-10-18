import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compareProfiles } from "../../src/index.js";
import type { ModelGateway } from "../../src/llm/gateway.js";
import type { RouteOutcome, RouteRequest } from "../../src/routers/index.js";
import { createSqliteTernStore } from "../../src/terns/index.js";
import { replyWith, routeTo } from "../../src/testing/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import {
  CodeDto,
  CodeReview,
  PullRequest,
  ReviewDto,
} from "../testing/fixtures/code-review.workflow.js";

/** `profiles/code-review-workflow/terse.yaml`: the coder's prompt replaced. */
const root = mkdtempSync(join(tmpdir(), "profiles-"));
mkdirSync(join(root, "profiles", "code-review-workflow"), { recursive: true });
writeFileSync(
  join(root, "profiles", "code-review-workflow", "terse.yaml"),
  "profile: terse\nversion: 1.0.0-terse\nprompts:\n  coder-agent: Code tersely.\n",
);

const decided = (next: string, confidence: number): RouteOutcome => ({
  kind: "decided",
  decision: { next, reason: "scripted judge", confidence },
});

/** The eval judge prefers terse reviews: scores them 0.75 (others 0.25), and picks them pairwise. */
function judge(request: RouteRequest): RouteOutcome {
  const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
  if (request.options.some((option) => option.name === "first")) {
    return decided(input.indexOf("terse") < input.indexOf("Answer 2:") ? "first" : "second", 0.9);
  }
  return decided(input.includes("terse") ? "adequate" : "inadequate", 0.75);
}

/** Scripted models: the coder answers by its (profiled) prompt; the eval judge as above or none. */
function scriptedGateway(judging: boolean): ModelGateway {
  const book = new ScriptBook();
  book.scriptOf("agent:coder-agent").thenAnswer((req) =>
    replyWith(CodeDto, {
      text: req.kind === "chat" && req.system.includes("tersely") ? "diff, terse" : "diff, long",
    }),
  );
  book.scriptOf("agent:reviewer-agent").thenReturnAlways(replyWith(ReviewDto, { text: "LGTM" }));
  book.scriptOf("router:review-gate-router").thenReturnAlways(routeTo(PullRequest));
  const scripted = createScriptedGateway(book);
  return {
    chatModel: scripted.chatModel,
    routeTo: (spec) =>
      spec.router !== "judge"
        ? scripted.routeTo(spec)
        : Promise.resolve(judging ? judge(spec.request) : { kind: "failed", reason: "no judge" }),
  };
}

const compare = (judging: boolean) =>
  compareProfiles(CodeReview, {
    profiles: ["base", "terse"],
    tasks: ["fix the bug", "add a test"],
    profileRoot: root,
    gateway: scriptedGateway(judging),
    processEnv: {},
  });

describe("AC2 (#204): one eval system — A/B of two profiles from one API", () => {
  it("runs both profiles on the same tasks, scores them with the judge and compares them pairwise", async () => {
    const comparison = await compare(true);

    expect(comparison.tasks).toBe(2);
    expect(comparison.profiles).toMatchObject([
      { name: "base", version: "1.0.0", meanScore: 0.25, scored: 2, pairwise: null, diff: [] },
      {
        name: "terse",
        version: "1.0.0-terse",
        meanScore: 0.75,
        scored: 2,
        failed: 0,
        pairwise: { wins: 2, losses: 0, ties: 0 },
        diff: ["prompts.coder-agent: changed"],
      },
    ]);
  });

  it("a judge that does not answer scores nothing — no case passes by default", async () => {
    const comparison = await compare(false);

    expect(comparison.profiles.map((row) => [row.meanScore, row.scored])).toEqual([
      [null, 0],
      [null, 0],
    ]);
    expect(comparison.profiles[1]?.pairwise).toEqual({ wins: 0, losses: 0, ties: 2 });
  });

  it("needs at least two profiles", async () => {
    await expect(
      compareProfiles(CodeReview, { profiles: ["base"], tasks: ["t"], processEnv: {} }),
    ).rejects.toThrow("compare needs at least two profiles");
  });
});
