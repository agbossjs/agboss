/**
 * #480 AC3: `agboss create` finishes whether or not graphify is installed and says, in one line,
 * how to get the code graph — graphify looked up on the PATH of the CLI's environment, never run.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { graphifyHint, isOnPath } from "../../src/cli/graphify-hint.js";
import { agboss } from "./agboss.js";

const folders: string[] = [];
const folder = (prefix: string): string => {
  const made = mkdtempSync(join(tmpdir(), prefix));
  folders.push(made);
  return made;
};
afterEach(() => {
  for (const made of folders.splice(0)) rmSync(made, { recursive: true, force: true });
});

/** A folder with a file `name`, executable or not. */
function binWith(name: string, isExecutable: boolean): string {
  const bin = folder("agboss-480-bin-");
  writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, name), isExecutable ? 0o755 : 0o644);
  return bin;
}

const MISSING =
  "Code graph for agents (optional): install graphify (pipx install graphifyy), then graphify install --project && graphify update .";
const FOUND = "Code graph for agents: graphify install --project && graphify update .";
const lines = (text: string): string[] =>
  text.split("\n").filter((line) => line.includes("graphify"));

describe("#480 AC3: agboss create and graphify", () => {
  it("#480 AC3: without graphify on the PATH, create exits 0 and says in one line how to enable it", async () => {
    const cwd = folder("agboss-480-");
    const call = await agboss(["create", "desk", "--yes", "--skip-install"], cwd, {
      PATH: folder("agboss-480-empty-"),
    });

    expect(call.code).toBe(0);
    expect(lines(call.stdout)).toEqual([MISSING]);
  });

  it("#480 AC3: with an executable graphify on the PATH, the line is how to build the graph", async () => {
    const cwd = folder("agboss-480-");
    const call = await agboss(["create", "desk", "--yes", "--skip-install"], cwd, {
      PATH: binWith("graphify", true),
    });

    expect(call.code).toBe(0);
    expect(lines(call.stdout)).toEqual([FOUND]);
  });

  it("#480: --dry-run writes nothing and says nothing about graphify", async () => {
    const cwd = folder("agboss-480-");
    const call = await agboss(["create", "desk", "--yes", "--dry-run"], cwd, {
      PATH: binWith("graphify", true),
    });

    expect(call.code).toBe(0);
    expect(lines(call.stdout).filter((line) => line.startsWith("Code graph"))).toEqual([]);
  });

  it("#480: the lookup — a non-executable file, a folder, no PATH, and Windows' PATHEXT", () => {
    expect(isOnPath("graphify", { PATH: binWith("graphify", false) }, "linux")).toBe(false);
    const withFolder = folder("agboss-480-dir-");
    mkdirSync(join(withFolder, "graphify"));
    expect(isOnPath("graphify", { PATH: withFolder }, "linux")).toBe(false);
    expect(isOnPath("graphify", {}, "linux")).toBe(false);
    expect(isOnPath("graphify", { PATH: binWith("graphify.exe", false) }, "win32")).toBe(true);
    expect(
      isOnPath("graphify", { Path: binWith("graphify.cmd", false), PATHEXT: ".COM;.CMD" }, "win32"),
    ).toBe(true);
    expect(isOnPath("graphify", { PATH: binWith("graphify", false) }, "win32")).toBe(false);
    expect(graphifyHint({ PATH: binWith("graphify", true) }, "linux")).toBe(FOUND);
    expect(graphifyHint({}, "linux")).toBe(MISSING);
  });
});
