/**
 * #859 AC4: where an application's A2A files may live, checked at assembly from the declarations —
 * inline in its tasks' records silently up to 64 KB, with `[a2a.inline-files-without-store]` up to
 * 256 KB, never above (`[a2a.file-store-required]`); on leases its instances share, files above 256
 * KB in one host's store are `[a2a.file-store-not-shared]`; and the options and the retention of
 * files are checked (`[a2a.file-options-invalid]`, `[application.retention-invalid]`).
 */
import { describe, expect, it } from "vitest";
import { A2AExpose } from "../../../src/a2a/a2a-expose.decorator.js";
import type { A2AFileOptions } from "../../../src/a2a/files/a2a-file-options.js";
import { Application, type ApplicationOptions } from "../../../src/application/application.js";
import { applicationOf } from "../../../src/application/assemble.js";
import { retentionViolations } from "../../../src/application/retention.js";
import { assemblyWarningsOf } from "../../../src/application/start-log.js";
import { Injectable } from "../../../src/components/decorators.js";
import type { Provider } from "../../../src/components/injection.js";
import { GraphRuleError } from "../../../src/graph/rule-error.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryA2AFileRepository } from "../../../src/infrastructure/in-memory-a2a-file.repository.js";
import type { StoreDescriptor } from "../../../src/infrastructure/execution-lease.repository.js";
import { LocalDiskA2AFileRepository } from "../../../src/infrastructure/local-disk-a2a-file.repository.js";
import { EmptyEnvironment } from "../../../src/index.js";
import { hours, kilobytes } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { PostgresLeases } from "../../application/fixtures/store-backends.fixture.js";
import { PostgresA2ATasks } from "../fixtures/a2a-task-stores.fixture.js";
import {
  FileCallerChannel,
  FileReviewWorkflow,
  FileReviewWorkflowStart,
} from "../fixtures/files.application.js";

/** A file store every instance reaches (an S3 bucket, say). */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
class SharedA2AFiles extends InMemoryA2AFileRepository {
  static override readonly store: StoreDescriptor = { backend: "s3" };
}

const appWith = (
  files: A2AFileOptions | undefined,
  providers: readonly Provider[] = [],
  more: Partial<ApplicationOptions> = {},
) => {
  @A2AExpose({
    name: "rules-a2a-expose",
    version: "1.0.0",
    description: "files",
    exports: [FileReviewWorkflowStart],
    skills: {
      "file-review-workflow-start": { tags: ["files"], ...(files === undefined ? {} : { files }) },
    },
  })
  class RulesA2AExpose {}

  @Application({
    name: "rules-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [FileReviewWorkflow],
    providers: [FileCallerChannel, ...providers],
    exposes: [RulesA2AExpose],
    budgets: TEST_BUDGETS,
    ...more,
  })
  class RulesApplication {}
  return RulesApplication;
};

const isOwn = (code: string): boolean =>
  code.startsWith("a2a.") || code === "application.retention-invalid";

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

const sized = (total: number): A2AFileOptions => ({
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
    expect(await outcomeOf(appWith(sized(1024), [InMemoryA2AFileRepository]))).toEqual({
      violations: [],
      warnings: [],
    });
  });

  it("the application's a2aFiles count too, under the skill's own", async () => {
    const big = appWith(undefined, [], { a2aFiles: sized(512) });

    expect((await outcomeOf(big)).violations).toEqual(["a2a.file-store-required"]);
  });
});

describe("#859 AC4: files above 256 KB on leases the instances share", () => {
  const shared = [PostgresLeases, PostgresA2ATasks];

  it("in one host's store (in-memory, local disk): [a2a.file-store-not-shared]", async () => {
    for (const store of [InMemoryA2AFileRepository, LocalDiskA2AFileRepository])
      expect((await outcomeOf(appWith(sized(1024), [...shared, store]))).violations).toEqual([
        "a2a.file-store-not-shared",
      ]);
  });

  it("in a store every instance reaches, or within the inline tiers: assembled", async () => {
    expect((await outcomeOf(appWith(sized(1024), [...shared, SharedA2AFiles]))).violations).toEqual(
      [],
    );
    expect(
      (await outcomeOf(appWith(sized(64), [...shared, InMemoryA2AFileRepository]))).violations,
    ).toEqual([]);
  });

  it("on the in-memory leases of one instance, any store is its own: assembled", async () => {
    expect((await outcomeOf(appWith(sized(1024), [InMemoryA2AFileRepository]))).violations).toEqual(
      [],
    );
  });
});

describe("#859: the file options and their retention, checked at assembly", () => {
  it("[a2a.file-options-invalid] on the skill's and the application's options", async () => {
    const app = appWith({ allowedFileOrigins: ["http://insecure.example"] }, [], {
      a2aFiles: { maxFiles: 0 },
    });

    expect((await outcomeOf(app)).violations).toEqual([
      "a2a.file-options-invalid",
      "a2a.file-options-invalid",
    ]);
  });

  it("retention.a2aFiles above a2aTasks keeps files no task reads: [application.retention-invalid]", async () => {
    const longer = appWith(undefined, [], { retention: { a2aFiles: hours(48) } });
    const shorter = appWith(undefined, [], { retention: { a2aFiles: hours(1) } });

    expect((await outcomeOf(longer)).violations).toEqual(["application.retention-invalid"]);
    expect((await outcomeOf(shorter)).violations).toEqual([]);
  });

  it("#904 item 5 AC5.3: a2aFiles' refusal names a2aFiles and a2aTasks only, its fix among them", () => {
    const messages = [
      ...retentionViolations("files-application", { a2aFiles: hours(48) }),
      ...retentionViolations("files-application", { a2aFiles: 0 }),
    ].map((found) => found.message);

    expect(messages).toEqual([
      expect.stringContaining(
        "— @Application({ retention: { a2aTasks: hours(24), a2aFiles: hours(24) } })",
      ),
      expect.stringContaining("— @Application({ retention: { a2aFiles: hours(24) } })"),
    ]);
    expect(messages.filter((text) => /fencedEffects|meshAnswers/.test(text))).toEqual([]);
  });
});
