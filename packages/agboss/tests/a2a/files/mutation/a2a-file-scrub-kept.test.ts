/**
 * #1356 (shard `a2a-files`): what a turn line keeps of a file (`throughKeepingFiles`): its descriptor's kept fields
 * and nothing it does not have, an `https:` url without a user or a password and no other, the slots the mask never
 * sees as anything but a nonce, the walk that stops at 64 levels, and the descriptors put back wherever the mask left
 * them, in a list or a record.
 */
import { describe, expect, it } from "vitest";
import { throughKeepingFiles } from "../../../../src/a2a/files/a2a-file-scrub.js";

const same = (value: unknown): Promise<unknown> => Promise.resolve(value);
const SHA = "a".repeat(64);
const nest = (levels: number, leaf: unknown, wrap: (inner: unknown) => unknown): unknown => {
  let value = leaf;
  for (let level = 0; level < levels; level += 1) value = wrap(value);
  return value;
};

describe("#1356: the descriptor a turn line keeps", () => {
  it("is its kept fields only: a field it does not have is no key", async () => {
    const shown = await throughKeepingFiles(
      { file: { mediaType: "image/png", fileId: "f-1", extra: "x" } },
      same,
    );

    expect(shown).toStrictEqual({ file: { mediaType: "image/png", fileId: "f-1" } });
  });

  it("keeps every one of its fields: media type, id, url, digest and size, and its name", async () => {
    const shown = await throughKeepingFiles(
      {
        file: {
          mediaType: "image/png",
          url: "https://files.example/a.png",
          sha256: SHA,
          sizeBytes: 3,
          filename: "a.png",
        },
      },
      same,
    );

    expect(shown).toStrictEqual({
      file: {
        mediaType: "image/png",
        url: "https://files.example/a.png",
        sha256: SHA,
        sizeBytes: 3,
        filename: "a.png",
      },
    });
  });

  it.each([
    ["http", "http://files.example/a.png"],
    ["ftp", "ftp://files.example/a.png"],
    ["a user", "https://user@files.example/a.png"],
    ["a password", "https://:secret@files.example/a.png"],
    ["both", "https://user:secret@files.example/a.png"],
    ["no host", "https://"],
    ["no url at all", "not a url"],
  ])("a url with %s is not kept: the file shows as its scrub", async (_why, url) => {
    const shown = await throughKeepingFiles({ file: { mediaType: "image/png", url } }, same);

    expect(shown).toStrictEqual({ file: { mediaType: "image/png", source: "url" } });
  });
});

describe("#1356: the slots of the files held out", () => {
  it("are numbered from 0 under a key made for the call, and carry the name beside them", async () => {
    const seen: unknown[] = [];
    await throughKeepingFiles(
      {
        first: { mediaType: "image/png", fileId: "f-1", filename: "one.png" },
        second: { mediaType: "image/png", fileId: "f-2" },
      },
      (rest) => {
        seen.push(rest);
        return same(rest);
      },
    );

    const [rest] = seen as [Record<string, Record<string, unknown>>];
    const keys = Object.keys(rest.first ?? {}).filter((key) => key !== "filename");
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(
      /^\$kept-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(rest).toStrictEqual({
      first: { [keys[0] ?? ""]: 0, filename: "one.png" },
      second: { [keys[0] ?? ""]: 1 },
    });
  });

  it("come back as the descriptor, with the name the mask gave, and none when it gave none", async () => {
    const shown = await throughKeepingFiles(
      {
        named: { mediaType: "image/png", fileId: "f-1", filename: "secret.png" },
        bare: { mediaType: "image/png", fileId: "f-2" },
      },
      async (rest) => JSON.parse(JSON.stringify(rest).replaceAll("secret", "<masked>")) as unknown,
    );

    expect(shown).toStrictEqual({
      named: { mediaType: "image/png", fileId: "f-1", filename: "<masked>.png" },
      bare: { mediaType: "image/png", fileId: "f-2" },
    });
  });

  it("come back from a list the mask returned, each in its own place", async () => {
    const shown = await throughKeepingFiles(
      [
        { mediaType: "image/png", fileId: "f-1" },
        "text",
        { mediaType: "image/png", fileId: "f-2" },
      ],
      same,
    );

    expect(shown).toStrictEqual([
      { mediaType: "image/png", fileId: "f-1" },
      "text",
      { mediaType: "image/png", fileId: "f-2" },
    ]);
  });
});

describe("#1356: how deep the walk back goes", () => {
  it("is 64 levels of lists: the 64th is read, the 65th is not shown", async () => {
    const at = (levels: number) =>
      throughKeepingFiles(null, () => same(nest(levels, "leaf", (inner) => [inner])));
    const flat = (value: unknown): unknown => {
      let at = value;
      while (Array.isArray(at)) [at] = at as unknown[];
      return at;
    };

    expect(flat(await at(64))).toBe("leaf");
    expect(flat(await at(65))).toBe("[too deep]");
  });

  it("is 64 levels of records as well", async () => {
    const at = (levels: number) =>
      throughKeepingFiles(null, () => same(nest(levels, "leaf", (inner) => ({ inner }))));
    const flat = (value: unknown): unknown => {
      let found = value;
      while (typeof found === "object" && found !== null)
        found = (found as { inner: unknown }).inner;
      return found;
    };

    expect(flat(await at(64))).toBe("leaf");
    expect(flat(await at(65))).toBe("[too deep]");
  });
});
