// `agboss rag index` interrupted (#891 AC5): a knowledge base whose index runs until its signal aborts
import {
  Agent,
  Application,
  EmptyEnvironment,
  Workflow,
  inline,
  Ttl,
} from "../../../../agboss/src/index.js";
import {
  Rag,
  RagScope,
  RagSource,
  type RagIndexOptions,
  type RagIndexReport,
  type RagRetrieval,
} from "../../../../agboss/src/rag/index.js";
import { TEST_BUDGETS } from "../../../../agboss/tests/flow/fixtures/budgets.js";
import { starOf } from "../../../../agboss/tests/fixtures/test-flow/star.js";
import { testConfig, testDefaults } from "../../../../agboss/tests/helpers.js";

/** What the test sees of the run: that it started, and whether its signal aborted it. */
export interface InterruptProbe {
  started: boolean;
  aborted: boolean;
}

/** One probe for the process, whichever module loader imports this file. */
export const interruptProbe = (): InterruptProbe => {
  const global = globalThis as { agbossRagInterruptProbe?: InterruptProbe };
  global.agbossRagInterruptProbe ??= { started: false, aborted: false };
  return global.agbossRagInterruptProbe;
};

@Rag({
  name: "slow-rag",
  description: "An index that takes long",
  scope: RagScope.Shared,
  topK: 2,
})
export class SlowRag extends RagSource {
  protected override retrieve(): RagRetrieval {
    return { results: [] };
  }

  protected override index({ signal }: RagIndexOptions): Promise<RagIndexReport> {
    const probe = interruptProbe();
    probe.started = true;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        probe.aborted = true;
        reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      });
    });
  }
}

@Agent({
  name: "slow-reader-agent",
  description: "Reads the slow knowledge base",
  prompt: inline("Read."),
  model: "test/alpha",
  price: testConfig.agents.alpha.price,
  rag: [SlowRag],
})
export class SlowReaderAgent {}

@Workflow({
  name: "slow-notes-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  defaults: testDefaults,
  flow: starOf(SlowReaderAgent),
})
export class SlowNotesWorkflow {}

@Application({
  name: "slow-notes-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SlowNotesWorkflow],
  budgets: TEST_BUDGETS,
})
export class SlowNotesApplication {}
