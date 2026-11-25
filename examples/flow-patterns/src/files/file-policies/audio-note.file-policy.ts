import { FilePolicy } from "@agboss/core";
import { hours, megabytes } from "@agboss/core/units";

/** The voice notes a request takes: mp3 or m4a, kept an hour after the request ends. */
@FilePolicy({
  ttl: hours(1),
  maxFiles: 1,
  allowedMediaTypes: ["audio/mpeg", "audio/mp4"],
  maxFileSize: megabytes(5),
  maxTotalFileSize: megabytes(5),
})
export class AudioNoteFilePolicy {}
