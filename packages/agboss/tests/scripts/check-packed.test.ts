/**
 * #497 — `scripts/check-packed.mjs` (`npm run check:packed`, CI's packed-project job): its command
 * line, and its "installed, not linked" check — the project's `@agboss/core` must be a copy in its
 * own node_modules (what a user gets from npm), never a workspace link, and the only copy. The
 * whole run (pack, create, install, positive and negative) is the job itself: it needs the network.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runNode } from "../helpers/process.js";

const repo = new URL("../../../../", import.meta.url).pathname;
const scratch = mkdtempSync(join(tmpdir(), "agboss-check-packed-"));

interface Ran {
  readonly status: number | null;
  readonly out: string;
}

const checkPacked = async (...args: string[]): Promise<Ran> => {
  const result = await runNode([join(repo, "scripts/check-packed.mjs"), ...args], { cwd: repo });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
};

/** A package folder with its package.json. */
const packageAt = (dir: string, name: string): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "0.1.0" }));
};

/** A project folder of its own under the scratch folder. */
const project = (name: string): string => {
  const dir = join(scratch, name);
  mkdirSync(join(dir, "node_modules", "@agboss"), { recursive: true });
  return dir;
};

const core = (dir: string): string => join(dir, "node_modules", "@agboss", "core");

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("AC4: check:packed's command line", () => {
  it("AC4: --help prints the usage and exits 0", async () => {
    const ran = await checkPacked("--help");

    expect(ran.status).toBe(0);
    expect(ran.out).toContain("usage: node scripts/check-packed.mjs");
  });

  it("AC4: an unknown argument is a usage error, exit 2", async () => {
    const ran = await checkPacked("--fast");

    expect(ran.status).toBe(2);
    expect(ran.out).toContain("unknown argument: --fast");
    expect(ran.out).toContain("usage:");
  });

  it("AC4: --dir without a folder is a usage error, exit 2", async () => {
    const ran = await checkPacked("--dir");

    expect(ran.status).toBe(2);
    expect(ran.out).toContain("--dir needs a value");
  });

  it("AC4: an option where a value is due is a usage error, exit 2", async () => {
    const ran = await checkPacked("--verify-install", "--keep");

    expect(ran.status).toBe(2);
    expect(ran.out).toContain("--verify-install needs a value");
  });

  it("AC4: --verify-install with another option is a usage error, exit 2", async () => {
    const ran = await checkPacked("--verify-install", scratch, "--keep");

    expect(ran.status).toBe(2);
    expect(ran.out).toContain("--verify-install takes no other option");
  });
});

describe("AC4: check:packed's @agboss/core is installed, not linked", () => {
  it("AC4: a copy in the project's own node_modules passes, exit 0", async () => {
    const dir = project("installed");
    packageAt(core(dir), "@agboss/core");
    packageAt(join(dir, "node_modules", "@agboss", "cli"), "@agboss/cli");

    const ran = await checkPacked("--verify-install", dir);

    expect(ran.status).toBe(0);
    expect(ran.out).toContain("@agboss/core is installed, not linked");
  });

  it("AC4: no @agboss/core at all fails, exit 1", async () => {
    const ran = await checkPacked("--verify-install", project("missing"));

    expect(ran.status).toBe(1);
    expect(ran.out).toContain("node_modules/@agboss/core is missing");
  });

  it("AC4: a workspace link fails, naming where it points", async () => {
    const dir = project("linked");
    const workspace = join(scratch, "workspace-core");
    packageAt(workspace, "@agboss/core");
    symlinkSync(workspace, core(dir), "dir");

    const ran = await checkPacked("--verify-install", dir);

    expect(ran.status).toBe(1);
    expect(ran.out).toContain("is a link to");
    expect(ran.out).toContain("workspace-core, not an installed package");
  });

  it("AC4: a folder that is not @agboss/core's package fails", async () => {
    const dir = project("other-package");
    packageAt(core(dir), "@agboss/other");

    const ran = await checkPacked("--verify-install", dir);

    expect(ran.status).toBe(1);
    expect(ran.out).toContain("package.json is not @agboss/core's");
  });

  it("AC4: a folder without a package.json fails the same way", async () => {
    const dir = project("no-manifest");
    mkdirSync(core(dir), { recursive: true });

    const ran = await checkPacked("--verify-install", dir);

    expect(ran.status).toBe(1);
    expect(ran.out).toContain("package.json is not @agboss/core's");
  });

  it("AC4: a scope folder linked elsewhere resolves outside the project and fails", async () => {
    const dir = join(scratch, "linked-scope");
    const elsewhere = join(scratch, "elsewhere-scope");
    packageAt(join(elsewhere, "core"), "@agboss/core");
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    symlinkSync(elsewhere, join(dir, "node_modules", "@agboss"), "dir");

    const ran = await checkPacked("--verify-install", dir);

    expect(ran.status).toBe(1);
    expect(ran.out).toContain("resolves outside the project's node_modules");
  });

  it("AC4: a second copy under the CLI fails: the CLI would not run on the tarball", async () => {
    const dir = project("nested");
    packageAt(core(dir), "@agboss/core");
    const nested = join(dir, "node_modules", "@agboss", "cli", "node_modules", "@agboss", "core");
    packageAt(nested, "@agboss/core");
    packageAt(dirname(dirname(dirname(nested))), "@agboss/cli");

    const ran = await checkPacked("--verify-install", dir);

    expect(ran.status).toBe(1);
    expect(ran.out).toContain("a second @agboss/core is installed at");
  });
});
