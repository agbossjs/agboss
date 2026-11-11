/**
 * #497 — `agbossVitest()` (`@agboss/core/testing/vitest`): the `test` options of a project's vitest
 * config with AGBoss inlined (`server.deps.inline`, so every file the core loads goes through vite,
 * in the test's module graph) and its matchers registered (`setupFiles`). A user's own options are
 * kept: arrays are merged, never replaced, and nothing is added twice.
 */
import { describe, expect, it } from "vitest";
import { agbossVitest } from "../../src/testing/vitest.js";

const SETUP = "@agboss/core/testing/setup";
const CORE = /@agboss\//;

describe("AC5: agbossVitest() inlines AGBoss and registers its setup file", () => {
  it("AC5: with no options it gives the inlined core and the setup file only", () => {
    expect(agbossVitest()).toEqual({
      setupFiles: [SETUP],
      server: { deps: { inline: [CORE] } },
    });
  });

  it("AC5: with an empty object it gives the same as with nothing", () => {
    expect(agbossVitest({})).toEqual(agbossVitest());
  });

  it("AC5: the user's setup files come first, the AGBoss one is appended", () => {
    expect(agbossVitest({ setupFiles: ["./tests/setup.ts"] }).setupFiles).toEqual([
      "./tests/setup.ts",
      SETUP,
    ]);
  });

  it("AC5: one setup file given as a string becomes a list with the AGBoss one", () => {
    expect(agbossVitest({ setupFiles: "./tests/setup.ts" }).setupFiles).toEqual([
      "./tests/setup.ts",
      SETUP,
    ]);
  });

  it("AC5: a setup file list that already has the AGBoss one is kept as it is", () => {
    expect(agbossVitest({ setupFiles: [SETUP, "./tests/setup.ts"] }).setupFiles).toEqual([
      SETUP,
      "./tests/setup.ts",
    ]);
  });

  it("AC5: the AGBoss setup file given as a string is not added twice", () => {
    expect(agbossVitest({ setupFiles: SETUP }).setupFiles).toEqual([SETUP]);
  });

  it("AC5: the user's inlined dependencies come first, the core is appended", () => {
    expect(agbossVitest({ server: { deps: { inline: ["my-lib", /other/] } } }).server).toEqual({
      deps: { inline: ["my-lib", /other/, CORE] },
    });
  });

  it("AC5: an inline list that already has the core's pattern gets no second one", () => {
    expect(agbossVitest({ server: { deps: { inline: [/@agboss\//, "my-lib"] } } }).server).toEqual({
      deps: { inline: [CORE, "my-lib"] },
    });
  });

  it("AC5: a pattern of the same text with other flags is the user's own, the core is appended", () => {
    expect(agbossVitest({ server: { deps: { inline: [/@agboss\//i] } } }).server).toEqual({
      deps: { inline: [/@agboss\//i, CORE] },
    });
  });

  it("AC5: inline: true (every dependency inlined) already covers the core and is kept", () => {
    expect(agbossVitest({ server: { deps: { inline: true } } }).server).toEqual({
      deps: { inline: true },
    });
  });

  it("AC5: the user's other server and deps options pass through", () => {
    const test = agbossVitest({
      server: { sourcemap: true, deps: { external: [/legacy/], moduleDirectories: ["/vendor/"] } },
    });

    expect(test.server).toEqual({
      sourcemap: true,
      deps: { external: [/legacy/], moduleDirectories: ["/vendor/"], inline: [CORE] },
    });
  });

  it("AC5: server options without deps get deps with the core", () => {
    expect(agbossVitest({ server: { sourcemap: "inline" } }).server).toEqual({
      sourcemap: "inline",
      deps: { inline: [CORE] },
    });
  });

  it("AC5: every other option passes through unchanged", () => {
    const projects = [{ extends: true as const, test: { name: "unit" } }];
    const test = agbossVitest({ include: ["tests/**/*.test.ts"], passWithNoTests: true, projects });

    expect(test.include).toEqual(["tests/**/*.test.ts"]);
    expect(test.passWithNoTests).toBe(true);
    expect(test.projects).toBe(projects);
  });

  it("AC5: called twice it adds nothing twice", () => {
    const once = agbossVitest({ setupFiles: ["./a.ts"], server: { deps: { inline: ["my-lib"] } } });

    expect(agbossVitest(once)).toEqual(once);
  });

  it("AC5: the user's options are not changed in place", () => {
    const setupFiles = ["./a.ts"];
    const inline = ["my-lib"];
    agbossVitest({ setupFiles, server: { deps: { inline } } });

    expect([setupFiles, inline]).toEqual([["./a.ts"], ["my-lib"]]);
  });
});

describe("#891: a store package shares the test's core", () => {
  it("#891 AC6: every @agboss package is inlined — a store's classes are decorated by the same core", () => {
    const inline = agbossVitest().server?.deps?.inline;
    const patterns = Array.isArray(inline) ? inline.filter((entry) => entry instanceof RegExp) : [];

    for (const file of [
      "/app/node_modules/@agboss/core/dist/index.js",
      "/app/node_modules/@agboss/mongodb/dist/index.js",
      "/app/node_modules/@agboss/redis/dist/index.js",
      "/app/node_modules/@agboss/postgres/dist/index.js",
    ])
      expect(patterns.some((pattern) => pattern.test(file))).toBe(true);
  });
});
