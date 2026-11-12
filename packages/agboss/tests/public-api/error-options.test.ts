/**
 * #906 AC1 (API review G8, completing #890; D1: every exported error class, `AGBossError` or not,
 * testing exports included): every exported `Error` subclass of every entry
 * constructs from ONE options object whose keys are the error's own properties, and takes a
 * `cause` — typed (`ConstructorParameters` is checked by `tsc` on the fixtures below) and kept
 * (`.cause`). The test walks the exports of each entry, so a new error class without a fixture
 * fails it — and a class that takes its facts positionally, or drops a `cause`, fails its own case.
 * `AGBossError` itself is the base a project's own errors extend (`message`, `{ cause, details }`).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { fixtures as agbossFixtures } from "./error-options.fixtures.js";
import { plainFixtures } from "./error-options.fixtures-plain.js";

const fixtures: Readonly<Record<string, object>> = { ...agbossFixtures, ...plainFixtures };

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { exports: exportMap } = JSON.parse(
  readFileSync(resolve(packageRoot, "package.json"), "utf8"),
) as {
  readonly exports: Readonly<Record<string, { readonly types: string }>>;
};

/**
 * Every entry of package.json#exports, as its source module (`./dist/a/index.d.ts` →
 * `src/a/index.ts`) — read from the package, never listed here, so an entry added later is walked.
 */
const ENTRIES: Readonly<Record<string, object>> = Object.fromEntries(
  await Promise.all(
    Object.entries(exportMap).map(async ([entry, { types }]) => {
      const source = resolve(
        packageRoot,
        types.replace("./dist/", "src/").replace(/\.d\.ts$/, ".ts"),
      );
      return [entry, (await import(pathToFileURL(source).href)) as object] as const;
    }),
  ),
);

type ErrorClass = (new (options: never) => Error) & { readonly code?: unknown };

/** Every `Error` subclass any entry exports, by name (`AGBossError` itself, the base, is not one). */
const exportedErrors = (): ReadonlyMap<string, ErrorClass> => {
  const found = new Map<string, ErrorClass>();
  for (const entry of Object.values(ENTRIES))
    for (const [name, value] of Object.entries(entry))
      if (typeof value === "function" && value.prototype instanceof Error)
        found.set(name, value as ErrorClass);
  found.delete("AGBossError");
  return found;
};

const classes = exportedErrors();

describe("#906 AC1: every exported error takes one options bag with a cause", () => {
  it("AC1: the walk covers every entry of package.json#exports and finds the errors, each with a fixture", () => {
    expect(Object.keys(ENTRIES).length).toBe(Object.keys(exportMap).length);
    // the acceptance's enumeration found 120 in core's built entries, `AGBossError` among them
    expect(classes.size).toBeGreaterThanOrEqual(119);
    expect([...classes.keys()].filter((name) => !(name in fixtures)).sort()).toEqual([]);
    expect(
      Object.keys(fixtures)
        .filter((name) => !classes.has(name))
        .sort(),
    ).toEqual([]);
  });

  it.each([...classes.keys()].sort())(
    "AC1: %s — one parameter, keys are own properties, the cause is kept, the code is a string",
    (name) => {
      const ErrorClass = classes.get(name) as unknown as new (options: object) => Error & {
        readonly code?: unknown;
      };
      const options = fixtures[name] ?? {};
      const cause = new Error(`the cause of ${name}`);

      expect(ErrorClass.length, `${name}: positional parameters`).toBeLessThanOrEqual(1);
      const error = new ErrorClass({ ...options, cause });

      expect(error).toBeInstanceOf(ErrorClass);
      expect(error.cause).toBe(cause);
      const missing = Object.keys(options).filter((key) => !Object.hasOwn(error, key));
      expect(missing, `${name}: option keys that are no own property`).toEqual([]);
      expect(typeof error.code, `${name}: a literal code on the instance`).toBe("string");
      // the class's own code, or a sub-code of it (`model` → `model.circuit-open`)
      const own = (classes.get(name) as ErrorClass).code;
      if (own !== undefined) {
        const code = String(error.code);
        expect(code === own || code.startsWith(`${String(own)}.`), `${name}: ${code}`).toBe(true);
      }
      expect(error.name).toBe(name);
    },
  );

  it("AC1: a cause is optional: every error is made without one", () => {
    for (const [name, ErrorClass] of classes) {
      const error = new (ErrorClass as unknown as new (options: object) => Error)(
        fixtures[name] ?? {},
      );
      expect(error, name).toBeInstanceOf(Error);
    }
  });
});
