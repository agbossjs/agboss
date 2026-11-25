import { File, FileDto } from "@agboss/core/dto";

/** A photo of an ID card. */
export class IdCheckRequestDto {
  @File({ prompt: "A photo of the ID card" })
  photo!: FileDto;
}
