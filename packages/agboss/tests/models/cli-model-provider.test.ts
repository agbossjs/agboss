import { describe, expect, it } from "vitest";
import { ModelCallError } from "../../src/models/circuit-breaker.js";
import { CliModelProvider, type CliInvocation } from "../../src/models/cli-model-provider.js";
import { ModelFailure } from "../../src/models/model-failure.js";
import { PromptCaching } from "../../src/models/prompt-caching.js";
import { Reasoning } from "../../src/models/reasoning.js";
import { ModelProviderFailureError } from "../../src/models/transport/failure-error.js";
import type { ModelProviderRequest } from "../../src/models/transport/transport.js";

/** #1313g: a model served by a command-line tool, run as a process group that ends with the call. */

const requestOf = (signal = new AbortController().signal): ModelProviderRequest => ({
  model: "cli/model",
  messages: [],
  tools: [],
  temperature: 0,
  maxTokens: undefined,
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
  signal,
});

const node = (script: string, extra: Partial<CliInvocation> = {}): CliInvocation => ({
  command: process.execPath,
  args: ["-e", script],
  ...extra,
});

class Cli extends CliModelProvider {
  constructor(private readonly run: CliInvocation) {
    super();
  }
  protected override invocationOf(): CliInvocation {
    return this.run;
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("#1313g: CliModelProvider", () => {
  it("complete: the process's stdout is the answer, its stdin the request's", async () => {
    const cli = new Cli(node("process.stdin.pipe(process.stdout)", { stdin: "hello" }));

    const answer = await cli.complete(requestOf());

    expect(answer.text).toBe("hello");
    expect(answer.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it("stream: the text of each line as it comes", async () => {
    const cli = new Cli(node("console.log('a'); console.log('b')"));

    const pieces: string[] = [];
    for await (const piece of cli.stream(requestOf()).textStream) pieces.push(piece);

    expect(pieces).toEqual(["a\n", "b\n"]);
  });

  it("a non-zero exit is the provider's failure (a server error), with the CLI's stderr", async () => {
    const cli = new Cli(node("console.error('boom'); process.exit(3)"));

    const failed = await cli.complete(requestOf()).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(ModelProviderFailureError);
    expect((failed as ModelProviderFailureError).failure).toBe(ModelFailure.ServerError);
    expect(String((failed as Error).cause)).toContain("boom");
  });

  it("a command that cannot start is a ModelCallError, model.cli-failed", async () => {
    const cli = new Cli({ command: "/no/such/command", args: [] });

    const failed = await cli.complete(requestOf()).catch((error: unknown) => error);

    expect(failed).toBeInstanceOf(ModelCallError);
    expect((failed as ModelCallError).code).toBe("model.cli-failed");
  });

  it("a cancel kills the process and its children: nothing outlives the call", async () => {
    const script =
      "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'});" +
      "console.log(c.pid); setInterval(()=>{},1000)";
    const controller = new AbortController();
    const cli = new Cli(node(script));
    const stream = cli.stream(requestOf(controller.signal));
    const iterator = stream.textStream[Symbol.asyncIterator]();

    const first = await iterator.next();
    const grandchild = Number(String(first.value).trim());
    expect(alive(grandchild)).toBe(true);
    controller.abort(new Error("cancelled"));
    await iterator.next().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(alive(grandchild)).toBe(false);
  });

  it("parseStreamLine can refuse the call fail-closed from the CLI's first frame", async () => {
    class Strict extends Cli {
      protected override parseStreamLine(line: string): string | undefined {
        if (line === "init:unsafe")
          throw new ModelCallError({
            code: "model.cli-failed",
            provider: "cli",
            message: "unsafe",
          });
        return line;
      }
    }
    const cli = new Strict(node("console.log('init:unsafe'); console.log('text')"));

    const read = async (): Promise<void> => {
      for await (const piece of cli.stream(requestOf()).textStream) expect(piece).toBeDefined();
    };

    await expect(read()).rejects.toThrow(ModelCallError);
  });

  it("onInit runs verifyStartup, and its failure refuses the start", async () => {
    class Checked extends Cli {
      override verifyStartup(): void {
        throw new Error("cli not installed");
      }
    }

    await expect(new Checked(node("")).onInit()).rejects.toThrow("cli not installed");
  });
});
