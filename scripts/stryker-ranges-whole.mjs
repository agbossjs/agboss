// A file a shard mutates whole, but for the declarations named as plumbing (#1366): the rule of the shards of money, fence,
// cancel and limits is that no line that holds a number, a limit, a deadline, a step count, spend, a ledger id, a fence
// or a cancel is left out because it "only keeps books". What is left out is named here, with the reason.
import { readFileSync } from "node:fs";

const PACKAGE = new URL("../packages/agboss/", import.meta.url);

/** The files with named exclusions: file -> declaration -> why it is pure plumbing. The coverage test reads it. */
export const PLUMBING = {};

const HEAD =
  /^(?:export )?(?:default )?(?:abstract )?(?:async )?(?:function\*? |const |let |class |enum )([A-Za-z_$][\w$]*)/;

/** The declaration at line `start` of `lines`, to its last line (through the blank lines inside it). */
function endOf(lines, start) {
  let end = start;
  for (let next = start + 1; next < lines.length; next += 1) {
    const line = lines[next] ?? "";
    if (/^[^\s})\]]/.test(line)) break;
    if (line.trim() !== "") end = next;
  }
  return end;
}

/**
 * `file` as the shard's `mutate` entries: the file whole, or — when `excluded` names declarations (`{ name: reason }`,
 * a reason that says why no number, limit, deadline, step count, spend, ledger id, fence or cancel is in it) — every
 * other top-level declaration as its own range, found by name, so a declaration added to the file is mutated.
 */
export function wholeFile(file, excluded = {}) {
  const names = Object.keys(excluded);
  if (names.length === 0) return [file];
  const lines = readFileSync(new URL(file, PACKAGE), "utf8").split("\n");
  const heads = lines.flatMap((line, at) => {
    const name = HEAD.exec(line)?.[1];
    return name === undefined ? [] : [{ name, at }];
  });
  for (const name of names)
    if (!heads.some((head) => head.name === name))
      throw new Error(`${file}: the excluded ${name} is not a top-level declaration`);
  PLUMBING[file] = excluded;
  return heads
    .filter((head) => !names.includes(head.name))
    .map(({ at }) => `${file}:${String(at + 1)}-${String(endOf(lines, at) + 1)}`);
}
