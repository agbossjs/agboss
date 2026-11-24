import { FilePolicy } from "@agboss/core";
import { hours, megabytes } from "@agboss/core/units";

/** The invoices a request takes: a PDF and a CSV, kept a day after the request ends. */
@FilePolicy({
  ttl: hours(24),
  maxFiles: 2,
  allowedMediaTypes: ["application/pdf", "text/csv"],
  maxFileSize: megabytes(5),
  maxTotalFileSize: megabytes(10),
})
export class InvoiceFilePolicy {}
