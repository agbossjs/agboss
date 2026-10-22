/** #336 AC3: where a result over its bound is cut — whitespace near the bound, never inside a character. */
import { describe, expect, it } from "vitest";
import { boundedText } from "../../../src/graph/agent-loop/tool-result-size.js";
import { kilobytes, type Bytes } from "../../../src/units/index.js";

const bytes = (amount: number): Bytes => kilobytes(amount / 1024);

describe("#336 AC3: boundedText", () => {
  it("keeps a text that fits as it is", () => {
    expect(boundedText("short", bytes(5))).toEqual({
      kept: "short",
      marker: "",
      isTruncated: false,
    });
  });

  it("cuts at the last whitespace within the final 256 bytes it keeps", () => {
    const text = `${"a".repeat(900)} ${"b".repeat(200)}`;

    const { kept, marker } = boundedText(text, bytes(1000));

    expect(kept).toBe("a".repeat(900));
    expect(marker).toBe("\n[result truncated: 1,101 bytes, the first 900 kept]");
  });

  it("cuts at the bound when no whitespace is near it", () => {
    const text = `${"a".repeat(100)} ${"b".repeat(1000)}`;

    expect(boundedText(text, bytes(1000)).kept).toHaveLength(1000);
  });

  it("never splits a UTF-8 character", () => {
    const { kept, marker } = boundedText("é".repeat(10), bytes(5));

    expect(kept).toBe("éé");
    expect(marker).toBe("\n[result truncated: 20 bytes, the first 4 kept]");
  });

  it("counts kilobytes as 1,024 bytes", () => {
    expect(kilobytes(64)).toBe(65_536);
  });
});
