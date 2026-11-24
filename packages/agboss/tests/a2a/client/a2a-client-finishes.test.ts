/**
 * #916 item 3 (option C): a typed client's output covers every finish of its skill by default; with
 * `@A2AAgent({ target: { finishes } })` it covers those it names — the card check compares only
 * them (a name the card does not list: `[a2a.unknown-finish]`), and a task that ends at another
 * finish is `A2AUnexpectedFinishError`, which `.onError` takes. Names no finish could have are
 * refused at assembly; `describe` and `--json` show the list.
 */
import { describe, expect, it } from "vitest";
import {
  A2AClient,
  A2AClientFile,
  A2AContractError,
  A2AContractRule,
  A2AFileDto,
  A2AUnexpectedFinishError,
} from "../../../src/a2a/index.js";
import type { DtoClass } from "../../../src/dto/types.js";
import { Nested, Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import { testWith } from "../../../src/testing/index.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import {
  FilesA2AExpose,
  FilesApplication,
  ReviewRequestDto,
  ReviewResultDto,
} from "../fixtures/files.application.js";
import { fetchAs } from "../server/sdk-client.js";
import { PDF } from "../files/support.js";
import { agentEndingAt, AnswerDto } from "./support/finishes-agent.js";
import { AGENT_URL, type SdkAgent } from "./support/sdk-agent.js";

const REVIEW = "file-review-workflow-start";
const REVIEWED = "file-review-workflow-finish";
const RETURNED = "file-returned-workflow-finish";

/** A DTO that takes both finishes of the review: every field optional. */
class AnyReviewDto {
  @Nested(A2AFileDto, { prompt: "the report", optional: true })
  report?: A2AFileDto;

  @Text({ prompt: "the verdict", optional: true })
  verdict?: string;

  @Nested(A2AFileDto, { prompt: "the document", optional: true })
  file?: A2AFileDto;
}

const test = testWith(FilesApplication);

/** What the card check of a review client with `output` and `finishes` gives. */
async function cardCheckOf(
  url: string,
  output: DtoClass,
  finishes?: readonly string[],
): Promise<unknown> {
  const client = new A2AClient({
    url,
    fetcher: fetchAs("dana"),
    contract: { skill: REVIEW, input: ReviewRequestDto, output, finishes },
  });
  return client.agentCard().then(
    () => "accepted",
    (error: unknown) => error,
  );
}

const serve = { expose: FilesA2AExpose, callerResolver: BearerCallerResolver };

describe("#916 item 3: the card check of a client's output against its skill's finishes", () => {
  test("AC3.1 by default every finish: a DTO of one finish is [a2a.schema-mismatch] naming the other", async ({
    a2aServer,
  }) => {
    const refused = await cardCheckOf((await a2aServer(serve)).url, ReviewResultDto);

    expect(refused).toBeInstanceOf(A2AContractError);
    expect((refused as A2AContractError).rule).toBe(A2AContractRule.SchemaMismatch);
    expect((refused as A2AContractError).differences.join("; ")).toContain(`output (${RETURNED})`);
  });

  test("AC3.2 by default a DTO that takes every finish is accepted", async ({ a2aServer }) => {
    expect(await cardCheckOf((await a2aServer(serve)).url, AnyReviewDto)).toBe("accepted");
  });

  test("AC3.3 target.finishes narrows the check: the one finish the DTO takes is accepted", async ({
    a2aServer,
  }) => {
    expect(await cardCheckOf((await a2aServer(serve)).url, ReviewResultDto, [REVIEWED])).toBe(
      "accepted",
    );
  });

  test("AC3.4 a finish the skill does not have: [a2a.unknown-finish], nothing sent", async ({
    a2aServer,
  }) => {
    const refused = await cardCheckOf((await a2aServer(serve)).url, ReviewResultDto, [
      "refund-workflow-finish",
    ]);

    expect((refused as A2AContractError).rule).toBe(A2AContractRule.UnknownFinish);
    expect((refused as A2AContractError).message).toMatch(
      /^\[a2a\.unknown-finish\] .*refund-workflow-finish is not a finish of the skill \(its finishes: file-review-workflow-finish, file-returned-workflow-finish\)/,
    );
  });

  test("AC3.5 a narrowed client gets its finish's output from a real AGBoss agent", async ({
    a2aServer,
  }) => {
    const client = new A2AClient<ReviewRequestDto, ReviewResultDto>({
      url: (await a2aServer(serve)).url,
      fetcher: fetchAs("dana"),
      contract: {
        skill: REVIEW,
        input: ReviewRequestDto,
        output: ReviewResultDto,
        finishes: [REVIEWED],
      },
    });
    const document = A2AClientFile.fromBytes(PDF, { mediaType: "application/pdf" });

    expect(await client.execute({ document, note: "please" })).toMatchObject({ verdict: "ok" });
  });
});

const askerOf = (agent: SdkAgent, finishes?: readonly string[]) =>
  new A2AClient<WorkflowStartTextDto, AnswerDto>({
    url: AGENT_URL,
    fetcher: agent.fetcher,
    contract: { input: WorkflowStartTextDto, output: AnswerDto, finishes },
  });

describe("#916 item 3: a task that ends at a finish the client does not take", () => {
  it("AC3.6 A2AUnexpectedFinishError naming the finish, the agent and what it takes", async () => {
    const agent = agentEndingAt("hand-over-workflow-finish");

    const failed = await askerOf(agent, ["answer-workflow-finish"])
      .execute({ text: "hi" })
      .catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(A2AUnexpectedFinishError);
    expect(failed).toMatchObject({
      code: "a2a.unexpected-finish",
      finish: "hand-over-workflow-finish",
      finishes: ["answer-workflow-finish"],
    });
  });

  it("AC3.7 at a finish it takes, or with no list (every finish), the output is read", async () => {
    const agent = agentEndingAt("hand-over-workflow-finish");

    expect(await askerOf(agent).execute({ text: "hi" })).toEqual({ text: "hello" });
    expect(
      await askerOf(agentEndingAt("answer-workflow-finish"), ["answer-workflow-finish"]).execute({
        text: "hi",
      }),
    ).toEqual({ text: "hello" });
  });
});
