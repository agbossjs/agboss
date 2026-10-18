/**
 * Spike #115 — run in a child process (`node --import tsx print-fingerprint.ts`) to compare
 * fingerprints across processes, locales, time zones, working directories and Node versions.
 * Prints one JSON line: the agent and router fingerprints and the legacy `stableJson` of keys whose
 * `localeCompare` order depends on the locale.
 */
import { stableJson } from "../../../src/terns/versions.js";
import { canonicalJson } from "./canonical-json.js";
import { fingerprintOf } from "./fingerprint.js";
import { FIXTURE_FILES, INHERITED, coderAgent, mainRouter, promptFolder } from "./fixture.js";
import { assembleAgent, assembleRouter } from "./request.js";

/** Keys whose collation differs between locales (et: "z" < "t"; sv: "ä" after "z"). */
export const LOCALE_SENSITIVE_KEYS = { t: 1, z: 2, äpple: 3, Beta: 4, alpha: 5 };

const dir = await promptFolder(FIXTURE_FILES);
const agent = fingerprintOf(await assembleAgent(coderAgent(dir), INHERITED));
const router = fingerprintOf(await assembleRouter(mainRouter(dir), INHERITED));
process.stdout.write(
  `${JSON.stringify({
    agent: agent.hash,
    router: router.hash,
    canonical: canonicalJson(LOCALE_SENSITIVE_KEYS),
    legacyStableJson: stableJson(LOCALE_SENSITIVE_KEYS),
  })}\n`,
);
