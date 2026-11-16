import { Nested } from "@agboss/core/dto";
import { A2AFileDto } from "@agboss/core/a2a";

/** An invoice and the list of its items: a PDF and a CSV. */
export class InvoiceRequestDto {
  @Nested(A2AFileDto, { prompt: "The invoice, a PDF" })
  invoice!: A2AFileDto;

  @Nested(A2AFileDto, { prompt: "The invoice's items, a CSV" })
  items!: A2AFileDto;
}
