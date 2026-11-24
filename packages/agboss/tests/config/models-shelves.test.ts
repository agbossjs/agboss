/**
 * #1318c: the `ragRerankers`, `fileTranscribers` and `fileMaskers` shelves of a profile — the model of a
 * model reranker, of the built-in file transcriber and of the built-in image redactor. Each is read where
 * its model is resolved; a name nothing has, or an agent that does not read the view, is a ProfileError;
 * the declared components are never changed.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { componentOf } from "../../src/components/metadata.js";
import { ProfileError, ProfileErrorReason } from "../../src/config/profile-error.js";
import { withFileModels } from "../../src/config/file-model-overrides.js";
import { FileView } from "../../src/files/model-files.js";
import { DocsReranker } from "../rag/fixtures/rerank.application.js";
import { ModelsApplication } from "./fixtures/models-app/models.application.js";

const assembled = (profile?: string) =>
  applicationOf(ModelsApplication, profile === undefined ? {} : { profile });

const failure = async (attempt: Promise<unknown>): Promise<ProfileError> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error("expected a ProfileError");
};

const rerankerModelOf = async (profile?: string) =>
  (await assembled(profile)).workflows[0]?.rerankers?.find((one) => one.name === "docs-reranker");

describe("the ragRerankers shelf", () => {
  it("declared: the reranker's own model", async () => {
    expect((await rerankerModelOf())?.model).toBe("local/llama");
  });

  it("a profile's model is the one the reranker is resolved to, the declared class untouched", async () => {
    expect((await rerankerModelOf("reranker"))?.model).toBe("local/other");
    const meta = componentOf(DocsReranker);
    expect(meta?.kind === "reranker" ? meta.meta.model : undefined).toBe("local/llama");
    expect((await rerankerModelOf())?.model).toBe("local/llama");
  });

  it("a reranker the application lacks, or a provider no workflow reaches, is a ProfileError or a rule", async () => {
    const ghost = await failure(assembled("ghost-reranker"));

    expect(ghost.reason).toBe(ProfileErrorReason.Unknown);
    expect(ghost.message).toContain("ragRerankers.ghost-reranker");
    await expect(assembled("ghost-provider")).rejects.toThrow(
      /ragRerankers\.docs-reranker\.modelProvider/u,
    );
  });
});

describe("the fileTranscribers and fileMaskers shelves", () => {
  it("an agent that is not the application's, or one that does not read the view, is a ProfileError", async () => {
    for (const profile of ["ghost-transcriber", "ghost-masker", "unread-view"]) {
      const error = await failure(assembled(profile));

      expect(error.reason).toBe(ProfileErrorReason.Unknown);
      expect(error.message).toMatch(/fileTranscribers\.|fileMaskers\./u);
    }
  });

  it("a provider for a file model is refused when the file loads: the gateway finds the one that serves the model", async () => {
    await expect(assembled("transcriber-provider")).rejects.toThrow(/modelProvider/u);
  });

  it("the config of an agent that reads the view carries the profile's model; the others' do not", () => {
    const files = (views: readonly FileView[]) => ({
      views,
      transcriptionModel: "local/llama",
      redactionModel: "local/llama",
    });
    const config = {
      agents: {
        "reads-agent": { files: files([FileView.Transcription, FileView.Redacted]) },
        "plain-agent": { files: files([FileView.Original]) },
      },
    };
    const byKey = new Map([
      ["files.transcriber.reads-agent", { model: "local/t" }],
      ["files.redactor.reads-agent", { model: "local/r" }],
      ["files.transcriber.plain-agent", { model: "local/x" }],
    ]);
    const overrides = { providers: [], byKey, reached: new Set<string>() };

    const patched = withFileModels(config as never, overrides);

    expect(patched.agents?.["reads-agent"]?.files).toMatchObject({
      transcriptionModel: "local/t",
      redactionModel: "local/r",
    });
    expect(patched.agents?.["plain-agent"]?.files?.transcriptionModel).toBe("local/llama");
    expect([...overrides.reached].sort()).toEqual([
      "files.redactor.reads-agent",
      "files.transcriber.reads-agent",
    ]);
    expect(config.agents["reads-agent"].files.transcriptionModel).toBe("local/llama");
  });
});
