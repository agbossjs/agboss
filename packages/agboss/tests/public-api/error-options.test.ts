/**
 * #906 AC1 (API review G8, completing #890): every exported `AGBossError` subclass of every entry
 * constructs from ONE options object whose keys are the error's own properties, and takes a
 * `cause` — typed (`ConstructorParameters` is checked by `tsc` on the fixtures below) and kept
 * (`.cause`). The test walks the exports of each entry, so a new error class without a fixture
 * fails it — and a class that takes its facts positionally, or drops a `cause`, fails its own case.
 * `AGBossError` itself is the base a project's own errors extend (`message`, `{ cause, details }`).
 */
import { describe, expect, it } from "vitest";
import * as a2a from "../../src/a2a/index.js";
import * as channels from "../../src/channels/index.js";
import * as core from "../../src/core/index.js";
import * as dto from "../../src/dto/index.js";
import * as evals from "../../src/eval/index.js";
import * as graph from "../../src/graph/index.js";
import * as root from "../../src/index.js";
import * as internal from "../../src/internal.js";
import * as mcp from "../../src/mcp/index.js";
import * as memory from "../../src/memory/index.js";
import * as models from "../../src/models/index.js";
import * as rag from "../../src/rag/index.js";
import * as router from "../../src/router/index.js";
import * as stores from "../../src/stores/index.js";
import * as testing from "../../src/testing/index.js";
import * as contracts from "../../src/testing/contracts/index.js";
import * as faults from "../../src/testing/faults/index.js";
import * as testingVitest from "../../src/testing/vitest.js";
import * as tool from "../../src/tool/index.js";
import * as units from "../../src/units/index.js";
import { AGBossError } from "../../src/index.js";
import { fixtures } from "./error-options.fixtures.js";

/** Every entry of package.json#exports that has exports (`./testing/setup` has none). */
const ENTRIES: Readonly<Record<string, object>> = {
  ".": root,
  "./dto": dto,
  "./units": units,
  "./models": models,
  "./testing": testing,
  "./testing/vitest": testingVitest,
  "./testing/contracts": contracts,
  "./testing/faults": faults,
  "./mcp": mcp,
  "./rag": rag,
  "./a2a": a2a,
  "./memory": memory,
  "./eval": evals,
  "./stores": stores,
  "./internal": internal,
  "./core": core,
  "./graph": graph,
  "./router": router,
  "./tool": tool,
  "./channels": channels,
};

type ErrorClass = new (options: never) => AGBossError;

/** Every `AGBossError` subclass any entry exports, by name (the base is not one). */
const exportedErrors = (): ReadonlyMap<string, ErrorClass> => {
  const found = new Map<string, ErrorClass>();
  for (const entry of Object.values(ENTRIES))
    for (const [name, value] of Object.entries(entry))
      if (typeof value === "function" && value.prototype instanceof AGBossError)
        found.set(name, value as ErrorClass);
  return found;
};

const classes = exportedErrors();

describe("#906 AC1: every exported error takes one options bag with a cause", () => {
  it("AC1: the walk finds the errors, and each has a fixture (a new class needs one)", () => {
    expect(classes.size).toBeGreaterThan(80);
    expect([...classes.keys()].filter((name) => !(name in fixtures)).sort()).toEqual([]);
    expect(
      Object.keys(fixtures)
        .filter((name) => !classes.has(name))
        .sort(),
    ).toEqual([]);
  });

  it.each([...classes.keys()].sort())(
    "AC1: %s — keys are own properties, the cause is kept, the code is the class's",
    (name) => {
      const ErrorClass = classes.get(name) as new (options: object) => AGBossError;
      const options = fixtures[name] ?? {};
      const cause = new Error(`the cause of ${name}`);

      const error = new ErrorClass({ ...options, cause });

      expect(error).toBeInstanceOf(ErrorClass);
      expect(error.cause).toBe(cause);
      const missing = Object.keys(options).filter((key) => !Object.hasOwn(error, key));
      expect(missing, `${name}: option keys that are no own property`).toEqual([]);
      // the class's own code, or a sub-code of it (`model` → `model.circuit-open`)
      const own = String(Reflect.get(ErrorClass, "code"));
      expect(error.code === own || error.code.startsWith(`${own}.`), `${name}: ${error.code}`).toBe(
        true,
      );
      expect(error.name).toBe(name);
    },
  );

  it("AC1: a cause is optional: every error is made without one", () => {
    for (const [name, ErrorClass] of classes) {
      const error = new (ErrorClass as new (options: object) => AGBossError)(fixtures[name] ?? {});
      expect(error, name).toBeInstanceOf(AGBossError);
    }
  });
});
