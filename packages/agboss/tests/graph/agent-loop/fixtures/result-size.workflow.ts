import {
  Agent,
  Injectable,
  RagMode,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ToolHandler,
} from "../../../../src/index.js";
import { Rag } from "../../../../src/components/decorators.js";
import type { OnToolEnd } from "../../../../src/core/observer-hooks.js";
import type { ToolEndEvent } from "../../../../src/core/observability.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../../src/dto/index.js";
import { Application } from "../../../../src/application/application.js";
import { EmptyEnvironment } from "../../../../src/index.js";
import {
  PiiAction,
  PiiPolicy,
  type PiiMatch,
  type PiiPolicyHandler,
} from "../../../../src/pii/index.js";
import type { RagRetrieval } from "../../../../src/rag/types.js";
import { kilobytes } from "../../../../src/units/index.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { start } from "../../../helpers/flow.js";

/** What the observer saw of each tool call, and every text the PII detector read (tests reset both). */
export const toolEnds: ToolEndEvent[] = [];
export const piiReads: string[] = [];

/** The pages, notes and passages the tools and the knowledge base return (the tests mock them). */
@Injectable()
export class PageReader {
  textOf(url: string): Promise<string> {
    return Promise.resolve(`the page ${url}`);
  }
}

export class PageQuery {
  @Text({ prompt: "the page's URL" })
  url!: string;
}

export class PageContent {
  @Text()
  text!: string;
}

/** A tool whose pages may be long: its own bound wins over `defaults.tools`. */
@Tool({
  name: "fetch-page-tool",
  description: "Fetches a web page as text",
  input: PageQuery,
  output: PageContent,
  maxResultSize: kilobytes(256),
  deps: [PageReader],
})
export class FetchPageTool implements ToolHandler<PageQuery, PageContent> {
  constructor(private readonly pageReader: PageReader) {}

  async run({ url }: PageQuery): Promise<PageContent> {
    return { text: await this.pageReader.textOf(url) };
  }
}

/** A tool without its own bound: the workflow's, else the built-in 128 KB. */
@Tool({
  name: "read-notes-tool",
  description: "Reads the notes of a page",
  input: PageQuery,
  output: PageContent,
  deps: [PageReader],
})
export class ReadNotesTool implements ToolHandler<PageQuery, PageContent> {
  constructor(private readonly pageReader: PageReader) {}

  async run({ url }: PageQuery): Promise<PageContent> {
    return { text: await this.pageReader.textOf(url) };
  }
}

/** A tool that fails with a long message: the model reads its error, bounded too. */
@Tool({
  name: "broken-page-tool",
  description: "Fails",
  input: PageQuery,
  output: PageContent,
  deps: [PageReader],
})
export class BrokenPageTool implements ToolHandler<PageQuery, PageContent> {
  constructor(private readonly pageReader: PageReader) {}

  async run({ url }: PageQuery): Promise<PageContent> {
    throw new Error(await this.pageReader.textOf(url));
  }
}

/** A knowledge base in context mode: its block is bounded by the agent's `maxResultSize`. */
@Rag({ name: "pages-rag", description: "Pages", topK: 1, deps: [PageReader] })
export class PagesRag {
  constructor(private readonly pageReader: PageReader) {}

  async retrieve(query: string): Promise<RagRetrieval> {
    return { results: [{ text: await this.pageReader.textOf(query), source: "pages.md" }] };
  }
}

/** A project detector that records what it reads: masking must read only the kept part. */
@PiiPolicy({ name: "recording-pii-policy", action: PiiAction.replaceWithKind() })
export class RecordingPiiPolicy implements PiiPolicyHandler {
  findMatches(text: string): readonly PiiMatch[] {
    piiReads.push(text);
    return [];
  }
}

@Injectable()
export class ToolEndLog implements OnToolEnd {
  onToolEnd(event: ToolEndEvent): void {
    toolEnds.push(event);
  }
}

@Agent({
  name: "research-agent",
  description: "Reads pages",
  prompt: "Read the pages you are asked about.",
  model: "test/research",
  tools: [FetchPageTool, ReadNotesTool, BrokenPageTool],
})
export class ResearchAgent {}

@Agent({
  name: "context-agent",
  description: "Answers from the pages",
  prompt: "Answer from the pages.",
  model: "test/research",
  rag: [{ use: PagesRag, mode: RagMode.Context }],
})
export class ContextAgent {}

@WorkflowStart({
  name: "page-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class PageStart {}

@WorkflowStart({
  name: "context-workflow-start",
  description: "A question",
  input: WorkflowStartTextDto,
})
export class ContextStart {}

@WorkflowFinish({
  name: "page-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class PageFinish {}

@Workflow({
  name: "page-workflow",
  version: "1.0.0",
  flow: [
    start(PageStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ResearchAgent)
      .toFinish(PageFinish),
    start(ContextStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ContextAgent)
      .toFinish(PageFinish),
  ],
  providers: [PageReader],
})
export class PageWorkflow {}

/** No bound set anywhere: every tool without its own reads the built-in 128 KB. */
@Application({
  name: "page-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PageWorkflow],
  budgets: TEST_BUDGETS,
  observers: [ToolEndLog],
  piiPolicies: [RecordingPiiPolicy],
})
export class PageApplication {}

/** One bound for every tool result a model reads, from the application. */
@Application({
  name: "bounded-page-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PageWorkflow],
  budgets: TEST_BUDGETS,
  defaults: { tools: { maxResultSize: kilobytes(64) } },
})
export class BoundedPageApplication {}

/** A tool whose own bound is not a whole number of bytes from 1. */
@Tool({
  name: "zero-bound-tool",
  description: "Bound to nothing",
  input: PageQuery,
  output: PageContent,
  maxResultSize: kilobytes(0),
})
export class ZeroBoundTool implements ToolHandler<PageQuery, PageContent> {
  run({ url }: PageQuery): Promise<PageContent> {
    return Promise.resolve({ text: url });
  }
}

@Agent({
  name: "zero-bound-agent",
  description: "Uses the zero-bound tool",
  prompt: "Use the tool.",
  model: "test/research",
  tools: [ZeroBoundTool],
})
export class ZeroBoundAgent {}

@WorkflowStart({
  name: "zero-bound-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class ZeroBoundStart {}

@Workflow({
  name: "zero-bound-workflow",
  version: "1.0.0",
  flow: [
    start(ZeroBoundStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ZeroBoundAgent)
      .toFinish(PageFinish),
  ],
  defaults: { tools: { maxResultSize: kilobytes(0.1) } },
})
export class ZeroBoundWorkflow {}

/** Both bounds invalid: the tool's own and the workflow's `defaults.tools`, reported at once. */
@Application({
  name: "zero-bound-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ZeroBoundWorkflow],
  budgets: TEST_BUDGETS,
})
export class ZeroBoundApplication {}
