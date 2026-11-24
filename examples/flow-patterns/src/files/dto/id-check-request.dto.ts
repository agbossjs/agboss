import { Nested } from "@agboss/core/dto";
import { A2AFileDto } from "@agboss/core/a2a";

/** A photo of an ID card. */
export class IdCheckRequestDto {
  @Nested(A2AFileDto, { prompt: "A photo of the ID card" })
  photo!: A2AFileDto;
}
