/**
 * #497 — `agbossTest()` (`@agboss/core/testing/vitest`): the `test` options of a project's vitest
 * config with AGBoss inlined (`server.deps.inline`, so every file the core loads goes through vite,
 * in the test's module graph) and its matchers registered (`setupFiles`). A user's own options are
 * kept: arrays are merged, never replaced, and nothing is added twice.
 */
import { describe, expect, it } from "vitest";
import { agbossTest } from "../../src/testing/vitest.js";

const SETUP = "@agboss/core/testing/setup";
const CORE = /@agboss\/core/;

describe("AC5: agbossTest() inlines AGBoss and registers its setup file", () => {
  it("AC5: with no options it gives the inlined core and the setup file only", () => {
    expect(agbossTest()).toEqual({
      setupFiles: [SETUP],
      server: { deps: { inline: [CORE] } },
    });
  });

  it("AC5: with an empty object it gives the same as with nothing", () => {
    expect(agbossTest({})).toEqual(agbossTest());
  });

  it("AC5: the user's setup files come first, the AGBoss one is appended", () => {
    expect(agbossTest({ setupFiles: ["./tests/setup.ts"] }).setupFiles).toEqual([
      "./tests/setup.ts",
      SETUP,
    ]);
  });

  it("AC5: one setup file given as a string becomes a list with the AGBoss one", () => {
    expect(agbossTest({ setupFiles: "./tests/setup.ts" }).setupFiles).toEqual([
      "./tests/setup.ts",
      SETUP,
    ]);
  });

  it("AC5: a setup file list that already has the AGBoss one is kept as it is", () => {
    expect(agbossTest({ setupFiles: [SETUP, "./tests/setup.ts"] }).setupFiles).toEqual([
      SETUP,
      "./tests/setup.ts",
    ]);
  });

  it("AC5: the AGBoss setup file given as a string is not added twice", () => {
    expect(agbossTest({ setupFiles: SETUP }).setupFiles).toEqual([SETUP]);
  });

  it("AC5: the user's inlined dependencies come first, the core is appended", () => {
    expect(agbossTest({ server: { deps: { inline: ["my-lib", /other/] } } }).server).toEqual({
      deps: { inline: ["my-lib", /other/, CORE] },
    });
  });

  it("AC5: an inline list that already has the core's pattern gets no second one", () => {
    expect(
      agbossTest({ server: { deps: { inline: [/@agboss\/core/, "my-lib"] } } }).server,
    ).toEqual({ deps: { inline: [CORE, "my-lib"] } });
  });

  it("AC5: a pattern of the same text with other flags is the user's own, the core is appended", () => {
    expect(agbossTest({ server: { deps: { inline: [/@agboss\/core/i] } } }).server).toEqual({
      deps: { inline: [/@agboss\/core/i, CORE] },
    });
  });

  it("AC5: inline: true (every dependency inlined) already covers the core and is kept", () => {
    expect(agbossTest({ server: { deps: { inline: true } } }).server).toEqual({
      deps: { inline: true },
    });
  });

  it("AC5: the user's other server and deps options pass through", () => {
    const test = agbossTest({
      server: { sourcemap: true, deps: { external: [/legacy/], moduleDirectories: ["/vendor/"] } },
    });

    expect(test.server).toEqual({
      sourcemap: true,
      deps: { external: [/legacy/], moduleDirectories: ["/vendor/"], inline: [CORE] },
    });
  });

  it("AC5: server options without deps get deps with the core", () => {
    expect(agbossTest({ server: { sourcemap: "inline" } }).server).toEqual({
      sourcemap: "inline",
      deps: { inline: [CORE] },
    });
  });

  it("AC5: every other option passes through unchanged", () => {
    const projects = [{ extends: true as const, test: { name: "unit" } }];
    const test = agbossTest({ include: ["tests/**/*.test.ts"], passWithNoTests: true, projects });

    expect(test.include).toEqual(["tests/**/*.test.ts"]);
    expect(test.passWithNoTests).toBe(true);
    expect(test.projects).toBe(projects);
  });

  it("AC5: called twice it adds nothing twice", () => {
    const once = agbossTest({ setupFiles: ["./a.ts"], server: { deps: { inline: ["my-lib"] } } });

    expect(agbossTest(once)).toEqual(once);
  });

  it("AC5: the user's options are not changed in place", () => {
    const setupFiles = ["./a.ts"];
    const inline = ["my-lib"];
    agbossTest({ setupFiles, server: { deps: { inline } } });

    expect([setupFiles, inline]).toEqual([["./a.ts"], ["my-lib"]]);
  });
});
