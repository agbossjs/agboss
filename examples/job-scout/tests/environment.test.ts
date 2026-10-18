import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "agboss";
import { testWith } from "agboss/testing";
import { JobScoutApplication } from "../src/job-scout.application.js";
import type { AppEnvironment } from "../src/environments/app.environment.js";
import { GreenhouseJobs } from "../src/tools/greenhouse-jobs.tool.js";

const query = {
  profile: "Senior backend engineer, TypeScript and Node.js",
  locations: ["israel"],
  titleMustInclude: [],
  excludeTitleWords: [],
  skills: [],
  boards: ["fireblocks"],
  count: 5,
  minFit: 0,
};

/** Every board request the app makes, answered with an empty board (no network). */
function recordBoardRequests(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      urls.push(url);
      return Promise.resolve(Response.json({ jobs: [] }));
    }),
  );
  return urls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// `npm run chat` (the app) defaults to dev; testWith defaults to test.environment.ts (#261).
const asChat = testWith(JobScoutApplication, { env: "dev" });
const bare = testWith(JobScoutApplication);
const asTest = testWith(JobScoutApplication, { env: "test" });

describe("#182: the app's environment reaches GreenhouseBoards", () => {
  asChat(
    "AC1: the app's default (npm run chat, no --env) is dev.environment.ts: the real board API",
    async ({ app }) => {
      const urls = recordBoardRequests();

      await app.tool(GreenhouseJobs).invoke(query);

      expect(urls).toEqual([
        "https://boards-api.greenhouse.io/v1/boards/fireblocks/jobs?content=true",
      ]);
    },
  );

  bare(
    "testWith without env → test.environment.ts (tests never hit the real API by default)",
    async ({ app }) => {
      const urls = recordBoardRequests();

      await app.tool(GreenhouseJobs).invoke(query);

      expect(urls).toEqual(["https://greenhouse.test/v1/boards/fireblocks/jobs?content=true"]);
    },
  );

  asTest('{ env: "test" } → test.environment.ts', async ({ app }) => {
    const urls = recordBoardRequests();

    await app.tool(GreenhouseJobs).invoke(query);

    expect(urls).toEqual(["https://greenhouse.test/v1/boards/fireblocks/jobs?content=true"]);
  });
});

describe("#261 AC8: an environment of the wrong shape does not compile", () => {
  it("a missing or mistyped field is a tsc error in the environment file", () => {
    // @ts-expect-error — greenhouseApiUrl is missing: the contract (app.environment.ts) requires it
    const missing: AppEnvironment = {};
    // @ts-expect-error — greenhouseApiUrl is a string
    const mistyped: AppEnvironment = { greenhouseApiUrl: 42 };
    const fromVariable: AppEnvironment = { greenhouseApiUrl: env("GREENHOUSE_API_URL") };
    expect([missing, mistyped, fromVariable]).toHaveLength(3);
  });
});
