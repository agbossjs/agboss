import type { RunnableConfig } from "@langchain/core/runnables";
import type { PiiTokenMap } from "../../pii/tokens.js";
import type { DiscardReason, StreamStep } from "../types.js";
import type { RunStream } from "./run-stream.js";
import { Trimmer } from "./trim.js";
import { Unmasker } from "./unmask.js";

/**
 * What an agent's visit streams (#1006): one `AgentStream` per visit, one `AttemptStream` per model
 * call of it. Text goes to the sink at once, unless the agent has a blocking output check (a PII
 * policy with a block rule, an output guardrail): then it is held — never on the wire — until the
 * visit's checks passed (`release`), and a rejected attempt's text is dropped without a trace.
 */

/** Where a visit is: the step key without its attempt. */
export type StepSite = Omit<StreamStep, "attempt">;

/** The text of one model call, from its first token to its end or its retraction. */
export class AttemptStream {
  #emitted = false;
  #discarded = false;
  readonly #held: string[] = [];
  readonly #tokens: PiiTokenMap | undefined;
  #unmask: Unmasker | undefined;
  #trim = new Trimmer();

  /** `tokens`: the run's PII tokens, set when the agent's model reads through PII policies. */
  constructor(
    private readonly step: StreamStep,
    private readonly sink: RunStream,
    readonly isHeld: boolean,
    tokens: PiiTokenMap | undefined,
  ) {
    this.#tokens = tokens;
    this.#unmask = tokens === undefined ? undefined : new Unmasker(tokens);
  }

  /**
   * The model answers again from the start inside this call (a fallback, #1005): what reached the
   * consumer is retracted, what was held dropped, and the new text streams as this attempt's.
   */
  restart(reason: DiscardReason): void {
    this.discard(reason);
    this.#discarded = false;
    this.#emitted = false;
    this.#unmask = this.#tokens === undefined ? undefined : new Unmasker(this.#tokens);
    this.#trim = new Trimmer();
  }

  /** One token of the model's text, revealed and trimmed as the reply will be (#1007). */
  push(token: string): void {
    this.#show(this.#unmask?.push(token) ?? token);
  }

  /** The model call ended: what was held back for a possible token is text now. */
  end(): void {
    this.#show(this.#unmask?.end() ?? "");
    this.#trim.end();
  }

  #show(text: string): void {
    const shown = this.#trim.push(text);
    if (this.#discarded || shown === "") return;
    if (this.isHeld) {
      this.#held.push(shown);
      return;
    }
    this.#emitted = true;
    this.sink.emit({ kind: "textDelta", delta: shown, step: this.step });
  }

  /** Retracts the attempt: what reached the consumer is discarded, what was held is dropped. */
  discard(reason: DiscardReason): void {
    if (this.#discarded) return;
    this.#discarded = true;
    this.#held.length = 0;
    if (this.#emitted) this.sink.emit({ kind: "discarded", step: this.step, reason });
  }

  /** The held text, now that the visit's checks passed (a retracted attempt holds none). */
  release(): void {
    for (const token of this.#held.splice(0)) {
      this.#emitted = true;
      this.sink.emit({ kind: "textDelta", delta: token, step: this.step });
    }
  }
}

/** The stream of one agent visit. */
export class AgentStream {
  #last: AttemptStream | undefined;

  constructor(
    private readonly sink: RunStream,
    private readonly site: StepSite,
    private readonly isHeld: boolean,
  ) {}

  /** The next model call of the visit, `attempt` from 1. */
  begin(attempt: number, tokens?: PiiTokenMap): AttemptStream {
    const stream = new AttemptStream({ ...this.site, attempt }, this.sink, this.isHeld, tokens);
    this.#last = stream;
    return stream;
  }

  /** The latest attempt is rejected (a judge). */
  discardLast(reason: DiscardReason): void {
    this.#last?.discard(reason);
  }

  /** The visit ended in failure: what is still shown is retracted, what is held is dropped. */
  fail(): void {
    this.#last?.discard("failed");
  }

  /** The visit's checks passed: a held answer goes out now. */
  release(): void {
    this.#last?.release();
  }
}

/** The `configurable` key of the visit's stream: its loop's nodes read it, nothing else does. */
const AGENT_STREAM_KEY = "agentStream";

/** The config with the visit's stream: only the nodes of the agent's own loop hear it. */
export function withAgentStream(
  config: RunnableConfig | undefined,
  stream: AgentStream | undefined,
): RunnableConfig | undefined {
  if (stream === undefined) return config;
  return { ...config, configurable: { ...config?.configurable, [AGENT_STREAM_KEY]: stream } };
}

/** The visit's stream a loop node was given; `undefined` when nothing listens or outside a visit. */
export function agentStreamOf(config: RunnableConfig | undefined): AgentStream | undefined {
  const found: unknown = config?.configurable?.[AGENT_STREAM_KEY];
  return found instanceof AgentStream ? found : undefined;
}
