/**
 * #1269: what an agent's files come to — every level applied: the agent's over its workflow's over its
 * application's, then the skills, `a2aFiles` and the built-ins.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_A2A_FILE_LIMITS } from "../../src/a2a/files/a2a-file-options.js";
import {
  DEFAULT_FILE_MODEL,
  mergedFileDefaults,
  resolvedFilesOf,
  type FileLevels,
} from "../../src/files/file-settings.js";
import { FileSource, FileView } from "../../src/files/model-files.js";
import { kilobytes } from "../../src/units/index.js";

const levels = (over: Partial<FileLevels> = {}): FileLevels => ({
  agent: {},
  defaults: undefined,
  skills: [],
  a2aFiles: undefined,
  hasPiiPolicy: false,
  ...over,
});

describe("mergedFileDefaults", () => {
  it("the one that exists, as it is", () => {
    const only = { maxFiles: 2 };

    expect(mergedFileDefaults(only, undefined)).toBe(only);
    expect(mergedFileDefaults(undefined, only)).toBe(only);
    expect(mergedFileDefaults(undefined, undefined)).toBeUndefined();
  });

  it("the workflow's over the application's, field by field", () => {
    expect(
      mergedFileDefaults(
        { maxFiles: 2, maxFileSize: kilobytes(1) },
        { maxFiles: 3, transcriptionMaxTokens: 9 },
      ),
    ).toEqual({ maxFiles: 3, maxFileSize: kilobytes(1), transcriptionMaxTokens: 9 });
  });
});

describe("the built-ins", () => {
  it("a cheap vision model transcribes and redacts unless set", () => {
    const files = resolvedFilesOf(levels());

    expect(DEFAULT_FILE_MODEL).toBe("google/gemini-2.5-flash-lite");
    expect(files.transcriptionModel).toBe("google/gemini-2.5-flash-lite");
    expect(files.redactionModel).toBe("google/gemini-2.5-flash-lite");
  });

  it("an agent with no setting reads input files as originals, from the A2A defaults", () => {
    const files = resolvedFilesOf(levels());

    expect(files.sources).toEqual([FileSource.Input]);
    expect(files.views).toEqual([FileView.Original]);
    expect(files.maxFileSize).toBe(DEFAULT_A2A_FILE_LIMITS.maxFileSize);
    expect(files.allowedMediaTypes).toEqual([...DEFAULT_A2A_FILE_LIMITS.allowedMediaTypes]);
    expect(files.isTypesExplicit).toBe(false);
  });

  it("a PII policy makes the transcription the default view", () => {
    expect(resolvedFilesOf(levels({ hasPiiPolicy: true })).views).toEqual([FileView.Transcription]);
    expect(
      resolvedFilesOf(levels({ hasPiiPolicy: true, agent: { views: [FileView.Original] } })).views,
    ).toEqual([FileView.Original]);
  });
});

describe("the skills and a2aFiles give the size and the types", () => {
  it("the largest size and the union of the types of the skills that set them", () => {
    const files = resolvedFilesOf(
      levels({
        skills: [
          { maxFileSize: kilobytes(100), allowedMediaTypes: ["image/png", "text/csv"] },
          { maxFileSize: kilobytes(300), allowedMediaTypes: ["application/pdf", "image/png"] },
          {},
        ],
        a2aFiles: { maxFileSize: kilobytes(7), allowedMediaTypes: ["text/plain"] },
      }),
    );

    expect(files.maxFileSize).toBe(kilobytes(300));
    expect(files.allowedMediaTypes).toEqual(["image/png", "text/csv", "application/pdf"]);
  });

  it("skills that set neither leave it to a2aFiles", () => {
    const files = resolvedFilesOf(
      levels({
        skills: [{}, { maxFiles: 2 }],
        a2aFiles: { maxFileSize: kilobytes(7), allowedMediaTypes: ["text/plain"] },
      }),
    );

    expect(files.maxFileSize).toBe(kilobytes(7));
    expect(files.allowedMediaTypes).toEqual(["text/plain"]);
  });

  it("skills that set no type but a size, and a2aFiles with neither: the built-in types", () => {
    const files = resolvedFilesOf(
      levels({ skills: [{ maxFileSize: kilobytes(9) }], a2aFiles: {} }),
    );

    expect(files.maxFileSize).toBe(kilobytes(9));
    expect(files.allowedMediaTypes).toEqual([...DEFAULT_A2A_FILE_LIMITS.allowedMediaTypes]);
  });

  it("a level of the settings beats them, and its types are explicit", () => {
    const files = resolvedFilesOf(
      levels({
        agent: { maxFileSize: kilobytes(1), allowedMediaTypes: ["image/gif"] },
        skills: [{ maxFileSize: kilobytes(300), allowedMediaTypes: ["application/pdf"] }],
      }),
    );

    expect(files.maxFileSize).toBe(kilobytes(1));
    expect(files.allowedMediaTypes).toEqual(["image/gif"]);
    expect(files.isTypesExplicit).toBe(true);
  });
});

describe("the built-in file model", () => {
  it("is Gemini 2.5 Flash Lite, for transcription and redaction alike", () => {
    const files = resolvedFilesOf({
      agent: {},
      defaults: undefined,
      skills: [],
      a2aFiles: undefined,
      hasPiiPolicy: false,
    });

    expect(DEFAULT_FILE_MODEL).toBe("google/gemini-2.5-flash-lite");
    expect(files.transcriptionModel).toBe("google/gemini-2.5-flash-lite");
    expect(files.redactionModel).toBe("google/gemini-2.5-flash-lite");
  });
});
