import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { stableJson } from "../../../src/terns/versions.js";
import { CODER_FINGERPRINT } from "./fixture.js";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("./print-fingerprint.ts", import.meta.url));
/** `--import tsx` resolves from the working directory; the children run elsewhere, so pass its URL. */
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

const Printed = z.object({
  agent: z.string(),
  router: z.string(),
  canonical: z.string(),
  legacyStableJson: z.string(),
});
type Printed = z.infer<typeof Printed>;

interface ProcessSetting {
  readonly locale: string;
  readonly timeZone: string;
  readonly cwd: string;
}

async function printInChild(setting: ProcessSetting): Promise<Printed> {
  const { stdout } = await run(process.execPath, ["--import", TSX, SCRIPT], {
    cwd: setting.cwd,
    env: { ...process.env, LANG: setting.locale, LC_ALL: setting.locale, TZ: setting.timeZone },
    timeout: 20_000,
  });
  return Printed.parse(JSON.parse(stdout));
}

const SETTINGS: readonly ProcessSetting[] = [
  { locale: "en_US.UTF-8", timeZone: "UTC", cwd: process.cwd() },
  { locale: "et_EE.UTF-8", timeZone: "Asia/Jerusalem", cwd: tmpdir() },
  { locale: "sv_SE.UTF-8", timeZone: "America/Los_Angeles", cwd: tmpdir() },
];

describe("spike #115 — the same fingerprint in other processes", () => {
  it("is equal in every process, locale, time zone and working directory, and equals the pinned value", async () => {
    const printed = await Promise.all(SETTINGS.map(printInChild));

    expect(new Set(printed.map((line) => line.agent))).toEqual(new Set([CODER_FINGERPRINT]));
    expect(new Set(printed.map((line) => line.router)).size).toBe(1);
    expect(new Set(printed.map((line) => line.canonical)).size).toBe(1);
  }, 60_000);

  it("shows the defect it fixes: today's stableJson (configHash, promptVersion) depends on the locale", async () => {
    const [english, estonian] = await Promise.all(SETTINGS.slice(0, 2).map(printInChild));

    expect(english?.legacyStableJson).not.toBe(estonian?.legacyStableJson);
    expect(stableJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  }, 60_000);
});
