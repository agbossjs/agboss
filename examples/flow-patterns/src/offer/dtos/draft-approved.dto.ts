import { Text } from "@agboss/core/dto";

/** The reviewer's verdict "send it": a marker, with an optional note for the record. */
export class DraftApprovedDto {
  @Text({ prompt: "a note for the record", optional: true })
  note?: string;
}
