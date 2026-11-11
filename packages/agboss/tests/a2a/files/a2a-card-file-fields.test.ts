/**
 * #904 item 5 (AC5.1): the Agent Card never asks for a file field in the data part. As set by
 * `@A2AExpose({ cardFileFields })` (a skill may set its own): `Extension`, the default — the file
 * fields out of the data `input` schema and its `required`, declared in the skills extension's
 * `files` — or `Marker` — each one in it as `{ "x-agboss-file-part": true, description }`, never
 * required. A foreign validator (ajv) accepts a data part without file fields under either; the
 * AGBoss client's schema check reads both; `describe --json` names the setting.
 */
import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import type { Class } from "../../../src/components/injection.js";
import { A2ACardFileFields, A2AExpose } from "../../../src/a2a/a2a-expose.decorator.js";
import { FILE_PART_KEYWORD } from "../../../src/a2a/a2a-card-file-fields.js";
import { cardFileFieldsViolations } from "../../../src/a2a/files/a2a-file-options.js";
import { checkCard } from "../../../src/a2a/client/a2a-card.js";
import { A2AClient } from "../../../src/a2a/index.js";
import { Application } from "../../../src/application/application.js";
import { applicationOf } from "../../../src/application/assemble.js";
import { contractsOf } from "../../../src/describe/contracts.js";
import { Text } from "../../../src/dto/index.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { testWith } from "../../../src/testing/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import {
  FileCallerChannel,
  FilesA2AExpose,
  FileReviewWorkflow,
  FileReviewWorkflowStart,
  ReviewRequestDto,
} from "../fixtures/files.application.js";

const START = "file-review-workflow-start";
const FILES = { allowedMediaTypes: ["application/pdf", "text/plain", "image/png"] };

@A2AExpose({
  name: "marked-files-a2a-expose",
  version: "1.0.0",
  description: "Reviews documents, its file fields marked",
  exports: [FileReviewWorkflowStart],
  cardFileFields: A2ACardFileFields.Marker,
  skills: { [START]: { files: FILES } },
})
export class MarkedFilesA2AExpose {}

@A2AExpose({
  name: "own-files-a2a-expose",
  version: "1.0.0",
  description: "Reviews documents, the skill's own setting over the expose's",
  exports: [FileReviewWorkflowStart],
  cardFileFields: A2ACardFileFields.Marker,
  skills: { [START]: { files: FILES, cardFileFields: A2ACardFileFields.Extension } },
})
export class OwnFilesA2AExpose {}

@Application({
  name: "card-files-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [FileReviewWorkflow],
  providers: [BearerCallerResolver, FileCallerChannel],
  exposes: [FilesA2AExpose, MarkedFilesA2AExpose, OwnFilesA2AExpose],
  budgets: TEST_BUDGETS,
})
export class CardFilesApplication {}

const test = testWith(CardFilesApplication);
const SKILLS = "https://agboss.dev/a2a/skills/v1";

interface SkillEntry {
  readonly input: { properties: Record<string, unknown>; required?: string[] };
  readonly cardFileFields: string;
  readonly files?: Record<string, unknown>;
}

/** The skills extension's entry of the review skill on the card at `url`. */
async function entryOf(url: string): Promise<SkillEntry> {
  const card = (await (await fetch(`${url}/.well-known/agent-card.json`)).json()) as {
    capabilities: { extensions: { uri: string; params: { skills: Record<string, SkillEntry> } }[] };
  };
  const entry = card.capabilities.extensions.find((each) => each.uri === SKILLS)?.params.skills[
    START
  ];
  if (entry === undefined) throw new Error("no skills extension entry");
  return entry;
}

const serve = (expose: Class) => ({ expose, callerResolver: BearerCallerResolver });

describe("#904 item 5 AC5.1: the card's file fields", () => {
  test("Extension (the default): out of input and required, declared in the extension's files", async ({
    a2aServer,
  }) => {
    const entry = await entryOf((await a2aServer(serve(FilesA2AExpose))).url);

    expect(Object.keys(entry.input.properties)).toEqual(["note"]);
    expect(entry.input.required).toBeUndefined();
    expect(entry.cardFileFields).toBe("extension");
    expect(entry.files).toEqual({
      document: { list: false, optional: false, mediaTypes: FILES.allowedMediaTypes },
      pages: { list: true, optional: true, mediaTypes: FILES.allowedMediaTypes },
    });
  });

  test("Marker: each in input as its marker, none required, no files entry", async ({
    a2aServer,
  }) => {
    const entry = await entryOf((await a2aServer(serve(MarkedFilesA2AExpose))).url);

    expect(entry.input.properties).toMatchObject({
      document: {
        [FILE_PART_KEYWORD]: true,
        description: expect.stringContaining("the document to review"),
      },
      pages: { [FILE_PART_KEYWORD]: true, description: expect.stringContaining("file parts") },
      note: { type: "string" },
    });
    expect(entry.input.required).toBeUndefined();
    expect(entry.cardFileFields).toBe("marker");
    expect(entry.files).toBeUndefined();
  });

  test("a skill's own setting is over its expose's", async ({ a2aServer }) => {
    const entry = await entryOf((await a2aServer(serve(OwnFilesA2AExpose))).url);

    expect(entry.cardFileFields).toBe("extension");
    expect(Object.keys(entry.input.properties)).toEqual(["note"]);
  });

  test("a foreign validator (ajv) accepts a data part without file fields, in either mode", async ({
    a2aServer,
  }) => {
    const extension = await entryOf((await a2aServer(serve(FilesA2AExpose))).url);
    const marker = await entryOf((await a2aServer(serve(MarkedFilesA2AExpose))).url);
    // a strict ajv refuses keywords it does not know: the marker's is declared, as a caller would
    const strict = new Ajv();
    strict.addVocabulary([FILE_PART_KEYWORD]);
    const lenient = new Ajv({ strict: false });

    for (const ajv of [strict, lenient])
      for (const schema of [extension.input, marker.input]) {
        const validate = ajv.compile(schema);
        expect([validate({ note: "please" }), validate({})]).toEqual([true, true]);
      }
  });

  test("the AGBoss client's check reads both: the same DTO passes, a mismatched file field is named", async ({
    a2aServer,
  }) => {
    class OtherRequestDto {
      @Text({ prompt: "a note" })
      note!: string;
    }
    const expected = (input: typeof ReviewRequestDto | typeof OtherRequestDto) => ({
      agent: "files",
      skill: START,
      input,
      output: undefined,
    });
    for (const expose of [FilesA2AExpose, MarkedFilesA2AExpose]) {
      const { url } = await a2aServer(serve(expose));
      const card = await new A2AClient({ url, fetcher: fetch }).agentCard();

      expect(() => {
        checkCard(card, expected(ReviewRequestDto));
      }).not.toThrow();
    }
    const { url } = await a2aServer(serve(FilesA2AExpose));
    const card = await new A2AClient({ url, fetcher: fetch }).agentCard();

    expect(() => {
      checkCard(card, expected(OtherRequestDto));
    }).toThrow(/the skill requires the file field document/);
  });
});

describe("#904 item 5 AC5.1: the setting, checked and described", () => {
  it("describe --json names each export's setting", async () => {
    const contracts = contractsOf(await applicationOf(CardFilesApplication));

    expect(
      contracts.exports.map((each) =>
        each.kind === "a2a" ? [each.expose, each.cardFileFields] : [],
      ),
    ).toEqual([
      ["files-a2a-expose", "extension"],
      ["marked-files-a2a-expose", "marker"],
      ["own-files-a2a-expose", "extension"],
    ]);
  });

  it("a value of no A2ACardFileFields, a skill it does not export: refused at assembly", () => {
    const expose = {
      cardFileFields: "inline" as A2ACardFileFields,
      skills: { "other-workflow-start": { cardFileFields: A2ACardFileFields.Marker } },
    };

    expect(
      cardFileFieldsViolations("x-a2a-expose", expose, new Set([START]), "app").map((v) => v.code),
    ).toEqual(["a2a.unknown-skill-option", "a2a.file-options-invalid"]);
  });
});
