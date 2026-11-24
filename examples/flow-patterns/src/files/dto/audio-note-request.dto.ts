import { File, FileDto } from "@agboss/core/dto";

/** A voice note. */
export class AudioNoteRequestDto {
  @File({ prompt: "The voice note, an mp3" })
  note!: FileDto;
}
