// The `agboss` commands as the CLI itself lists them (`agboss help --json`), so docs are checked against
// the CLI that ships, wherever its package lives (#196).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The package directory and bin file that provide the `agboss` command. */
function agbossBinOf(repo) {
  for (const name of readdirSync(join(repo, "packages"))) {
    const manifest = join(repo, "packages", name, "package.json");
    if (!existsSync(manifest)) continue;
    const bin = JSON.parse(readFileSync(manifest, "utf8")).bin?.agboss;
    if (bin) return join(repo, "packages", name, bin);
  }
  throw new Error("no package in packages/ has a `agboss` bin");
}

/** What may follow `agboss <command>` as its first word: `<a|b>` alternatives or a literal word. */
function positionalsOf(usage) {
  const third = usage.split(/\s+/)[2] ?? "";
  const alternatives = /^<([\w:|-]+\|[\w:|-]+)>$/.exec(third);
  if (alternatives) return new Set(alternatives[1].split("|"));
  return /^[a-z][\w:-]*$/.test(third) ? new Set([third]) : undefined;
}

function commandOf(entry) {
  const flags = [...entry.options, ...entry.commonOptions].map((option) => option.flag);
  // a command made of subcommands (#396: `agboss eval run | score`): each one's own flags
  const subcommands = new Map(
    (entry.subcommands ?? []).map((sub) => [sub.name.split(" ")[1], commandOf(sub)]),
  );
  const positionals = positionalsOf(entry.usage);
  if (entry.name === "generate" && positionals) {
    for (const shortKind of ["w", "a", "r", "ar", "t", "m", "oa", "ec"]) {
      positionals.add(shortKind);
    }
  }
  return {
    name: entry.name,
    flags: new Set([...flags, "--help"]),
    positionals,
    subcommands,
  };
}

/** `name` and alias (`(alias g)` in its summary) → the command. */
export function cliCommands(repo) {
  const out = execFileSync(process.execPath, [agbossBinOf(repo), "help", "--json"], {
    encoding: "utf8",
    env: { ...process.env, AGBOSS_NO_STAR: "1" },
  });
  const commands = new Map();
  for (const entry of JSON.parse(out).result) {
    const command = commandOf(entry);
    commands.set(entry.name, command);
    const alias = /\(alias (\w+)\)/.exec(entry.summary)?.[1];
    if (alias) commands.set(alias, command);
  }
  return commands;
}

function* sourcesOf(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourcesOf(path);
    else if (entry.name.endsWith(".ts")) yield path;
  }
}

/** Every source line of the packages' `src/` (what the CLI prints is in there). */
export function* sourceLines(repo) {
  for (const name of readdirSync(join(repo, "packages"))) {
    const src = join(repo, "packages", name, "src");
    if (!existsSync(src)) continue;
    for (const path of sourcesOf(src)) {
      const lines = readFileSync(path, "utf8").split("\n");
      for (const [index, text] of lines.entries())
        yield { place: `${path.slice(repo.length + 1)}:${String(index + 1)}`, text };
    }
  }
}
