/**
 * #1244: the storage tier's size, pinned: of each exported start, its input's files take
 * `maxTotalFileSize`, its finishes' files `maxFileSize`; the most of them all.
 */
import { describe, expect, it } from "vitest";
import { A2AExpose } from "../../../../src/a2a/a2a-expose.decorator.js";
import { A2AFileDto, WorkflowFinishFileDto } from "../../../../src/a2a/files/a2a-file.dto.js";
import type { A2AFileOptions } from "../../../../src/a2a/files/a2a-file-options.js";
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
import { caseOf, onStart } from "../../../helpers/flow.js";
import {
  FileReviewFinish,
  FilesA2AExpose,
  FileReviewWorkflow,
  FileReviewWorkflowStart,
  FileSummaryWorkflow,
  ReviewRequestDto,
  ReviewResultDto,
} from "../../fixtures/files.application.js";

class FilesInDto {
  @Nested(A2AFileDto, { prompt: "f" })
  file!: A2AFileDto;
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
function skill(input: new () => object, output: new () => object, files?: A2AFileOptions): Skill {
  counter += 1;
  const id = `tier-${String(counter)}`;

  @WorkflowStart({ name: `${id}-workflow-start`, description: "s", input })
  class TierStart {}

  @WorkflowFinish({ name: `${id}-workflow-finish`, description: "f", output })
  class TierFinish {}

  @Workflow({
    name: `${id}-workflow`,
    version: "1.0.0",
    flow: [onStart(TierStart).toFinish(TierFinish)],
  })
  class TierWorkflow {}

  @A2AExpose({
    name: `${id}-a2a-expose`,
    version: "1.0.0",
    description: "t",
    exports: [TierStart],
    ...(files === undefined ? {} : { skills: { [`${id}-workflow-start`]: { files } } }),
  })
  class TierExpose {}

  return { expose: TierExpose, workflow: TierWorkflow, start: TierStart };
}

const SIZES: A2AFileOptions = { maxFileSize: 100 as Bytes, maxTotalFileSize: 1000 as Bytes };
const tierOf = (skills: readonly Skill[], application?: A2AFileOptions): number =>
  fileTierSizeOf(
    skills.map((each) => each.expose),
    skills.map((each) => each.workflow),
    application,
  );

describe("fileTierSizeOf", () => {
  it("files in the input only: the total limit", () => {
    expect(tierOf([skill(FilesInDto, TextDto)], SIZES)).toBe(1000);
  });

  it("files in a finish only: the file limit", () => {
    expect(tierOf([skill(TextDto, FilesInDto)], SIZES)).toBe(100);
    expect(tierOf([skill(TextDto, WorkflowFinishFileDto)], SIZES)).toBe(100);
  });

  it("a list of files counts as files", () => {
    class ListedDto {
      @List(A2AFileDto, { prompt: "l" })
      files!: A2AFileDto[];
    }
    expect(tierOf([skill(ListedDto, TextDto)], SIZES)).toBe(1000);
  });

  it("both: the larger of the two", () => {
    expect(tierOf([skill(FilesInDto, FilesInDto)], SIZES)).toBe(1000);
    expect(
      tierOf([skill(FilesInDto, FilesInDto)], {
        maxFileSize: 5000 as Bytes,
        maxTotalFileSize: 1000 as Bytes,
      }),
    ).toBe(5000);
  });

  it("no files at all: 0, and with no skills: 0", () => {
    expect(tierOf([skill(TextDto, TextDto)], SIZES)).toBe(0);
    expect(tierOf([skill(WorkflowStartTextDto, TextDto)], SIZES)).toBe(0);
    expect(tierOf([], SIZES)).toBe(0);
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

    @A2AExpose({
      name: `${id}-a2a-expose`,
      version: "1.0.0",
      description: "m",
      exports: [MapStart],
    })
    class MapExpose {}

    expect(tierOf([{ expose: MapExpose, workflow: MapWorkflow, start: MapStart }], SIZES)).toBe(0);
  });

  it("the most of all exported skills; each skill's own options over the application's", () => {
    const small = skill(FilesInDto, TextDto, { maxTotalFileSize: 300 as Bytes });
    const big = skill(FilesInDto, TextDto, { maxTotalFileSize: 700 as Bytes });
    const none = skill(TextDto, TextDto);

    expect(tierOf([small, none, big, small], SIZES)).toBe(700);
    expect(tierOf([small], SIZES)).toBe(300);
    expect(tierOf([none, small], SIZES)).toBe(300);
  });

  it("an expose with no files option for its skill takes the application's, then the default", () => {
    const plain = skill(FilesInDto, TextDto);

    expect(tierOf([plain], SIZES)).toBe(1000);
    expect(tierOf([plain], undefined)).toBe(64 * 1024);
  });

  it("only an @A2AExpose counts: a class that is none (or no component) is skipped", () => {
    @Injectable({ deps: [] })
    class NotAnExpose {}
    class Undecorated {
      readonly bare = true;
    }
    const real = skill(FilesInDto, TextDto);

    expect(fileTierSizeOf([NotAnExpose, Undecorated, real.expose], [real.workflow], SIZES)).toBe(
      1000,
    );
  });

  it("an export that is no start, or no declaration, keeps no file", () => {
    counter += 1;
    const id = `tier-odd-${String(counter)}`;

    @WorkflowFinish({ name: `${id}-workflow-finish`, description: "f", output: FilesInDto })
    class OddFinish {}
    class Undecorated {
      readonly bare = true;
    }

    @A2AExpose({
      name: `${id}-a2a-expose`,
      version: "1.0.0",
      description: "o",
      exports: [OddFinish, Undecorated],
    })
    class OddExpose {}

    expect(fileTierSizeOf([OddExpose], [], SIZES)).toBe(0);
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

@Workflow({
  name: "tier-mixed-workflow",
  version: "1.0.0",
  flow: [
    onStart(FileReviewWorkflowStart)
      .toAction(MixedAction)
      .switch(
        caseOf(ReviewResultDto).toFinish(FileReviewFinish),
        caseOf(TextDto).toFinish(MixedTextFinish),
      ),
  ],
})
class MixedWorkflow {}

describe("a skill whose finishes differ", () => {
  it("files in only one of its finishes count: the file limit is in", () => {
    const limits = { maxFileSize: 5000 as Bytes, maxTotalFileSize: 1000 as Bytes };

    expect(fileTierSizeOf([FilesA2AExpose], [MixedWorkflow], limits)).toBe(5000);
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
