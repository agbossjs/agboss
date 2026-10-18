import { describe, expect } from "vitest";
import { ExecutionStatus } from "../../../src/app/types.js";
import { replyWith, routeTo, testWith } from "../../../src/testing/index.js";
import {
  AskResumeWorkflowFinish,
  ChatWorkflowFinish,
  IntakeWorkflowStart,
  MainRouter,
  ProfilerAgent,
  ScoutAgent,
  ChatApplication,
} from "../fixtures/chat.fixture.js";
import { OpeningsDto, ProfileDto, ResumeMissingDto } from "../fixtures/dtos.js";

const test = testWith(ChatApplication);

describe("#272 example 1: a router in a loop", () => {
  test("the profiler's profile goes back to the router, the scout's openings finish", async ({
    app,
    mockLlm,
  }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ProfilerAgent), routeTo(ScoutAgent));
    mockLlm(ProfilerAgent).thenReturn(replyWith(ProfileDto, { summary: "TS backend" }));
    mockLlm(ScoutAgent).thenReturn(replyWith(OpeningsDto, { openings: "3 roles" }));

    const result = await app.execute(IntakeWorkflowStart, { text: "my resume …" });

    expect(result).toFollowPath([
      IntakeWorkflowStart,
      MainRouter,
      ProfilerAgent,
      MainRouter,
      ScoutAgent,
      ChatWorkflowFinish,
    ]);
    expect(result.status).toBe(ExecutionStatus.Finished);
    expect(result).toFinishWith(ChatWorkflowFinish, { openings: "3 roles" });
  });

  test("a missing resume is a case that finishes", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ProfilerAgent));
    mockLlm(ProfilerAgent).thenReturn(replyWith(ResumeMissingDto, { reason: "no file" }));

    const result = await app.execute(IntakeWorkflowStart, { text: "hi" });

    expect(result).toFinishWith(AskResumeWorkflowFinish, { reason: "no file" });
    expect(mockLlm(ScoutAgent).requests).toHaveLength(0);
  });

  test("the scout reads the profile in its input message", async ({ app, mockLlm }) => {
    mockLlm(MainRouter).thenReturn(routeTo(ProfilerAgent), routeTo(ScoutAgent));
    mockLlm(ProfilerAgent).thenReturn(replyWith(ProfileDto, { summary: "TS backend" }));
    mockLlm(ScoutAgent).thenReturn(replyWith(OpeningsDto, { openings: "3 roles" }));

    await app.execute(IntakeWorkflowStart, { text: "my resume …" });

    expect(mockLlm(ScoutAgent).onlyRequest.input).toBe(
      '### profile (from profiler-agent, ProfileDto)\n{\n  "summary": "TS backend"\n}',
    );
  });
});
