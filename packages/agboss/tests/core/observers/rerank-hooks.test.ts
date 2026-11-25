/**
 * #1343 (#1299): `onRerankStart` / `onRerankEnd` — told for each reranking, in the step (or the
 * search tool's call) that retrieves: reranked with its spend, fell back, or failed the step — a
 * start always has its end; never the query or a passage.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Observer,
  RerankOutcome,
  type RerankEndEvent,
  type RerankStartEvent,
} from "../../../src/index.js";
import type { App } from "../../../src/app/types.js";
import { createTestAppWith } from "../../../src/testing/create-app-with.js";
import { replyWith } from "../../../src/testing/index.js";
import { ScriptBook } from "../../../src/testing/script-book.js";
import { createScriptedGateway } from "../../../src/testing/scripted-gateway.js";
import { usd } from "../../../src/units/index.js";
import { execute } from "../../helpers/flow.js";
import {
  ANSWER,
  FALLBACK_CONTEXT,
  MODEL_CONTEXT,
  rerankApplication,
  STRICT_CONTEXT,
} from "../../rag/fixtures/rerank.application.js";

const events: (RerankStartEvent | RerankEndEvent)[] = [];

@Observer()
class RerankWatch {
  onRerankStart(event: RerankStartEvent): void {
    events.push(event);
  }

  onRerankEnd(event: RerankEndEvent): void {
    events.push(event);
  }
}

let app: App | undefined;
beforeEach(() => {
  events.length = 0;
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const QUESTION = "When does on-call start?";

async function appWith(book: ScriptBook): Promise<App> {
  app = await createTestAppWith(rerankApplication(undefined, [RerankWatch]), {
    gateway: createScriptedGateway(book),
  });
  return app;
}

const endOf = (): RerankEndEvent => {
  const end = events.find((event): event is RerankEndEvent => "outcome" in event);
  if (end === undefined) throw new Error("no onRerankEnd was told");
  return end;
};

describe("#1343: onRerankStart / onRerankEnd", () => {
  it("a reranking is told with its candidates, its results and what its model cost", async () => {
    const book = new ScriptBook();
    book
      .scriptOf("reranker:docs-reranker")
      .thenReturn(replyWith('{"ranking":[27,1,2]}', { cost: usd(0.002) }));
    book.scriptOf("agent:model-context-agent").thenReturn(replyWith("done"));

    await execute(await appWith(book), MODEL_CONTEXT.start, { text: QUESTION });

    expect(events.map((event) => ("outcome" in event ? "end" : "start"))).toEqual(["start", "end"]);
    expect(events[0]).toMatchObject({
      rag: "model-ranked-rag",
      reranker: "docs-reranker",
      candidates: 30,
      topK: 3,
      step: { component: { name: "model-context-agent" } },
      workflow: { name: "model-context-workflow" },
    });
    expect(endOf()).toMatchObject({ outcome: RerankOutcome.Reranked, results: 3, costUsd: 0.002 });
  });

  it("a reranker that failed under Fallback ends FellBack, the first topK going on", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:fallback-context-agent").thenReturn(replyWith("done"));

    await execute(await appWith(book), FALLBACK_CONTEXT.start, { text: QUESTION });

    expect(endOf()).toMatchObject({ outcome: RerankOutcome.FellBack, results: 3 });
  });

  it("a reranker that failed the step still ends, Failed", async () => {
    const book = new ScriptBook();
    book.scriptOf("agent:strict-context-agent").thenReturn(replyWith("never"));

    await execute(await appWith(book), STRICT_CONTEXT.start, { text: QUESTION }).catch(
      () => undefined,
    );

    expect(events).toHaveLength(2);
    expect(endOf()).toMatchObject({ outcome: RerankOutcome.Failed, results: 0 });
  });

  it("an event shows names and counts, never the query or a passage", async () => {
    const book = new ScriptBook();
    book.scriptOf("reranker:docs-reranker").thenReturn(replyWith('{"ranking":[27,1,2]}'));
    book.scriptOf("agent:model-context-agent").thenReturn(replyWith("done"));

    await execute(await appWith(book), MODEL_CONTEXT.start, { text: QUESTION });

    const shown = JSON.stringify(events);
    expect(shown).not.toContain(QUESTION);
    expect(shown).not.toContain(ANSWER.text);
  });
});
