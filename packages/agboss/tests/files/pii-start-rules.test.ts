/**
 * #899 §1, §5: the assembly rules of an agent's files, reported with all the others — an invalid
 * setting, a redacted view nothing can make, an original file under a PII policy.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { FileSource, FileView, ModelFiles } from "../../src/files/model-files.js";
import type { DtoClass } from "../../src/dto/types.js";
import { AnswerFiles } from "../../src/files/model-files.js";
import {
  GuardrailVerdict,
  InputGuardrail,
  PiiAction,
  PiiFileAction,
  PiiKind,
  PiiPolicy,
  type PiiMatch,
  type PiiPolicyHandler,
} from "../../src/index.js";
import { kilobytes } from "../../src/units/index.js";
import { FileDto } from "../../src/dto/standard/file.js";
import { fieldsOf, recordField } from "../../src/dto/metadata.js";
import { METADATA_KEY } from "../../src/polyfills/symbol-metadata.js";
import { hasFileAtAnyDepth } from "../../src/dto/standard/file.js";
import { List, Nested, Text } from "../../src/dto/index.js";
import { FetchedDto, readerApplication } from "./reader.factory.js";

@PiiPolicy({
  name: "cards-pii-policy",
  description: "Hides cards",
  rules: [PiiKind.CardNumber.mask()],
})
class CardsPiiPolicy {}

@PiiPolicy({
  name: "open-cards-pii-policy",
  description: "Hides cards in text, lets the original file through",
  rules: [PiiKind.CardNumber.mask()],
  files: PiiFileAction.AllowOriginal,
})
class OpenCardsPiiPolicy {}

@PiiPolicy({
  name: "open-emails-pii-policy",
  description: "Hides emails in text, lets the original file through",
  rules: [PiiKind.Email.mask()],
  files: PiiFileAction.AllowOriginal,
})
class OpenEmailsPiiPolicy {}

@PiiPolicy({ name: "staff-id-pii-policy", action: PiiAction.mask() })
class StaffIdPiiPolicy implements PiiPolicyHandler {
  findMatches(): readonly PiiMatch[] {
    return [];
  }
}

const codesOf = async (application: ReturnType<typeof readerApplication>): Promise<string[]> => {
  const failure = await applicationOf(application.Application).then(
    () => undefined,
    (error: unknown) => error,
  );
  const violations: unknown =
    failure instanceof Error ? Reflect.get(failure, "violations") : undefined;
  return Array.isArray(violations)
    ? violations.map((violation: unknown) => String(Reflect.get(Object(violation), "code")))
    : [];
};

describe("[files.invalid-setting] is an assembly rule, never thrown at import", () => {
  it("empty sources and views, a non-positive limit, maxFileSize over the total", async () => {
    const empty = readerApplication({ files: ModelFiles.of({ sources: [], views: [] }) });
    const limits = readerApplication({
      files: ModelFiles.of({
        maxFiles: 0,
        maxFileSize: kilobytes(2),
        maxTotalFileSize: kilobytes(1),
      }),
    });

    expect(await codesOf(empty)).toEqual(["files.invalid-setting", "files.invalid-setting"]);
    expect(await codesOf(limits)).toEqual(["files.invalid-setting", "files.invalid-setting"]);
  });

  it("a type no model reads as a file", async () => {
    const types = readerApplication({
      files: ModelFiles.of({ allowedMediaTypes: ["application/zip"] }),
    });

    expect(await codesOf(types)).toEqual(["files.invalid-setting"]);
  });

  it("a valid setting assembles", async () => {
    await expect(
      applicationOf(readerApplication({ files: ModelFiles.of({}) }).Application),
    ).resolves.toBeDefined();
  });
});

class InnerDto {
  @Nested(FileDto, { prompt: "f" })
  file!: FileDto;
}
class MiddleDto {
  @Nested(InnerDto, { prompt: "i" })
  inner!: InnerDto;
}
class TopDto {
  @Nested(MiddleDto, { prompt: "m" })
  middle!: MiddleDto;
}
class ListedDto {
  @List(InnerDto, { prompt: "l" })
  items!: InnerDto[];
}
class NodeDto {
  @Text({ prompt: "t" })
  label!: string;
}
// a class cannot name itself in its own decorator: the cycle is closed in its field table
class LeafDto {
  @Nested(NodeDto, { prompt: "n", optional: true })
  next?: NodeDto;
}
{
  const [link] = fieldsOf(LeafDto);
  if (link === undefined) throw new Error("no field");
  recordField(Reflect.get(NodeDto, METADATA_KEY), {
    ...link,
    element: { kind: "dto", dto: NodeDto },
  });
}

@InputGuardrail({
  name: "files-test-input-guardrail",
  description: "Passes everything",
  refusal: "No.",
})
class TextOnlyGuardrail {
  check(): GuardrailVerdict {
    return GuardrailVerdict.passed();
  }
}

@PiiPolicy({
  name: "other-cards-pii-policy",
  description: "Hides cards, original files stay masked",
  rules: [PiiKind.CardNumber.mask()],
})
class OtherCardsPiiPolicy {}

describe("AC3: [files.no-redactor], [pii.original-file], [pii.redacted-needs-kinds]", () => {
  it("a redacted view has no redactor to make it", async () => {
    const redacted = readerApplication({ files: ModelFiles.of({ views: [FileView.Redacted] }) });

    expect(await codesOf(redacted)).toEqual(["files.no-redactor"]);
  });

  it("AC3: under a PII policy the original file is refused, its masked transcription starts", async () => {
    const original = readerApplication({
      files: ModelFiles.of({ views: [FileView.Original] }),
      piiPolicies: [CardsPiiPolicy],
    });
    const transcribed = readerApplication({
      files: ModelFiles.of({}),
      piiPolicies: [CardsPiiPolicy],
    });
    const both = readerApplication({
      files: ModelFiles.of({ views: [FileView.Transcription, FileView.Original] }),
      piiPolicies: [CardsPiiPolicy],
    });

    expect(await codesOf(original)).toEqual(["pii.original-file"]);
    expect(await codesOf(both)).toEqual(["pii.original-file"]);
    expect(await codesOf(transcribed)).toEqual([]);
    expect(await codesOf(readerApplication({ files: ModelFiles.of({}) }))).toEqual([]);
  });

  it("AC3: the original starts only when EVERY applying policy lets files through", async () => {
    const files = ModelFiles.of({ views: [FileView.Original] });
    const allOpen = readerApplication({
      files,
      piiPolicies: [OpenCardsPiiPolicy, OpenEmailsPiiPolicy],
    });
    const oneMasks = readerApplication({
      files,
      piiPolicies: [OpenCardsPiiPolicy, OtherCardsPiiPolicy],
    });

    expect(await codesOf(allOpen)).toEqual([]);
    expect(await codesOf(oneMasks)).toEqual(["pii.original-file"]);
  });

  it("AC3: a policy excluded for the agent no longer rules the original out", async () => {
    const excluded = readerApplication({
      files: ModelFiles.of({ views: [FileView.Original] }),
      piiPolicies: [CardsPiiPolicy],
      excludePiiPolicies: [CardsPiiPolicy],
    });

    expect(await codesOf(excluded)).toEqual([]);
  });

  it("a redacted view under a policy of a project's own detector is refused: no redactor can know what to black out", async () => {
    const custom = readerApplication({
      files: ModelFiles.of({ views: [FileView.Redacted] }),
      piiPolicies: [StaffIdPiiPolicy],
    });
    const declared = readerApplication({
      files: ModelFiles.of({ views: [FileView.Redacted] }),
      piiPolicies: [CardsPiiPolicy],
    });
    const transcribed = readerApplication({
      files: ModelFiles.of({ views: [FileView.Transcription] }),
      piiPolicies: [StaffIdPiiPolicy],
    });

    expect((await codesOf(custom)).sort()).toEqual([
      "files.no-redactor",
      "pii.redacted-needs-kinds",
    ]);
    expect(await codesOf(declared)).toEqual(["files.no-redactor"]);
    expect(await codesOf(transcribed)).toEqual([]);
  });

  it("a PiiFileAction that is none is a [files.invalid-setting]", async () => {
    @PiiPolicy({
      name: "wrong-files-pii-policy",
      description: "Says something else",
      rules: [PiiKind.CardNumber.mask()],
      // @ts-expect-error a string that is no PiiFileAction
      files: "maybe",
    })
    class WrongPolicy {}

    expect(await codesOf(readerApplication({ piiPolicies: [WrongPolicy] }))).toEqual([
      "files.invalid-setting",
    ]);
  });
});

describe("AC4: input guardrails see files, so an agent with both starts (PR 1's interim refusal is gone)", () => {
  it("input guardrails and file sources are no start problem", async () => {
    const input = readerApplication({ files: ModelFiles.of({}), guardrails: [TextOnlyGuardrail] });
    const toolResults = readerApplication({
      files: ModelFiles.of({ sources: [FileSource.ToolResults] }),
      guardrails: [TextOnlyGuardrail],
    });

    await expect(applicationOf(input.Application)).resolves.toBeDefined();
    await expect(applicationOf(toolResults.Application)).resolves.toBeDefined();
  });
});

describe("AC2: an agent's answer files (PR 1's interim refusal is gone)", () => {
  it("an answer with file fields starts when the agent saw the originals; any depth", async () => {
    const seen = readerApplication({
      files: ModelFiles.of({ views: [FileView.Original] }),
      output: FetchedDto,
    });
    const nested = readerApplication({
      files: ModelFiles.of({ views: [FileView.Original] }),
      output: TopDto,
    });

    await expect(applicationOf(seen.Application)).resolves.toBeDefined();
    await expect(applicationOf(nested.Application)).resolves.toBeDefined();
  });

  it("[files.answer-file-unseen]: only a transcription seen, or no file read at all — unless the model's own descriptors are allowed", async () => {
    const transcribed = readerApplication({
      files: ModelFiles.of({ views: [FileView.Transcription] }),
      output: FetchedDto,
    });
    const none = readerApplication({ output: FetchedDto });
    const any = readerApplication({
      files: ModelFiles.of({ views: [FileView.Transcription], answerFiles: AnswerFiles.Any }),
      output: FetchedDto,
    });
    const defaulted = readerApplication({
      files: ModelFiles.of({}),
      piiPolicies: [CardsPiiPolicy],
      output: FetchedDto,
    });

    expect(await codesOf(transcribed)).toEqual(["files.answer-file-unseen"]);
    expect(await codesOf(none)).toEqual(["files.answer-file-unseen"]);
    expect(await codesOf(defaulted)).toEqual(["files.answer-file-unseen"]);
    await expect(applicationOf(any.Application)).resolves.toBeDefined();
  });

  it("[files.answer-file-unseen]: a redacted view is no original to return — the pick would fail at run time, and the original must not be handed back instead", async () => {
    const redacted = readerApplication({
      files: ModelFiles.of({ views: [FileView.Redacted], allowedMediaTypes: ["image/png"] }),
      piiPolicies: [CardsPiiPolicy],
      output: FetchedDto,
    });

    expect(await codesOf(redacted)).toEqual(["files.answer-file-unseen"]);
  });

  it("[pii.original-file]: AnswerFiles.Any lets the model return the unmasked original, so it is refused where a policy masks the agent's files and the original is not allowed", async () => {
    const answering = (views: FileView[], policy: new () => object) =>
      readerApplication({
        files: ModelFiles.of({
          views,
          allowedMediaTypes: ["image/png"],
          answerFiles: AnswerFiles.Any,
        }),
        piiPolicies: [policy],
        output: FetchedDto,
      });

    expect(await codesOf(answering([FileView.Redacted], CardsPiiPolicy))).toEqual([
      "pii.original-file",
    ]);
    expect(await codesOf(answering([FileView.Transcription], CardsPiiPolicy))).toEqual([
      "pii.original-file",
    ]);
    // the developer lets the original through: no new rule
    await expect(
      applicationOf(answering([FileView.Redacted], OpenCardsPiiPolicy).Application),
    ).resolves.toBeDefined();
    // an agent whose answer has no file fields has nothing to return
    const textOnly = readerApplication({
      files: ModelFiles.of({
        views: [FileView.Redacted],
        allowedMediaTypes: ["image/png"],
        answerFiles: AnswerFiles.Any,
      }),
      piiPolicies: [CardsPiiPolicy],
    });
    await expect(applicationOf(textOnly.Application)).resolves.toBeDefined();
  });

  it("a file at any depth counts: nested, twice nested, in a list of DTOs; a DTO that holds itself has no file and the search ends", async () => {
    const text = (output: DtoClass) => readerApplication({ output });
    for (const output of [InnerDto, MiddleDto, TopDto, ListedDto])
      expect(await codesOf(text(output))).toEqual(["files.answer-file-unseen"]);
    // such a DTO is a start error of its own since #1202 ([dto.cyclic]); the search must still end on it
    expect(hasFileAtAnyDepth(NodeDto)).toBe(false);
  });
});
