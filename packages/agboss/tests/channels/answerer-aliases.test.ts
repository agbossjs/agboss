/**
 * #934 AC2: an application written for 0.1.0 — `@ChannelRole({ answeredBy })`, a reader of
 * `result.pending[0].answeredBy` — still compiles and runs, with a deprecation hint on each alias.
 */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { beforeEach, describe, expect, it } from "vitest";
import { ComponentError } from "../../src/components/metadata.js";
import { ChannelRole, PauseAnswerer } from "../../src/index.js";
import { channelRoleOf } from "../../src/channels/channel-role.decorator.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  ConfirmOrderTool,
  DeskClerkAgent,
  DeskWorkflowStart,
  PausesApplication,
  RefundRequestDto,
  resetPauses,
} from "./fixtures/pauses.workflow.js";

const test = testWith(PausesApplication);

beforeEach(resetPauses);

const OPTIONS = { name: "desk-role", description: "d", approves: RefundRequestDto };

describe("AC2: a role with answeredBy still assembles, the same pauses", () => {
  it("answeredBy alone is read as answerer", () => {
    @ChannelRole({ ...OPTIONS, answeredBy: PauseAnswerer.Channel })
    class OldRole {}
    expect(channelRoleOf(OldRole)?.options.answerer).toBe(PauseAnswerer.Channel);
  });

  it("answerer alone, and both the same, assemble", () => {
    @ChannelRole({ ...OPTIONS, answerer: PauseAnswerer.ThreadOwner })
    class NewRole {}
    @ChannelRole({
      ...OPTIONS,
      answerer: PauseAnswerer.ThreadOwner,
      answeredBy: PauseAnswerer.ThreadOwner,
    })
    class BothRole {}
    expect(channelRoleOf(NewRole)?.options.answerer).toBe(PauseAnswerer.ThreadOwner);
    expect(channelRoleOf(BothRole)?.options.answerer).toBe(PauseAnswerer.ThreadOwner);
  });

  it("both given, different → [channel.role-form]", () => {
    const declare = () => {
      @ChannelRole({
        ...OPTIONS,
        answerer: PauseAnswerer.ThreadOwner,
        answeredBy: PauseAnswerer.Channel,
      })
      class Conflict {}
      return Conflict;
    };
    expect(declare).toThrow(ComponentError);
    expect(declare).toThrow(/\[channel\.role-form\]/);
  });

  it("neither → [channel.role-form] naming answerer", () => {
    const declare = () => {
      // @ts-expect-error — a role names who may answer
      @ChannelRole(OPTIONS)
      class None {}
      return None;
    };
    expect(declare).toThrow(/\[channel\.role-form\].*answerer/);
  });
});

describe("AC2: PendingPause.answeredBy equals answerer", () => {
  test("a pending pause carries both, the same value", async ({ app, mockLlm }) => {
    mockLlm(DeskClerkAgent).thenReturn(callTool(ConfirmOrderTool, { orderId: "7" }));
    const paused = await execute(
      app,
      DeskWorkflowStart,
      { text: "confirm 7" },
      { ownerId: "alice" },
    );
    const [pending] = paused.pending;
    expect(pending?.answerer).toBe(PauseAnswerer.ThreadOwner);
    const fields: Partial<Record<"answeredBy", unknown>> = pending ?? {};
    expect(fields.answeredBy).toBe(pending?.answerer);
  });
});

/** The deprecated flag of each alias, read from the declarations the package publishes. */
function deprecatedOf(file: string, owner: string, name: string): boolean {
  const path = new URL(`../../src/${file}`, import.meta.url).pathname;
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.ES2023,
    true,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === owner)
      for (const member of node.members)
        if (member.name?.getText() === name)
          found = ts.getJSDocTags(member).some((tag) => tag.tagName.text === "deprecated");
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe("AC2: the aliases carry @deprecated", () => {
  it.each([
    ["channels/channel-role.decorator.ts", "ChannelRoleBaseOptions", "answeredBy"],
    ["pause/types.ts", "PendingPauseBase", "answeredBy"],
    ["infrastructure/pause-record.ts", "PauseRecord", "answeredBy"],
    ["flow/runtime/execution-record.ts", "PauseAnswerRecord", "responder"],
    ["eval/run/trace.ts", "EvalPauseTrace", "responder"],
  ])("%s %s.%s", (file, owner, name) => {
    expect(deprecatedOf(file, owner, name)).toBe(true);
  });
});
