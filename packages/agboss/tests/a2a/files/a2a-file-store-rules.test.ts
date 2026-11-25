/**
 * #859 AC4: where an application's A2A files may live, checked at assembly from the declarations —
 * inline in its tasks' records silently up to 64 KB, with `[a2a.inline-files-without-store]` up to
 * 256 KB, never above (`[a2a.file-store-required]`); on leases its instances share, files above 256
 * KB in one host's store are `[a2a.file-store-not-shared]`; and the options and the retention of
 * files are checked (`[file-policy.invalid]`, `[application.retention-invalid]`).
 */
import { describe, expect, it } from "vitest";
import { A2AEndpoint } from "../../../src/a2a/a2a-endpoint.decorator.js";
import { FilePolicy, type FilePolicyOptions } from "../../../src/files/file-policy.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { Application, type ApplicationOptions } from "../../../src/application/application.js";
import { applicationOf } from "../../../src/application/assemble.js";
import { retentionViolations } from "../../../src/application/retention.js";
import { assemblyWarningsOf } from "../../../src/application/start-log.js";
import { Injectable } from "../../../src/components/decorators.js";
import type { Provider } from "../../../src/components/injection.js";
import { GraphRuleError } from "../../../src/graph/rule-error.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryFileRepository } from "../../../src/infrastructure/in-memory-file.repository.js";
import type { StoreDescriptor } from "../../../src/infrastructure/execution-lease.repository.js";
import { LocalDiskFileRepository } from "../../../src/infrastructure/local-disk-file.repository.js";
import { EmptyEnvironment, Ttl } from "../../../src/index.js";
import { hours, kilobytes, minutes } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { PostgresLeases } from "../../application/fixtures/store-backends.fixture.js";
import { PostgresA2ATasks } from "../fixtures/a2a-task-stores.fixture.js";
import {
  FileCallerChannel,
  FileReviewWorkflowStart,
  fileReviewFlow,
} from "../fixtures/files.application.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/** A file store every instance reaches (an S3 bucket, say). */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
class SharedA2AFiles extends InMemoryFileRepository {
  static override readonly store: StoreDescriptor = { backend: "s3" };
}

const appWith = (
  files: FilePolicyOptions | undefined,
  providers: readonly Provider[] = [],
  more: Partial<ApplicationOptions> = {},
) => {
  @FilePolicy({ ttl: hours(24), name: "rules-file-policy", ...files })
  class RulesFilePolicy {}

  @Workflow({
    name: "rules-file-review-workflow",
    version: "1.0.0",
    historyTtl: Ttl.Forever,
    flow: fileReviewFlow,
    filePolicy: RulesFilePolicy,
  })
  class RulesWorkflow {}

  @A2AEndpoint({
    name: "rules-a2a-expose",
    version: "1.0.0",
    description: "files",
    ttl: { tasks: hours(24), messages: minutes(15) },
    skills: [{ start: FileReviewWorkflowStart, tags: ["files"] }],
  })
  class RulesA2AExpose {}

  @Application({
    name: "rules-application",
    modelProvider: TestModelProvider,
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [RulesWorkflow],
    providers: [FileCallerChannel, ...providers],
    endpoints: [RulesA2AExpose],
    budgets: TEST_BUDGETS,
    ...more,
  })
  class RulesApplication {}
  return RulesApplication;
};

const isOwn = (code: string): boolean =>
  code.startsWith("a2a.") ||
  code.startsWith("file-policy.") ||
  code.startsWith("workflow.") ||
  code === "application.retention-invalid";

/** The assembly's file rule codes, or its warnings' file codes when it assembles. */
async function outcomeOf(application: ReturnType<typeof appWith>) {
  try {
    const assembled = await applicationOf(application);
    return {
      violations: [] as string[],
      warnings: assemblyWarningsOf({ ...assembled })
        .map((warning) => warning.code)
        .filter(isOwn),
    };
  } catch (error) {
    if (!(error instanceof GraphRuleError)) throw error;
    const violations = error.violations.map((each) => each.code).filter(isOwn);
    return { violations, warnings: [] as string[] };
  }
}

const sized = (total: number): FilePolicyOptions => ({
  maxFileSize: kilobytes(total),
  maxTotalFileSize: kilobytes(total),
});

describe("#859 AC4: the storage tier of files, with no file store listed", () => {
  it("up to 64 KB: inline, silently", async () => {
    expect(await outcomeOf(appWith(sized(64)))).toEqual({ violations: [], warnings: [] });
  });

  it("up to 256 KB: inline, with [a2a.inline-files-without-store]", async () => {
    const { violations, warnings } = await outcomeOf(appWith(sized(256)));

    expect(violations).toEqual([]);
    expect(warnings).toContain("a2a.inline-files-without-store");
  });

  it("above 256 KB: [a2a.file-store-required] — a file store listed lifts it", async () => {
    expect((await outcomeOf(appWith(sized(257)))).violations).toEqual(["a2a.file-store-required"]);
    expect(await outcomeOf(appWith(sized(1024), [InMemoryFileRepository]))).toEqual({
      violations: [],
      warnings: [],
    });
  });

  it("the workflow's filePolicy sizes the tier", async () => {
    const big = appWith(sized(512));

    expect((await outcomeOf(big)).violations).toEqual(["a2a.file-store-required"]);
  });
});

describe("#859 AC4: files above 256 KB on leases the instances share", () => {
  const shared = [PostgresLeases, PostgresA2ATasks];

  it("in one host's store (in-memory, local disk): [a2a.file-store-not-shared]", async () => {
    for (const store of [InMemoryFileRepository, LocalDiskFileRepository])
      expect((await outcomeOf(appWith(sized(1024), [...shared, store]))).violations).toEqual([
        "a2a.file-store-not-shared",
      ]);
  });

  it("in a store every instance reaches, or within the inline tiers: assembled", async () => {
    expect((await outcomeOf(appWith(sized(1024), [...shared, SharedA2AFiles]))).violations).toEqual(
      [],
    );
    expect(
      (await outcomeOf(appWith(sized(64), [...shared, InMemoryFileRepository]))).violations,
    ).toEqual([]);
  });

  it("on the in-memory leases of one instance, any store is its own: assembled", async () => {
    expect((await outcomeOf(appWith(sized(1024), [InMemoryFileRepository]))).violations).toEqual(
      [],
    );
  });
});

describe("#859: the file options and their retention, checked at assembly", () => {
  it("[file-policy.invalid] on the workflow's policy, each problem once", async () => {
    const app = appWith({ allowedOrigins: ["http://insecure.example"], maxFiles: 0 });

    expect((await outcomeOf(app)).violations).toEqual([
      "file-policy.invalid",
      "file-policy.invalid",
    ]);
  });

  it("retention.a2aFiles is gone: a typo of retention, refused (#1316: the files age by @FilePolicy.ttl)", () => {
    const messages = retentionViolations("files-application", { a2aFiles: hours(48) }).map(
      (found) => found.message,
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("retention.a2aFiles is not a retention");
  });
});
