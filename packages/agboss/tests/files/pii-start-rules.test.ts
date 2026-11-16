/**
 * #899 §1, §5: the assembly rules of an agent's files, reported with all the others — an invalid
 * setting, a redacted view nothing can make, an original file under a PII policy.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { FileSource, FileView, ModelFiles } from "../../src/files/model-files.js";
import {
  DecidedBy,
  GuardrailVerdict,
  InputGuardrail,
  PiiAction,
  PiiKind,
  PiiPolicy,
  pii,
} from "../../src/index.js";
import { kilobytes } from "../../src/units/index.js";
import { A2AFileDto } from "../../src/a2a/files/a2a-file.dto.js";
import { fieldsOf, recordField } from "../../src/dto/metadata.js";
import { METADATA_KEY } from "../../src/polyfills/symbol-metadata.js";
import { hasFileAtAnyDepth } from "../../src/a2a/files/a2a-file.dto.js";
import { ListOf, Nested, Text } from "../../src/dto/index.js";
import { FetchedDto, readerApplication } from "./reader.factory.js";

@PiiPolicy({
  name: "cards-pii-policy",
  description: "Hides cards",
  rules: [pii(PiiKind.CardNumber, PiiAction.replaceWithKind())],
})
class CardsPiiPolicy {}

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

  it("a type no model reads as a file, and the history source that is not read yet", async () => {
    const types = readerApplication({
      files: ModelFiles.of({ allowedMediaTypes: ["audio/mpeg"] }),
    });
    const history = readerApplication({ files: ModelFiles.of({ sources: [FileSource.History] }) });

    expect(await codesOf(types)).toEqual(["files.invalid-setting"]);
    expect(await codesOf(history)).toEqual(["files.invalid-setting"]);
  });

  it("a valid setting assembles", async () => {
    await expect(
      applicationOf(readerApplication({ files: ModelFiles.of({}) }).Application),
    ).resolves.toBeDefined();
  });
});

describe("[files.no-redactor] and [pii.original-file]", () => {
  it("a redacted view has no redactor to make it", async () => {
    const redacted = readerApplication({ files: ModelFiles.of({ views: [FileView.Redacted] }) });

    expect(await codesOf(redacted)).toEqual(["files.no-redactor"]);
  });

  it("under a PII policy the original file and its transcription are both refused (masked transcripts: PR 2)", async () => {
    const original = readerApplication({
      files: ModelFiles.of({ views: [FileView.Original] }),
      piiPolicies: [CardsPiiPolicy],
    });
    const transcribed = readerApplication({
      files: ModelFiles.of({}),
      piiPolicies: [CardsPiiPolicy],
    });

    expect(await codesOf(original)).toEqual(["pii.original-file"]);
    expect(await codesOf(transcribed)).toEqual(["files.invalid-setting"]);
    expect(await codesOf(readerApplication({ files: ModelFiles.of({}) }))).toEqual([]);
  });
});

@InputGuardrail({
  name: "files-test-input-guardrail",
  description: "Passes everything: it reads text only",
  refusal: "No.",
  decidedBy: DecidedBy.Code,
})
class TextOnlyGuardrail {
  check(): GuardrailVerdict {
    return GuardrailVerdict.passed();
  }
}

describe("interim: input guardrails read text only, so file parts do not pass them (#899 PR 2 lifts it)", () => {
  const guardrails = [TextOnlyGuardrail];

  it("an agent whose input files can reach its model past an input guardrail does not start", async () => {
    const input = readerApplication({ files: ModelFiles.of({}), guardrails });
    const toolResults = readerApplication({
      files: ModelFiles.of({ sources: [FileSource.ToolResults] }),
      guardrails,
    });

    expect(await codesOf(input)).toEqual(["files.invalid-setting"]);
    expect(await codesOf(toolResults)).toEqual(["files.invalid-setting"]);
  });

  it("without an input guardrail it starts", async () => {
    await expect(
      applicationOf(readerApplication({ files: ModelFiles.of({}) }).Application),
    ).resolves.toBeDefined();
  });

  it("only tool-result files with guardToolResultFiles: false start; an agent with no files does too", async () => {
    const unguarded = readerApplication({
      files: ModelFiles.of({ sources: [FileSource.ToolResults], guardToolResultFiles: false }),
      guardrails,
    });
    const none = readerApplication({ guardrails });

    await expect(applicationOf(unguarded.Application)).resolves.toBeDefined();
    await expect(applicationOf(none.Application)).resolves.toBeDefined();
  });
});

describe("interim: an agent's output with file fields does not start (#899 PR 2 lifts it)", () => {
  it("a file field in the output DTO is refused, guardrails or not; a text output starts", async () => {
    const answering = readerApplication({ files: ModelFiles.of({}), output: FetchedDto });
    const answeringNoFiles = readerApplication({ output: FetchedDto });

    expect(await codesOf(answering)).toEqual(["files.invalid-setting"]);
    expect(await codesOf(answeringNoFiles)).toEqual(["files.invalid-setting"]);
    await expect(applicationOf(readerApplication({}).Application)).resolves.toBeDefined();
  });

  it("a file at any depth is refused: nested, twice nested, in a list of DTOs; a cycle without files starts", async () => {
    class InnerDto {
      @Nested(A2AFileDto, { prompt: "f" })
      file!: A2AFileDto;
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
      @ListOf(InnerDto, { prompt: "l" })
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
    const [link] = fieldsOf(LeafDto);
    if (link === undefined) throw new Error("no field");
    recordField(Reflect.get(NodeDto, METADATA_KEY), {
      ...link,
      element: { kind: "dto", dto: NodeDto },
    });

    for (const output of [InnerDto, MiddleDto, TopDto, ListedDto])
      expect(await codesOf(readerApplication({ output }))).toEqual(["files.invalid-setting"]);
    expect(hasFileAtAnyDepth(NodeDto)).toBe(false);
  });
});
