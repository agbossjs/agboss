/**
 * #899 AC6: audio and video follow the rules of images — read through the guarded path, checked by their
 * magic bytes, shown to the model as parts, held to the limits and the allowed types before any model call.
 */
import { FileError } from "../../src/core/error-families/remote-errors.js";
import { describe, expect, it } from "vitest";
import { isOfMediaType } from "../../src/a2a/files/a2a-media-check.js";
import { ModelFileLimitError, FileRefusal } from "../../src/files/file-errors.js";
import { FileView, ModelFileLimit, ModelFiles } from "../../src/files/model-files.js";
import { replyWith, testWith } from "../../src/testing/index.js";
import { kilobytes } from "../../src/units/index.js";
import { execute } from "../helpers/flow.js";
import { inline, readerApplication, sha256Of } from "./reader.factory.js";

const bytes = (head: number[], tail = "x-rest"): Buffer =>
  Buffer.concat([Buffer.from(head), Buffer.from(tail)]);
const ascii = (text: string): number[] => [...Buffer.from(text, "latin1")];

const MP3 = bytes(ascii("ID3"));
const WAV = bytes([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAVE")]);
const OGG = bytes(ascii("OggS"));
const FLAC = bytes(ascii("fLaC"));
const M4A = bytes([0, 0, 0, 24, ...ascii("ftypM4A ")]);
const MP4 = bytes([0, 0, 0, 24, ...ascii("ftypisom")]);
const MOV = bytes([0, 0, 0, 20, ...ascii("ftypqt  ")]);
const WEBM = bytes([0x1a, 0x45, 0xdf, 0xa3]);

describe("AC6: the magic bytes of audio and video", () => {
  it("each type accepts its own signature", () => {
    const cases: [string, Buffer][] = [
      ["audio/mpeg", MP3],
      ["audio/mpeg", bytes([0xff, 0xfb, 0x90])],
      ["audio/wav", WAV],
      ["audio/x-wav", WAV],
      ["audio/ogg", OGG],
      ["audio/flac", FLAC],
      ["audio/aac", bytes([0xff, 0xf1, 0x50])],
      ["audio/mp4", M4A],
      ["video/mp4", MP4],
      ["video/quicktime", MOV],
      ["video/webm", WEBM],
      ["video/x-matroska", WEBM],
    ];
    expect(cases.map(([type, body]) => isOfMediaType(type, body))).toEqual(cases.map(() => true));
  });

  it("a type refuses another's signature, and a video is no audio brand", () => {
    expect(isOfMediaType("audio/mpeg", WAV)).toBe(false);
    expect(isOfMediaType("audio/wav", MP3)).toBe(false);
    expect(isOfMediaType("audio/ogg", FLAC)).toBe(false);
    expect(isOfMediaType("video/mp4", M4A)).toBe(false);
    expect(isOfMediaType("audio/mp4", MP4)).toBe(false);
    expect(isOfMediaType("video/webm", MP4)).toBe(false);
    expect(isOfMediaType("audio/mpeg", Buffer.from("plain text"))).toBe(false);
  });
});

describe("AC6: audio and video reach the model as parts", () => {
  const reader = readerApplication({
    files: ModelFiles.of({
      views: [FileView.Original],
      allowedMediaTypes: ["audio/mpeg", "video/mp4"],
    }),
  });

  testWith(reader.Application)(
    "AC6: an mp3 and an mp4 are an audio and a video part, shown as { kind, mediaType, sizeBytes, sha256 }",
    async ({ app, mockLlm }) => {
      const agent = mockLlm(reader.Agent).thenReturn(replyWith("heard"));

      await execute(app, reader.Start, {
        document: inline(MP3, "audio/mpeg", "note.mp3"),
        pages: [inline(MP4, "video/mp4", "clip.mp4")],
      });

      const [request] = agent.requests;
      expect(request?.kind === "chat" ? request.parts : []).toEqual([
        expect.objectContaining({
          kind: "audio",
          mediaType: "audio/mpeg",
          sizeBytes: MP3.byteLength,
          sha256: sha256Of(MP3),
        }),
        expect.objectContaining({
          kind: "video",
          mediaType: "video/mp4",
          sizeBytes: MP4.byteLength,
          sha256: sha256Of(MP4),
        }),
      ]);
      expect(JSON.stringify(request)).not.toContain(MP3.toString("base64"));
    },
  );

  testWith(reader.Application)(
    "AC6: bytes that are not what the type says are refused before any model call",
    async ({ app, mockLlm }) => {
      const agent = mockLlm(reader.Agent);

      const run = execute(app, reader.Start, { document: inline(WAV, "audio/mpeg", "fake.mp3") });

      await expect(run).rejects.toFailWith(FileError.Refused, {
        refusal: FileRefusal.MediaTypeMismatch,
      });
      expect(agent).toHaveBeenCalledTimes(0);
    },
  );
});

describe("AC6: the limits of size and type hold for audio and video, before any model call", () => {
  const small = readerApplication({
    files: ModelFiles.of({
      views: [FileView.Original],
      allowedMediaTypes: ["audio/mpeg", "video/mp4"],
      maxFileSize: kilobytes(1),
      maxTotalFileSize: kilobytes(1),
    }),
  });
  const mp3Only = readerApplication({
    files: ModelFiles.of({ views: [FileView.Original], allowedMediaTypes: ["audio/mpeg"] }),
  });

  testWith(small.Application)(
    "AC6: a video over maxFileSize is ModelFileLimitError, the model is never called",
    async ({ app, mockLlm }) => {
      const agent = mockLlm(small.Agent);
      const big = bytes([0, 0, 0, 24, ...ascii("ftypisom")], "y".repeat(2000));

      const run = execute(app, small.Start, { document: inline(big, "video/mp4", "big.mp4") });

      await expect(run).rejects.toFailWith(ModelFileLimitError, {
        limit: ModelFileLimit.MaxFileSize,
      });
      expect(agent).toHaveBeenCalledTimes(0);
    },
  );

  testWith(mp3Only.Application)(
    "AC6: a type that is not allowed (a video, here) is ModelFileLimitError, the model is never called",
    async ({ app, mockLlm }) => {
      const agent = mockLlm(mp3Only.Agent);

      const run = execute(app, mp3Only.Start, { document: inline(MP4, "video/mp4", "clip.mp4") });

      await expect(run).rejects.toFailWith(ModelFileLimitError, {
        limit: ModelFileLimit.MediaType,
      });
      expect(agent).toHaveBeenCalledTimes(0);
    },
  );
});
