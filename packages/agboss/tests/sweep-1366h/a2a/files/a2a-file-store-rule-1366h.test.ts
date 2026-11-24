/**
 * #1366: the file store rule reports, per violation, the code and the node it names (the
 * application, or the expose whose skill options are wrong), measures the tier in KB (256 KB is the
 * edge, 64 KB the silent one), reads absent providers/exposes as none, reads two listed lease stores
 * (an unknown pairing) as no lease backend, and treats every one-host store as one host's.
 */
import { describe, expect, it } from "vitest";
import {
  a2aFileStoreViolations,
  inlineFilesWarningOf,
} from "../../../../src/a2a/a2a-file-store-rule.js";
import { A2AExpose } from "../../../../src/a2a/a2a-expose.decorator.js";
import { FilePolicy, type FilePolicyOptions } from "../../../../src/files/file-policy.js";
import { Workflow } from "../../../../src/flow/decorators/workflow.js";
import type { Provider } from "../../../../src/components/injection.js";
import { InMemoryFileRepository } from "../../../../src/infrastructure/in-memory-file.repository.js";
import { InMemoryExecutionLeaseRepository } from "../../../../src/infrastructure/execution-lease.repository.js";
import { LocalDiskFileRepository } from "../../../../src/infrastructure/local-disk-file.repository.js";
import { kilobytes } from "../../../../src/units/index.js";
import { PostgresLeases } from "../../../application/fixtures/store-backends.fixture.js";
import { PostgresA2ATasks } from "../../../a2a/fixtures/a2a-task-stores.fixture.js";
import {
  FileReviewWorkflow,
  FileReviewWorkflowStart,
  fileReviewFlow,
} from "../../../a2a/fixtures/files.application.js";

const sized = (total: number): FilePolicyOptions => ({
  maxFileSize: kilobytes(total),
  maxTotalFileSize: kilobytes(total),
});

let counter = 0;

/** The file review workflow under a `@FilePolicy` of these options. */
function workflowWith(options: FilePolicyOptions) {
  counter += 1;
  @FilePolicy({ name: `sized-${String(counter)}-file-policy`, ...options })
  class SizedPolicy {}

  @Workflow({
    name: `sized-${String(counter)}-workflow`,
    version: "1.0.0",
    flow: fileReviewFlow,
    filePolicy: SizedPolicy,
  })
  class SizedWorkflow {}
  return SizedWorkflow;
}

@FilePolicy({ name: "zero-files-file-policy", maxFiles: 0 })
class ZeroFilesPolicy {}

@A2AExpose({
  name: "rules-a2a-expose",
  version: "1.0.0",
  description: "files",
  exports: [FileReviewWorkflowStart],
  skills: { "file-review-workflow-start": { tags: ["files"], filePolicy: ZeroFilesPolicy } },
})
class BadSkillExpose {}

@A2AExpose({
  name: "plain-a2a-expose",
  version: "1.0.0",
  description: "files",
  exports: [FileReviewWorkflowStart],
  skills: { "file-review-workflow-start": { tags: ["files"] } },
})
class PlainExpose {}

const optionsOf = (over: Record<string, unknown>) => {
  const { files, ...rest } = over;
  return {
    name: "rules-application",
    workflows: [
      files === undefined ? FileReviewWorkflow : workflowWith(files as FilePolicyOptions),
    ],
    exposes: [PlainExpose],
    ...rest,
  } as never;
};

const outcomeOf = (over: Record<string, unknown>) =>
  a2aFileStoreViolations(optionsOf(over)).map((found) => ({
    code: found.code,
    nodes: found.nodes,
    message: found.message,
  }));

describe("#1366 the nodes a violation names", () => {
  it("a workflow's policy names the application, a skill's the expose", () => {
    const found = outcomeOf({ exposes: [BadSkillExpose], files: { maxFiles: 0 } });
    expect(found.map(({ code, nodes }) => ({ code, nodes }))).toEqual([
      { code: "file-policy.invalid", nodes: ["rules-application"] },
      { code: "file-policy.invalid", nodes: ["rules-a2a-expose"] },
    ]);
  });

  it("file-store-required and file-store-not-shared name the application and show the KB", () => {
    const required = outcomeOf({ files: sized(1024), providers: [] });
    expect(required).toHaveLength(1);
    expect(required[0]).toMatchObject({
      code: "a2a.file-store-required",
      nodes: ["rules-application"],
    });
    expect(required[0]?.message).toMatch(/keep up to 1024 KB of files, above the 256 KB/);

    const notShared = outcomeOf({
      files: sized(1024),
      providers: [PostgresLeases, PostgresA2ATasks, InMemoryFileRepository],
    });
    expect(notShared).toHaveLength(1);
    expect(notShared[0]).toMatchObject({
      code: "a2a.file-store-not-shared",
      nodes: ["rules-application"],
    });
    expect(notShared[0]?.message).toContain("up to 1024 KB");
  });
});

describe("#1366 tiers and absent options", () => {
  it("no providers listed at all: above 256 KB a store is required", () => {
    expect(outcomeOf({ files: sized(300) }).map(({ code }) => code)).toEqual([
      "a2a.file-store-required",
    ]);
  });

  it("no exposes listed: no files, no violation", () => {
    expect(outcomeOf({ exposes: undefined, files: sized(1024) })).toEqual([]);
  });

  it("256 KB exactly needs no store; a store of one host is the same with every one-host backend", () => {
    expect(outcomeOf({ files: sized(256) })).toEqual([]);
    for (const store of [InMemoryFileRepository, LocalDiskFileRepository]) {
      expect(
        outcomeOf({
          files: sized(257),
          providers: [PostgresLeases, PostgresA2ATasks, store],
        }).map(({ code }) => code),
      ).toEqual(["a2a.file-store-not-shared"]);
    }
  });

  it("two listed lease stores (unknown pairing) are no in-memory leases: a one-host store is refused", () => {
    const providers: Provider[] = [
      PostgresLeases,
      InMemoryExecutionLeaseRepository,
      InMemoryFileRepository,
    ];
    expect(outcomeOf({ files: sized(1024), providers }).map(({ code }) => code)).toEqual([
      "a2a.file-store-not-shared",
    ]);
  });
});

describe("#1366 inlineFilesWarningOf", () => {
  const sourcesOf = (total: number) => ({
    name: "rules-application",
    providers: [],
    exposes: [PlainExpose],
    workflows: [workflowWith(sized(total))],
  });

  it("a warning between 64 and 256 KB (both edges), showing the KB; none outside", () => {
    expect(inlineFilesWarningOf(sourcesOf(64))).toBeUndefined();
    expect(inlineFilesWarningOf(sourcesOf(65))).toMatch(/keep up to 65 KB of files inline/);
    expect(inlineFilesWarningOf(sourcesOf(256))).toMatch(/keep up to 256 KB of files inline/);
    expect(inlineFilesWarningOf(sourcesOf(257))).toBeUndefined();
  });

  it("none when a store is listed", () => {
    expect(
      inlineFilesWarningOf({ ...sourcesOf(100), providers: [InMemoryFileRepository] }),
    ).toBeUndefined();
  });
});
