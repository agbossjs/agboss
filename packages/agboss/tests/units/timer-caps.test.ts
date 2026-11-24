/**
 * #1141: every timer-backed duration setting is refused above its documented maximum — never above
 * 2^31 − 1 ms, where Node fires the timer at once — and accepted at it. Each setting: cap + 1 refused
 * naming the field, the cap accepted.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { a2aHttpListener } from "../../src/a2a/a2a-http.js";
import { checkedCallTimeout } from "../../src/a2a/client/a2a-client-options.js";
import { Application } from "../../src/application/application.js";
import { applicationOf } from "../../src/application/assemble.js";
import { ComponentError } from "../../src/components/metadata.js";
import { testWith } from "../../src/testing/index.js";
import { toolExpiryViolations } from "../../src/components/tool-expiry-rules.js";
import { Text } from "../../src/dto/index.js";
import { countQuorumOf } from "../../src/flow/quorum-step.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { SystemClock } from "../../src/infrastructure/clock.js";
import { Idempotency } from "../../src/app/idempotency.js";
import { OutboundMasking } from "../../src/app/outbound-masking.js";
import { hours } from "../../src/units/index.js";
import { meshContextValuesOf } from "../../src/mesh/mesh-context-values.js";
import { EmptyEnvironment, HealthCheck, HealthCheckResult, Tool } from "../../src/index.js";
import {
  ModelCost,
  ModelProvider,
  OpenAiCompatibleProvider,
  PromptCaching,
  Reasoning,
  RetryPolicy,
  type NoRequestFields,
} from "../../src/models/index.js";
import { defineTool } from "../../src/tools/define-tool.js";
import { UnitError, minutes, seconds, usd, type Milliseconds } from "../../src/units/index.js";
import {
  MAX_DEADLINE,
  MAX_TIMEOUT,
  MAX_TIMER_DELAY,
  checkedTimer,
} from "../../src/units/timer-limits.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { ProbeWorkflow } from "../health/fixtures/health.application.js";
import { CircuitBreakerPolicy } from "../../src/models/circuit-breaker-policy.js";

const over = (max: Milliseconds): Milliseconds => (max + 1) as Milliseconds;

/** The `limits.timeout-invalid` messages an application's assembly gives (none → empty). */
async function timeoutProblemsOf(application: new () => object): Promise<string[]> {
  const error: unknown = await applicationOf(application).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (error === undefined) return [];
  if (!(error instanceof GraphRuleError)) throw error as Error;
  return error.violations
    .filter((one) => one.code === "limits.timeout-invalid")
    .map((one) => one.message);
}

function applicationWith(options: {
  readonly shutdownTimeout?: Milliseconds;
  readonly compensationTimeout?: Milliseconds;
  readonly healthChecks?: never[];
  readonly providers?: never[];
}): new () => object {
  class CappedApplication {
    readonly isCapped = true;
  }
  Application({
    name: "capped-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows: [ProbeWorkflow],
    budgets: TEST_BUDGETS,
    ...options,
  })(CappedApplication);
  return CappedApplication;
}

describe("#1141: the caps are under the timer's limit", () => {
  it("AC: MAX_TIMEOUT and MAX_DEADLINE fit a Node timer", () => {
    expect(MAX_TIMER_DELAY).toBe(2 ** 31 - 1);
    expect(MAX_TIMEOUT).toBeLessThanOrEqual(MAX_TIMER_DELAY);
    expect(MAX_DEADLINE).toBeLessThanOrEqual(MAX_TIMER_DELAY);
    expect(MAX_DEADLINE + 86_400_000).toBeGreaterThan(MAX_TIMER_DELAY);
  });

  it("refuses NaN and Infinity, names the field, accepts the cap", () => {
    expect(() => checkedTimer("x", Number.NaN, MAX_TIMEOUT)).toThrow(UnitError);
    expect(() => checkedTimer("x", Infinity, MAX_TIMEOUT)).toThrow(/x is Infinity ms/u);
    expect(checkedTimer("x", MAX_TIMEOUT, MAX_TIMEOUT)).toBe(MAX_TIMEOUT);
  });
});

const closing = testWith(applicationWith({}) as never);

describe("#1141: @Application timers", () => {
  closing(
    "close({ timeout }): cap + 1 rejects naming the field, the cap closes",
    async ({ app }) => {
      await app.ready();
      await expect(app.close({ timeout: over(MAX_TIMEOUT) })).rejects.toThrow(
        /close\(\{ timeout \}\) is 86400001 ms/u,
      );
      await expect(app.close({ timeout: MAX_TIMEOUT })).resolves.toBeUndefined();
    },
  );

  for (const field of ["shutdownTimeout", "compensationTimeout"] as const) {
    it(`${field}: cap + 1 refused naming the field, the cap accepted`, async () => {
      const refused = await timeoutProblemsOf(applicationWith({ [field]: over(MAX_TIMEOUT) }));
      expect(refused).toHaveLength(1);
      expect(refused[0]).toContain(`its ${field} is ${String(MAX_TIMEOUT + 1)} ms`);
      expect(await timeoutProblemsOf(applicationWith({ [field]: MAX_TIMEOUT }))).toEqual([]);
    });
  }

  it("Idempotency timeout: cap + 1 refused naming the field, the cap not refused as a timer", async () => {
    const idempotency = new Idempotency(
      {} as never,
      {} as never,
      new OutboundMasking({ requiresMask: false }),
      {} as never,
      {} as never,
    );
    const execute = () => "done";
    const refused = idempotency.runOnce({
      name: "charge",
      ttl: hours(24),
      timeout: over(MAX_TIMEOUT),
      execute,
    });
    await expect(refused).rejects.toThrow(/timeout is 86400001 ms/u);
    // the cap is a timer's: what refuses it now is the lease bound, not the timer cap
    const atCap = idempotency.runOnce({
      name: "charge",
      ttl: hours(24),
      timeout: MAX_TIMEOUT,
      execute,
    });
    await expect(atCap).rejects.toThrow(/not below the lease/u);
  });
});

@HealthCheck({ name: "long-health-check", timeout: over(MAX_TIMEOUT) })
class LongHealthCheck {
  check(): Promise<HealthCheckResult> {
    return Promise.resolve(HealthCheckResult.healthy());
  }
}

@HealthCheck({ name: "capped-health-check", timeout: MAX_TIMEOUT })
class CappedHealthCheck {
  check(): Promise<HealthCheckResult> {
    return Promise.resolve(HealthCheckResult.healthy());
  }
}

describe("#1141: @HealthCheck timeout", () => {
  it("cap + 1 refused naming the field, the cap accepted", async () => {
    const refused = await timeoutProblemsOf(
      applicationWith({ healthChecks: [LongHealthCheck] as never[] }),
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("timeout is 86400001 ms");
    expect(
      await timeoutProblemsOf(applicationWith({ healthChecks: [CappedHealthCheck] as never[] })),
    ).toEqual([]);
  });
});

function providerWith(timeout: Milliseconds): never {
  @ModelProvider({
    name: "wire-model-provider",
    description: "stub",
    serves: [/^wire\//],
    baseUrl: "http://wire.test/v1",
    timeout,
    cost: ModelCost.fromPrices({
      "wire/model": { inputPerMillion: usd(1), outputPerMillion: usd(1) },
    }),
    reasoning: Reasoning.off(),
    promptCaching: PromptCaching.off(),
    retryPolicy: RetryPolicy.none(),
    circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
      failureThreshold: 50,
      failureWindow: minutes(1),
      openDuration: seconds(30),
    }),
  })
  class WireModelProvider extends OpenAiCompatibleProvider {
    override readonly requestFields: NoRequestFields = {};
  }
  return WireModelProvider as never;
}

describe("#1141: @ModelProvider timeout", () => {
  it("cap + 1 refused naming the field, the cap accepted", async () => {
    const refused = await timeoutProblemsOf(
      applicationWith({ providers: [providerWith(over(MAX_TIMEOUT))] }),
    );
    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("timeout is 86400001 ms");
    expect(
      await timeoutProblemsOf(applicationWith({ providers: [providerWith(MAX_TIMEOUT)] })),
    ).toEqual([]);
  });
});

describe("#1141: RetryPolicy delays", () => {
  const retryOn = [] as const;
  it("exponential initialDelay and maxDelay", () => {
    const exponential = (initialDelay: number, maxDelay: number) => () =>
      RetryPolicy.exponential({
        maxAttempts: 2,
        initialDelay: initialDelay as Milliseconds,
        maxDelay: maxDelay as Milliseconds,
        jitter: false,
        retryOn,
      });
    expect(exponential(over(MAX_TIMEOUT), over(MAX_TIMEOUT))).toThrow(
      /initialDelay is 86400001 ms/u,
    );
    expect(exponential(1, over(MAX_TIMEOUT))).toThrow(/maxDelay is 86400001 ms/u);
    expect(exponential(MAX_TIMEOUT, MAX_TIMEOUT)).not.toThrow();
  });

  it("fixed delay", () => {
    const fixed = (delay: number) => () =>
      RetryPolicy.fixed({ maxAttempts: 2, delay: delay as Milliseconds, retryOn });
    expect(fixed(over(MAX_TIMEOUT))).toThrow(/delay is 86400001 ms/u);
    expect(fixed(MAX_TIMEOUT)).not.toThrow();
  });
});

class Query {
  @Text({ prompt: "q" })
  q!: string;
}

describe("#1141: a tool's timeout", () => {
  const definition = (timeout: Milliseconds) => ({
    name: "slow-tool",
    description: "d",
    input: z.object({}),
    output: z.object({}),
    timeout,
    run: () => Promise.resolve({}),
  });

  it("defineTool (and an MCP facade through it): cap + 1 refused naming the field, the cap accepted", () => {
    expect(() => defineTool(definition(over(MAX_TIMEOUT)))).toThrow(
      /slow-tool: timeout is 86400001 ms/u,
    );
    expect(() => defineTool(definition(MAX_TIMEOUT))).not.toThrow();
  });

  it("@Tool: [limits.timeout-invalid] at assembly", () => {
    const toolWith = (timeout: Milliseconds): never => {
      @Tool({ name: "slow-tool", description: "d", input: Query, output: Query, timeout })
      class SlowTool {
        execute(): Promise<Query> {
          return Promise.resolve(new Query());
        }
      }
      return SlowTool as never;
    };
    const refused = toolExpiryViolations({
      local: [toolWith(over(MAX_TIMEOUT))],
    });
    expect(refused.map((one) => one.code)).toEqual(["limits.timeout-invalid"]);
    expect(refused[0]?.message).toContain("timeout is 86400001 ms");
    expect(toolExpiryViolations({ local: [toolWith(MAX_TIMEOUT)] })).toEqual([]);
  });
});

describe("#1141: A2A", () => {
  const listener =
    (options: object): (() => unknown) =>
    () =>
      a2aHttpListener(
        {} as never,
        {
          ...options,
          expose: {},
          authenticator: {},
          publicUrl: "https://x.test",
        } as never,
      );

  it("maxTaskDuration: cap + 1 refused naming the field", () => {
    expect(listener({ maxTaskDuration: over(MAX_DEADLINE) })).toThrow(
      /\[a2a.timeout-invalid\].*maxTaskDuration is 2073600001 ms/u,
    );
  });

  it("a caps accepted: the listener's own checks go on (not the timeout's)", () => {
    for (const options of [{ maxTaskDuration: MAX_DEADLINE }])
      expect(listener(options)).not.toThrow(/timeout-invalid/u);
  });

  it("a client call's timeout: cap + 1 refused naming the field, the cap accepted", () => {
    expect(() => {
      checkedCallTimeout("peer-a2a-agent", over(MAX_TIMEOUT));
    }).toThrow(ComponentError);
    expect(() => {
      checkedCallTimeout("peer-a2a-agent", over(MAX_TIMEOUT));
    }).toThrow(/a call's timeout is 86400001 ms/u);
    expect(() => {
      checkedCallTimeout("peer-a2a-agent", MAX_TIMEOUT);
    }).not.toThrow();
  });
});

describe("#1141: deadlines", () => {
  it(".joinQuorum({ deadline }): cap + 1 refused naming the field, the cap accepted", () => {
    expect(() => countQuorumOf({ min: 1, deadline: over(MAX_DEADLINE) })).toThrow(
      /deadline is 2073600001 ms/u,
    );
    expect(countQuorumOf({ min: 1, deadline: MAX_DEADLINE }).deadline).toBe(MAX_DEADLINE);
  });

  it("execute({ deadline }): cap + 1 refused naming the field, the cap accepted", () => {
    const at = (deadline: Milliseconds) => () =>
      meshContextValuesOf({} as never, { deadline }, new Date(0));
    expect(at(over(MAX_DEADLINE))).toThrow(/deadline is 2073600001 ms/u);
    expect(at(MAX_DEADLINE)).not.toThrow();
  });
});

describe("#1141: the system clock waits out a delay a timer cannot take", () => {
  it("a delay above 2^31 − 1 ms is not fired at once and warns nothing", async () => {
    vi.useFakeTimers();
    try {
      const clock = new SystemClock();
      let isDone = false;
      void clock.sleep((MAX_TIMER_DELAY + 1000) as Milliseconds).then(() => {
        isDone = true;
      });
      await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY);
      expect(isDone).toBe(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(isDone).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
