/**
 * #1303c: `@Memory({ ttl })` is what the recovery sweep removes an idle thread by — each workflow's
 * own ttl from its own memory; a stateless workflow and a `Ttl.Forever` memory are never swept.
 */
import { describe, expect, it } from "vitest";
import {
  Agent,
  Application,
  EmptyEnvironment,
  Memory,
  Ttl,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
} from "../../src/index.js";
import type { Class } from "../../src/components/injection.js";
import { applicationOf } from "../../src/application/assemble.js";
import { retentionSourcesOf } from "../../src/application/retention-sources.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { hours } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";

@Memory({ name: "hour-memory", description: "An hour", ttl: hours(1), uncompactedTurns: 2 })
class HourMemory {}

@Memory({ name: "forever-memory", description: "For ever", ttl: Ttl.Forever })
class ForeverMemory {}

const workflowOf = (name: string, memory?: Class) => {
  @WorkflowStart({
    name: `${name}-workflow-start`,
    description: "A message",
    input: WorkflowStartTextDto,
  })
  class Start {}
  @WorkflowFinish({
    name: `${name}-workflow-finish`,
    description: "The answer",
    output: WorkflowFinishTextDto,
  })
  class Finish {}
  @Agent({
    name: `${name}-agent`,
    description: "Answers",
    prompt: inline("Answer."),
    model: "test/chat",
  })
  class Replier {}
  @Workflow({
    name: `${name}-workflow`,
    version: "1.0.0",
    flow: [onStart(Start).toAgent(Replier).toFinish(Finish)],
    ...(memory === undefined ? {} : { memory }),
  })
  class Named {}
  return Named;
};

const ttlsOf = async (workflows: readonly Class[], records: object) => {
  @Application({
    name: "ttl-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows,
    budgets: TEST_BUDGETS,
  })
  class TtlApplication {}
  const assembled = await applicationOf(TtlApplication);
  return retentionSourcesOf({ records, clock: {} } as never, assembled);
};

describe("#1303c: the ttl of a workflow's memory reaches the sweep", () => {
  it("lists a workflow whose memory keeps a thread for a duration, by workflow name", async () => {
    const records = {};

    const sources = await ttlsOf([workflowOf("hour", HourMemory)], records);

    expect(sources.threadTtls).toEqual(new Map([["hour-workflow", hours(1)]]));
    expect(sources.threadRecords).toBe(records);
  });

  it("lists no workflow that is stateless or keeps its threads for ever", async () => {
    const forever = await ttlsOf([workflowOf("forever", ForeverMemory)], {});
    const stateless = await ttlsOf([workflowOf("plain")], {});

    expect(forever.threadTtls).toEqual(new Map());
    expect(stateless.threadTtls).toEqual(new Map());
  });
});
