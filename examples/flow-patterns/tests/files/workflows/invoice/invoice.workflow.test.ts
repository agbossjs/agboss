import { createHash } from "node:crypto";
import { expect } from "vitest";
import { replyWith, testWith } from "@agboss/core/testing";
import { FlowPatternsApplication } from "../../../../src/flow-patterns.application.js";
import { InvoiceReaderAgent } from "../../../../src/files/agents/invoice-reader/invoice-reader.agent.js";
import { InvoiceResultWorkflowFinish } from "../../../../src/files/workflows/invoice/invoice-result.workflow-finish.js";
import { InvoiceWorkflowStart } from "../../../../src/files/workflows/invoice/invoice.workflow-start.js";

/** #899: an invoice PDF reaches the model as a content part and its CSV as text; a request shows a file as { kind, mediaType, sizeBytes, sha256 }, never its bytes. */

const test = testWith(FlowPatternsApplication);

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const inline = (bytes: Uint8Array, mediaType: string, filename: string) => ({
  mediaType,
  filename,
  inline: Buffer.from(bytes).toString("base64"),
  sha256: sha256Of(bytes),
  sizeBytes: bytes.byteLength,
});

const PDF = Buffer.from("%PDF-1.7 invoice INV-7");
const CSV = Buffer.from("item,price\nlamp,12\n");

test("the invoice PDF is a content part, its CSV is text", async ({ app, mockLlm }) => {
  const agent = mockLlm(InvoiceReaderAgent).thenReturn(replyWith("INV-7, total 12"));

  const result = await app.execute(InvoiceWorkflowStart, {
    invoice: inline(PDF, "application/pdf", "invoice.pdf"),
    items: inline(CSV, "text/csv", "items.csv"),
  });

  const [request] = agent.requests;
  expect(request?.kind === "chat" ? request.parts : []).toEqual([
    expect.objectContaining({ kind: "file", mediaType: "application/pdf", sha256: sha256Of(PDF) }),
  ]);
  expect(JSON.stringify(request)).toContain("item,price");
  expect(result).toFinishWith(InvoiceResultWorkflowFinish, { text: "INV-7, total 12" });
});
