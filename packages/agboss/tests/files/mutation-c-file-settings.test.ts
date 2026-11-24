/**
 * #1269: what an agent's files come to — every level applied: the agent's over its workflow's over its
 * application's, over the workflow's file policy and the built-ins.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILE_FETCH_TIMEOUT,
  DEFAULT_FILE_LIMITS,
  FilePolicy,
  type FilePolicyOptions,
} from "../../src/files/file-policy.js";
import {
  DEFAULT_FILE_MODEL,
  mergedFileDefaults,
  resolvedFilesOf,
  type FileLevels,
} from "../../src/files/file-settings.js";
import { FileSource, FileView } from "../../src/files/model-files.js";
import { kilobytes, seconds } from "../../src/units/index.js";

const levels = (over: Partial<FileLevels> = {}): FileLevels => ({
  agent: {},
  defaults: undefined,
  filePolicy: undefined,
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
    expect(files.maxFileSize).toBe(DEFAULT_FILE_LIMITS.maxFileSize);
    expect(files.allowedMediaTypes).toEqual([...DEFAULT_FILE_LIMITS.allowedMediaTypes]);
    expect(files.isTypesExplicit).toBe(false);
  });

  it("a PII policy makes the transcription the default view", () => {
    expect(resolvedFilesOf(levels({ hasPiiPolicy: true })).views).toEqual([FileView.Transcription]);
    expect(
      resolvedFilesOf(levels({ hasPiiPolicy: true, agent: { views: [FileView.Original] } })).views,
    ).toEqual([FileView.Original]);
  });
});

/** A `@FilePolicy` class with these options. */
const policyOf = (options: FilePolicyOptions) => {
  @FilePolicy({ name: "settings-file-policy", ...options })
  class Policy {}
  return Policy;
};

describe("the workflow's file policy gives the limits, the types and the fetch", () => {
  it("its size and types, narrowed to the models' kinds, not explicit", () => {
    const files = resolvedFilesOf(
      levels({
        filePolicy: policyOf({
          maxFileSize: kilobytes(7),
          maxTotalFileSize: kilobytes(70),
          maxFiles: 2,
          allowedMediaTypes: ["text/plain"],
        }),
      }),
    );

    expect(files.maxFileSize).toBe(kilobytes(7));
    expect(files.maxTotalFileSize).toBe(kilobytes(70));
    expect(files.maxFiles).toBe(2);
    expect(files.allowedMediaTypes).toEqual(["text/plain"]);
    expect(files.isTypesExplicit).toBe(false);
  });

  it("a policy that sets no type leaves the built-in types", () => {
    const files = resolvedFilesOf(levels({ filePolicy: policyOf({ maxFileSize: kilobytes(9) }) }));

    expect(files.maxFileSize).toBe(kilobytes(9));
    expect(files.allowedMediaTypes).toEqual([...DEFAULT_FILE_LIMITS.allowedMediaTypes]);
  });

  it("its origins, timeout and pool ride the settings: a model's read of a file by url uses them", () => {
    const fetchPool = { maxConcurrent: 3, maxQueuedPerOwner: 2 };
    const files = resolvedFilesOf(
      levels({
        filePolicy: policyOf({
          allowedOrigins: ["https://files.example"],
          fetchTimeout: seconds(3),
          fetchPool,
        }),
      }),
    );

    expect(files.allowedOrigins).toEqual(["https://files.example"]);
    expect(files.fetchTimeout).toBe(seconds(3));
    expect(files.fetchPool).toBe(fetchPool);
    expect(resolvedFilesOf(levels()).fetchPool).toBeUndefined();
    expect(resolvedFilesOf(levels()).fetchTimeout).toBe(DEFAULT_FILE_FETCH_TIMEOUT);
  });

  it("a level of the settings beats it, and its types are explicit", () => {
    const files = resolvedFilesOf(
      levels({
        agent: { maxFileSize: kilobytes(1), allowedMediaTypes: ["image/gif"] },
        filePolicy: policyOf({
          maxFileSize: kilobytes(30),
          maxTotalFileSize: kilobytes(30),
          allowedMediaTypes: ["application/pdf"],
        }),
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
      filePolicy: undefined,
      hasPiiPolicy: false,
    });

    expect(DEFAULT_FILE_MODEL).toBe("google/gemini-2.5-flash-lite");
    expect(files.transcriptionModel).toBe("google/gemini-2.5-flash-lite");
    expect(files.redactionModel).toBe("google/gemini-2.5-flash-lite");
  });
});
