import { Flag, Text } from "@agboss/core/dto";

/** The venue buyer's answer: the venue, and whether it was booked (its purchase approved). */
export class VenueBookingDto {
  @Text({ prompt: "the venue" })
  venue!: string;

  @Flag({ prompt: "whether the venue was booked: false when its purchase was declined" })
  isBooked!: boolean;
}
