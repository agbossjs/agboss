/**
 * #1316f: `executionContext.handledError` is the failure the `.onError` side path a step runs on
 * took in — the record `ExecutionOutput.handledErrors` keeps — and `undefined` on any other step.
 */
import { describe, expect } from "vitest";
import { Text } from "../../../src/dto/index.js";
import {
  Action,
  Application,
  EmptyEnvironment,
  ExecutionContext,
  Injectable,
  StepFailedError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type HandledErrorRecord,
} from "../../../src/index.js";
import { testWith } from "../../../src/testing/index.js";
import { execute, onStart, toAction } from "../../helpers/flow.js";
import { TEST_BUDGETS } from "../fixtures/budgets.js";

class JobDto {
  @Text() name!: string;
}
class DoneDto {
  @Text() text!: string;
}

const seen: { step: string; handled: HandledErrorRecord | undefined }[] = [];

@Injectable({ deps: [ExecutionContext] })
class Reader {
  constructor(private readonly executionContext: ExecutionContext) {}
  note(step: string): void {
    seen.push({ step, handled: this.executionContext.handledError });
  }
}

@WorkflowStart({ name: "handled-workflow-start", description: "A job", input: JobDto })
class HandledStart {}

@Action({
  name: "plain-handled-action",
  description: "Runs first",
  input: { job: JobDto },
  deps: [Reader],
  output: JobDto,
})
class PlainAction {
  constructor(private readonly reader: Reader) {}
  execute(input: { readonly job: JobDto }): JobDto {
    this.reader.note("plain");
    return input.job;
  }
}

@Action({
  name: "failing-handled-action",
  description: "Fails",
  input: { job: JobDto },
  deps: [Reader],
  output: DoneDto,
})
class FailingAction {
  constructor(private readonly reader: Reader) {}
  execute(): DoneDto {
    this.reader.note("failing");
    throw new Error("boom");
  }
}

@Action({
  name: "recover-handled-action",
  description: "Recovers",
  input: { job: JobDto },
  deps: [Reader],
  output: DoneDto,
})
class RecoverAction {
  constructor(private readonly reader: Reader) {}
  execute(): DoneDto {
    this.reader.note("recover");
    return { text: "recovered" };
  }
}

@WorkflowFinish({ name: "handled-workflow-finish", description: "Done", output: DoneDto })
class HandledFinish {}

@Workflow({
  name: "handled-workflow",
  version: "1.0.0",
  flow: [
    onStart(HandledStart)
      .toAction(PlainAction)
      .toAction(FailingAction)
      .onError(StepFailedError, toAction(RecoverAction).toFinish(HandledFinish))
      .toFinish(HandledFinish),
  ],
})
class HandledWorkflow {}

@Application({
  name: "handled-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [HandledWorkflow],
  budgets: TEST_BUDGETS,
})
class HandledApplication {}

const test = testWith(HandledApplication);

describe("#1316f: executionContext.handledError", () => {
  test("the step on the side path reads the failure it took in; steps off it read none", async ({
    app,
  }) => {
    seen.length = 0;

    const result = await execute(app, HandledStart, { name: "j" });

    expect(seen.map((one) => one.step)).toEqual(["plain", "failing", "recover"]);
    expect(seen[0]?.handled).toBeUndefined();
    expect(seen[1]?.handled).toBeUndefined();
    expect(seen[2]?.handled).toMatchObject({
      at: { name: "failing-handled-action" },
      by: { name: "recover-handled-action" },
    });
    expect(seen[2]?.handled).toEqual(result.handledErrors[0]);
  });
});
