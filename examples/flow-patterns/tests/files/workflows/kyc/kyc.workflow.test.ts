import { createHash } from "node:crypto";
import sharp from "sharp";
import { expect } from "vitest";
import { FileRedactor, PiiRefusedError } from "@agboss/core";
import { replyWith, testWith } from "@agboss/core/testing";
import { FlowPatternsApplication } from "../../../../src/flow-patterns.application.js";
import { KycAgent } from "../../../../src/files/agents/kyc/kyc.agent.js";
import { KycResultWorkflowFinish } from "../../../../src/files/workflows/kyc/kyc-result.workflow-finish.js";
import { KycWorkflowStart } from "../../../../src/files/workflows/kyc/kyc.workflow-start.js";

/** #899: an ID photo reaches the model as a redacted copy made by the built-in redactor (scripted: mockModel(FileRedactor)), never as the original; an SSN found in it refuses it. */

const test = testWith(FlowPatternsApplication);

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const inline = (bytes: Uint8Array, mediaType: string, filename: string) => ({
  mediaType,
  filename,
  inline: Buffer.from(bytes).toString("base64"),
  sha256: sha256Of(bytes),
  sizeBytes: bytes.byteLength,
});

/** A small card photo: a white image with a red block where the number is. */
async function idPhoto(): Promise<Buffer> {
  const block = await sharp({
    create: { width: 40, height: 10, channels: 3, background: "#ff0000" },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width: 120, height: 80, channels: 3, background: "#ffffff" } })
    .composite([{ input: block, left: 10, top: 20 }])
    .png()
    .toBuffer();
}

test("the ID photo reaches the model as a redacted copy, never as the original", async ({
  app,
  mockModel,
}) => {
  const photo = await idPhoto();
  const redactor = mockModel(FileRedactor).thenReturn(
    replyWith('{"regions":[{"target":"card-number","x":0.08,"y":0.25,"w":0.34,"h":0.12}]}'),
  );
  const agent = mockModel(KycAgent).thenReturn(replyWith("An ID card, intact."));

  const result = await app.execute(KycWorkflowStart, {
    photo: inline(photo, "image/png", "id.png"),
  });

  expect(redactor.requests).toHaveLength(1);
  const [request] = agent.requests;
  const parts = request?.kind === "chat" ? request.parts : [];
  expect(parts).toHaveLength(1);
  expect(parts[0]?.sha256).not.toBe(sha256Of(photo));
  expect(result).toFinishWith(KycResultWorkflowFinish, { text: "An ID card, intact." });
});

test("an SSN found in the photo refuses it: the model is never called", async ({
  app,
  mockModel,
}) => {
  const photo = await idPhoto();
  mockModel(FileRedactor).thenReturn(
    replyWith('{"regions":[{"target":"us-ssn","x":0.08,"y":0.25,"w":0.34,"h":0.12}]}'),
  );
  const agent = mockModel(KycAgent);

  const run = app.execute(KycWorkflowStart, { photo: inline(photo, "image/png", "id.png") });

  await expect(run).rejects.toBeInstanceOf(PiiRefusedError);
  expect(agent).toHaveBeenCalledTimes(0);
});
