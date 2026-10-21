import { ExecutionContext, Tool, type ToolHandler } from "agboss";
import type { Candidate } from "../helpers/boards.helper.js";
import { GreenhouseBoards } from "../services/greenhouse-boards.service.js";
import { fitScorer, matchScore, MAX_JUDGED, passesFilters } from "../helpers/greenhouse.helper.js";
import { JOB_SEARCH, type JobSearch } from "../config/search.config.js";
import { JobFitJudge, type FitRater } from "../services/job-fit.service.js";
import { JobMatches, JobQuery } from "./greenhouse-jobs.dto.js";
import { minutes } from "agboss/units";

/**
 * Public Greenhouse boards (no key): hard filters (location, excluded titles), then a cheap judge
 * (Jev) rates every remaining job against what the user wants; the best `count` come back with
 * links. Board responses and judgements are cached per instance; the judge's spend is the tool's
 * (its `ROUTER_FACTORY` decisions are accounted by the framework). A cancelled execution stops the
 * search before the judge is asked.
 */
@Tool({
  name: "greenhouse-jobs-tool",
  description:
    "Find jobs on Greenhouse boards that fit what the user wants; returns the best with links.",
  input: JobQuery,
  output: JobMatches,
  timeout: minutes(4),
  deps: [JobFitJudge, JOB_SEARCH, GreenhouseBoards, ExecutionContext],
})
export class GreenhouseJobs implements ToolHandler<JobQuery, JobMatches> {
  private readonly score: ReturnType<typeof fitScorer>;

  constructor(
    judge: FitRater,
    private readonly search: JobSearch,
    private readonly boards: GreenhouseBoards,
    private readonly executionContext: ExecutionContext,
  ) {
    this.score = fitScorer((profile, job) => judge.rate(profile, job));
  }

  async run(input: JobQuery): Promise<JobMatches> {
    const requested = input.boards.length > 0 ? input.boards : Object.keys(this.search.boards);
    const boards = [...new Set(requested.map((board) => board.trim().toLowerCase()))];
    const { failedBoards, candidates } = await this.boards.jobs(boards);
    const filtered = candidates.filter((job) => passesFilters(job, input, this.search.places));
    const judgedJobs = filtered.slice(0, MAX_JUDGED);
    this.executionContext.signal.throwIfAborted();
    const { fits } = await this.score(input.profile, judgedJobs);
    const passed = judgedJobs
      .map((job, i) => ({ job, fit: fits[i] }))
      .filter(
        (item): item is { job: Candidate; fit: number } =>
          item.fit !== undefined && item.fit >= input.minFit,
      )
      .sort((a, b) => b.fit - a.fit || b.job.updated.localeCompare(a.job.updated));
    return {
      searched: boards,
      failedBoards,
      afterFilters: filtered.length,
      judged: judgedJobs.length,
      judgeFailures: fits.filter((fit) => fit === undefined).length,
      passed: passed.length,
      jobs: passed.slice(0, input.count).map(({ job, fit }) => ({
        company: job.company,
        title: job.title,
        location: job.location,
        department: job.department,
        url: job.url,
        updated: job.updated,
        fit: Math.round(fit * 100),
        matchedSkills: matchScore(input.skills, `${job.title} ${job.text}`).matched,
      })),
    };
  }
}
