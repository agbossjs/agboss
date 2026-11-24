import { File, FileDto } from "@agboss/core/dto";

/** An invoice and the list of its items: a PDF and a CSV. */
export class InvoiceRequestDto {
  @File({ prompt: "The invoice, a PDF" })
  invoice!: FileDto;

  @File({ prompt: "The invoice's items, a CSV" })
  items!: FileDto;
}
