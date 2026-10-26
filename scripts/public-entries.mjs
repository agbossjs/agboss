// The public entries of the `agboss` package, read from its package.json (#195): `exports`
// minus `deprecatedExports` (old entries kept one minor release as deprecated re-exports). The
// examples' lint allowlist is built from it, so the rule and the package cannot drift.
import { readFileSync } from "node:fs";

const PACKAGE = new URL("../packages/agboss/package.json", import.meta.url);

/** `"./dto"` → `"@agboss/core/dto"`, `"."` → `"agboss"`. */
const specifierOf = (name, subpath) => (subpath === "." ? name : `${name}/${subpath.slice(2)}`);

export function publicEntries() {
  const pkg = JSON.parse(readFileSync(PACKAGE, "utf8"));
  const deprecated = Object.keys(pkg.deprecatedExports ?? {});
  // `@agboss/core/internal` (#205): only for agboss-cli, never public
  const internal = pkg.internalExports ?? [];
  const subpaths = Object.keys(pkg.exports).filter((s) => !internal.includes(s));
  return {
    name: pkg.name,
    /** e.g. `["@agboss/core/internal"]`: entries of the CLI, outside the public API */
    internal: internal.map((s) => specifierOf(pkg.name, s)),
    /** e.g. `["agboss", "@agboss/core/dto", …]` */
    current: subpaths.filter((s) => !deprecated.includes(s)).map((s) => specifierOf(pkg.name, s)),
    /** e.g. `{ "@agboss/core/core": "agboss", … }` — old entry → where to import instead */
    deprecated: Object.fromEntries(
      deprecated.map((s) => [
        specifierOf(pkg.name, s),
        specifierOf(pkg.name, pkg.deprecatedExports[s]),
      ]),
    ),
  };
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The `no-restricted-imports` patterns of code that uses AGBoss as a package (examples). */
export function packageImportPatterns() {
  const { name, current, deprecated } = publicEntries();
  const subpaths = current.filter((s) => s !== name).map((s) => escape(s.slice(name.length + 1)));
  const old = Object.keys(deprecated).map((s) => escape(s.slice(name.length + 1)));
  const quoted = current.map((s) => `"${s}"`).join(", ");
  return [
    {
      regex: `^(\\.\\./){2,}(packages|agboss|${escape(name)})/`,
      message: `Examples import only from "${name}" (its public API).`,
    },
    {
      regex: `^${escape(name)}/(${old.join("|")})$`,
      message: `A deprecated entry (#195): import from "${name}" — \`agboss migrate imports\` rewrites it.`,
    },
    {
      regex: `^${escape(name)}/(?!(${[...subpaths, ...old].join("|")})$)`,
      message: `No deep imports: use one of the public entries ${quoted}.`,
    },
  ];
}

/** The `no-restricted-imports` patterns of agboss-cli (#205): the package's entries only. */
export function cliImportPatterns() {
  const { name, current, internal } = publicEntries();
  const subpaths = [...current, ...internal]
    .filter((s) => s !== name)
    .map((s) => escape(s.slice(name.length + 1)));
  return [
    {
      regex: `^(\\.\\./)+(agboss|${escape(name)})/`,
      message: `The CLI uses the framework as a package: import from "${name}" or its entries.`,
    },
    {
      regex: `^${escape(name)}/(?!(${subpaths.join("|")})$)`,
      message: `No deep imports: use one of the entries of "${name}" (package.json#exports).`,
    },
  ];
}
