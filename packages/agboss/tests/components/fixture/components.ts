import { file } from "../../../src/components/file.js";

import {
  Agent,
  Workflow,
  Injectable,
  InjectionToken,
  provide,
  ROUTER_FACTORY,
  Tool,
  type ToolHandler,
} from "../../../src/index.js";
import { McpServer, McpServerClient, McpTool } from "../../../src/mcp/index.js";
import { Text } from "../../../src/dto/index.js";
import type { RouterEngine } from "../../../src/routers/index.js";
import { testConfig, testDefaults } from "../../helpers.js";
import { starOf } from "../../fixtures/test-flow/star.js";
import { Reasoning, ReasoningEffort } from "../../../src/models/index.js";

export const GREETING = new InjectionToken<string>("GREETING");

@Injectable({ deps: [GREETING, ROUTER_FACTORY] })
export class Greeter {
  constructor(
    readonly greeting: string,
    readonly router: (name: string) => RouterEngine,
  ) {}
  greet(name: string): string {
    return `${this.greeting}, ${name}`;
  }
}

export class Person {
  @Text({ prompt: "who to greet" })
  name!: string;
}

export class Greeting {
  @Text()
  text!: string;
}

@Tool({
  name: "greet-tool",
  description: "Greets a person.",
  input: Person,
  output: Greeting,
  deps: [Greeter],
})
export class GreetTool implements ToolHandler<Person, Greeting> {
  constructor(private readonly greeter: Greeter) {}
  run(input: Person): Promise<Greeting> {
    return Promise.resolve({ text: this.greeter.greet(input.name) });
  }
}

class FileRead {
  @Text()
  path!: string;
}

class FileContent {
  @Text()
  text!: string;
}

const filesTools = { read: { input: FileRead, output: FileContent } };

@McpServer({
  name: "files",
  transport: "stdio",
  command: "files-server",
  tools: filesTools,
})
export class FilesServer extends McpServerClient<typeof filesTools> {}

@McpTool({
  server: FilesServer,
  name: "read-file-tool",
  description: "Read a file.",
  input: FileRead,
  output: FileContent,
  deps: [FilesServer],
})
export class ReadFile implements ToolHandler<FileRead, FileContent> {
  constructor(private readonly files: FilesServer) {}

  run(file: FileRead): Promise<FileContent> {
    return this.files.call("read", file);
  }
}

@Agent({
  name: "greeter-agent",
  description: "Greets people",
  model: "test/alpha",
  price: testConfig.agents.alpha.price,
  reasoning: Reasoning.on({ effort: ReasoningEffort.Low }),
  tools: [GreetTool, ReadFile],
  promptUrls: ["./greeter.prompt.md"],
  promptVariables: { language: "Hebrew" },
})
export class GreeterAgent {}

@Workflow({
  name: "greetings-workflow",
  version: "1.0.0",
  defaults: testDefaults,
  flow: starOf(GreeterAgent),
  mcp: [FilesServer],
  providers: [Greeter, provide(GREETING, "Shalom")],
})
export class Greetings {}
