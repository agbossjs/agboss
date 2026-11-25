/**
 * #859 AC3: a file is never smuggled inside a data part — an A2A file is a part of its own, filled
 * into a top-level field, so a DTO an application exchanges over A2A holds `FileDto` at the top
 * level only: one in a nested DTO or a list item is `[a2a.nested-file-field]` at assembly (an
 * exported start's input, its finishes' outputs, an `@A2AAgent`'s input and output), and a client
 * built with such a contract refuses to call.
 */
import { ConfigError } from "../../../src/core/error-families/config-errors.js";
import { hours, minutes, Ttl } from "../../../src/units/index.js";
import { describe, expect, it } from "vitest";
import { A2AAgent } from "../../../src/a2a/a2a-decorator.js";
import { A2AEndpoint } from "../../../src/a2a/a2a-endpoint.decorator.js";
import { A2AClient } from "../../../src/a2a/client/a2a-client.js";
import { FileDto, nestedFileFieldsOf } from "../../../src/dto/standard/file.js";
import { Application } from "../../../src/application/application.js";
import { applicationOf } from "../../../src/application/assemble.js";
import { List, Nested, Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { listOf, oneOf, type ListWrapper } from "../../../src/flow/dto-wrappers.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart } from "../../helpers/flow.js";
import { ReviewRequestDto } from "../fixtures/files.application.js";

/** A list item that carries a file of its own. */
export class AttachmentItemDto {
  @Text({ prompt: "what it is" })
  label!: string;

  @Nested(FileDto, { prompt: "its file" })
  file!: FileDto;
}

/** A request whose files sit in list items. */
export class ItemsRequestDto {
  @List(AttachmentItemDto, { prompt: "the attachments" })
  items!: AttachmentItemDto[];
}

/** A wrapper whose file sits in a nested DTO. */
export class WrappedRequestDto {
  @Nested(ReviewRequestDto, { prompt: "the wrapped request" })
  request!: ReviewRequestDto;
}

const codesOf = async (application: new () => object): Promise<string[]> => {
  try {
    await applicationOf(application);
    return [];
  } catch (error) {
    if (!(error instanceof ConfigError.GraphRules)) throw error;
    return error.violations.map((each) => each.code).filter((code) => code.startsWith("a2a."));
  }
};

function servedWith(
  input: new () => object,
  providers: readonly (new (...args: never[]) => object)[] = [],
) {
  @WorkflowStart({ name: "nested-workflow-start", description: "nested", input })
  class NestedStart {}

  @WorkflowFinish({ name: "nested-workflow-finish", description: "done", output: input })
  class NestedFinish {}

  @Workflow({
    name: "nested-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(NestedStart).toFinish(NestedFinish)],
  })
  class NestedWorkflow {}

  @A2AEndpoint({
    name: "nested-a2a-expose",
    version: "1.0.0",
    description: "n",
    ttl: { tasks: hours(24), messages: minutes(15) },
    skills: [NestedStart],
  })
  class NestedExpose {}

  @Application({
    name: "nested-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [NestedWorkflow],
    providers: [...providers],
    endpoints: [NestedExpose],
    budgets: TEST_BUDGETS,
  })
  class NestedApplication {}
  return NestedApplication;
}

/** An exported start whose one finish gives a list (#1271): the list's items are below the top level. */
function servedWithListOutput(item: ListWrapper) {
  @WorkflowStart({
    name: "listed-workflow-start",
    description: "listed",
    input: listOf(WorkflowStartTextDto),
  })
  class ListedStart {}

  @WorkflowFinish({ name: "listed-workflow-finish", description: "done", output: item })
  class ListedFinish {}

  @Workflow({
    name: "listed-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: [onStart(ListedStart).toFinish(ListedFinish)],
  })
  class ListedWorkflow {}

  @A2AEndpoint({
    name: "listed-a2a-expose",
    version: "1.0.0",
    description: "l",
    ttl: { tasks: hours(24), messages: minutes(15) },
    skills: [ListedStart],
  })
  class ListedExpose {}

  @Application({
    name: "listed-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [ListedWorkflow],
    endpoints: [ListedExpose],
    budgets: TEST_BUDGETS,
  })
  class ListedApplication {}
  return ListedApplication;
}

describe("#1271: a list output of an exported finish never skips the file checks", () => {
  it("items that hold a file at the top level: [a2a.nested-file-field]", async () => {
    expect(await codesOf(servedWithListOutput(listOf(ReviewRequestDto)))).toEqual([
      "a2a.nested-file-field",
    ]);
  });

  it("items that hold a file in a nested DTO: [a2a.nested-file-field]", async () => {
    expect(await codesOf(servedWithListOutput(listOf(WrappedRequestDto)))).toEqual([
      "a2a.nested-file-field",
    ]);
  });

  it("a oneOf variant of the items that holds a file: [a2a.nested-file-field], naming it", async () => {
    expect(
      await codesOf(servedWithListOutput(listOf(WorkflowStartTextDto, ReviewRequestDto))),
    ).toEqual(["a2a.nested-file-field"]);
  });

  it("items without files pass", async () => {
    expect(await codesOf(servedWithListOutput(listOf(WorkflowStartTextDto)))).toEqual([]);
  });
});

describe("#859 AC3: FileDto only at the top level of an A2A DTO", () => {
  it("the paths where a file sits below the top level, a list item's and a nested DTO's", () => {
    expect(nestedFileFieldsOf(ItemsRequestDto)).toEqual(["items[].file"]);
    expect(nestedFileFieldsOf(WrappedRequestDto)).toEqual(["request.document", "request.pages[]"]);
    expect(nestedFileFieldsOf(ReviewRequestDto)).toEqual([]);
  });

  it("an exported start's input (and finish) with a file in a list item: [a2a.nested-file-field]", async () => {
    expect(await codesOf(servedWith(ItemsRequestDto))).toEqual(["a2a.nested-file-field"]);
  });

  it("an exported start's input with a file in a nested DTO: [a2a.nested-file-field] for each path", async () => {
    expect(await codesOf(servedWith(WrappedRequestDto))).toEqual([
      "a2a.nested-file-field",
      "a2a.nested-file-field",
    ]);
  });

  it("an @A2AAgent whose output holds a file in a list item: [a2a.nested-file-field]", async () => {
    @A2AAgent({
      name: "nested-a2a-agent",
      url: "http://agent.test/a2a",
      input: WorkflowStartTextDto,
      output: ItemsRequestDto,
    })
    class NestedA2AAgent extends A2AClient<WorkflowStartTextDto, ItemsRequestDto> {}

    expect(await codesOf(servedWith(ReviewRequestDto, [NestedA2AAgent]))).toEqual([
      "a2a.nested-file-field",
    ]);
  });

  it("a client built with such a contract refuses to call, before anything is sent", async () => {
    const client = new A2AClient<WorkflowStartTextDto, WrappedRequestDto>({
      url: "http://agent.test/a2a",
      fetcher: () => Promise.reject(new Error("nothing is sent")),
      contract: { input: WorkflowStartTextDto, output: WrappedRequestDto },
    });

    await expect(client.execute({ text: "go" })).rejects.toThrow("[a2a.nested-file-field]");
  });
});
