/** #118 AC5 / #141: the 17 standard DTOs accept their examples and reject cross-field violations. */
import { describe, expect, it } from "vitest";
import {
  AddressDto,
  AttachmentDto,
  ContactInfoDto,
  DateRangeDto,
  DateTimeRangeDto,
  type DtoClass,
  MoneyDto,
  NoInputDto,
  PersonNameDto,
  PlainTextDto,
  RagSearchResultDto,
  RagSourceReferenceDto,
  ToolCallApprovalAskDto,
  ToolCallApprovalDecisionDto,
  WorkflowFinishTextDto,
  WorkflowPauseAnswerDto,
  WorkflowPauseQuestionDto,
  WorkflowStartTextDto,
} from "../../src/dto/index.js";
import { jsonSchemaOf, validate } from "../../src/dto/schema.js";

const examples: readonly (readonly [DtoClass, object])[] = [
  [WorkflowStartTextDto, { text: "find TypeScript jobs", author: "pavel" }],
  [WorkflowFinishTextDto, { text: "Done." }],
  [WorkflowPauseQuestionDto, { question: "Which city?", options: ["Tel Aviv", "Haifa"] }],
  [WorkflowPauseAnswerDto, { replyWith: "Haifa" }],
  [
    ToolCallApprovalAskDto,
    {
      callId: "call_1",
      tool: "save-shortlist-tool",
      arguments: { jobs: [{ title: "Engineer" }] },
      summary: "Adds one job to the shortlist",
    },
  ],
  [ToolCallApprovalDecisionDto, { approved: true, overrideArguments: { userId: "456" } }],
  [NoInputDto, {}],
  [RagSearchResultDto, { text: "Remote friendly", source: "notes/acme.md", score: 0.82 }],
  [MoneyDto, { amount: "19.99", currency: "USD" }],
  [DateRangeDto, { from: "2026-09-01", to: "2026-09-30", timeZone: "Asia/Jerusalem" }],
  [DateTimeRangeDto, { from: "2026-09-01T09:00:00+03:00", to: "2026-09-01T18:00:00+03:00" }],
  [AttachmentDto, { name: "invoice.pdf", mediaType: "application/pdf", url: "https://x.io/i.pdf" }],
  [AddressDto, { street: "Herzl 1", city: "Haifa", country: "IL" }],
  [PersonNameDto, { given: "Pavel" }],
  [ContactInfoDto, { phone: "+972521234567" }],
  [RagSourceReferenceDto, { title: "Acme notes", quote: "Remote friendly" }],
  [PlainTextDto, { text: "3 jobs saved" }],
];

const rejects = (dto: DtoClass, raw: object): boolean => {
  try {
    validate(dto, raw);
    return false;
  } catch {
    return true;
  }
};

describe("standard DTOs (#118)", () => {
  it("AC5: all 17 accept their example as is", () => {
    expect(examples).toHaveLength(17);
    for (const [dto, example] of examples) expect(validate(dto, example)).toEqual(example);
  });

  it("AC5: every field of every standard DTO has a prompt the model reads (NoInputDto has none)", () => {
    for (const [dto] of examples) {
      const properties = Object.values(jsonSchemaOf(dto).properties as Record<string, object>);
      for (const property of properties) expect(property).toHaveProperty("description");
    }
  });

  it("AC5: MoneyDto keeps at most two digits after the point and an upper-case ISO 4217 code", () => {
    expect(rejects(MoneyDto, { amount: "19.999", currency: "USD" })).toBe(true);
    expect(rejects(MoneyDto, { amount: "19.99", currency: "usd" })).toBe(true);
  });

  it("AC5: DateRangeDto — the same day on both ends passes; the last day before the first does not", () => {
    expect(rejects(DateRangeDto, { from: "2026-09-01", to: "2026-09-01" })).toBe(false);
    expect(() => validate(DateRangeDto, { from: "2026-09-02", to: "2026-09-01" })).toThrow(
      /to: the last day is before the first/,
    );
  });

  it("AC5: DateTimeRangeDto compares moments across offsets; equal ends fail (end excluded)", () => {
    const from = "2026-09-01T10:00:00+03:00"; // 07:00Z
    expect(rejects(DateTimeRangeDto, { from, to: "2026-09-01T09:00:00Z" })).toBe(false);
    expect(rejects(DateTimeRangeDto, { from, to: "2026-09-01T07:00:00Z" })).toBe(true);
    expect(rejects(DateTimeRangeDto, { from, to: "2026-09-01T06:00:00Z" })).toBe(true);
    expect(rejects(DateTimeRangeDto, { from: "2026-09-01T10:00", to: "2026-09-01T11:00" })).toBe(
      true,
    );
  });

  it("AC5: AttachmentDto needs exactly one of url and content", () => {
    const file = { name: "a.txt", mediaType: "text/plain" };
    expect(rejects(AttachmentDto, { ...file, content: "aGk=" })).toBe(false);
    expect(rejects(AttachmentDto, { ...file, url: "https://x.io/a", content: "aGk=" })).toBe(true);
    expect(rejects(AttachmentDto, file)).toBe(true);
  });

  it("AC5: ContactInfoDto needs an email, a phone or both", () => {
    expect(rejects(ContactInfoDto, { email: "a@b.io" })).toBe(false);
    expect(() => validate(ContactInfoDto, {})).toThrow(/email: give an email, a phone or both/);
  });

  it("AC5: RagSearchResultDto.score is from 0 to 1; WorkflowPauseQuestionDto has at most 6 options; RagSourceReferenceDto.quote ≤ 300", () => {
    expect(rejects(RagSearchResultDto, { text: "t", source: "s", score: 1.2 })).toBe(true);
    expect(
      rejects(WorkflowPauseQuestionDto, {
        question: "q",
        options: ["1", "2", "3", "4", "5", "6", "7"],
      }),
    ).toBe(true);
    expect(rejects(RagSourceReferenceDto, { title: "t", quote: "x".repeat(301) })).toBe(true);
    expect(rejects(WorkflowStartTextDto, { text: "" })).toBe(true);
  });

  it("AC5: ToolCallApprovalAskDto.arguments is any JSON object — not a string", () => {
    const request = { callId: "c", tool: "t", summary: "s" };
    expect(rejects(ToolCallApprovalAskDto, { ...request, arguments: {} })).toBe(false);
    expect(rejects(ToolCallApprovalAskDto, { ...request, arguments: "x" })).toBe(true);
  });
});

describe("#141 AC3: standard DTOs named by the hierarchy rule", () => {
  it("names start with their component kind; nothing says chat, user or person", () => {
    const names = examples.map(([dto]) => dto.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "WorkflowStartTextDto",
        "WorkflowFinishTextDto",
        "WorkflowPauseQuestionDto",
        "WorkflowPauseAnswerDto",
        "ToolCallApprovalAskDto",
        "ToolCallApprovalDecisionDto",
        "RagSearchResultDto",
        "RagSourceReferenceDto",
        "PlainTextDto",
      ]),
    );
    const prompts = JSON.stringify(examples.map(([dto]) => jsonSchemaOf(dto)));
    expect(prompts).not.toMatch(/\b(chat|user|person)\b/i);
  });

  it("RagSearchResultDto is valid without a score", () => {
    expect(rejects(RagSearchResultDto, { text: "Remote friendly", source: "notes/acme.md" })).toBe(
      false,
    );
  });

  it("#267: ToolCallApprovalDecisionDto takes a reason; overrideArguments only with approved: true", () => {
    const refusal = { approved: false, reason: "outside the change window" };
    expect(validate(ToolCallApprovalDecisionDto, refusal)).toEqual(refusal);
    expect(rejects(ToolCallApprovalDecisionDto, { approved: true })).toBe(false);
    const overriding = { approved: false, overrideArguments: { userId: "456" } };
    expect(rejects(ToolCallApprovalDecisionDto, overriding)).toBe(true);
  });

  it("PlainTextDto needs its text", () => {
    expect(rejects(PlainTextDto, {})).toBe(true);
  });
});
