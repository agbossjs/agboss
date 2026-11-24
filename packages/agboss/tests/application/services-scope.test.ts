/**
 * #1324a: `@Application({ services })` and `@Workflow({ services })` with `injectAs` ports. A
 * workflow's own services live in a container of that workflow; the application's singletons — its
 * rate-limit gate, the lease table, a service nobody rebinds — stay in the root container, one
 * instance for every workflow (a per-workflow clone would multiply every cap by the number of
 * workflows).
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { buildApplication } from "../../src/application/create-app.js";
import { Application } from "../../src/application/application.js";
import {
  Agent,
  Injectable,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type OnBeforeDestroy,
  type OnInit,
  type OnReady,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { RateLimitRepository } from "../../src/infrastructure/rate-limit.repository.js";
import { ExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { testDefaults } from "../helpers.js";
import { onStart } from "../helpers/flow.js";
import { EmptyEnvironment } from "../../src/index.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { ScriptBook } from "../../src/testing/script-book.js";

const events: string[] = [];

abstract class Notifier {
  abstract send(text: string): string;
}

@Injectable({ injectAs: Notifier })
class EmailNotifier implements OnInit {
  onInit(): void {
    events.push("EmailNotifier.onInit");
  }

  send(text: string): string {
    return `email:${text}`;
  }
}

@Injectable({ injectAs: Notifier })
class SmsNotifier implements OnInit, OnReady, OnBeforeDestroy {
  onInit(): void {
    events.push("SmsNotifier.onInit");
  }

  onReady(): void {
    events.push("SmsNotifier.onReady");
  }

  onBeforeDestroy(): void {
    events.push("SmsNotifier.onBeforeDestroy");
  }

  send(text: string): string {
    return `sms:${text}`;
  }
}

/** Reaches the port, so each workflow that binds it differently gets its own. */
@Injectable({ deps: [Notifier] })
class Alerts {
  constructor(readonly notifier: Notifier) {}
}

/** Reaches nothing a workflow binds: the application's one. */
@Injectable()
class DeskDirectory {}

@Injectable({ deps: [DeskDirectory] })
class DirectoryReader {
  constructor(readonly directory: DeskDirectory) {}
}

const workflowOver = (
  stem: string,
  services: readonly (typeof SmsNotifier | typeof EmailNotifier)[],
) => {
  @WorkflowStart({
    name: `${stem}-workflow-start`,
    description: "Start",
    input: WorkflowStartTextDto,
  })
  class Start {}
  @WorkflowFinish({
    name: `${stem}-workflow-finish`,
    description: "Done",
    output: WorkflowFinishTextDto,
  })
  class Finish {}
  @Agent({ name: `${stem}-agent`, description: "Answers", prompt: "Answer.", model: "test/alpha" })
  class Answerer {}
  @Workflow({
    name: `${stem}-workflow`,
    version: "1.0.0",
    defaults: testDefaults,
    flow: [onStart(Start).toAgent(Answerer).toFinish(Finish)],
    providers: [Alerts, DirectoryReader],
    services,
  })
  class Flow {}
  return Flow;
};

const applicationOver = (...workflows: ReturnType<typeof workflowOver>[]) => {
  @Application({
    name: "services-application",
    version: "1.0.0",
    environment: EmptyEnvironment,
    workflows,
    services: [EmailNotifier],
    budgets: TEST_BUDGETS,
  })
  class ServicesApplication {}
  return ServicesApplication;
};

/** The app of the workflow at `index`. */
const appAt = (built: Awaited<ReturnType<typeof build>>, index: number) => {
  const workflow = built.workflows[index];
  if (workflow === undefined) throw new Error(`no workflow at ${String(index)}`);
  return workflow.app;
};

const build = async (application: ReturnType<typeof applicationOver>) =>
  buildApplication(await applicationOf(application), {
    processEnv: {},
    gateway: createScriptedGateway(new ScriptBook()),
  });

describe("#1324a: workflow-scoped services over the application's", () => {
  it("a workflow's own implementation of a port serves that workflow; the others get the application's", async () => {
    const billing = workflowOver("billing", [SmsNotifier]);
    const support = workflowOver("support", []);
    const built = await build(applicationOver(billing, support));

    const billingAlerts = appAt(built, 0).resolve(Alerts);
    const supportAlerts = appAt(built, 1).resolve(Alerts);

    expect(billingAlerts.notifier.send("x")).toBe("sms:x");
    expect(supportAlerts.notifier.send("x")).toBe("email:x");
    expect(billingAlerts).not.toBe(supportAlerts);
    await built.app.close();
  });

  it("two workflows binding the port to different classes do not collide", async () => {
    const billing = workflowOver("billing", [SmsNotifier]);
    const support = workflowOver("support", [EmailNotifier]);
    const built = await build(applicationOver(billing, support));

    expect(appAt(built, 0).resolve(Notifier).send("x")).toBe("sms:x");
    expect(appAt(built, 1).resolve(Notifier).send("x")).toBe("email:x");
    await built.app.close();
  });

  it("pins the root container: the application's singletons are one instance for every workflow", async () => {
    const billing = workflowOver("billing", [SmsNotifier]);
    const support = workflowOver("support", []);
    const built = await build(applicationOver(billing, support));

    const [first, second] = [appAt(built, 0), appAt(built, 1)];
    // the rate-limit gate and the lease table: a per-workflow copy would multiply the caps
    expect(first.resolve(RateLimitRepository)).toBe(second.resolve(RateLimitRepository));
    expect(first.resolve(RateLimitRepository)).toBe(built.infrastructure.rateLimits);
    expect(first.resolve(ExecutionLeaseRepository)).toBe(second.resolve(ExecutionLeaseRepository));
    // a service that reaches nothing a workflow rebinds: the application's one
    expect(first.resolve(DeskDirectory)).toBe(second.resolve(DeskDirectory));
    expect(first.resolve(DirectoryReader).directory).toBe(
      second.resolve(DirectoryReader).directory,
    );
    await built.app.close();
  });

  it("each workflow's services are created at start with their hooks, and stopped at close", async () => {
    events.length = 0;
    const built = await build(applicationOver(workflowOver("billing", [SmsNotifier])));

    expect(events).toEqual(["EmailNotifier.onInit", "SmsNotifier.onInit", "SmsNotifier.onReady"]);

    await built.app.close();

    expect(events).toContain("SmsNotifier.onBeforeDestroy");
  });
});
