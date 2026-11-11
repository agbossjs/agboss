/**
 * #916 items 2 and 4: the card's file fields, of a skill's input and of its finishes' outputs, as
 * `@A2AExpose({ cardFileFields })` sets them — `Extension`: out of the data schema (and its
 * `required`), declared in the skills extension (`files` for the input, `outputFiles` by finish);
 * `Marker`: each in the data schema as `{ "x-agboss-file-part": { list, optional, mediaTypes },
 * description }`, never required. The AGBoss client's card check reads both alike: a missing required
 * file field, a file field declared as text, one file against a list, an optional file the skill
 * requires — each named under `Marker` as under `Extension`.
 */
import { describe, expect } from "vitest";
import type { Class } from "../../../src/components/injection.js";
import { A2ACardFileFields, A2AExpose } from "../../../src/a2a/a2a-expose.decorator.js";
import { FILE_PART_KEYWORD } from "../../../src/a2a/a2a-card-file-fields.js";
import { checkCard } from "../../../src/a2a/client/a2a-card.js";
import { A2AFileDto } from "../../../src/a2a/files/a2a-file.dto.js";
import { A2AClient } from "../../../src/a2a/index.js";
import { Application } from "../../../src/application/application.js";
import type { DtoClass } from "../../../src/dto/types.js";
import { ListOf, Nested, Text } from "../../../src/dto/index.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { testWith } from "../../../src/testing/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import {
  FileCallerChannel,
  FileReviewWorkflow,
  FileReviewWorkflowStart,
  FilesA2AExpose,
  FileSummaryWorkflow,
  FileSummaryWorkflowStart,
  ReviewRequestDto,
  ReviewResultDto,
} from "../fixtures/files.application.js";

const REVIEW = "file-review-workflow-start";
const SUMMARY = "file-summary-workflow-start";
const MEDIA = ["application/pdf", "text/plain", "image/png"];
const OUTPUT_MEDIA = ["application/pdf", "image/png", "text/plain"];

@A2AExpose({
  name: "marked-outputs-a2a-expose",
  version: "1.0.0",
  description: "Reviews and summarises documents, its file fields marked",
  exports: [FileReviewWorkflowStart, FileSummaryWorkflowStart],
  cardFileFields: A2ACardFileFields.Marker,
  skills: { [REVIEW]: { files: { allowedMediaTypes: MEDIA } } },
})
export class MarkedOutputsA2AExpose {}

@A2AExpose({
  name: "summary-files-a2a-expose",
  version: "1.0.0",
  description: "Summarises documents, its file fields in the extension",
  exports: [FileSummaryWorkflowStart],
})
export class SummaryFilesA2AExpose {}

@Application({
  name: "card-outputs-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FileReviewWorkflow, FileSummaryWorkflow],
  providers: [BearerCallerResolver, FileCallerChannel],
  exposes: [FilesA2AExpose, MarkedOutputsA2AExpose, SummaryFilesA2AExpose],
  a2aFiles: { allowedMediaTypes: OUTPUT_MEDIA },
  budgets: TEST_BUDGETS,
})
export class CardOutputsApplication {}

const test = testWith(CardOutputsApplication);
const SKILLS = "https://agboss.dev/a2a/skills/v1";

interface SkillEntry {
  readonly input: { properties: Record<string, unknown>; required?: string[] };
  readonly outputs: Record<string, { properties: Record<string, unknown>; required?: string[] }>;
  readonly outputFiles?: Record<string, Record<string, unknown>>;
}

/** The skills extension's entry of `skill` on the card at `url`. */
async function entryOf(url: string, skill: string): Promise<SkillEntry> {
  const card = (await (await fetch(`${url}/.well-known/agent-card.json`)).json()) as {
    capabilities: { extensions: { uri: string; params: { skills: Record<string, SkillEntry> } }[] };
  };
  const entry = card.capabilities.extensions.find((each) => each.uri === SKILLS)?.params.skills[
    skill
  ];
  if (entry === undefined) throw new Error("no skills extension entry");
  return entry;
}

const serve = (expose: Class) => ({ expose, callerResolver: BearerCallerResolver });

/** What `checkCard` throws for a client of `skill` with these DTOs on the card at `url`. */
async function refusalOf(
  url: string,
  skill: string,
  dtos: { readonly input?: DtoClass; readonly output?: DtoClass },
): Promise<string> {
  const card = await new A2AClient({ url, fetcher: fetch }).agentCard();
  try {
    checkCard(card, { agent: "files", skill, input: dtos.input, output: dtos.output });
    return "accepted";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("#916 item 4 AC4: the card's output schemas describe file fields as file parts", () => {
  test("AC4.1 Extension: out of each finish's data schema, declared in outputFiles by finish", async ({
    a2aServer,
  }) => {
    const entry = await entryOf((await a2aServer(serve(FilesA2AExpose))).url, REVIEW);
    const review = entry.outputs["file-review-workflow-finish"];

    expect(Object.keys(review?.properties ?? {})).toEqual(["verdict"]);
    expect(review?.required).toEqual(["verdict"]);
    expect(entry.outputFiles).toEqual({
      "file-review-workflow-finish": {
        report: { list: false, optional: false, mediaTypes: OUTPUT_MEDIA },
      },
      "file-returned-workflow-finish": {
        file: { list: false, optional: false, mediaTypes: OUTPUT_MEDIA },
      },
    });
  });

  test("AC4.2 Marker: each output file field marked in its data schema, never required", async ({
    a2aServer,
  }) => {
    const entry = await entryOf((await a2aServer(serve(MarkedOutputsA2AExpose))).url, REVIEW);
    const review = entry.outputs["file-review-workflow-finish"];

    expect(review?.properties.report).toEqual({
      [FILE_PART_KEYWORD]: { list: false, optional: false, mediaTypes: OUTPUT_MEDIA },
      description: expect.stringContaining('sent as a file part naming "report"'),
    });
    expect(review?.required).toEqual(["verdict"]);
    expect(entry.outputFiles).toBeUndefined();
  });

  test("AC4.3 the client's output DTO is checked file field by file field, in either mode", async ({
    a2aServer,
  }) => {
    class ReportAsTextDto {
      @Text({ prompt: "the report" })
      report!: string;

      @Text({ prompt: "the verdict" })
      verdict!: string;
    }
    class ReportsDto {
      @ListOf(A2AFileDto, { prompt: "the reports" })
      report!: A2AFileDto[];

      @Text({ prompt: "the verdict" })
      verdict!: string;
    }
    for (const expose of [SummaryFilesA2AExpose, MarkedOutputsA2AExpose]) {
      const { url } = await a2aServer(serve(expose));

      expect(await refusalOf(url, SUMMARY, { output: ReviewResultDto })).toBe("accepted");
      expect(await refusalOf(url, SUMMARY, { output: ReportAsTextDto })).toMatch(
        /report is a file field of the finish/,
      );
      expect(await refusalOf(url, SUMMARY, { output: ReportsDto })).toMatch(
        /report is one file on the finish/,
      );
    }
  });
});

describe("#916 item 2 AC2: a Marker card declares each file field as Extension does", () => {
  test("AC2.1 the marker object carries list, optional and the media types", async ({
    a2aServer,
  }) => {
    const entry = await entryOf((await a2aServer(serve(MarkedOutputsA2AExpose))).url, REVIEW);

    expect(entry.input.properties.document).toMatchObject({
      [FILE_PART_KEYWORD]: { list: false, optional: false, mediaTypes: MEDIA },
    });
    expect(entry.input.properties.pages).toMatchObject({
      [FILE_PART_KEYWORD]: { list: true, optional: true, mediaTypes: MEDIA },
    });
  });

  test("AC2.2 the client's input check names each mismatch under Marker as under Extension", async ({
    a2aServer,
  }) => {
    class NoDocumentDto {
      @Text({ prompt: "a note", optional: true })
      note?: string;
    }
    class DocumentAsTextDto {
      @Text({ prompt: "the document" })
      document!: string;
    }
    class OnePageDto {
      @Nested(A2AFileDto, { prompt: "the document" })
      document!: A2AFileDto;

      @Nested(A2AFileDto, { prompt: "one page", optional: true })
      pages?: A2AFileDto;
    }
    class OptionalDocumentDto {
      @Nested(A2AFileDto, { prompt: "the document", optional: true })
      document?: A2AFileDto;
    }
    for (const expose of [FilesA2AExpose, MarkedOutputsA2AExpose]) {
      const { url } = await a2aServer(serve(expose));
      const refused = (input: DtoClass) => refusalOf(url, REVIEW, { input });

      expect(await refused(ReviewRequestDto)).toBe("accepted");
      expect(await refused(NoDocumentDto)).toMatch(/requires the file field document/);
      expect(await refused(DocumentAsTextDto)).toMatch(/requires the file field document/);
      expect(await refused(OnePageDto)).toMatch(/pages is a list of files on the skill/);
      expect(await refused(OptionalDocumentDto)).toMatch(
        /document is a required file on the skill/,
      );
    }
  });
});
