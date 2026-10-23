import fs from "node:fs";
import path from "node:path";
import type { JoinKeySource } from "../flow/runtime/join-keys.js";
import { RE_RECORD_STALE, type CassetteChange } from "./errors.js";
import { cassetteHashesOf, staleComponentsOf } from "./vcr-hashes.js";
import { readCassette, v1HintOf } from "./vcr-file.js";

/**
 * `agboss check --cassettes` (#395 PR 4): every cassette of a project compared with the
 * application's components, without running a test — the same verdict a replay gives.
 */

/** A cassette file: `<name>.cassette.json`. */
const CASSETTE_SUFFIX = ".cassette.json";

/** Folders a project's cassettes are never in. */
const SKIPPED = new Set(["node_modules", ".git", "dist", ".agboss", "coverage"]);

/** Every cassette under `root`, in path order (`node_modules` and build output skipped). */
export function cassetteFilesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && !SKIPPED.has(entry.name)) walk(file);
      else if (entry.isFile() && entry.name.endsWith(CASSETTE_SUFFIX)) found.push(file);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found.sort();
}

/** One component of a cassette that changed since it was recorded. */
export interface StaleCassette {
  readonly file: string;
  readonly component: string;
  readonly changes: readonly CassetteChange[];
  /** The line `agboss check` prints: what changed and how to re-record it. */
  readonly message: string;
}

/** What the cassettes of a project hold against the application. */
export interface CassetteCheck {
  readonly stale: readonly StaleCassette[];
  /** Version 1 cassettes: they replay, but nothing in them can be found stale — each one's hint. */
  readonly hints: readonly string[];
  /** Files named like a cassette that are not one, with why. */
  readonly unreadable: readonly { readonly file: string; readonly message: string }[];
}

/** Every cassette among `files` compared with the components of the workflows. */
export function checkCassettes(
  files: readonly string[],
  workflows: readonly JoinKeySource[],
): CassetteCheck {
  const hashes = cassetteHashesOf(workflows);
  const stale: StaleCassette[] = [];
  const hints: string[] = [];
  const unreadable: { file: string; message: string }[] = [];
  for (const file of files) {
    try {
      const content = readCassette(file);
      if (content.version === 1) {
        hints.push(v1HintOf(file));
        continue;
      }
      for (const { component, changes } of staleComponentsOf(content.interactions, hashes)) {
        const message = `${component} changed since it was recorded (${changes.join(", ")}) — ${RE_RECORD_STALE}`;
        stale.push({ file, component, changes, message });
      }
    } catch (error) {
      unreadable.push({ file, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { stale, hints, unreadable };
}
