/**
 * #1356 (shard `a2a-files`): the finishes of a skill told apart — which hold a list (and of what), and that a skill
 * whose input takes no file and of whose finishes only one gives files still counts the file limit, never the total.
 */
import { describe, expect, it } from "vitest";
import { A2AEndpoint } from "../../../../src/a2a/a2a-endpoint.decorator.js";
import { fileTierSizeOf, listFinishItemsOf } from "../../../../src/a2a/files/a2a-file-tier.js";
import { ComponentOptions } from "../../../../src/components/component-options.js";
import { Nested, Text } from "../../../../src/dto/index.js";
import { FileDto } from "../../../../src/dto/standard/file.js";
import { Action } from "../../../../src/flow/decorators/action.js";
import { Workflow } from "../../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../../src/flow/decorators/workflow-start.js";
import { listOf, oneOf } from "../../../../src/flow/dto-wrappers.js";
import { FilePolicy } from "../../../../src/files/file-policy.js";
import { hours, minutes, Ttl, type Bytes } from "../../../../src/units/index.js";
import { onStart, toFinish } from "../../../helpers/flow.js";

class TextOnlyDto {
  @Text({ prompt: "t" })
  text!: string;
}
class WithFileDto {
  @Nested(FileDto, { prompt: "f" })
  file!: FileDto;
}

@WorkflowStart({ name: "tier-exact-workflow-start", description: "s", input: TextOnlyDto })
class ExactStart {}
@WorkflowFinish({ name: "tier-exact-files-workflow-finish", description: "f", output: WithFileDto })
class ExactFilesFinish {}
@WorkflowFinish({ name: "tier-exact-text-workflow-finish", description: "t", output: TextOnlyDto })
class ExactTextFinish {}
@WorkflowFinish({
  name: "tier-exact-list-workflow-finish",
  description: "l",
  output: listOf(TextOnlyDto),
})
class ExactListFinish {}

@Action({
  name: "tier-exact-action",
  description: "Answers with files or a text",
  input: { request: TextOnlyDto },
  output: oneOf(WithFileDto, TextOnlyDto),
})
class ExactAction {
  execute(): Promise<WithFileDto | TextOnlyDto> {
    return Promise.resolve({ text: "x" });
  }
}

@FilePolicy({
  ttl: hours(24),
  name: "tier-exact-file-policy",
  maxFileSize: 100 as Bytes,
  maxTotalFileSize: 1000 as Bytes,
})
class ExactPolicy {}

@Workflow({
  name: "tier-exact-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  filePolicy: ExactPolicy,
  flow: [
    onStart(ExactStart)
      .toAction(ExactAction)
      .toOneOf([toFinish(ExactFilesFinish), toFinish(ExactTextFinish)]),
  ],
})
class ExactWorkflow {}

@Workflow({
  name: "tier-exact-lists-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(ExactStart).toFinish(ExactListFinish)],
})
class ExactListsWorkflow {}

@A2AEndpoint({
  name: "tier-exact-a2a-expose",
  version: "1.0.0",
  description: "t",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [ExactStart],
})
class ExactExpose {}

describe("#1356: the file tier of a skill", () => {
  it("whose input takes no file and of whose finishes only one gives some counts the file limit", () => {
    expect(fileTierSizeOf([ExactExpose], [ExactWorkflow], ComponentOptions.none)).toBe(100);
  });
});

@A2AEndpoint({
  name: "tier-exact-finish-a2a-expose",
  version: "1.0.0",
  description: "t",
  ttl: { tasks: hours(24), messages: minutes(15) },
  skills: [ExactFilesFinish],
})
class FinishExpose {}

describe("#1356: an export that is no start", () => {
  it("keeps no file, though the finish it names gives some in a workflow it is part of", () => {
    expect(fileTierSizeOf([FinishExpose], [ExactWorkflow], ComponentOptions.none)).toBe(0);
  });
});

describe("#1356: the list finishes of a skill", () => {
  it("are told by their name with the class of their items, and a finish that is no list is left out", () => {
    expect([...listFinishItemsOf(ExactStart, [ExactListsWorkflow]).entries()]).toEqual([
      ["tier-exact-list-workflow-finish", [TextOnlyDto]],
    ]);
    expect(listFinishItemsOf(ExactStart, [ExactWorkflow]).size).toBe(0);
  });

  it("are none for a start no workflow holds", () => {
    class Elsewhere {
      readonly bare = true;
    }

    expect(listFinishItemsOf(Elsewhere, [ExactListsWorkflow]).size).toBe(0);
    expect(listFinishItemsOf(ExactStart, []).size).toBe(0);
  });
});
