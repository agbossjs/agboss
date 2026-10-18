import { ApplicationContext, Injectable } from "agboss";
import { z } from "zod";
import { JOB_SEARCH, type JobSearch } from "../config/search.config.js";
import {
  BoardResponse,
  candidateOf,
  type BoardJob,
  type Candidate,
} from "../helpers/boards.helper.js";

export type FetchJson = (url: string) => Promise<unknown>;

export async function fetchJsonOverHttp(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Greenhouse answered ${String(response.status)}`);
  return response.json();
}

const ProbeResponse = z.object({
  jobs: z.array(
    z.object({
      location: z.object({ name: z.string() }).nullable().optional(),
      company_name: z.string().optional(),
    }),
  ),
});

export type BoardProbe =
  | {
      readonly board: string;
      readonly company: string;
      readonly jobs: number;
      readonly inPlace: number;
    }
  | { readonly board: string; readonly error: string };

export interface BoardJobs {
  readonly failedBoards: { board: string; error: string }[];
  readonly candidates: Candidate[];
}

/** Where a probe reads boards: the board API and how JSON is fetched. */
export interface BoardApi {
  readonly greenhouseApiUrl: string;
  readonly fetchJson: FetchJson;
}

/** How many live jobs a board has, and how many of them are in a place (any of its words). */
export async function probeBoard(
  api: BoardApi,
  board: string,
  placeWords: readonly string[],
): Promise<BoardProbe> {
  try {
    const url = `${api.greenhouseApiUrl}/v1/boards/${encodeURIComponent(board)}/jobs`;
    const { jobs } = ProbeResponse.parse(await api.fetchJson(url));
    const words = placeWords.map((word) => word.toLowerCase());
    const inPlace = jobs.filter((job) =>
      words.some((word) => (job.location?.name ?? "").toLowerCase().includes(word)),
    ).length;
    return { board, company: jobs[0]?.company_name ?? board, jobs: jobs.length, inPlace };
  } catch (error) {
    return { board, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Public Greenhouse boards over HTTP (no key); board responses are cached per instance. */
@Injectable({ deps: [JOB_SEARCH, ApplicationContext] })
export class GreenhouseBoards {
  readonly #cache = new Map<string, Promise<BoardJob[]>>();

  constructor(
    private readonly search: JobSearch,
    private readonly applicationContext: ApplicationContext,
    private readonly fetchJson: FetchJson = fetchJsonOverHttp,
  ) {}

  /** The jobs of these boards; a failed board is reported, not thrown. */
  async jobs(boards: readonly string[]): Promise<BoardJobs> {
    const settled = await Promise.allSettled(boards.map((board) => this.board(board)));
    return {
      failedBoards: settled.flatMap((r, i) =>
        r.status === "rejected" ? [{ board: boards[i] ?? "", error: String(r.reason) }] : [],
      ),
      candidates: settled.flatMap((r, i) =>
        r.status === "fulfilled"
          ? r.value.map((job) => candidateOf(boards[i] ?? "", job, this.search.boards))
          : [],
      ),
    };
  }

  /** How many live jobs a board has, and how many of them are in a place (any of its words). */
  probe(board: string, placeWords: readonly string[]): Promise<BoardProbe> {
    const { greenhouseApiUrl } = this.applicationContext.environment;
    return probeBoard({ greenhouseApiUrl, fetchJson: this.fetchJson }, board, placeWords);
  }

  private board(board: string): Promise<BoardJob[]> {
    const cached = this.#cache.get(board);
    if (cached !== undefined) return cached;
    const url = `${this.applicationContext.environment.greenhouseApiUrl}/v1/boards/${encodeURIComponent(board)}/jobs?content=true`;
    const pending = this.fetchJson(url).then((body) => BoardResponse.parse(body).jobs);
    pending.catch(() => this.#cache.delete(board));
    this.#cache.set(board, pending);
    return pending;
  }
}
