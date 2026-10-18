/**
 * #261 PR 4: the generated `.agboss/types.d.ts` types `Environment` (what `ENV` gives) by each
 * application's contract — `interface Environment extends AppEnvironment {}` — so the project writes
 * no `declare module`; each workflow is analysed with its application's `defaults`.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateFlowTypes } from "../../../src/flow/types/generate.js";
import * as contractModule from "../../fixtures/environments/app/environments/app.environment.js";
import * as settingsModule from "../../fixtures/environments/app/settings.workflow.js";
import * as dtoModule from "../../../src/dto/index.js";

const fixtures = new URL("../../fixtures/environments/app/", import.meta.url).pathname;
const framework = new URL("../../../", import.meta.url).pathname;

const request = {
  workflows: [settingsModule.SettingsApp],
  applications: [settingsModule.SettingsApplication],
  modules: [
    { file: join(fixtures, "settings.workflow.ts"), exports: settingsModule },
    { file: join(framework, "src/dto/index.ts"), exports: dtoModule },
    { file: join(fixtures, "environments/app.environment.ts"), exports: contractModule },
  ],
  outFile: join(framework, ".artifacts/environment-types/.agboss/types.d.ts"),
  tablesModule: join(framework, "src/flow/generated-types.ts"),
};

describe("#261: Environment is typed by the application's contract", () => {
  it("the generated file extends Environment with the contract and imports it", () => {
    const { text, errors } = generateFlowTypes(request);

    expect(errors.map((found) => found.message)).toEqual([]);
    expect(text).toContain("\n  interface Environment extends SettingsEnvironment {}\n");
    expect(text).toMatch(/import type \{ SettingsEnvironment \} from ".*app\.environment\.js";/);
  });

  it("an unexported contract is [types.unexported-class]", () => {
    const { text, errors } = generateFlowTypes({
      ...request,
      modules: request.modules.slice(0, 2),
    });

    expect(text).toBeUndefined();
    expect(errors.map((found) => found.code)).toEqual(["types.unexported-class"]);
  });

  it("without applications nothing extends Environment", () => {
    const { text } = generateFlowTypes({ ...request, applications: [] });

    expect(text).not.toContain("interface Environment");
  });
});
