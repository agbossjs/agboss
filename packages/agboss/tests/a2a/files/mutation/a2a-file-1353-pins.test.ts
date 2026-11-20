/**
 * #1353: what a `Stryker disable` used to hide on the A2A file path, pinned on its own — an address's
 * zone, the families the block list is asked in, a start's input that is no class.
 */
import { describe, expect, it } from "vitest";
import { inputClassOf } from "../../../../src/a2a/files/a2a-file.dto.js";
import { isDeniedAddress, withoutZone } from "../../../../src/a2a/files/a2a-file-address.js";
import { Text } from "../../../../src/dto/decorators.js";
import { listOf } from "../../../../src/flow/dto-wrappers.js";

class InputDto {
  @Text({ prompt: "t" })
  text!: string;
}

describe("withoutZone", () => {
  it.each([
    ["fe80::1%eth0", "fe80::1"],
    ["fe80::1%eth0%x", "fe80::1"],
    ["fe80::1%", "fe80::1"],
    ["fe80::1", "fe80::1"],
    ["8.8.8.8", "8.8.8.8"],
  ])("%s is %s", (address, plain) => {
    expect(withoutZone(address)).toBe(plain);
  });

  it("takes the whole zone off, however long", () => {
    expect(withoutZone("fe80::1%a-zone-of-twenty-chars")).toBe("fe80::1");
  });

  it("takes no zone off a text a line end cuts: no address has one, and nothing of it is cut", () => {
    expect(withoutZone("8.8.8.8%a\nb")).toBe("8.8.8.8%a\nb");
    expect(isDeniedAddress("8.8.8.8%a\nb")).toBe(true);
  });
});

describe("isDeniedAddress asks the block list in the address's own family", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "[::1]",
    "fe80::1%eth0",
    "fc00::1",
  ])("%s is denied", (address) => {
    expect(isDeniedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111"])("%s is allowed", (address) => {
    expect(isDeniedAddress(address)).toBe(false);
  });
});

describe("inputClassOf", () => {
  it("is the class a start takes as its input, and nothing for a list or a map of fields", () => {
    expect(inputClassOf(InputDto)).toBe(InputDto);
    expect(inputClassOf(listOf(InputDto))).toBeUndefined();
    expect(inputClassOf({ text: InputDto })).toBeUndefined();
  });
});
