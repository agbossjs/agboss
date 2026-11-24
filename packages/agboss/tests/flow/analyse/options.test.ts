import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../../src/flow/analyse/analyse.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { OfferDraftDto, OfferSentDto } from "../fixtures/dtos.js";
import { ArticleWorkflow } from "../fixtures/article.fixture.js";
import { SecondKitWorkflowStart, SentKitWorkflowFinish } from "../fixtures/kit.fixture.js";
import { onStart } from "../fixtures/paths.js";
import { reviewerAgentOptions } from "../fixtures/reviewer-agent.options.js";

/** Shared agent options come from a static const in an `*.options.ts` file (#272 AC16). */

const OPTIONS_FILE = "tests/flow/fixtures/reviewer-agent.options.ts";

const sendOptions = {
  input: {
    draft: OfferDraftDto,
  },
  output: OfferSentDto,
};

@Action({
  ...sendOptions,
  name: "spread-send-action",
  description: "Sends the offer, with options spread from a const",
})
class SpreadSendAction {
  async execute(): Promise<OfferSentDto> {
    return Promise.resolve({ delivered: true });
  }
}

@Workflow({
  name: "spread-action-workflow",
  version: "1.0.0",
  flow: [
    onStart(SecondKitWorkflowStart).toAction(SpreadSendAction).toFinish(SentKitWorkflowFinish),
  ],
})
class SpreadActionWorkflow {}

const errorsWith = (
  workflow: abstract new () => unknown,
  modules: Parameters<typeof checkWorkflow>[1],
) => checkWorkflow(workflow, modules).errors.map(({ code, message }) => ({ code, message }));

describe("AC16: options from *.options.ts, dynamic options", () => {
  it("two classes spreading a const from an *.options.ts file pass", () => {
    const modules = [{ file: OPTIONS_FILE, exports: { reviewerAgentOptions } }];

    expect(errorsWith(ArticleWorkflow, { modules })).toEqual([]);
  });

  it("a const from another kind of file fails", () => {
    const modules = [{ file: "tests/flow/fixtures/shared.ts", exports: { reviewerAgentOptions } }];

    expect(errorsWith(ArticleWorkflow, { modules })).toEqual(
      ["draft-reviewer-agent", "final-reviewer-agent"].map((agent) => ({
        code: "agent.dynamic-options",
        message: `article-workflow: ${agent} spreads reviewerAgentOptions from tests/flow/fixtures/shared.ts — shared agent options are a static object literal in an *.options.ts file (satisfies Omit<AgentOptions, "name" | "description">)`,
      })),
    );
  });

  it("an *.options.ts file exporting a function (options built by a call) fails", () => {
    const makeOptions = () => reviewerAgentOptions;
    const modules = [{ file: OPTIONS_FILE, exports: { reviewerAgentOptions, makeOptions } }];

    expect(errorsWith(ArticleWorkflow, { modules })).toEqual([
      {
        code: "agent.dynamic-options",
        message: `article-workflow: ${OPTIONS_FILE} exports makeOptions, a function — an *.options.ts file declares static object literals, never options built by a call`,
      },
    ]);
  });

  it("*.options.ts is for agents only", () => {
    const modules = [{ file: "src/actions/send.options.ts", exports: { sendOptions } }];

    expect(errorsWith(SpreadActionWorkflow, { modules })).toEqual([
      {
        code: "agent.dynamic-options",
        message:
          "spread-action-workflow: spread-send-action spreads sendOptions from src/actions/send.options.ts — *.options.ts is for agents only; share logic through a service in deps",
      },
    ]);
  });
});
