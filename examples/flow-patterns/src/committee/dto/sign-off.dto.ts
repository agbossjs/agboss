import { Bool, Text } from "@agboss/core/dto";

/** One party's answer: whether it signs, and why not when it does not. */
export class SignOffDto {
  @Bool({ prompt: "whether the party signs the contract off" })
  approved!: boolean;

  @Text({ prompt: "why, in a sentence", optional: true })
  note?: string;
}
