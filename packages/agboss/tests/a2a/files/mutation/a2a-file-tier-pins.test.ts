import { hours, minutes } from "../../../../src/units/index.js";
/**
 * #1244: the storage tier's size, pinned: of each exported start, its input's files take
 * `maxTotalFileSize`, its finishes' files `maxFileSize`; the most of them all.
 */
import { describe, expect, it } from "vitest";
import { A2AEndpoint } from "../../../../src/a2a/a2a-endpoint.decorator.js";
import { FileDto, WorkflowFinishFileDto } from "../../../../src/dto/standard/file.js";
import { FilePolicy, type FilePolicyOptions } from "../../../../src/files/file-policy.js";
import { fileTierSizeOf, finishDtosOf } from "../../../../src/a2a/files/a2a-file-tier.js";
import { Injectable } from "../../../../src/components/decorators.js";
import type { Class } from "../../../../src/components/injection.js";
import { List, Nested, Text, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { Action } from "../../../../src/flow/decorators/action.js";
import type { Produced } from "../../../../src/index.js";
import { Workflow } from "../../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../../src/flow/decorators/workflow-start.js";
import type { Bytes } from "../../../../src/units/index.js";
import { oneOf, variant, type Variant } from "../../../../src/flow/dto-wrappers.js";
import { onStart, toFinish } from "../../../helpers/flow.js";
import {
  FileReviewFinish,
  FilesA2AExpose,
  FileReviewWorkflow,
  FileReviewWorkflowStart,
  FileSummaryWorkflow,
  ReviewRequestDto,
  ReviewResultDto,
} from "../../fixtures/files.application.js";
import { ComponentOptions } from "../../../../src/components/component-options.js";

class FilesInDto {
  @Nested(FileDto, { prompt: "f" })
  file!: FileDto;
}
class TextDto {
  @Text({ prompt: "t" })
  text!: string;
}

let counter = 0;

interface Skill {
  readonly expose: Class;
  readonly workflow: Class;
  readonly start: Class;
}

/** An exported skill whose input and finish hold files (or not). */
function skill(
  input: new () => object,
  output: new () => object,
  files: FilePolicyOptions = SIZES,
): Skill {
  counter += 1;
  const id = `tier-${String(counter)}`;

  @WorkflowStart({ name: `${id}-workflow-start`, description: "s", input })
  class TierStart {}

  @WorkflowFinish({ name: `${id}-workflow-finish`, description: "f", output })
  class TierFinish {}

  @FilePolicy({ ttl: hours(24), name: `${id}-file-policy`, ...files })
  class TierPolicy {}

  @Workflow({
    name: `${id}-workflow`,
    version: "1.0.0",
    flow: [onStart(TierStart).toFinish(TierFinish)],
    filePolicy: TierPolicy,
  })
  class TierWorkflow {}

  @A2AEndpoint({
    name: `${id}-a2a-expose`,
    version: "1.0.0",
    description: "t",
    ttl: { tasks: hours(24), messages: minutes(15) },
    skills: [TierStart],
  })
  class TierExpose {}

  return { expose: TierExpose, workflow: TierWorkflow, start: TierStart };
}

const SIZES: FilePolicyOptions = { maxFileSize: 100 as Bytes, maxTotalFileSize: 1000 as Bytes };
const tierOf = (skills: readonly Skill[]): number =>
  fileTierSizeOf(
    skills.map((each) => each.expose),
    skills.map((each) => each.workflow),
    ComponentOptions.none,
  );

describe("fileTierSizeOf", () => {
  it("files in the input only: the total limit", () => {
    expect(tierOf([skill(FilesInDto, TextDto)])).toBe(1000);
  });

  it("files in a finish only: the file limit", () => {
    expect(tierOf([skill(TextDto, FilesInDto)])).toBe(100);
    expect(tierOf([skill(TextDto, WorkflowFinishFileDto)])).toBe(100);
  });

  it("a list of files counts as files", () => {
    class ListedDto {
      @List(FileDto, { prompt: "l" })
      files!: FileDto[];
    }
    expect(tierOf([skill(ListedDto, TextDto)])).toBe(1000);
  });

  it("both: the larger of the two", () => {
    expect(tierOf([skill(FilesInDto, FilesInDto)])).toBe(1000);
    expect(
      tierOf([
        skill(FilesInDto, FilesInDto, {
          maxFileSize: 5000 as Bytes,
          maxTotalFileSize: 1000 as Bytes,
        }),
      ]),
    ).toBe(5000);
  });

  it("no files at all: 0, and with no skills: 0", () => {
    expect(tierOf([skill(TextDto, TextDto)])).toBe(0);
    expect(tierOf([skill(WorkflowStartTextDto, TextDto)])).toBe(0);
    expect(tierOf([])).toBe(0);
  });

  it("a start whose input is a map of fields takes no files of its own", () => {
    counter += 1;
    const id = `tier-map-${String(counter)}`;

    @WorkflowStart({ name: `${id}-workflow-start`, description: "s", input: { doc: FilesInDto } })
    class MapStart {}

    @WorkflowFinish({ name: `${id}-workflow-finish`, description: "f", output: TextDto })
    class MapFinish {}

    @Workflow({
      name: `${id}-workflow`,
      version: "1.0.0",
      flow: [onStart(MapStart).toFinish(MapFinish)],
    })
    class MapWorkflow {}

    @A2AEndpoint({
      name: `${id}-a2a-expose`,
      version: "1.0.0",
      description: "m",
      ttl: { tasks: hours(24), messages: minutes(15) },
      skills: [MapStart],
    })
    class MapExpose {}

    expect(tierOf([{ expose: MapExpose, workflow: MapWorkflow, start: MapStart }])).toBe(0);
  });

  it("the most of all exported skills; each skill's workflow policy its own", () => {
    const small = skill(FilesInDto, TextDto, {
      maxFileSize: 100 as Bytes,
      maxTotalFileSize: 300 as Bytes,
    });
    const big = skill(FilesInDto, TextDto, {
      maxFileSize: 100 as Bytes,
      maxTotalFileSize: 700 as Bytes,
    });
    const none = skill(TextDto, TextDto);

    expect(tierOf([small, none, big, small])).toBe(700);
    expect(tierOf([small])).toBe(300);
    expect(tierOf([none, small])).toBe(300);
  });

  it("a workflow policy that sets no size takes the default", () => {
    const plain = skill(FilesInDto, TextDto, {});

    expect(tierOf([plain])).toBe(64 * 1024);
  });

  it("only an @A2AEndpoint counts: a class that is none (or no component) is skipped", () => {
    @Injectable({ deps: [] })
    class NotAnExpose {}
    class Undecorated {
      readonly bare = true;
    }
    const real = skill(FilesInDto, TextDto);

    expect(
      fileTierSizeOf(
        [NotAnExpose, Undecorated, real.expose],
        [real.workflow],
        ComponentOptions.none,
      ),
    ).toBe(1000);
  });

  it("an export that is no start, or no declaration, keeps no file", () => {
    counter += 1;
    const id = `tier-odd-${String(counter)}`;

    @WorkflowFinish({ name: `${id}-workflow-finish`, description: "f", output: FilesInDto })
    class OddFinish {}
    class Undecorated {
      readonly bare = true;
    }

    @A2AEndpoint({
      name: `${id}-a2a-expose`,
      version: "1.0.0",
      description: "o",
      ttl: { tasks: hours(24), messages: minutes(15) },
      skills: [OddFinish, Undecorated],
    })
    class OddExpose {}

    expect(fileTierSizeOf([OddExpose], [], ComponentOptions.none)).toBe(0);
  });
});

@Action({
  name: "tier-mixed-action",
  description: "Answers with a report or a text",
  input: { request: ReviewRequestDto },
  output: oneOf(ReviewResultDto, TextDto),
})
class MixedAction {
  execute(_input: {
    readonly request: Produced<ReviewRequestDto, unknown>;
  }): Promise<Variant<typeof ReviewResultDto | typeof TextDto>> {
    return Promise.resolve(variant(TextDto, { text: "no report" }));
  }
}

@WorkflowFinish({ name: "tier-mixed-text-workflow-finish", description: "t", output: TextDto })
class MixedTextFinish {}

@FilePolicy({
  ttl: hours(24),
  name: "tier-mixed-file-policy",
  maxFileSize: 5000 as Bytes,
  maxTotalFileSize: 5000 as Bytes,
})
class MixedPolicy {}

@Workflow({
  name: "tier-mixed-workflow",
  version: "1.0.0",
  filePolicy: MixedPolicy,
  flow: [
    onStart(FileReviewWorkflowStart)
      .toAction(MixedAction)
      .toOneOf([toFinish(FileReviewFinish), toFinish(MixedTextFinish)]),
  ],
})
class MixedWorkflow {}

describe("a skill whose finishes differ", () => {
  it("files in only one of its finishes count: the file limit is in", () => {
    expect(fileTierSizeOf([FilesA2AExpose], [MixedWorkflow], ComponentOptions.none)).toBe(5000);
  });
});

describe("finishDtosOf", () => {
  it("the output DTO of each finish by its name, not of an action", () => {
    const summary = finishDtosOf(FileReviewWorkflowStart, [
      FileReviewWorkflow,
      FileSummaryWorkflow,
    ]);

    expect([...summary.entries()]).toEqual([
      ["file-review-workflow-finish", ReviewResultDto],
      ["file-returned-workflow-finish", WorkflowFinishFileDto],
    ]);
    expect(summary.size).toBe(2);
  });

  it("a start no workflow holds: none", () => {
    class Elsewhere {
      readonly bare = true;
    }

    expect(finishDtosOf(Elsewhere, [FileReviewWorkflow]).size).toBe(0);
    expect(finishDtosOf(FileReviewWorkflowStart, []).size).toBe(0);
  });
});
