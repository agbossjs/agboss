/**
 * #1318c: the `filePolicies` shelf and the `workflows.<name>.filePolicy` slot of a profile. One carrier of
 * the components' options (`ComponentOptions`) serves every reader of a file limit, so the limit is the
 * same on every path: `Files`, the inline offload, the file expiry, the A2A skills and tier, the assembly
 * rules and an agent's files. The declared policy class is never changed.
 */
import { describe, expect, it } from "vitest";
import { a2aFileStoreViolations } from "../../src/a2a/a2a-file-store-rule.js";
import { startsOfEndpoint } from "../../src/a2a/a2a-endpoint.decorator.js";
import { fileTierSizeOf } from "../../src/a2a/files/a2a-file-tier.js";
import { Files } from "../../src/a2a/files/files.service.js";
import { servedSkillsOf } from "../../src/a2a/server/a2a-skills.js";
import { applicationOf, type AssembledApplication } from "../../src/application/assemble.js";
import { fileCutoffsOf } from "../../src/application/file-expiry.js";
import { ComponentOptions } from "../../src/components/component-options.js";
import { componentOf } from "../../src/components/metadata.js";
import { ProfileError, ProfileErrorReason } from "../../src/config/profile-error.js";
import { FileError } from "../../src/core/error-families/remote-errors.js";
import { contractsOf } from "../../src/describe/contracts.js";
import { FileDto } from "../../src/dto/standard/file.js";
import { FileRefusal } from "../../src/files/file-errors.js";
import { filePolicyMetaOf } from "../../src/files/file-policy.js";
import { MAX_INLINE_FILE_BYTES } from "../../src/files/inline-cap.js";
import { inlineFilesOf } from "../../src/files/inline-offload.js";
import { runInFrame } from "../../src/flow/context/frame.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { testWith } from "../../src/testing/index.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { bytes, hours, kilobytes, seconds } from "../../src/units/index.js";
import {
  FileReviewPolicy,
  FileReviewWorkflow,
  FileSummaryWorkflow,
} from "../a2a/fixtures/files.application.js";
import { testFrame } from "../helpers/frame.js";
import {
  FilesAgentPolicy,
  FilesBareApplication,
  FilesBareWorkflow,
  FilesConfigApplication,
  FilesSkillExpose,
  FilesSkillPolicy,
  FilesSlotPolicy,
} from "./fixtures/files-app/files.application.js";

const NOW = new Date("2026-01-05T09:00:00.000Z");

const assembled = (profile?: string) =>
  applicationOf(FilesConfigApplication, profile === undefined ? {} : { profile });

const failure = async (attempt: Promise<unknown>): Promise<ProfileError> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error("expected a ProfileError");
};

const refusalOf = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "ok",
    (error: unknown) => (error as FileError.Refused).refusal,
  );

/** A frame of an execution of `workflow`, where a step's `Files` runs. */
const inWorkflow = <T>(workflow: unknown, work: () => Promise<T>): Promise<T> => {
  const frame = testFrame();
  const descriptor = { ...frame.execution.workflow, type: workflow } as never;
  return runInFrame({ ...frame, execution: { ...frame.execution, workflow: descriptor } }, work);
};

const text = (size: number) => ({ bytes: new Uint8Array(size), mediaType: "text/plain" });

/** The skill of `FilesSkillExpose` as the listener serves it. */
function skillOf(app: AssembledApplication) {
  const meta = componentOf(FilesSkillExpose);
  if (meta?.kind !== "a2a-endpoint") throw new Error("not an endpoint");
  const [skill] = servedSkillsOf(startsOfEndpoint(meta.meta), {
    contracts: contractsOf(app),
    workflows: app.workflows.map((one) => one.graph.type),
    expose: meta.meta,
    options: app.componentOptions,
  });
  if (skill === undefined) throw new Error("no skill");
  return skill;
}

/** How long the inline offload keeps a file of `workflow`: the ttl the store was handed. */
async function offloadTtlOf(app: AssembledApplication, workflow: unknown) {
  const store = new InMemoryFileRepository(new InMemoryDatabase());
  const inline = inlineFilesOf(
    () => store,
    new VirtualClock(NOW),
    workflow as never,
    app.componentOptions,
  );
  const big = FileDto.fromBytes(new Uint8Array(MAX_INLINE_FILE_BYTES + 1).fill(1), {
    mediaType: "application/pdf",
  });
  await inline.offload(big, { tenantId: "t", ownerId: "run-1" });
  return (await store.findMetadata({ tenantId: "t", fileId: big.fileId ?? "" }))?.ttl;
}

/** How long the sweep of the files keeps those of `name`'s workflow. */
const expiryTtlOf = (app: AssembledApplication, name: string): number | undefined => {
  const cutoff = fileCutoffsOf(
    app.workflows.map((one) => one.graph.type),
    NOW,
    app.componentOptions,
  ).get(name);
  return cutoff === undefined ? undefined : NOW.getTime() - cutoff.getTime();
};

const strict = testWith(FilesConfigApplication, { profile: "strict" });
const slotted = testWith(FilesConfigApplication, { profile: "slot" });

describe("the filePolicies shelf: one ttl on every path", () => {
  it("declared: no profile carries nothing, every reader reads the declared 24 hours", async () => {
    const app = await assembled();

    expect(app.componentOptions).toBe(ComponentOptions.none);
    expect(app.componentOptions.workflowFileLimits(FileReviewWorkflow).ttl).toBe(hours(24));
    expect(await offloadTtlOf(app, FileReviewWorkflow)).toBe(hours(24));
    expect(expiryTtlOf(app, "file-review-workflow")).toBe(hours(24));
    expect(skillOf(app).fileLimits.ttl).toBe(hours(24));
  });

  it("the profile's two hours: the carrier, the offload, the expiry and the skill agree", async () => {
    const app = await assembled("strict");

    expect(app.componentOptions.workflowFileLimits(FileReviewWorkflow).ttl).toBe(hours(2));
    expect(await offloadTtlOf(app, FileReviewWorkflow)).toBe(hours(2));
    expect(expiryTtlOf(app, "file-review-workflow")).toBe(hours(2));
    // the summary workflow shares the policy class: its skill's own policy sets no ttl
    expect(skillOf(app).fileLimits.ttl).toBe(hours(2));
  });

  strict(
    "Files.save of the application's container: the same ttl, size and types",
    async ({ app }) => {
      await app.ready();
      const files = app.resolve(Files);
      const save = (content: Parameters<Files["save"]>[0]) =>
        refusalOf(inWorkflow(FileReviewWorkflow, () => files.save(content)));

      expect(await save(text(20))).toBe("ok");
      expect(await save(text(21))).toBe(FileRefusal.TooLarge);
      expect(await save({ bytes: new Uint8Array(5), mediaType: "application/pdf" })).toBe(
        FileRefusal.MediaType,
      );
      expect(await save({ ...text(5), ttl: hours(3) })).toBe(FileRefusal.TtlAbovePolicy);
      expect(await save({ ...text(5), ttl: hours(1) })).toBe("ok");
    },
  );

  strict(
    "a workflow whose policy the profile leaves alone keeps its declared limits",
    async ({ app }) => {
      await app.ready();
      const carrier = app.resolve(ComponentOptions);

      expect(carrier.workflowFileLimits(FileReviewWorkflow).maxFileSize).toBe(bytes(20));
      expect(carrier.workflowFileLimits(FileSummaryWorkflow).maxFileSize).toBe(bytes(20));
      // a policy the profile names only for its agent's workflow: the others are not touched
      expect(carrier.fileLimits(FilesSkillPolicy).maxFileSize).toBe(bytes(10));
    },
  );
});

describe("the filePolicies shelf: one size on every path", () => {
  it("the skill's own policy over its workflow's, both with the profile's values", async () => {
    const app = await assembled("strict");
    const skill = skillOf(app);

    expect(skill.fileLimits).toMatchObject({ maxFileSize: 10, maxFiles: 1 });
    expect(skill.outputFileMediaTypes).toEqual(["text/plain"]);
  });

  it("the storage tier and the assembly rules read the profile, not the declaration", async () => {
    const app = await assembled("strict");
    const declared = await assembled();
    const options = {
      name: "files-config-application",
      endpoints: [FilesSkillExpose],
      workflows: [FileSummaryWorkflow],
    } as never;

    expect(fileTierSizeOf([FilesSkillExpose], [FileSummaryWorkflow], app.componentOptions)).toBe(
      40,
    );
    expect(
      fileTierSizeOf([FilesSkillExpose], [FileSummaryWorkflow], declared.componentOptions),
    ).toBe(kilobytes(64));
    expect(a2aFileStoreViolations(options, app.componentOptions)).toEqual([]);
  });

  it("a skill's policy a profile makes wider than its workflow's is an assembly error", async () => {
    await expect(assembled("skill-wider")).rejects.toThrow(
      /a2a\.skill-file-policy-exceeds-workflow[\s\S]*maxFileSize 30 is above 20/u,
    );
  });

  it("an agent's files: the limits of its workflow's policy under the profile", async () => {
    const agentFilesOf = (app: AssembledApplication) =>
      app.workflows.find((one) => one.config.name === "files-reader-workflow")?.config.agents[
        "files-reader-agent"
      ]?.files;

    expect(agentFilesOf(await assembled())?.maxFileSize).toBe(kilobytes(8));
    expect(agentFilesOf(await assembled("strict"))).toMatchObject({
      maxFileSize: 15,
      fetchTimeout: seconds(3),
    });
  });

  it("never changes the declared policy classes, nor another assembly of them", async () => {
    await assembled("strict");
    await assembled("slot-and-shelf");
    const plain = await assembled();

    expect(filePolicyMetaOf(FileReviewPolicy)?.maxFileSize).toBeUndefined();
    expect(filePolicyMetaOf(FileReviewPolicy)?.ttl).toBe(hours(24));
    expect(filePolicyMetaOf(FilesSkillPolicy)?.maxFileSize).toBe(kilobytes(4));
    expect(filePolicyMetaOf(FilesAgentPolicy)?.maxFileSize).toBe(kilobytes(8));
    expect(filePolicyMetaOf(FilesSlotPolicy)?.ttl).toBe(hours(2));
    expect(plain.componentOptions.workflowFileLimits(FileReviewWorkflow).ttl).toBe(hours(24));
  });
});

describe("the workflows.<name>.filePolicy slot", () => {
  it("replaces the declared policy on every path, and only for that workflow", async () => {
    const app = await assembled("slot");
    const carrier = app.componentOptions;

    expect(carrier.workflowFilePolicy(FileSummaryWorkflow)).toBe(FilesSlotPolicy);
    expect(carrier.workflowFilePolicy(FileReviewWorkflow)).toBe(FileReviewPolicy);
    expect(carrier.workflowFileLimits(FileSummaryWorkflow)).toMatchObject({
      ttl: hours(2),
      maxFileSize: kilobytes(6),
      allowedMediaTypes: ["text/plain"],
    });
    expect(expiryTtlOf(app, "file-summary-workflow")).toBe(hours(2));
    expect(expiryTtlOf(app, "file-review-workflow")).toBe(hours(24));
    expect(await offloadTtlOf(app, FileSummaryWorkflow)).toBe(hours(2));
    expect(await offloadTtlOf(app, FileReviewWorkflow)).toBe(hours(24));
    expect(skillOf(app).fileLimits).toMatchObject({ ttl: hours(2), maxFileSize: kilobytes(4) });
  });

  slotted("Files.save of the slotted workflow is bounded by the slot's policy", async ({ app }) => {
    await app.ready();
    const files = app.resolve(Files);
    const save = (workflow: unknown, size: number) =>
      refusalOf(inWorkflow(workflow, () => files.save(text(size))));

    expect(await save(FileSummaryWorkflow, kilobytes(6) + 1)).toBe(FileRefusal.TooLarge);
    expect(await save(FileSummaryWorkflow, kilobytes(6))).toBe("ok");
    expect(await save(FileReviewWorkflow, kilobytes(6) + 1)).toBe("ok");
  });

  it("the shelf changes the slot's policy in its turn", async () => {
    const carrier = (await assembled("slot-and-shelf")).componentOptions;

    expect(carrier.workflowFileLimits(FileSummaryWorkflow).ttl).toBe(hours(3));
    expect(filePolicyMetaOf(FilesSlotPolicy)?.ttl).toBe(hours(2));
  });

  it("a slot's policy a profile makes smaller than the skill's own is an assembly error", async () => {
    await expect(assembled("slot-below-skill")).rejects.toThrow(
      /a2a\.skill-file-policy-exceeds-workflow[\s\S]*maxFileSize 4096 is above 1024/u,
    );
  });

  it("a workflow that declares no policy gets one from the slot", async () => {
    await expect(applicationOf(FilesBareApplication, {})).rejects.toThrow(
      /workflow\.file-policy-required/u,
    );

    const app = await applicationOf(FilesBareApplication, { profile: "bare-slot" });

    expect(app.componentOptions.workflowFilePolicy(FilesBareWorkflow)).toBe(FilesSlotPolicy);
    expect(app.componentOptions.workflowFileLimits(FilesBareWorkflow).ttl).toBe(hours(2));
  });

  it("a class that is no @FilePolicy is refused, and so is a slot in a YAML file", async () => {
    const wrong = await failure(applicationOf(FilesBareApplication, { profile: "not-a-policy" }));
    const yaml = await failure(assembled("slot-in-yaml"));

    expect(wrong.message).toMatch(/workflows\.files-bare-workflow\.filePolicy is no @FilePolicy/u);
    expect(yaml.reason).toBe(ProfileErrorReason.Forbidden);
  });
});

describe("the filePolicies shelf: a name or a value that is wrong is a ProfileError", () => {
  it("a policy the application does not use", async () => {
    const error = await failure(assembled("ghost-policy"));

    expect(error.reason).toBe(ProfileErrorReason.Unknown);
    expect(error.message).toContain("filePolicies.ghost-policy");
    expect(error.message).toContain("file-review-policy");
  });

  it("a limit of 0, a total smaller than the file, an origin that is no https one", async () => {
    expect((await failure(assembled("bad-limit"))).reason).toBe(ProfileErrorReason.Invalid);
    const order = await failure(assembled("bad-order"));
    const origin = await failure(assembled("bad-origin"));

    expect(order.reason).toBe(ProfileErrorReason.Invalid);
    expect(order.message).toContain("maxFileSize is larger than maxTotalFileSize");
    expect(origin.message).toContain("filePolicies.file-review-policy: allowedOrigins entry");
  });
});
