import { Bool, Text } from "@agboss/core/dto";

/** The flight buyer's answer: the flights, and whether they were booked (their purchase approved). */
export class FlightBookingDto {
  @Text({ prompt: "the flights: from where to where" })
  route!: string;

  @Bool({ prompt: "whether the flights were booked: false when their purchase was declined" })
  isBooked!: boolean;
}
