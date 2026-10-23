// Every `scripts/…`, `npm run …`, `make …` and `agboss …` a doc (or a string the CLI prints) mentions
// must exist (#196): a script file, a package script, a Makefile target, a CLI command with its flags.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = /(?<![\w./-])scripts\/[\w.-]*\w/g;
const NPM_RUN = /\bnpm run ([\w:.-]+)/g;
const MAKE = /(?<![\w-])make ([a-z][\w-]*)/g;
// `agb <command>` anywhere in code; `agboss <command>` only as a command (line start, npx)
const GC =
  /(?:(?<![\w./@-])agb|(?<=^\s*|npx\s+)agboss) ([a-z][\w:-]*)((?: +(?:[^\s`'"|;#·—]+))*)/gm;

const scriptsOf = (dir) => {
  const manifest = join(dir, "package.json");
  return existsSync(manifest)
    ? Object.keys(JSON.parse(readFileSync(manifest, "utf8")).scripts ?? {})
    : [];
};

/** What exists: script files, every workspace's npm scripts, Makefile targets, the CLI. */
export function knownOf(repo, commands) {
  const workspaces = ["packages", "examples"].flatMap((group) =>
    existsSync(join(repo, group))
      ? readdirSync(join(repo, group)).map((name) => join(repo, group, name))
      : [],
  );
  const makefile = existsSync(join(repo, "Makefile"))
    ? readFileSync(join(repo, "Makefile"), "utf8")
    : "";
  return {
    repo,
    npm: new Set([repo, ...workspaces].flatMap(scriptsOf)),
    make: new Set([...makefile.matchAll(/^([\w-]+):/gm)].map((match) => match[1])),
    commands,
  };
}

/** The code of a Markdown file: inline code spans and the lines of fenced blocks (not ts ones). */
export function codeOf(markdown) {
  const parts = [];
  let fence;
  markdown.split("\n").forEach((line, index) => {
    const marker = /^\s*(`{3,}|~{3,})(\w*)/.exec(line);
    if (marker && !fence) fence = marker[2];
    else if (marker && fence !== undefined) fence = undefined;
    else if (fence !== undefined && !["ts", "typescript"].includes(fence))
      parts.push({ line: index + 1, text: line });
    else if (fence === undefined)
      for (const span of line.matchAll(/`([^`]+)`/g))
        parts.push({ line: index + 1, text: span[1] });
  });
  return parts;
}

function agbossProblem(command, rest, known) {
  const found = known.commands.get(command);
  if (!found) return `unknown command \`agboss ${command}\``;
  const words = rest.trim().split(/\s+/).filter(Boolean);
  const sub = found.subcommands?.get(words[0] ?? "");
  if (sub) return flagProblem(`${command} ${words[0]}`, sub, words.slice(1));
  const flag = words.find(
    (word) => word.startsWith("--") && !found.flags.has(word.replace(/=.*/, "")),
  );
  if (flag) return `\`agboss ${command}\` has no option ${flag}`;
  const first = words[0];
  if (found.positionals && first && /^[a-z][\w:-]*$/.test(first) && !found.positionals.has(first))
    return `\`agboss ${command} ${first}\`: expected ${[...found.positionals].join(" | ")}`;
  return undefined;
}

/** An option the subcommand does not take. */
function flagProblem(name, found, words) {
  const flag = words.find(
    (word) => word.startsWith("--") && !found.flags.has(word.replace(/=.*/, "")),
  );
  return flag ? `\`agboss ${name}\` has no option ${flag}` : undefined;
}

/** Problems with the commands in one piece of code text. */
export function commandProblems(text, known) {
  const problems = [];
  for (const [, command, rest] of text.matchAll(GC)) {
    const problem = agbossProblem(command, rest, known);
    if (problem) problems.push(problem);
  }
  for (const [, name] of text.matchAll(NPM_RUN))
    if (!known.npm.has(name)) problems.push(`no package has the script \`npm run ${name}\``);
  for (const [, target] of text.matchAll(MAKE))
    if (!known.make.has(target)) problems.push(`the Makefile has no target \`make ${target}\``);
  return problems;
}

/** Problems with the references of one doc, each as `doc:line: …`. */
export function referenceProblems(doc, markdown, known) {
  const problems = [];
  markdown.split("\n").forEach((line, index) => {
    for (const [path] of line.matchAll(SCRIPT))
      if (!existsSync(join(known.repo, path)))
        problems.push(`${doc}:${String(index + 1)}: ${path} does not exist`);
    for (const [, name] of line.matchAll(NPM_RUN))
      if (!known.npm.has(name))
        problems.push(`${doc}:${String(index + 1)}: no package has the script \`npm run ${name}\``);
  });
  for (const part of codeOf(markdown))
    for (const problem of commandProblems(part.text, known).filter(
      (text) => !text.startsWith("no package"),
    ))
      problems.push(`${doc}:${String(part.line)}: ${problem}`);
  return problems;
}
