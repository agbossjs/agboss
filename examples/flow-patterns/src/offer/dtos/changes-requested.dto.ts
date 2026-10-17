import { Text } from "agboss/dto";

/** The reviewer's verdict "rewrite it": what to change in the draft. */
export class ChangesRequestedDto {
  @Text({ prompt: "what to change" })
  notes!: string;
}
