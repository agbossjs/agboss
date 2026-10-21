import { Text } from "agboss/dto";

/** What the offsite got: one line per purchase, booked or declined. */
export class OffsiteBookingDto {
  @Text({ prompt: "what was booked and what was declined" })
  summary!: string;
}
