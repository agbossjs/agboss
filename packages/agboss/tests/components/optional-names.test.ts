/**
 * #1343a: the `name` of a non-persisted component is optional — it is the class name in kebab-case
 * when left out — and so is its `description`; a `-kind` suffix is not asked for. Persisted components
 * (`@Workflow`, `@Agent`, …) keep a required name that ends with its kind.
 */
import { describe, expect, it } from "vitest";
import {
  Arbiter,
  Agent,
  DecidedBy,
  HealthCheck,
  HealthCheckResult,
  InputGuardrail,
  Judge,
  JudgeVerdict,
  PauseListener,
  PiiKind,
  PiiPolicy,
  ToolCallDecision,
  ToolInterceptor,
  WorkingCalendar,
  secret,
  type Class,
} from "../../src/index.js";
import { arbiterOf } from "../../src/flow/decorators/arbiter.js";
import { ReplyInterpreter, replyInterpreterOf } from "../../src/channels/channel-role.decorator.js";
import { componentOf } from "../../src/components/metadata.js";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { guardrailMetaOf } from "../../src/components/policy-decorators.js";
import { healthCheckOf } from "../../src/health/health-check.js";
import { ModelCost, ModelProvider, RetryPolicy } from "../../src/models/index.js";
import { modelProviderOf } from "../../src/models/model-provider.decorator.js";
import { pauseListenerOf } from "../../src/pause/pause-listener.js";
import { piiPolicyMetaOf } from "../../src/pii/policy-checks.js";
import { RagReranker } from "../../src/rag/reranker.decorator.js";
import { toolInterceptorMetaOf } from "../../src/tool-interceptors/decorator.js";
import { workingCalendarOf } from "../../src/calendar/working-calendar.js";
import { minutes, seconds } from "../../src/units/index.js";

@HealthCheck({ timeout: seconds(1) })
class CrmHealthCheck {
  check() {
    return Promise.resolve(HealthCheckResult.healthy());
  }
}

@PauseListener({})
class BackofficeListener {
  onPauseOpened = (): Promise<void> => Promise.resolve();
  onPauseClosed = (): Promise<void> => Promise.resolve();
}

@WorkingCalendar({})
class TenantHolidays {
  addWorkingTime(): Date {
    return new Date(0);
  }
}

@ToolInterceptor({})
class TenantScope {
  beforeAnyTool() {
    return ToolCallDecision.allow();
  }
}

@InputGuardrail({ prompt: "Is it rude?", model: "test/gr", threshold: 0.5, refusal: "No." })
class RudeWords {}

@PiiPolicy({
  rules: [PiiKind.Email.mask()],
  secret: secret("PII_KEY"),
})
class ContactDetails {}

@Arbiter({ decidedBy: DecidedBy.Code })
class GoodScore {}

@ReplyInterpreter({ decidedBy: DecidedBy.Model, model: "test/reader" })
class RefundReader {}

@RagReranker({ candidates: 5, model: "test/rerank" })
class DocsRanker {}

@ModelProvider({
  serves: [/^bedrock\//],
  timeout: seconds(5),
  cost: ModelCost.fromResponse(),
  retryPolicy: RetryPolicy.none(),
  circuitBreakerPolicy: { failureThreshold: 1, window: minutes(1), openFor: minutes(1) },
})
class AwsBedrock {
  complete() {
    return Promise.reject(new Error("never called"));
  }
}

@Judge({ output: WorkflowStartTextDto })
class FairAnswer {
  judge() {
    return Promise.resolve(JudgeVerdict.passed());
  }
}

const nameOfKind = (cls: Class, kind: "reranker" | "judge"): string | undefined => {
  const component = componentOf(cls);
  return component?.kind === kind ? component.meta.name : undefined;
};

describe("#1343a: a name left out is the class name in kebab-case", () => {
  it.each([
    ["@HealthCheck", healthCheckOf(CrmHealthCheck)?.name, "crm-health-check"],
    ["@PauseListener", pauseListenerOf(BackofficeListener)?.name, "backoffice-listener"],
    ["@WorkingCalendar", workingCalendarOf(TenantHolidays)?.name, "tenant-holidays"],
    ["@ToolInterceptor", toolInterceptorMetaOf(TenantScope)?.name, "tenant-scope"],
    ["@InputGuardrail", guardrailMetaOf(RudeWords)?.name, "rude-words"],
    ["@PiiPolicy", piiPolicyMetaOf(ContactDetails)?.name, "contact-details"],
    ["@Arbiter", arbiterOf(GoodScore)?.options.name, "good-score"],
    ["@ReplyInterpreter", replyInterpreterOf(RefundReader)?.options.name, "refund-reader"],
    ["@RagReranker", nameOfKind(DocsRanker, "reranker"), "docs-ranker"],
    ["@ModelProvider", modelProviderOf(AwsBedrock).name, "aws-bedrock"],
    ["@Judge", nameOfKind(FairAnswer, "judge"), "fair-answer"],
  ])("%s", (_decorator, recorded, expected) => {
    expect(recorded).toBe(expected);
  });

  it("a given name wins over the class name", () => {
    @HealthCheck({ name: "crm", timeout: seconds(1) })
    class CrmProbe extends CrmHealthCheck {}

    expect(healthCheckOf(CrmProbe)?.name).toBe("crm");
  });

  it("a description is optional and recorded when given", () => {
    @HealthCheck({ description: "The CRM answers", timeout: seconds(1) })
    class DescribedCheck extends CrmHealthCheck {}

    expect(healthCheckOf(DescribedCheck)?.description).toBe("The CRM answers");
    expect(healthCheckOf(CrmHealthCheck)).not.toHaveProperty("description");
  });
});
