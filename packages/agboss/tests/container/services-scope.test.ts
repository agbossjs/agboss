import { describe, expect, it } from "vitest";
import {
  createContainer,
  type ApplicationContainer,
} from "../../src/components/container/container.js";
import { checkGraph } from "../../src/components/container/graph-check.js";
import type { ProviderModule } from "../../src/components/container/registrations.js";
import { Injectable, InjectionToken, provide, type Provider } from "../../src/index.js";

/** #1324a: `injectAs` ports, a workflow's own `services` shadowing the application's, scoped instances. */

abstract class Notifier {
  abstract send(text: string): string;
}

@Injectable({ injectAs: Notifier })
class EmailNotifier {
  send(text: string): string {
    return `email:${text}`;
  }
}

@Injectable({ injectAs: Notifier })
class SmsNotifier {
  send(text: string): string {
    return `sms:${text}`;
  }
}

@Injectable({ injectAs: Notifier })
class PagerNotifier {
  send(text: string): string {
    return `pager:${text}`;
  }
}

/** Reaches a port, so a workflow that binds the port differently needs its own instance. */
@Injectable({ deps: [Notifier] })
class Alerts {
  constructor(readonly notifier: Notifier) {}
}

/** Reaches nothing a workflow binds: one instance for the whole application. */
@Injectable()
class SharedGate {}

@Injectable({ deps: [SharedGate] })
class GateUser {
  constructor(readonly gate: SharedGate) {}
}

const APPLICATION: ProviderModule = {
  owner: "desk-application",
  declaredIn: "@Application",
  providers: [EmailNotifier],
};

const workflowModule = (owner: string, ...services: Provider[]): ProviderModule => ({
  owner,
  providers: services,
  services,
});

/** The application's shared part, as `applicationContainerOf` builds it. */
const shared = (...modules: ProviderModule[]): ApplicationContainer => ({
  modules,
  core: new Map(),
  defaults: new Map(),
  instances: new Map(),
});

const workflowContainer = (application: ApplicationContainer, own?: ProviderModule) =>
  createContainer({ modules: own === undefined ? [] : [own], core: new Map() }, { application });

describe("#1324a: injectAs binds a class to an abstract port", () => {
  it("a dependency on a port gets the class that names it, which does not extend it", () => {
    const container = createContainer({
      modules: [{ owner: "desk-workflow", providers: [EmailNotifier, Alerts] }],
      core: new Map(),
    });

    const alerts = container.get(Alerts) as Alerts;

    expect(alerts.notifier.send("hi")).toBe("email:hi");
    expect(container.get(Notifier)).toBe(container.get(EmailNotifier));
  });

  it("two classes for one port in one module are ambiguous, naming both", () => {
    const modules = [{ owner: "desk-workflow", providers: [EmailNotifier, SmsNotifier, Alerts] }];

    expect(() => createContainer({ modules, core: new Map() }).get(Alerts)).toThrow(
      "[di.ambiguous-implementation] Alerts depends on Notifier, and 2 listed classes implement it: EmailNotifier",
    );
    expect(() => {
      checkGraph([Alerts], modules, []);
    }).toThrow("[di.ambiguous-implementation]");
  });

  it("a class names several ports", () => {
    abstract class Pager {
      abstract page(): string;
    }
    @Injectable({ injectAs: [Notifier, Pager] })
    class Both {
      send(text: string): string {
        return text;
      }
      page(): string {
        return "paged";
      }
    }

    const container = createContainer({
      modules: [{ owner: "desk-workflow", providers: [Both] }],
      core: new Map(),
    });

    expect(container.get(Notifier)).toBe(container.get(Pager));
  });

  it("the port is not found for a class that does not name it", () => {
    expect(() => {
      checkGraph([Alerts], [{ owner: "desk-workflow", providers: [] }], []);
    }).toThrow('[di.unregistered-token] Alerts: "Notifier" is not registered');
  });
});

describe("#1324a: a workflow's services shadow the application's, for that workflow alone", () => {
  it("the workflow's own implementation of the port wins over the application's", () => {
    const application = shared(APPLICATION);
    const billing = workflowContainer(application, workflowModule("billing-workflow", SmsNotifier));
    const support = workflowContainer(application);

    expect((billing.get(Alerts) as Alerts).notifier.send("x")).toBe("sms:x");
    expect((support.get(Alerts) as Alerts).notifier.send("x")).toBe("email:x");
  });

  it("a class reaching an overridden port is one instance per workflow, not the first one's", () => {
    const application = shared(APPLICATION);
    const billing = workflowContainer(application, workflowModule("billing-workflow", SmsNotifier));
    const shipping = workflowContainer(
      application,
      workflowModule("shipping-workflow", PagerNotifier),
    );

    const first = billing.get(Alerts) as Alerts;
    const second = shipping.get(Alerts) as Alerts;

    expect(first).not.toBe(second);
    expect(first.notifier.send("x")).toBe("sms:x");
    expect(second.notifier.send("x")).toBe("pager:x");
    // asked again, each workflow gets its own again
    expect(billing.get(Alerts)).toBe(first);
    expect(shipping.get(Alerts)).toBe(second);
  });

  it("two workflows binding the same port to different classes never collide", () => {
    const application = shared();
    const billing = workflowContainer(application, workflowModule("billing-workflow", SmsNotifier));
    const shipping = workflowContainer(
      application,
      workflowModule("shipping-workflow", PagerNotifier),
    );

    expect(() => billing.get(Notifier)).not.toThrow();
    expect((shipping.get(Notifier) as Notifier).send("x")).toBe("pager:x");
  });

  it("what reaches no workflow-bound port stays one instance for the whole application", () => {
    const application = shared(APPLICATION);
    const billing = workflowContainer(application, workflowModule("billing-workflow", SmsNotifier));
    const support = workflowContainer(application);

    expect(billing.get(SharedGate)).toBe(support.get(SharedGate));
    expect((billing.get(GateUser) as GateUser).gate).toBe((support.get(GateUser) as GateUser).gate);
  });

  it("a value a workflow binds is scoped too: what reads it is created per workflow", () => {
    const LIMIT = new InjectionToken<number>("LIMIT");
    @Injectable({ deps: [LIMIT] })
    class Capped {
      constructor(readonly limit: number) {}
    }
    const application = shared({
      owner: "desk-application",
      providers: [Capped, provide(LIMIT, 1)],
    });
    const other = workflowContainer(
      application,
      workflowModule("billing-workflow", provide(LIMIT, 1)),
    );

    expect(workflowContainer(application).get(Capped)).not.toBe(other.get(Capped));
  });
});
