import { describe, expect, it } from "vitest";
import { loadApplicationClass } from "../../src/loader/load-application.js";
import { ApplicationLoadError } from "../../src/loader/load-errors.js";
import { SoloApplication } from "../fixtures/loader/apps/solo.application.js";

/** #268 AC1: the application of `agboss --application <path>` / `"agboss": { "application" }`. */

const fixture = (name: string): string => new URL(`../${name}`, import.meta.url).pathname;
// vitest already transpiles TypeScript; the CLI registers tsx itself
const options = { typescript: false } as const;

describe("#268 AC1: the application module", () => {
  it("loads the one exported @Application class of the module", async () => {
    const found = await loadApplicationClass(
      fixture("fixtures/loader/apps/solo.application.ts"),
      options,
    );

    expect(found).toBe(SoloApplication);
  });

  it("a missing file is an ApplicationLoadError naming it", async () => {
    const loading = loadApplicationClass(fixture("fixtures/loader/nope.application.ts"), options);

    await expect(loading).rejects.toBeInstanceOf(ApplicationLoadError);
    await expect(loading).rejects.toThrow(/Application file not found: .*nope\.application\.ts/);
  });

  it("a module with no @Application or with two is an error naming the count", async () => {
    await expect(
      loadApplicationClass(fixture("fixtures/loader/none.workflow.ts"), options),
    ).rejects.toThrow(
      /none\.workflow\.ts: expected exactly one exported @Application class, found 0/,
    );
    await expect(
      loadApplicationClass(fixture("fixtures/loader/two.application.ts"), options),
    ).rejects.toThrow(
      /two\.application\.ts: expected exactly one exported @Application class, found 2/,
    );
  });
});
