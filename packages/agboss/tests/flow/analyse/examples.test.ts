import { describe, expect, it } from "vitest";
import {
  analyseWorkflow,
  checkWorkflow,
  inputShapesOf,
} from "../../../src/flow/analyse/analyse.js";
import { ArticleWorkflow } from "../fixtures/article.fixture.js";
import { ChatWorkflow } from "../fixtures/chat.fixture.js";
import { OfferWorkflow } from "../fixtures/offer.fixture.js";
import { OrderWorkflow } from "../fixtures/order.fixture.js";
import { SupportWorkflow } from "../fixtures/support.fixture.js";
import { HistoryOfferWorkflow } from "../fixtures/history.fixture.js";

/** The #272 examples 1–3 and the #270 examples assemble: no rule is broken. */

describe("AC11: the #272 and #270 examples pass every rule", () => {
  it.each([
    ["chat (a router in a loop)", ChatWorkflow],
    ["offer (a review loop with an own path)", OfferWorkflow],
    ["article (two classes of one agent)", ArticleWorkflow],
    ["order (errors and a rollback)", OrderWorkflow],
    ["support (#270: router, optional loyalty)", SupportWorkflow],
    ["history offer (#299: historyOf in a loop)", HistoryOfferWorkflow],
  ])("%s", (_, workflow) => {
    expect(checkWorkflow(workflow)).toMatchObject({ errors: [], warnings: [] });
  });

  it("returns the analysed graph and each node's input shapes (S4)", () => {
    const analysis = analyseWorkflow(OfferWorkflow);

    expect([...analysis.graph.nodes.keys()]).toEqual([
      "draft-agent",
      "editor-agent",
      "notify-recruiter-action",
      "offer-failed-workflow-finish",
      "offer-sent-workflow-finish",
      "offer-workflow-start",
      "reviewer-agent",
      "send-offer-action",
    ]);
    const changes = { name: "changes", isPresent: true, producers: ["reviewer-agent"] };
    expect(inputShapesOf(analysis, "editor-agent")).toEqual([
      [{ name: "draft", isPresent: true, producers: ["draft-agent"] }, changes],
      [{ name: "draft", isPresent: true, producers: ["editor-agent"] }, changes],
    ]);
  });
});
