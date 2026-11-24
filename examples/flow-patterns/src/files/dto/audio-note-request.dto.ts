import { Nested } from "@agboss/core/dto";
import { A2AFileDto } from "@agboss/core/a2a";

/** A voice note. */
export class AudioNoteRequestDto {
  @Nested(A2AFileDto, { prompt: "The voice note, an mp3" })
  note!: A2AFileDto;
}
