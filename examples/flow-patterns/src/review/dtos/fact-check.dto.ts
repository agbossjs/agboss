import { Text } from "agboss/dto";

/** One fact checker's finding: two copies check independently. */
export class FactCheckDto {
  @Text({ prompt: "a claim to verify, or none" })
  claim!: string;
}
