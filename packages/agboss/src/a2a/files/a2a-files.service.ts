import { Injectable } from "../../components/decorators.js";
import { A2AFileRepository } from "../../infrastructure/a2a-file.repository.js";
import { Clock, lazyLoad } from "../../infrastructure/clock.js";
import type { A2AFileDto } from "./a2a-file.dto.js";
import { A2AFileRefusal, A2AFileRefusedError } from "./a2a-file-errors.js";
import { mediaTypeEssenceOf } from "./a2a-file-options.js";

/** A file a step makes: its bytes, its media type and its name. */
export interface A2AFileContent {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly filename?: string;
}

/** A file by reference: its media type and name. */
export interface A2AFileReference {
  readonly mediaType: string;
  readonly filename?: string;
}

/** What the service does, loaded with its first save or read. */
const work = () => lazyLoad(import("./a2a-files-work.js"));

/**
 * What a step does with the files of its A2A task (#859, `deps: [A2AFiles]`): reads the bytes of a
 * file its input holds (`read`), makes one for its finish's output (`save` — kept in the
 * application's `A2AFileRepository` under the task, or inline with none listed — bounded by
 * `@Application({ a2aFiles })`, its bytes checked against its media type), or names one by
 * reference (`fromUrl`, served as a `url` part). A file is its task's: another task's is never
 * read, whatever descriptor a step holds.
 */
@Injectable({ deps: [A2AFileRepository, Clock] })
export class A2AFiles {
  constructor(
    private readonly store: A2AFileRepository,
    private readonly clock: Clock,
  ) {}

  /** Keeps a file for this execution's task; the descriptor its output holds. */
  async save(content: A2AFileContent): Promise<A2AFileDto> {
    return (await work()).savedFile(this.store, this.clock, content);
  }

  /** A file by reference: its `url` is the output's part; its bytes never pass through here. */
  fromUrl(url: string, reference: A2AFileReference): A2AFileDto {
    if (!URL.canParse(url) || new URL(url).protocol !== "https:")
      throw new A2AFileRefusedError({ refusal: A2AFileRefusal.UrlInvalid });
    return {
      mediaType: mediaTypeEssenceOf(reference.mediaType),
      ...(reference.filename === undefined ? {} : { filename: reference.filename }),
      url,
    };
  }

  /** The bytes of a file of this execution's task, checked against its `sha256`. */
  async read(file: A2AFileDto): Promise<Uint8Array> {
    return (await work()).readFile(this.store, file);
  }
}
