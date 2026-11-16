import { Agent, FileView, ModelFiles } from "@agboss/core";
import { megabytes } from "@agboss/core/units";
import { InvoiceRequestDto } from "../../dto/invoice-request.dto.js";

/**
 * Reads an invoice PDF and its items CSV: the PDF as a native content part, the CSV as text
 * (`FileView.Original`). A model that cannot take a PDF stops the application at start
 * (`[model.unsupported-input]`), not on the first call.
 */
@Agent({
  name: "invoice-reader-agent",
  description: "Reads an invoice and its items",
  prompt: "Read the invoice and its items. Give the invoice number and the total, one line.",
  model: "google/gemini-2.5-flash-lite",
  input: { request: InvoiceRequestDto },
  files: ModelFiles.of({
    views: [FileView.Original],
    allowedMediaTypes: ["application/pdf", "text/csv"],
    maxFileSize: megabytes(5),
    maxTotalFileSize: megabytes(10),
    maxFiles: 2,
  }),
})
export class InvoiceReaderAgent {}
