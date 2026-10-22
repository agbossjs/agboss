import { Integer, Text } from "agboss/dto";

/** What to book: where and for how many nights. */
export class TripRequestDto {
  @Text({ prompt: "where the trip goes" })
  destination!: string;

  @Integer({ prompt: "how many nights" })
  nights!: number;
}

export class TripFlightDto {
  @Text({ prompt: "the flight booking's id at the airline" })
  bookingId!: string;
}

export class TripHotelDto {
  @Text({ prompt: "the hotel booking's id at the hotel" })
  bookingId!: string;
}

export class TripBookedDto {
  @Text({ prompt: "the flight booking's id" })
  flightBookingId!: string;

  @Text({ prompt: "the hotel booking's id" })
  hotelBookingId!: string;
}
