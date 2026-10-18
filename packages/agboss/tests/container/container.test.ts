import { describe, expect, it } from "vitest";
import { createContainer } from "../../src/components/container/container.js";
import { checkGraph, dependencyTree } from "../../src/components/container/graph-check.js";
import type { ProviderModule } from "../../src/components/container/registrations.js";
import { Injectable, InjectionToken, provide, type Provider } from "../../src/index.js";

const LIMIT = new InjectionToken<number>("LIMIT");

@Injectable()
class OrderBook {}

@Injectable({ deps: [OrderBook] })
class Shipping {
  constructor(readonly orderBook: OrderBook) {}
}

@Injectable({ deps: [OrderBook] })
class Billing {
  constructor(readonly orderBook: OrderBook) {}
}

/** A contract with a built-in default, like the framework's storage contracts. */
abstract class AuditRepository {
  abstract kind(): string;
}

@Injectable()
class MemoryAuditRepository extends AuditRepository {
  kind(): string {
    return "memory";
  }
}

@Injectable()
class SqliteAuditRepository extends AuditRepository {
  kind(): string {
    return "sqlite";
  }
}

@Injectable()
class PostgresAuditRepository extends AuditRepository {
  kind(): string {
    return "postgres";
  }
}

@Injectable({ deps: [AuditRepository] })
class AuditService {
  constructor(readonly auditRepository: AuditRepository) {}
}

const moduleOf = (owner: string, ...providers: Provider[]): ProviderModule => ({
  owner,
  providers,
});

const containerOf = (modules: readonly ProviderModule[], defaults = new Map()) =>
  createContainer({ modules, core: new Map(), defaults });

describe("#261 AC2: one container per application instance, no scopes", () => {
  it("one instance per class: a class listed by two workflows is created once", () => {
    const container = containerOf([
      moduleOf("shipping-workflow", OrderBook, Shipping),
      moduleOf("billing-workflow", OrderBook, Billing),
    ]);

    const shipping = container.get(Shipping) as Shipping;
    const billing = container.get(Billing) as Billing;

    expect(shipping.orderBook).toBe(billing.orderBook);
    expect(container.get(OrderBook)).toBe(shipping.orderBook);
    expect(container.created).toEqual(["OrderBook", "Shipping", "Billing"]);
  });

  it("conflicting values: one token with different values in two workflows fails", () => {
    const modules = [
      moduleOf("shipping-workflow", provide(LIMIT, 3)),
      moduleOf("billing-workflow", provide(LIMIT, 5)),
    ];

    expect(() => {
      checkGraph([], modules, []);
    }).toThrow(
      '[di.conflicting-values] LIMIT has different values in @Workflow "shipping-workflow" and @Workflow "billing-workflow" — use different tokens or an environment value',
    );
    expect(() => containerOf(modules)).toThrow("[di.conflicting-values]");
  });

  it("the same value in two workflows is one registration", () => {
    const container = containerOf([
      moduleOf("shipping-workflow", provide(LIMIT, 3)),
      moduleOf("billing-workflow", provide(LIMIT, 3)),
    ]);

    expect(container.get(LIMIT)).toBe(3);
  });

  it("two different values of one token in one workflow fail too", () => {
    expect(() => {
      checkGraph([], [moduleOf("shipping-workflow", provide(LIMIT, 3), provide(LIMIT, 4))], []);
    }).toThrow(
      '[di.conflicting-values] LIMIT has two different values in @Workflow "shipping-workflow"',
    );
  });

  it("no new: provide(Contract, new …) fails at assembly — the container creates every instance", () => {
    const modules = [
      moduleOf("audit-workflow", provide(AuditRepository, new MemoryAuditRepository())),
    ];

    expect(() => {
      checkGraph([AuditService], modules, []);
    }).toThrow(
      '[di.instance-provider] @Workflow "audit-workflow": provide(AuditRepository, …) binds an instance to a class',
    );
  });

  it("a scope option does not compile: there are no scopes", () => {
    // @ts-expect-error — no `scope`: one instance per class for the application instance
    const decorate = Injectable({ scope: "run" });

    expect(decorate).toBeTypeOf("function");
  });
});

describe("#261: implementation by inheritance", () => {
  const defaults = new Map([[AuditRepository, MemoryAuditRepository]]);

  it("none listed → the built-in default", () => {
    const container = containerOf([moduleOf("audit-workflow", AuditService)], defaults);

    expect((container.get(AuditService) as AuditService).auditRepository.kind()).toBe("memory");
  });

  it("one listed → it, the same instance as asking for the class itself", () => {
    const container = containerOf(
      [moduleOf("audit-workflow", SqliteAuditRepository, AuditService)],
      defaults,
    );

    const service = container.get(AuditService) as AuditService;

    expect(service.auditRepository.kind()).toBe("sqlite");
    expect(container.get(SqliteAuditRepository)).toBe(service.auditRepository);
    expect(container.get(AuditRepository)).toBe(service.auditRepository);
  });

  it("two listed → [di.ambiguous-implementation], naming the dependant and both classes", () => {
    const modules = [
      moduleOf("audit-workflow", SqliteAuditRepository, AuditService),
      moduleOf("report-workflow", PostgresAuditRepository),
    ];
    const message =
      '[di.ambiguous-implementation] AuditService depends on AuditRepository, and 2 listed classes implement it: SqliteAuditRepository (@Workflow "audit-workflow"), PostgresAuditRepository (@Workflow "report-workflow") — list one';

    expect(() => {
      checkGraph([AuditService], modules, []);
    }).toThrow(message);
    expect(() => containerOf(modules, defaults).get(AuditService)).toThrow(message);
  });

  it("no implementation and no default → not registered", () => {
    expect(() => {
      checkGraph([AuditService], [moduleOf("audit-workflow")], []);
    }).toThrow('AuditService: "AuditRepository" is not registered in @Workflow({ providers })');
  });

  it("the dependency tree shows the contract with the implementation's dependencies", () => {
    @Injectable({ deps: [OrderBook] })
    class OrderAuditRepository extends AuditRepository {
      constructor(readonly orderBook: OrderBook) {
        super();
      }
      kind(): string {
        return "orders";
      }
    }

    expect(
      dependencyTree(AuditService, [moduleOf("audit-workflow", OrderAuditRepository, OrderBook)]),
    ).toBe("AuditRepository (OrderBook)");
  });
});
