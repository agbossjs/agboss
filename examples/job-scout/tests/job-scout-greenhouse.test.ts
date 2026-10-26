import { testExecutionContext, toolOf } from "@agboss/core/testing";
import { describe, expect, it, vi } from "vitest";
import { FIT_QUESTION, mapLimited, type FitJudge } from "../src/helpers/fit.helper.js";
import { GreenhouseJobs } from "../src/tools/greenhouse-jobs.tool.js";
import { GreenhouseBoards } from "../src/services/greenhouse-boards.service.js";
import { JobFitJudge } from "../src/services/job-fit.service.js";

/** The application context of the dev environment: the public board API. */
const { application } = testExecutionContext({
  application: {
    environment: { greenhouseApiUrl: "https://boards-api.greenhouse.io", sqlitePath: ":memory:" },
  },
}).tenant;

const greenhouse = (deps: {
  judge: FitJudge;
  fetchJson: (url: string) => Promise<unknown>;
  search: typeof testSearch;
}) =>
  toolOf(
    new GreenhouseJobs(
      { rate: deps.judge },
      deps.search,
      new GreenhouseBoards(deps.search, application, deps.fetchJson),
      testExecutionContext(),
    ),
  );
import type { JobSearch } from "../src/config/search.config.js";
import { usageRecord } from "./helpers.js";

/** A test config: its own boards and places — nothing from the shipped example. */
const testSearch: JobSearch = {
  boards: { fireblocks: "Fireblocks", similarweb: "Similarweb", jfrog: "JFrog", ghost: "Ghost" },
  places: { israel: ["Israel", "Tel Aviv", "Herzliya", "Or Yehuda"] },
};

const board = (jobs: object[]) => ({ jobs });
const job = (title: string, location: string, content: string) => ({
  title,
  absolute_url: `https://example.com/${title.replace(/\s/g, "-")}`,
  updated_at: "2026-09-20T10:00:00-04:00",
  location: { name: location },
  departments: [{ name: "R&D" }],
  content,
});

const boards: Record<string, object> = {
  fireblocks: board([
    job(
      "Senior Backend Engineer",
      "Tel Aviv-Yafo, Tel Aviv District, Israel",
      "&lt;p&gt;Java, Kotlin, Kafka&lt;/p&gt;",
    ),
    job("Team Lead, Backend", "Tel Aviv, Israel", "Java"),
    job("Backend Engineer", "New York", "Java"),
  ]),
  similarweb: board([job("Backend Engineer, Platform", "Tel Aviv", "Kotlin and Spring")]),
  jfrog: board([job("Sales Engineer", "Herzliya, Israel", "sales")]),
};

const fetchJson = vi.fn((url: string) => {
  const token = /boards\/([^/]+)\/jobs/.exec(url)?.[1] ?? "";
  const body = boards[token];
  return body === undefined ? Promise.reject(new Error("404")) : Promise.resolve(body);
});

/** Fits by title word; "Sales" is a no-fit; costs $0.00002 per decision. */
const judge = vi.fn<FitJudge>((_profile, j) =>
  Promise.resolve({
    fit: j.title.includes("Sales") ? 0.1 : j.title.includes("Senior") ? 0.9 : 0.7,
    costUsd: 0.00002,
  }),
);

const search = {
  profile: "Senior backend, Java or Kotlin primary; no management roles",
  locations: ["Israel"],
  excludeTitleWords: ["Team Lead"],
  skills: ["Java", "Kotlin", "Kafka"],
  boards: ["fireblocks", "similarweb", "jfrog", "ghost"],
};

describe("greenhouse-jobs-tool", () => {
  it("filters hard, lets the judge rank the rest and returns the best with links", async () => {
    const tool = greenhouse({ judge, fetchJson, search: testSearch });

    const result = await tool.invoke({ ...search, minFit: 0.5 });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.value.jobs.map((j) => [j.company, j.title, j.fit])).toEqual([
      ["Fireblocks", "Senior Backend Engineer", 90],
      ["Similarweb", "Backend Engineer, Platform", 70],
    ]);
    expect(result.value.jobs[0]?.matchedSkills).toEqual(["Java", "Kotlin", "Kafka"]);
    expect(result.value).toMatchObject({ afterFilters: 3, judged: 3, passed: 2, judgeFailures: 0 });
    expect(result.value.failedBoards).toEqual([{ board: "ghost", error: "Error: 404" }]);
  });

  it("ranks everything by default (no floor)", async () => {
    const tool = greenhouse({ judge, fetchJson, search: testSearch });

    const result = await tool.invoke(search);

    expect(result.kind === "ok" && result.value.jobs.map((j) => j.fit)).toEqual([90, 70, 10]);
  });

  it("caches boards and judgements for the same profile", async () => {
    fetchJson.mockClear();
    judge.mockClear();
    const tool = greenhouse({ judge, fetchJson, search: testSearch });

    await tool.invoke({ ...search, boards: ["similarweb"] });
    await tool.invoke({ ...search, boards: ["similarweb"], count: 5 });

    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("uses all configured boards by default and counts judge failures", async () => {
    const failing: FitJudge = () => Promise.resolve({ fit: undefined, costUsd: 0 });
    const tool = greenhouse({ judge: failing, fetchJson, search: testSearch });

    const result = await tool.invoke({ profile: search.profile, locations: ["Israel"] });

    expect(result.kind === "ok" && result.value.searched).toEqual([
      "fireblocks",
      "similarweb",
      "jfrog",
      "ghost",
    ]);
    expect(result.kind === "ok" && result.value.judgeFailures).toBe(4);
  });
});

describe("JobFitJudge (Jev per job)", () => {
  const jobText = {
    company: "Acme",
    title: "Backend",
    location: "Haifa",
    department: "R&D",
    text: "Java",
  };

  it("asks the router the fit question and returns P(fit) with its cost", async () => {
    const route = vi.fn<any>(() =>
      Promise.resolve({
        kind: "decided",
        decision: { next: "no_fit", reason: "", confidence: 0.8 },
        usage: usageRecord("router:job-fit", 0.00002),
      }),
    );

    const result = await new JobFitJudge(() => ({ name: "job-fit", route })).rate(
      "Java backend",
      jobText,
    );

    expect(result.fit).toBeCloseTo(0.2);
    expect(result.costUsd).toBe(0.00002);
    expect((route.mock.calls[0]?.[0] as any).instructions).toBe(FIT_QUESTION);
  });

  it("reports a failed decision as no fit value", async () => {
    const route = vi.fn<any>(() => Promise.resolve({ kind: "failed", reason: "down" }));

    expect(await new JobFitJudge(() => ({ name: "job-fit", route })).rate("x", jobText)).toEqual({
      fit: undefined,
      costUsd: 0,
    });
  });

  it("mapLimited keeps order under a concurrency limit", async () => {
    expect(await mapLimited([3, 1, 2], 2, (n) => Promise.resolve(n * 10))).toEqual([30, 10, 20]);
  });
});

describe("hard filters", () => {
  it("keeps only titles with a required word and drops excluded ones, before the judge", async () => {
    judge.mockClear();
    const tool = greenhouse({ judge, fetchJson, search: testSearch });

    const result = await tool.invoke({
      ...search,
      titleMustInclude: ["Senior"],
      excludeTitleWords: ["Lead"],
    });

    expect(result.kind === "ok" && result.value.jobs.map((j) => j.title)).toEqual([
      "Senior Backend Engineer",
    ]);
    expect(judge).toHaveBeenCalledTimes(1);
  });

  it("matches Israeli cities for Israel", async () => {
    const tool = greenhouse({
      judge,
      search: testSearch,
      fetchJson: () =>
        Promise.resolve(
          board([job("Backend", "Or Yehuda", "Java"), job("Backend", "Berlin", "Java")]),
        ),
    });

    const result = await tool.invoke({ ...search, boards: ["x"], excludeTitleWords: [] });

    expect(result.kind === "ok" && result.value.jobs.map((j) => j.location)).toEqual(["Or Yehuda"]);
  });
});
