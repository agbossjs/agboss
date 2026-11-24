/**
 * #1269: the assembly rules of an agent's files — each rule's code, message and node, not only that
 * the application does not start.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { nameOf } from "../../src/components/name-of.js";
import { filesViolations } from "../../src/files/file-rules.js";
import type { ResolvedModelFiles } from "../../src/files/file-settings.js";
import {
  AnswerFiles,
  FileSource,
  FileView,
  ModelFiles,
  type ModelFilesOptions,
} from "../../src/files/model-files.js";
import { PiiAction, PiiFileAction, PiiKind, PiiPolicy } from "../../src/index.js";
import type { PiiMatch, PiiPolicyHandler } from "../../src/index.js";
import type { RuleViolation } from "../../src/graph/rule-error.js";
import { kilobytes } from "../../src/units/index.js";
import { FetchedDto, readerApplication, type ReaderOptions } from "./reader.factory.js";

const bytesOf = (count: number) => kilobytes(count / 1024);

@PiiPolicy({
  name: "rules-cards-pii-policy",
  description: "Hides cards",
  rules: [PiiKind.CardNumber.mask()],
})
class CardsPolicy {}

@PiiPolicy({
  name: "rules-emails-pii-policy",
  description: "Hides emails",
  rules: [PiiKind.Email.mask()],
})
class EmailsPolicy {}

@PiiPolicy({
  name: "rules-open-pii-policy",
  description: "Hides cards, lets the original through",
  rules: [PiiKind.CardNumber.mask()],
  files: PiiFileAction.AllowOriginal,
})
class OpenPolicy {}

@PiiPolicy({ name: "rules-staff-pii-policy", action: PiiAction.mask() })
class StaffPolicy implements PiiPolicyHandler {
  findMatches(): readonly PiiMatch[] {
    return [];
  }
}

@PiiPolicy({ name: "rules-badge-pii-policy", action: PiiAction.mask() })
class BadgePolicy implements PiiPolicyHandler {
  findMatches(): readonly PiiMatch[] {
    return [];
  }
}

/** The violations a start throws, as the rules reported them. */
async function thrownBy(options: ReaderOptions): Promise<{ name: string; found: RuleViolation[] }> {
  const app = readerApplication(options);
  const failure = await applicationOf(app.Application).then(
    () => undefined,
    (error: unknown) => error,
  );
  const violations: unknown =
    failure instanceof Error ? Reflect.get(failure, "violations") : undefined;
  const found = Array.isArray(violations)
    ? violations.map((item: RuleViolation) => ({
        code: item.code,
        message: item.message,
        nodes: item.nodes,
      }))
    : [];
  return { name: nameOf(app.Agent), found };
}

/** The rules over the settings of a valid application, patched: what start-time validation lets through. */
async function patchedBy(patch: Partial<ResolvedModelFiles>) {
  const app = readerApplication(withFiles({}));
  const [workflow] = (await applicationOf(app.Application)).workflows;
  const name = nameOf(app.Agent);
  const settings = workflow?.config.agents[name];
  if (workflow === undefined || settings?.files === undefined) throw new Error("no files");
  const patched = {
    ...workflow,
    config: {
      ...workflow.config,
      agents: {
        ...workflow.config.agents,
        [name]: { ...settings, files: { ...settings.files, ...patch } },
      },
    },
  };
  return { name, found: filesViolations([patched]) };
}

const withFiles = (files: ModelFilesOptions, more: ReaderOptions = {}): ReaderOptions => ({
  files: ModelFiles.of(files),
  ...more,
});

describe("[files.invalid-setting]: sources and views", () => {
  it("empty sources and views", async () => {
    const { name, found } = await thrownBy(withFiles({ sources: [], views: [] }));

    expect(found).toEqual([
      {
        code: "files.invalid-setting",
        message: `${name}: files — sources is empty`,
        nodes: [name],
      },
      { code: "files.invalid-setting", message: `${name}: files — views is empty`, nodes: [name] },
    ]);
  });

  it("a source and a view that are none, among valid ones", async () => {
    const source = ["bogus"].join("") as FileSource;
    const view = ["sketch"].join("") as FileView;
    const { name, found } = await patchedBy({
      sources: [FileSource.Input, FileSource.ToolResults, FileSource.History, source],
      views: [FileView.Original, FileView.Transcription, view],
    });

    expect(found.map((item) => item.message)).toEqual([
      `${name}: files — sources has "bogus"`,
      `${name}: files — views has "sketch"`,
    ]);
  });
});

describe("[files.invalid-setting]: numbers and answerFiles", () => {
  it("a limit that is no whole number from 1, and a file larger than the total", async () => {
    const { name, found } = await thrownBy(
      withFiles({ maxFileSize: bytesOf(0.5), maxTotalFileSize: bytesOf(0), maxFiles: 0 }),
    );

    expect(found.map((item) => item.message)).toEqual([
      `${name}: files — maxFileSize is not a whole number of bytes from 1`,
      `${name}: files — maxTotalFileSize is not a whole number of bytes from 1`,
      `${name}: files — maxFiles is not a whole number from 1`,
      `${name}: files — maxFileSize is larger than maxTotalFileSize: raise maxTotalFileSize`,
    ]);
    expect(found.map((item) => item.code)).toEqual(Array(4).fill("files.invalid-setting"));
    expect(found.map((item) => item.nodes)).toEqual(Array(4).fill([name]));
  });

  it("one byte, one file and a file as large as the total are valid; a fraction of a file is not", async () => {
    const edge = await thrownBy(
      withFiles({ maxFileSize: bytesOf(1), maxTotalFileSize: bytesOf(1), maxFiles: 1 }),
    );
    const fraction = await thrownBy(withFiles({ maxFiles: 1.5 }));

    expect(edge.found).toEqual([]);
    expect(fraction.found.map((item) => item.message)).toEqual([
      `${fraction.name}: files — maxFiles is not a whole number from 1`,
    ]);
  });

  it("an answerFiles that is none", async () => {
    const { name, found } = await patchedBy({ answerFiles: ["some"].join("") as AnswerFiles });

    expect(found.map((item) => item.message)).toEqual([
      `${name}: files — answerFiles is not an AnswerFiles`,
    ]);
  });
});

describe("[files.invalid-setting]: media types", () => {
  it("named types without a form in a model message, each told", async () => {
    const { name, found } = await thrownBy(
      withFiles({ allowedMediaTypes: ["application/zip", "image/png", "font/woff"] }),
    );

    expect(found.map((item) => item.message)).toEqual([
      `${name}: files — allowedMediaTypes has application/zip: a model reads text, images, PDFs, audio and video as files`,
      `${name}: files — allowedMediaTypes has font/woff: a model reads text, images, PDFs, audio and video as files`,
    ]);
  });

  it("no type at all, named or defaulted", async () => {
    const named = await thrownBy(withFiles({ allowedMediaTypes: [] }));
    const defaulted = await thrownBy(withFiles({}, { a2aFiles: { allowedMediaTypes: [] } }));

    for (const { name, found } of [named, defaulted])
      expect(found).toEqual([
        {
          code: "files.invalid-setting",
          message: `${name}: files — allowedMediaTypes is empty`,
          nodes: [name],
        },
      ]);
  });

  it("types the application's a2aFiles gave are narrowed at start, not checked strictly", async () => {
    const { found } = await thrownBy(
      withFiles({}, { a2aFiles: { allowedMediaTypes: ["application/zip", "image/png"] } }),
    );

    expect(found).toEqual([]);
  });
});

describe("[pii.original-file]", () => {
  it("the original file under policies that mask it: each masking policy named, the open one not", async () => {
    const { name, found } = await thrownBy(
      withFiles(
        { views: [FileView.Original] },
        { piiPolicies: [CardsPolicy, OpenPolicy, EmailsPolicy] },
      ),
    );

    expect(found).toEqual([
      {
        code: "pii.original-file",
        message: `${name}: FileView.Original sends the file to its model unmasked while rules-cards-pii-policy, rules-emails-pii-policy apply to it — use FileView.Transcription, set files: PiiFileAction.AllowOriginal on the policy, or exclude the policy`,
        nodes: [name],
      },
    ]);
  });

  it("AnswerFiles.Any lets the model return the unmasked original, while the policies mask the files", async () => {
    const { name, found } = await thrownBy(
      withFiles(
        { views: [FileView.Transcription], answerFiles: AnswerFiles.Any },
        { piiPolicies: [CardsPolicy, EmailsPolicy], output: FetchedDto },
      ),
    );

    expect(found).toEqual([
      {
        code: "pii.original-file",
        message: `${name}: AnswerFiles.Any lets its model return a file the execution holds, the unmasked original too, while rules-cards-pii-policy, rules-emails-pii-policy mask its files — use the default answerFiles (files by number: a file it saw), set files: PiiFileAction.AllowOriginal on the policy, or exclude the policy`,
        nodes: [name],
      },
    ]);
  });

  it("AnswerFiles.Any is no rule where the original is a view, no policy masks, or no file is answered", async () => {
    const original = await thrownBy(
      withFiles(
        { views: [FileView.Original], answerFiles: AnswerFiles.Any },
        { piiPolicies: [OpenPolicy], output: FetchedDto },
      ),
    );
    const open = await thrownBy(
      withFiles(
        { views: [FileView.Transcription], answerFiles: AnswerFiles.Any },
        { piiPolicies: [OpenPolicy], output: FetchedDto },
      ),
    );
    const noFiles = await thrownBy(
      withFiles(
        { views: [FileView.Transcription], answerFiles: AnswerFiles.Any },
        { piiPolicies: [CardsPolicy] },
      ),
    );
    const noPolicy = await thrownBy(
      withFiles(
        { views: [FileView.Transcription], answerFiles: AnswerFiles.Any },
        { output: FetchedDto },
      ),
    );

    for (const { found } of [original, open, noFiles, noPolicy]) expect(found).toEqual([]);
  });
});

describe("[pii.redacted-needs-kinds]", () => {
  it("a redacted view under policies that read with their own detector, each named", async () => {
    const { name, found } = await thrownBy(
      withFiles(
        { views: [FileView.Redacted] },
        { piiPolicies: [StaffPolicy, CardsPolicy, BadgePolicy] },
      ),
    );

    expect(found.map((item) => item.code)).toEqual([
      "files.no-redactor",
      "pii.redacted-needs-kinds",
    ]);
    expect(found[1]).toEqual({
      code: "pii.redacted-needs-kinds",
      message: `${name}: FileView.Redacted needs the kinds a policy names, and rules-staff-pii-policy, rules-badge-pii-policy reads text with its own detector — use FileView.Transcription (it works with it), or a policy with rules`,
      nodes: [name],
    });
  });
});

describe("[files.answer-file-unseen]", () => {
  it("an agent that reads no file", async () => {
    const { name, found } = await thrownBy({ output: FetchedDto });

    expect(found).toEqual([
      {
        code: "files.answer-file-unseen",
        message: `${name}: its answer has file fields, but it reads no file — give it files: ModelFiles.of({ … }) (or answerFiles: AnswerFiles.Any, the model's own descriptors, checked at run time)`,
        nodes: [name],
      },
    ]);
  });

  it("an agent that never sees an original", async () => {
    const { name, found } = await thrownBy(
      withFiles({ views: [FileView.Transcription] }, { output: FetchedDto }),
    );

    expect(found).toEqual([
      {
        code: "files.answer-file-unseen",
        message: `${name}: its answer has file fields, but it never sees an original file (its views: transcription or redacted copy only), and only an original can be returned — add FileView.Original, or set answerFiles: AnswerFiles.Any`,
        nodes: [name],
      },
    ]);
  });

  it("an agent that saw the original, or may answer any descriptor, or answers no file", async () => {
    const original = await thrownBy(
      withFiles({ views: [FileView.Transcription, FileView.Original] }, { output: FetchedDto }),
    );
    const any = await thrownBy({
      output: FetchedDto,
      ...withFiles({ answerFiles: AnswerFiles.Any }),
    });
    const textual = await thrownBy({});

    for (const { found } of [original, any, textual]) expect(found).toEqual([]);
  });
});

describe("[files.history-needs-store]", () => {
  it("the history as a source with no file store, told with its node", async () => {
    const { name, found } = await thrownBy({
      ...withFiles({ sources: [FileSource.History] }),
      providers: [],
    });

    expect(found).toEqual([
      {
        code: "files.history-needs-store",
        message: `${name}: FileSource.History needs an A2AFileRepository in @Application({ providers }): a turn keeps its files' descriptors, not their bytes — the inline default has none to read again`,
        nodes: [name],
      },
    ]);
  });
});

class NoPolicy {
  readonly kind = "not a policy";
}

describe("the rules read the PII policies of the workflows' agents", () => {
  it("an agent whose element has no policy, an unlisted agent or no PII at all breaks none", async () => {
    const app = readerApplication(withFiles({ views: [FileView.Original] }));
    const [workflow] = (await applicationOf(app.Application)).workflows;
    if (workflow === undefined) throw new Error("no workflow");
    const name = nameOf(app.Agent);
    const { pii: listed, ...unlisted } = workflow;
    const base = listed ?? {
      observability: [],
      model: [],
      excludes: { workflow: [], byElement: new Map() },
      chains: [],
      classes: [],
      detectors: [],
    };
    const withMap = (byElement: Map<string, readonly (new () => object)[]>) => ({
      ...workflow,
      pii: { ...base, byElement },
    });

    expect(filesViolations([workflow])).toEqual([]);
    expect(filesViolations([unlisted])).toEqual([]);
    expect(filesViolations([withMap(new Map())])).toEqual([]);
    expect(filesViolations([withMap(new Map([[name, [NoPolicy]]]))])).toEqual([]);
  });
});
