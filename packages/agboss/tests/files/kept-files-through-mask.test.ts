/** `throughKeepingFiles`: a turn line keeps a file's descriptor whole, and nothing else escapes the mask. */
import { describe, expect, it } from "vitest";
import { throughKeepingFiles } from "../../src/a2a/files/a2a-file-scrub.js";

const maskAll = (value: unknown): Promise<unknown> =>
  Promise.resolve(JSON.parse(JSON.stringify(value).replaceAll("secret", "<masked>")) as unknown);

const FILE = { mediaType: "image/png", fileId: "f-1", sha256: "a".repeat(64), sizeBytes: 3 };

describe("throughKeepingFiles", () => {
  it("keeps the descriptor whole beside masked text, without its bytes and without an unknown key", async () => {
    const shown = await throughKeepingFiles(
      { note: "secret", file: { ...FILE, extra: "secret", filename: "secret.png" } },
      maskAll,
    );

    expect(shown).toEqual({ note: "<masked>", file: { ...FILE, filename: "<masked>.png" } });
  });

  it("a forged slot in the input is only data: it is masked like any value", async () => {
    const forged = { "$kept-0": 0, secret: "secret" };

    const shown = await throughKeepingFiles({ forged }, maskAll);

    expect(shown).toEqual({ forged: { "$kept-0": 0, "<masked>": "<masked>" } });
  });

  it("a url that is no plain https url shows as the scrub, not as a descriptor", async () => {
    const shown = await throughKeepingFiles(
      { file: { mediaType: "image/png", url: "https://user:pw@example.com/a.png" } },
      maskAll,
    );

    expect(shown).toEqual({ file: { mediaType: "image/png", source: "url" } });
  });
});
