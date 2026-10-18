import { describe, expect, it } from "vitest";
import { testExecutionContext } from "agboss/testing";
import { GreenhouseBoards, type FetchJson } from "../src/services/greenhouse-boards.service.js";

/** The application context of the dev environment: the public board API. */
const { application } = testExecutionContext({
  application: { environment: { greenhouseApiUrl: "https://boards-api.greenhouse.io", sqlitePath: ":memory:" },
  },
}).tenant;

const probeBoard = (board: string, words: readonly string[], fetchJson: FetchJson) =>
  new GreenhouseBoards({ boards: {}, places: {} }, application, fetchJson).probe(board, words);
import { workflowOf } from "agboss/testing";
import { JobScout } from "../src/job-scout.workflow.js";
import { jobScoutPromptVariables } from "../src/config/prompt-variables.js";
import { jobSearchConfig, JobSearchSchema } from "../src/config/search.config.js";

describe("job-scout search config", () => {
  it("rejects a config without boards", () => {
    expect(() => JobSearchSchema.parse({ boards: {} })).toThrow(/at least one board/);
    expect(JobSearchSchema.parse({ boards: { acme: "Acme" } }).places).toEqual({});
  });

  it("ships an example config", () => {
    expect(Object.keys(jobSearchConfig.boards).length).toBeGreaterThan(10);
    expect(Object.keys(jobSearchConfig.places)).toContain("israel");
  });

  it("prompt variables list the configured boards and places", () => {
    const variables = jobScoutPromptVariables({
      boards: { acme: "Acme" },
      places: { germany: ["Berlin", "Munich"] },
    });

    expect(variables).toEqual({
      boards: "acme (Acme)",
      boardCount: "1",
      knownPlaces: "Places the search knows (they also match their cities): germany.",
    });
    expect(jobScoutPromptVariables({ boards: { acme: "Acme" }, places: {} }).knownPlaces).toContain(
      "matched literally",
    );
  });

  it("assembled prompts: every variable filled, the rules in place", async () => {
    const { prompts } = await workflowOf(JobScout);
    const p = prompts["profiler-agent"];
    const s = prompts["scout-agent"];
    const boards = String(Object.keys(jobSearchConfig.boards).length);

    expect(p).not.toContain("{{");
    expect(s).not.toContain("{{");
    expect(p).toContain("Proposed search brief:");
    expect(p).toContain(`Boards: all ${boards}`);
    expect(p).not.toMatch(/^\d\. /m);
    expect(s).toContain("Never add a filter of your own.");
    // the list comes first and is never dropped for the notes-based explanation (found in #92 M1)
    const scout = s ?? "";
    expect(scout.indexOf("numbered list")).toBeLessThan(
      (scout as any).indexOf("search_company_notes"),
    );
    expect(s).toContain("Never drop this list");
    expect(s).not.toMatch(/e\.g\. (Lead|Senior)/);
    expect(s).toContain("they also match their cities): israel");
  });
});

describe("probeBoard", () => {
  const jobs = {
    jobs: [
      { location: { name: "Berlin, Germany" }, company_name: "Acme" },
      { location: { name: "Paris" } },
      { location: null },
    ],
  };

  it("counts live jobs and those in the place", async () => {
    expect(await probeBoard("acme", ["germany", "munich"], () => Promise.resolve(jobs))).toEqual({
      board: "acme",
      company: "Acme",
      jobs: 3,
      inPlace: 1,
    });
  });

  it("reports a board that fails", async () => {
    expect(await probeBoard("ghost", ["x"], () => Promise.reject(new Error("404")))).toEqual({
      board: "ghost",
      error: "404",
    });
  });
});
