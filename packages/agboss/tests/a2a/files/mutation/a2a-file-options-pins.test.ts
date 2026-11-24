import { hours } from "../../../../src/units/index.js";
/**
 * #1244: the file options, pinned: the defaults as they are, the media type's essence, each
 * option's rule at its boundary with the exact message, and the card file fields' rules.
 */
import { describe, expect, it } from "vitest";
import {
  A2ACardFileFields,
  DEFAULT_A2A_FILE_MEDIA_TYPES,
  cardFileFieldsOf,
  cardFileFieldsViolations,
  mediaTypeEssenceOf,
} from "../../../../src/a2a/files/a2a-file-options.js";
import {
  DEFAULT_FILE_FETCH_TIMEOUT,
  DEFAULT_FILE_LIMITS,
  FilePolicy,
  fileLimitsOf,
  filePolicyViolations,
  type FilePolicyOptions,
} from "../../../../src/files/file-policy.js";
import { kilobytes, seconds, type Bytes } from "../../../../src/units/index.js";

const CODE = "a2a.file-options-invalid";
const POLICY_CODE = "file-policy.invalid";
const NODES = ["app"];
const policyOf = (options: FilePolicyOptions) => {
  @FilePolicy({ ttl: hours(24), name: "pins-file-policy", ...options })
  class Policy {}
  return Policy;
};
const messagesOf = (options: FilePolicyOptions | undefined): string[] =>
  filePolicyViolations(
    "app's filePolicy",
    options === undefined ? undefined : policyOf(options),
    NODES,
  ).map((each) => each.message);

describe("the defaults", () => {
  it("are exactly 64 KB, 64 KB, 5 files, nine media types, no origin, ten seconds and no own pool", () => {
    expect(DEFAULT_FILE_LIMITS).toStrictEqual({
      ttl: hours(24),
      maxFileSize: kilobytes(64),
      maxTotalFileSize: kilobytes(64),
      maxFiles: 5,
      allowedMediaTypes: [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "application/pdf",
        "text/plain",
        "text/markdown",
        "text/csv",
        "application/json",
      ],
      allowedOrigins: [],
      fetchTimeout: seconds(10),
      fetchPool: undefined,
    });
    expect(DEFAULT_A2A_FILE_MEDIA_TYPES).toBe(DEFAULT_FILE_LIMITS.allowedMediaTypes);
    expect(DEFAULT_FILE_FETCH_TIMEOUT).toBe(seconds(10));
    expect(Object.isFrozen(DEFAULT_FILE_LIMITS)).toBe(true);
  });

  it("a skill's own fields win over its workflow's, over the defaults", () => {
    const limits = fileLimitsOf(
      policyOf({ maxFiles: 2, maxFileSize: 10 as Bytes }),
      policyOf({ maxFiles: 1 }),
    );

    expect(limits).toStrictEqual({ ...DEFAULT_FILE_LIMITS, maxFiles: 1, maxFileSize: 10 });
    expect(fileLimitsOf(undefined, undefined)).toStrictEqual(DEFAULT_FILE_LIMITS);
    class NoPolicy {
      readonly none = true;
    }
    expect(fileLimitsOf(NoPolicy)).toStrictEqual(DEFAULT_FILE_LIMITS);
  });
});

describe("mediaTypeEssenceOf", () => {
  it("drops the parameters, the spaces and the case", () => {
    expect(mediaTypeEssenceOf("Text/Plain; charset=utf-8")).toBe("text/plain");
    expect(mediaTypeEssenceOf("  IMAGE/PNG  ")).toBe("image/png");
    expect(mediaTypeEssenceOf("text/plain;")).toBe("text/plain");
    expect(mediaTypeEssenceOf("application/pdf")).toBe("application/pdf");
    expect(mediaTypeEssenceOf("")).toBe("");
    expect(mediaTypeEssenceOf(";charset=x")).toBe("");
  });
});

describe("filePolicyViolations", () => {
  it("no options, or good ones: none", () => {
    expect(filePolicyViolations("w", undefined, NODES)).toEqual([]);
    expect(messagesOf({})).toEqual([]);
    expect(
      messagesOf({
        maxFileSize: 1 as Bytes,
        maxTotalFileSize: 1 as Bytes,
        maxFiles: 1,
        allowedMediaTypes: ["text/plain", "application/vnd.x+json"],
        allowedOrigins: ["https://files.example", "https://files.example:8443"],
      }),
    ).toEqual([]);
  });

  it("each violation: the rule code, its place and problem, the nodes", () => {
    expect(filePolicyViolations("the place", policyOf({ maxFiles: 0 }), ["n1", "n2"])).toEqual([
      {
        code: POLICY_CODE,
        message: "the place: pins-file-policy: maxFiles is not a whole number from 1",
        nodes: ["n1", "n2"],
      },
    ]);
  });

  it("a size is a whole number from 1, for each of the two fields", () => {
    for (const field of ["maxFileSize", "maxTotalFileSize"] as const) {
      const message = `app's filePolicy: pins-file-policy: ${field} is not a whole number of bytes from 1`;
      expect(messagesOf({ [field]: 1 as Bytes }), field).toEqual([]);
      for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
        expect(messagesOf({ [field]: bad as Bytes }), `${field} ${String(bad)}`).toEqual([message]);
      expect(messagesOf(Object.assign({}, { [field]: "5" }))).toEqual([message]);
    }
  });

  it("the count is a whole number from 1", () => {
    const message = "app's filePolicy: pins-file-policy: maxFiles is not a whole number from 1";
    expect(messagesOf({ maxFiles: 1 })).toEqual([]);
    expect(messagesOf({ maxFiles: 100 })).toEqual([]);
    for (const bad of [0, -3, 2.5, Number.NaN])
      expect(messagesOf({ maxFiles: bad })).toEqual([message]);
  });

  it("a media type is a lower-case type/subtype, as its essence", () => {
    const message = (type: string) =>
      `app's filePolicy: pins-file-policy: allowedMediaTypes entry "${type}" is not a lower-case type/subtype`;
    expect(
      messagesOf({ allowedMediaTypes: ["Text/Plain", "textplain", "text/plain; x=y", ""] }),
    ).toEqual(["Text/Plain", "textplain", "text/plain; x=y", ""].map(message));
    expect(messagesOf({ allowedMediaTypes: ["text/plain"] })).toEqual([]);
  });

  it("an origin is an https: origin as URL writes it, with no path", () => {
    const message = (origin: string) =>
      `app's filePolicy: pins-file-policy: allowedOrigins entry "${origin}" is not an https: origin (no path)`;
    const bad = [
      "http://files.example",
      "https://files.example/",
      "https://files.example/a",
      "https://files.example:443",
      "HTTPS://files.example",
      "files.example",
      "",
    ];
    expect(messagesOf({ allowedOrigins: bad })).toEqual(bad.map(message));
    expect(messagesOf({ allowedOrigins: ["https://files.example"] })).toEqual([]);
  });

  it("every problem at once: sizes, then the count, then the types, then the origins", () => {
    expect(
      messagesOf({
        maxFileSize: 0 as Bytes,
        maxTotalFileSize: 0 as Bytes,
        maxFiles: 0,
        allowedMediaTypes: ["X"],
        allowedOrigins: ["y"],
      }),
    ).toEqual([
      "app's filePolicy: pins-file-policy: maxFileSize is not a whole number of bytes from 1",
      "app's filePolicy: pins-file-policy: maxTotalFileSize is not a whole number of bytes from 1",
      "app's filePolicy: pins-file-policy: maxFiles is not a whole number from 1",
      'app\'s filePolicy: pins-file-policy: allowedMediaTypes entry "X" is not a lower-case type/subtype',
      'app\'s filePolicy: pins-file-policy: allowedOrigins entry "y" is not an https: origin (no path)',
    ]);
  });
});

describe("the card file fields", () => {
  it("the skill's own, else the expose's, else Extension", () => {
    const expose = {
      cardFileFields: A2ACardFileFields.Marker,
      skills: { a: { cardFileFields: A2ACardFileFields.Extension }, b: {} },
    };

    expect(cardFileFieldsOf(expose, "a")).toBe(A2ACardFileFields.Extension);
    expect(cardFileFieldsOf(expose, "b")).toBe(A2ACardFileFields.Marker);
    expect(cardFileFieldsOf(expose, "c")).toBe(A2ACardFileFields.Marker);
    expect(cardFileFieldsOf({}, "c")).toBe(A2ACardFileFields.Extension);
  });

  it("a skill the expose does not export, and a value that is none of the enum's", () => {
    const violations = cardFileFieldsViolations(
      "the-expose",
      {
        cardFileFields: "other" as A2ACardFileFields,
        skills: {
          gone: { cardFileFields: A2ACardFileFields.Marker },
          unset: {},
          kept: { cardFileFields: A2ACardFileFields.Extension },
          odd: { cardFileFields: "nope" as A2ACardFileFields },
        },
      },
      new Set(["kept", "odd"]),
      "the-where",
    );

    expect(violations).toEqual([
      {
        code: "a2a.unknown-skill-option",
        message:
          "the-expose sets the cardFileFields of gone, which it does not export — name an exported start",
        nodes: ["the-where"],
      },
      {
        code: CODE,
        message: "the-expose's cardFileFields is not an A2ACardFileFields (Extension or Marker)",
        nodes: ["the-where"],
      },
      {
        code: CODE,
        message:
          'the-expose\'s skills["odd"].cardFileFields is not an A2ACardFileFields (Extension or Marker)',
        nodes: ["the-where"],
      },
    ]);
  });

  it("good values, or none: no violation", () => {
    expect(
      cardFileFieldsViolations(
        "e",
        {
          cardFileFields: A2ACardFileFields.Marker,
          skills: { a: { cardFileFields: A2ACardFileFields.Extension }, b: {} },
        },
        new Set(["a", "b"]),
        "w",
      ),
    ).toEqual([]);
    expect(cardFileFieldsViolations("e", {}, new Set(), "w")).toEqual([]);
  });
});
