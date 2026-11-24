/**
 * #1316: `@FilePolicy` — one class bounds a workflow's files; a workflow with files names one; a
 * skill's own policy only tightens it; `Files.save` and `Files.read` of a file by url read it; the
 * old options are on no entry.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { a2aFileStoreViolations } from "../../src/a2a/a2a-file-store-rule.js";
import { A2AEndpoint } from "../../src/a2a/a2a-endpoint.decorator.js";
import { Files } from "../../src/a2a/files/files.service.js";
import { FileError } from "../../src/core/error-families/remote-errors.js";
import { FileRefusal, FileUnavailableReason } from "../../src/files/file-errors.js";
import {
  FilePolicy,
  filePolicyExcesses,
  fileLimitsOf,
  filePolicyMetaOf,
} from "../../src/files/file-policy.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { runInFrame } from "../../src/flow/context/frame.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { kilobytes, hours, minutes } from "../../src/units/index.js";
import {
  FileReviewWorkflow,
  FileReviewWorkflowStart,
  fileReviewFlow,
} from "../a2a/fixtures/files.application.js";
import { PDF, TEXT } from "../a2a/files/support.js";
import { testFrame } from "../helpers/frame.js";
import { ComponentOptions } from "../../src/components/component-options.js";

const API = join(import.meta.dirname, "../../api");
const reports = readdirSync(API)
  .filter((file) => file.endsWith(".api.md"))
  .map((file) => readFileSync(join(API, file), "utf8"));

describe("#1316b: the old options are on no entry", () => {
  it("A2AFileOptions, the listener's fetch options and ByReference are gone; @FilePolicy is there", () => {
    const text = reports.join("\n");

    expect(text).not.toMatch(/\bA2AFileOptions\b/u);
    expect(text).not.toMatch(/\bmaxConcurrentFileFetches\w*\b/u);
    expect(text).not.toMatch(/\bfileFetchTimeout\b/u);
    expect(text).not.toMatch(/\ba2aFiles\?: A2AFileOptions/u);
    expect(text).not.toMatch(/ByReference/u);
    expect(text).toMatch(/function FilePolicy\(/u);
    expect(text).toMatch(/interface FileFetchPool/u);
    expect(text).toMatch(/FetchBusy/u);
  });
});

describe("#1316b: @FilePolicy and the limits it gives", () => {
  it("records its name (the class name in kebab-case by default) and its options", () => {
    @FilePolicy({ maxFiles: 2 })
    class DeskFilesPolicy {}
    @FilePolicy({ name: "own-name", description: "d" })
    class Named {}

    expect(filePolicyMetaOf(DeskFilesPolicy)).toMatchObject({
      name: "desk-files-policy",
      maxFiles: 2,
    });
    expect(filePolicyMetaOf(Named)).toMatchObject({ name: "own-name", description: "d" });
    expect(
      filePolicyMetaOf(
        class Bare {
          readonly bare = true;
        },
      ),
    ).toBeUndefined();
  });

  it("a narrower policy over its parent's, field by field; one that is no policy sets nothing", () => {
    @FilePolicy({ maxFiles: 3, maxFileSize: kilobytes(8), allowedOrigins: ["https://a.example"] })
    class Parent {}
    @FilePolicy({ maxFiles: 1 })
    class Child {}

    expect(fileLimitsOf(Parent, Child)).toMatchObject({
      maxFiles: 1,
      maxFileSize: kilobytes(8),
      allowedOrigins: ["https://a.example"],
    });
    expect(
      fileLimitsOf(
        Parent,
        class Plain {
          readonly plain = true;
        },
      ).maxFiles,
    ).toBe(3);
  });

  it("what a narrower policy sets beyond its parent's: sizes, counts, timeouts, types and origins", () => {
    @FilePolicy({
      maxFiles: 3,
      allowedMediaTypes: ["text/plain"],
      allowedOrigins: ["https://a.example"],
    })
    class Parent {}
    @FilePolicy({
      maxFiles: 4,
      allowedMediaTypes: ["text/plain", "image/png"],
      allowedOrigins: ["https://b.example"],
    })
    class Wider {}
    @FilePolicy({ maxFiles: 2, allowedMediaTypes: ["text/plain"] })
    class Tighter {}

    expect(filePolicyExcesses(Parent, Wider)).toEqual([
      "maxFiles 4 is above 3",
      "allowedMediaTypes has image/png, which it does not",
      "allowedOrigins has https://b.example, which it does not",
    ]);
    expect(filePolicyExcesses(Parent, Tighter)).toEqual([]);
    // with no parent, the built-ins are the bound: no origin is allowed there
    expect(filePolicyExcesses(undefined, Wider)).toEqual([
      "allowedOrigins has https://b.example, which it does not",
    ]);
  });
});

describe("#1316b: the assembly rules", () => {
  const optionsOf = (workflow: unknown, endpoints: readonly unknown[] = []) =>
    ({ name: "rules-application", workflows: [workflow], endpoints }) as never;
  const codes = (found: readonly { readonly code: string }[]) => found.map(({ code }) => code);

  it("[workflow.file-policy-required]: files in the flow, no policy on the workflow", () => {
    @Workflow({
      name: "no-policy-file-review-workflow",
      version: "1.0.0",
      flow: fileReviewFlow,
    })
    class NoPolicyWorkflow {}

    expect(
      codes(a2aFileStoreViolations(optionsOf(NoPolicyWorkflow), ComponentOptions.none)),
    ).toEqual(["workflow.file-policy-required"]);
    expect(a2aFileStoreViolations(optionsOf(FileReviewWorkflow), ComponentOptions.none)).toEqual(
      [],
    );
  });

  it("[file-policy.not-a-file-policy]: a class that is no @FilePolicy named by a workflow", () => {
    class Plain {
      readonly plain = true;
    }
    @Workflow({
      name: "plain-policy-file-review-workflow",
      version: "1.0.0",
      flow: fileReviewFlow,
      filePolicy: Plain,
    })
    class PlainPolicyWorkflow {}

    expect(
      codes(a2aFileStoreViolations(optionsOf(PlainPolicyWorkflow), ComponentOptions.none)),
    ).toEqual(["file-policy.not-a-file-policy"]);
  });

  it("[a2a.skill-file-policy-exceeds-workflow]: a skill's policy that sets more than its workflow's", () => {
    @FilePolicy({ maxFiles: 9 })
    class Wide {}
    @FilePolicy({ maxFiles: 1 })
    class Narrow {}
    const exposeWith = (name: string, filePolicy: new () => object) => {
      @A2AEndpoint({
        name,
        version: "1.0.0",
        description: "files",
        ttl: { tasks: hours(24), messages: minutes(15) },
        skills: [{ start: FileReviewWorkflowStart, filePolicy }],
      })
      class Expose {}
      return Expose;
    };

    const wide = a2aFileStoreViolations(
      optionsOf(FileReviewWorkflow, [exposeWith("wide-a2a-expose", Wide)]),
      ComponentOptions.none,
    );
    const narrow = a2aFileStoreViolations(
      optionsOf(FileReviewWorkflow, [exposeWith("narrow-a2a-expose", Narrow)]),
      ComponentOptions.none,
    );

    expect(codes(wide)).toEqual(["a2a.skill-file-policy-exceeds-workflow"]);
    expect(wide[0]?.message).toContain("maxFiles 9 is above 5");
    expect(narrow).toEqual([]);
  });
});

describe("#1316b: a step's Files read the policy of its workflow", () => {
  const clock = new VirtualClock(new Date("2026-01-05T09:00:00.000Z"));
  const files = () =>
    new Files(new InMemoryFileRepository(new InMemoryDatabase()), clock, ComponentOptions.none);
  const reasonOf = (work: Promise<unknown>) =>
    work.then(
      () => "ok",
      (error: unknown) =>
        error instanceof FileError.Unavailable
          ? error.reason
          : (error as FileError.Refused).refusal,
    );

  /** A frame of an execution of a workflow with this policy. */
  const inWorkflowOf = <T>(policy: new () => object, work: () => Promise<T>): Promise<T> => {
    @Workflow({
      name: `policy-${policy.name.toLowerCase()}-workflow`,
      version: "1.0.0",
      flow: fileReviewFlow,
      filePolicy: policy,
    })
    class PolicyWorkflow {}
    const frame = testFrame();
    const workflow = { ...frame.execution.workflow, type: PolicyWorkflow } as never;
    return runInFrame({ ...frame, execution: { ...frame.execution, workflow } }, work);
  };

  it("Files.save: the media types and the size of the policy, else the built-ins", async () => {
    @FilePolicy({ allowedMediaTypes: ["text/plain"], maxFileSize: kilobytes(1) })
    class TextOnly {}

    const outcomes = await Promise.all([
      reasonOf(
        inWorkflowOf(TextOnly, () => files().save({ bytes: PDF, mediaType: "application/pdf" })),
      ),
      reasonOf(
        inWorkflowOf(TextOnly, () => files().save({ bytes: TEXT, mediaType: "text/plain" })),
      ),
      reasonOf(
        inWorkflowOf(TextOnly, () =>
          files().save({ bytes: new Uint8Array(2048).fill(97), mediaType: "text/plain" }),
        ),
      ),
    ]);

    expect(outcomes).toEqual([FileRefusal.MediaType, "ok", FileRefusal.TooLarge]);
  });

  it("Files.read of a file by url: refused off the policy's origins, never fetched", async () => {
    @FilePolicy({ allowedOrigins: ["https://files.example"] })
    class Origins {}
    const url = files().fromUrl("https://elsewhere.example/a.pdf", {
      mediaType: "application/pdf",
    });

    expect(await reasonOf(inWorkflowOf(Origins, () => files().read(url)))).toBe(
      FileRefusal.OriginDenied,
    );
    expect(
      await reasonOf(
        inWorkflowOf(
          class None {
            readonly none = true;
          },
          () => files().read(url),
        ),
      ),
    ).toBe(FileRefusal.OriginDenied);
    expect(FileUnavailableReason.FetchBusy).toBe("fetch-busy");
  });
});
