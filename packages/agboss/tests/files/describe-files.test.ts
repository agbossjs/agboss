/**
 * #899 (AC2, M1): what an agent's files are in `agboss describe` (the text and `--json`) and in the config
 * hash — a change of what reaches the model (a view, a limit, a policy's file action) is a new version, an
 * agent without files has no `files` anywhere.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { describeAssembledApplication } from "../../src/describe/describe-application.js";
import { describeServices } from "../../src/describe/describe-workflow.js";
import { workflowSnapshotOf } from "../../src/describe/snapshot.js";
import { elementFingerprintsOf } from "../../src/run/fingerprints.js";
import { AnswerFiles, FileSource, FileView, ModelFiles } from "../../src/files/model-files.js";
import { PiiFileAction, PiiKind, PiiPolicy } from "../../src/index.js";
import { megabytes } from "../../src/units/index.js";
import { readerApplication } from "./reader.factory.js";

@PiiPolicy({
  name: "describe-masks-pii-policy",
  description: "Hides cards",
  rules: [PiiKind.CardNumber.mask()],
  files: PiiFileAction.Mask,
})
class MaskingPolicy {}

@PiiPolicy({
  name: "describe-masks-pii-policy",
  description: "Hides cards",
  rules: [PiiKind.CardNumber.mask()],
  files: PiiFileAction.AllowOriginal,
})
class OpeningPolicy {}

async function snapshotOf(options: Parameters<typeof readerApplication>[0]) {
  const reader = readerApplication(options);
  const assembled = await applicationOf(reader.Application);
  const [workflow] = assembled.workflows;
  if (workflow === undefined) throw new Error("no workflow");
  return {
    lines: describeAssembledApplication(assembled),
    snapshot: workflowSnapshotOf(workflow, describeServices),
  };
}

const agentOf = (snapshot: Awaited<ReturnType<typeof snapshotOf>>["snapshot"]) =>
  snapshot.nodes.find((node) => node.agent !== undefined)?.agent;

describe("AC2: describe shows an agent's files", () => {
  it("the text: where the files come from, in which views, the limits, what may come back", async () => {
    const { lines } = await snapshotOf({
      files: ModelFiles.of({
        sources: [FileSource.Input, FileSource.ToolResults],
        views: [FileView.Original, FileView.Transcription],
        maxFileSize: megabytes(2),
        maxTotalFileSize: megabytes(4),
        maxFiles: 3,
        allowedMediaTypes: ["image/png"],
      }),
    });

    expect(lines).toContain("files");
    expect(lines.join("\n")).toContain(
      "input, tool-results → original, transcription (3 files, 2 MB each, 4 MB in all) · answer files: seen-in-visit",
    );
  });

  it("the JSON: AgentSnapshot.files with the resolved settings; none for an agent without", async () => {
    const withFiles = await snapshotOf({
      files: ModelFiles.of({
        views: [FileView.Transcription],
        answerFiles: AnswerFiles.Any,
        allowedMediaTypes: ["image/png"],
      }),
    });
    const without = await snapshotOf({});

    expect(agentOf(withFiles.snapshot)?.files).toMatchObject({
      sources: ["input"],
      views: ["transcription"],
      allowedMediaTypes: ["image/png"],
      answerFiles: "any",
      guardToolResultFiles: true,
      transcriptionModel: expect.any(String),
    });
    expect(agentOf(withFiles.snapshot)?.files).not.toHaveProperty("redactionModel");
    expect(agentOf(without.snapshot)).not.toHaveProperty("files");
    expect(without.lines).not.toContain("files");
  });
});

describe("AC2: the config hash follows what reaches the model", () => {
  const hashOf = async (options: Parameters<typeof readerApplication>[0]) =>
    (await snapshotOf(options)).snapshot.configHash;

  it("a view, a limit, a source, a type, the answer rule and the tool-result guard each change it", async () => {
    const base = ModelFiles.of({ views: [FileView.Original], allowedMediaTypes: ["image/png"] });
    const variants = [
      ModelFiles.of({ views: [FileView.Transcription], allowedMediaTypes: ["image/png"] }),
      ModelFiles.of({ views: [FileView.Original], allowedMediaTypes: ["image/png"], maxFiles: 2 }),
      ModelFiles.of({
        views: [FileView.Original],
        allowedMediaTypes: ["image/png"],
        sources: [FileSource.Input, FileSource.ToolResults],
      }),
      ModelFiles.of({ views: [FileView.Original], allowedMediaTypes: ["image/jpeg"] }),
      ModelFiles.of({
        views: [FileView.Original],
        allowedMediaTypes: ["image/png"],
        answerFiles: AnswerFiles.Any,
      }),
      ModelFiles.of({
        views: [FileView.Original],
        allowedMediaTypes: ["image/png"],
        guardToolResultFiles: false,
      }),
    ];
    const hashes = new Set([
      await hashOf({ files: base }),
      ...(await Promise.all(variants.map((files) => hashOf({ files })))),
    ]);

    expect(hashes.size).toBe(variants.length + 1);
  });

  it("a PII policy's file action changes it: Mask and AllowOriginal are two versions", async () => {
    const files = ModelFiles.of({
      views: [FileView.Transcription],
      allowedMediaTypes: ["image/png"],
    });

    const masking = await hashOf({ files, piiPolicies: [MaskingPolicy] });
    const opening = await hashOf({ files, piiPolicies: [OpeningPolicy] });

    expect(masking).not.toBe(opening);
  });

  it("the fingerprint of an agent names each policy's file action: two policies that differ only in it differ", async () => {
    const files = ModelFiles.of({
      views: [FileView.Transcription],
      allowedMediaTypes: ["image/png"],
    });
    const fingerprintOf = async (policy: typeof MaskingPolicy) => {
      const assembled = await applicationOf(
        readerApplication({ files, piiPolicies: [policy] }).Application,
      );
      const [workflow] = assembled.workflows;
      if (workflow === undefined) throw new Error("no workflow");
      return JSON.stringify(
        elementFingerprintsOf({
          config: workflow.config,
          routers: workflow.routers,
          pii: workflow.pii,
        }),
      );
    };

    const masking = await fingerprintOf(MaskingPolicy);
    const opening = await fingerprintOf(OpeningPolicy);

    expect(masking).toContain(`"files":"mask"`);
    expect(opening).toContain(`"files":"allow-original"`);
    expect(masking).not.toBe(opening);
  });
});
