import { describe, expect } from "vitest";
import { replyWith, testWith } from "../../../src/testing/index.js";
import {
  ArticleDraftWorkflowFinish,
  ArticleWriterAgent,
  CriticAgent,
  PlannerAgent,
  PlanResearcherAgent,
  ResearchWorkflowStart,
} from "../fixtures/launch.fixture.js";
import { ArticleDraftDto } from "../fixtures/launch-dtos.js";
import { CritiqueDto, PlanDto, ResearchDto } from "../fixtures/review-dtos.js";
import { ResearchApplication } from "./fixtures/launch.applications.js";

const research = testWith(ResearchApplication);

describe("AC1: different agents, a repeated one", () => {
  research("repeated agent — two copies, listOf after join, copy ids", async ({ app, mockLlm }) => {
    mockLlm(PlannerAgent).thenReturn(replyWith(PlanDto, { outline: "intro, body" }));
    mockLlm(PlanResearcherAgent).thenReturn(replyWith(ResearchDto, { facts: "three facts" }));
    mockLlm(CriticAgent).thenReturn(
      replyWith(CritiqueDto, { remark: "too long" }),
      replyWith(CritiqueDto, { remark: "no sources" }),
    );
    mockLlm(ArticleWriterAgent).thenReturn(replyWith(ArticleDraftDto, { text: "the article" }));

    const result = await app.execute(ResearchWorkflowStart, { text: "write about tea" });

    expect(result.path).toEqual([
      "research-workflow-start",
      "planner-agent",
      "plan-researcher-agent",
      "critic-agent#1",
      "critic-agent#2",
      "article-writer-agent",
      "article-draft-workflow-finish",
    ]);
    expect(result).toFinishWith(ArticleDraftWorkflowFinish, { text: "the article" });
    expect(mockLlm(ArticleWriterAgent).requests[0]?.input).toContain("too long");
  });
});
