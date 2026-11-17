/** #1269: files in a decision model's state: text and png, jpeg, webp images follow it; anything else is refused. */
import { describe, expect, it } from "vitest";
import { decisionStateWith } from "../../src/files/decision-parts.js";
import type { FilePiece } from "../../src/files/file-pieces.js";
import { ModelCallError } from "../../src/models/circuit-breaker.js";

const ASKER = { caller: "judge:quality", model: "gpt-vision" };
const image = (mediaType: string): FilePiece => ({ kind: "image", mediaType, data: "QUJD" });

const refusalOf = (pieces: readonly FilePiece[]): unknown => {
  try {
    decisionStateWith("state", pieces, ASKER);
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("#1269: decisionStateWith", () => {
  it("no pieces: the state itself, whatever it is", () => {
    const object = { a: 1 };
    const parts = ["x"];

    expect(decisionStateWith("t", [], ASKER)).toBe("t");
    expect(decisionStateWith(object, [], ASKER)).toBe(object);
    expect(decisionStateWith(parts, [], ASKER)).toBe(parts);
  });

  it("a text state is the first part, a text piece follows as its text", () => {
    expect(decisionStateWith("state", [{ kind: "text", text: "heading" }], ASKER)).toEqual([
      "state",
      "heading",
    ]);
  });

  it("a JSON object state is its JSON text", () => {
    expect(decisionStateWith({ a: 1 }, [{ kind: "text", text: "t" }], ASKER)).toEqual([
      '{"a":1}',
      "t",
    ]);
  });

  it("a list state keeps its parts", () => {
    expect(decisionStateWith(["one", "two"], [{ kind: "text", text: "t" }], ASKER)).toEqual([
      "one",
      "two",
      "t",
    ]);
  });

  it.each(["image/png", "image/jpeg", "image/webp"])(
    "%s is an image part as a data URL",
    (type) => {
      expect(decisionStateWith("s", [image(type)], ASKER)).toEqual([
        "s",
        { type: "image_url", image_url: { url: `data:${type};base64,QUJD` } },
      ]);
    },
  );

  it("an image of another type is refused: model.unsupported-input, naming the asker and type", () => {
    const error = refusalOf([image("image/gif")]);

    expect(error).toBeInstanceOf(ModelCallError);
    expect(error).toMatchObject({
      code: "model.unsupported-input",
      provider: "decisions",
      model: "gpt-vision",
      kind: "image",
      mediaType: "image/gif",
      message:
        "model.unsupported-input: judge:quality: gpt-vision takes png, jpeg and webp images as input, not image/gif",
    });
  });

  it("a PDF is refused, even when its media type is an image's", () => {
    expect(refusalOf([{ kind: "file", mediaType: "application/pdf", data: "QUJD" }])).toMatchObject(
      {
        code: "model.unsupported-input",
        kind: "file",
        mediaType: "application/pdf",
      },
    );
    expect(refusalOf([{ kind: "file", mediaType: "image/png", data: "QUJD" }])).toMatchObject({
      code: "model.unsupported-input",
      kind: "file",
    });
  });

  it("an audio is refused", () => {
    expect(refusalOf([{ kind: "audio", mediaType: "audio/mpeg", data: "QUJD" }])).toMatchObject({
      kind: "audio",
    });
  });
});
