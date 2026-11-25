import { Injectable } from "../../components/decorators.js";
import { ComponentOptions } from "../../components/component-options.js";
import { FileRepository } from "../../infrastructure/file.repository.js";
import { Clock, lazyLoad } from "../../infrastructure/clock.js";
import type { FileDto } from "../../dto/standard/file.js";
import { FileRefusal, fileRefused } from "../../files/file-errors.js";
import type { Milliseconds } from "../../units/index.js";
import { mediaTypeEssenceOf } from "./a2a-file-options.js";

/** A file a step makes: its bytes, its media type and its name. */
export interface FileToSave {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly filename?: string;
  /**
   * How long it is kept once the execution's tree has ended; at most the workflow's `@FilePolicy.ttl`
   * (else `FileError.Refused`, `FileRefusal.TtlAbovePolicy`), which is its default.
   */
  readonly ttl?: Milliseconds;
}

/** A file by reference: its media type and name. */
export interface FileReference {
  readonly mediaType: string;
  readonly filename?: string;
}

/** What the service does, loaded with its first save or read. */
const work = () => lazyLoad(import("./files-work.js"));

/**
 * What a step does with the files of its A2A task (#859, `deps: [Files]`): reads the bytes of a
 * file its input holds (`read`), makes one for its finish's output (`save` — kept in the
 * application's `FileRepository` under the task, or inline with none listed — bounded by
 * its workflow's `@FilePolicy`, its bytes checked against its media type), or names one by
 * reference (`fromUrl`, served as a `url` part). A file is its task's: another task's is never
 * read, whatever descriptor a step holds.
 */
@Injectable({ deps: [FileRepository, Clock, ComponentOptions] })
export class Files {
  /**
   * @internal The container injects the application's file store and clock: left out of the
   * declarations.
   */
  constructor(
    private readonly store: FileRepository,
    private readonly clock: Clock,
    private readonly options: ComponentOptions,
  ) {}

  /** Keeps a file for this execution's task; the descriptor its output holds. */
  async save(content: FileToSave): Promise<FileDto> {
    return (await work()).savedFile(this.store, this.clock, content, this.options);
  }

  /** A file by reference: its `url` is the output's part; its bytes never pass through here. */
  fromUrl(url: string, reference: FileReference): FileDto {
    if (!URL.canParse(url) || new URL(url).protocol !== "https:")
      throw fileRefused({ refusal: FileRefusal.UrlInvalid });
    return {
      mediaType: mediaTypeEssenceOf(reference.mediaType),
      ...(reference.filename === undefined ? {} : { filename: reference.filename }),
      url,
    };
  }

  /** The bytes of a file of this execution's task, checked against its `sha256`. */
  async read(file: FileDto): Promise<Uint8Array> {
    return (await work()).readFile(this.store, this.clock, file, this.options);
  }
}
