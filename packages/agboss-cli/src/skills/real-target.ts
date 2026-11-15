import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, parse, sep } from "node:path";

/**
 * Where a link's text really leads (#1107), the way the kernel reads it: one component at a time,
 * every symlink on the way followed before the next component is applied. A `..` after a symlinked
 * folder then goes up from that folder's target, not from the folder's name — `path.resolve` on the
 * text would collapse `docs/symdir/..` to `docs` before `symdir` is ever followed.
 */

/** The kernel stops at 40 links on one path (`ELOOP`); so does this. */
const MAX_LINKS = 40;

/** `realpath` of the longest existing prefix of `path`, the rest appended as written. */
export function realPrefix(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(realPrefix(parent), basename(path));
  }
}

const partsOf = (text: string): string[] =>
  text.split(sep === "\\" ? /[\\/]+/ : "/").filter((part) => part !== "" && part !== ".");

/** `text` split into its root (empty when relative) and its components. */
const splitText = (text: string): { root: string; parts: string[] } => {
  const { root } = parse(text);
  return { root, parts: partsOf(text.slice(root.length)) };
};

/**
 * The real place `text` leads to when read from the real folder `from`; undefined when it loops
 * (more than 40 links). A part that does not exist cannot be followed: it and the parts after it
 * are applied as written (a `..` there goes up lexically, as it will once the folder exists).
 */
export function resolveReal(from: string, text: string): string | undefined {
  const start = splitText(text);
  let at = realPrefix(start.root === "" ? from : start.root);
  const todo = start.parts;
  let links = 0;
  for (let part = todo.shift(); part !== undefined; part = todo.shift()) {
    if (part === "..") {
      at = dirname(at);
      continue;
    }
    const next = join(at, part);
    const found = lstatSync(next, { throwIfNoEntry: false });
    if (found === undefined) {
      let rest = next;
      for (const more of todo) rest = more === ".." ? dirname(rest) : join(rest, more);
      return rest;
    }
    if (!found.isSymbolicLink()) {
      at = next;
      continue;
    }
    links += 1;
    if (links > MAX_LINKS) return undefined;
    const inner = splitText(readlinkSync(next));
    if (inner.root !== "") at = realPrefix(inner.root);
    todo.unshift(...inner.parts);
  }
  return at;
}
