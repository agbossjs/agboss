import { afterEach, describe, expect, it, vi } from "vitest";
import { defineEnvironment, fromEnv, type Environment } from "agboss";
import { testWith } from "agboss/testing";
import { JobScoutApplication } from "../src/job-scout.application.js";
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

// `npm run chat` (the app) defaults to dev; testWith defaults to test.environment.ts when it exists.
const asChat = testWith(JobScoutApplication, { env: "dev" });
const bare = testWith(JobScoutApplication);
const asTest = testWith(JobScoutApplication, { env: "test" });
const stub: Environment = { greenhouseApiUrl: "http://greenhouse.stub" };
const ownValues = testWith(JobScoutApplication, { environment: stub });

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

  ownValues("AC2: a test passes its own environment; the service receives it", async ({ app }) => {
    const urls = recordBoardRequests();

    await app.tool(GreenhouseJobs).invoke(query);

    expect(urls).toEqual(["http://greenhouse.stub/v1/boards/fireblocks/jobs?content=true"]);
  });
});

describe("#182 AC3: an environment of the wrong shape does not compile", () => {
  it("a missing or mistyped field is a tsc error in the environment file", () => {
    // @ts-expect-error — greenhouseApiUrl is missing: the contract (environment.ts) requires it
    const missing = defineEnvironment({});
    // @ts-expect-error — greenhouseApiUrl is a string
    const mistyped = defineEnvironment({ greenhouseApiUrl: 42 });
    const fromVariable = defineEnvironment({ greenhouseApiUrl: fromEnv("GREENHOUSE_API_URL") });
    expect([missing, mistyped, fromVariable]).toHaveLength(3);
  });
});
