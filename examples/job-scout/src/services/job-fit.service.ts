import { Injectable, ROUTER_FACTORY, type RouterEngine } from "@agboss/core";
import { FIT, FIT_QUESTION, JOB_TEXT_CHARS, NO_FIT, type JobText } from "../helpers/fit.helper.js";

/** P(the job fits what the candidate wants), undefined when the judge failed; and what it cost. */
export interface JobFit {
  readonly fit: number | undefined;
  readonly costUsd: number;
}

/** Rates how well a job fits what the candidate wants. */
export interface FitRater {
  rate(profile: string, job: JobText): Promise<JobFit>;
}

/** Jev as the fit judge: one cheap decision per job, on the router "job-fit". */
@Injectable({ deps: [ROUTER_FACTORY] })
export class JobFitJudge implements FitRater {
  private readonly router: RouterEngine;

  constructor(routers: (name: string) => RouterEngine) {
    this.router = routers("job-fit");
  }

  async rate(profile: string, job: JobText): Promise<JobFit> {
    const outcome = await this.router.route({
      instructions: FIT_QUESTION,
      input: [
        `Candidate wants:\n${profile}`,
        `Job: ${job.title} — ${job.company}, ${job.location}`,
        `Department: ${job.department}`,
        job.text.slice(0, JOB_TEXT_CHARS),
      ].join("\n\n"),
      options: [
        { name: "fit", description: FIT },
        { name: "no_fit", description: NO_FIT },
      ],
    });
    const costUsd = outcome.usage?.costUsd ?? 0;
    if (outcome.kind === "failed") return { fit: undefined, costUsd };
    const confidence = outcome.decision.confidence ?? 1;
    return { fit: outcome.decision.next === "fit" ? confidence : 1 - confidence, costUsd };
  }
}
