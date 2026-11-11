import { describe, expect, it } from "vitest";
import { createContainer } from "../../src/components/container/container.js";
import { checkGraph } from "../../src/components/container/graph-check.js";
import type { ProviderModule } from "../../src/components/container/registrations.js";
import {
  Injectable,
  InjectionToken,
  provide,
  type ClassProvider,
  type Provider,
} from "../../src/index.js";

/** What a coordination store asks of a durable one (#891: like `ExecutionIdStore`). */
interface IdStore {
  claim(id: string): boolean;
}

const ID_STORE = new InjectionToken<IdStore>("ID_STORE");
const LIMIT = new InjectionToken<number>("LIMIT");

/** A contract with two implementations, like `ExecutionLeaseRepository`. */
abstract class LeaseStore {
  abstract kind(): string;
}

@Injectable()
class Connection {}

@Injectable({ deps: [Connection] })
class DurableLeaseStore extends LeaseStore implements IdStore {
  constructor(readonly connection: Connection) {
    super();
  }
  kind(): string {
    return "durable";
  }
  claim(): boolean {
    return true;
  }
}

@Injectable({ deps: [ID_STORE] })
class CoordinationLeaseStore extends LeaseStore {
  constructor(readonly ids: IdStore) {
    super();
  }
  kind(): string {
    return "coordination";
  }
}

@Injectable({ deps: [LeaseStore] })
class LeaseUser {
  constructor(readonly leases: LeaseStore) {}
}

@Injectable({ deps: [ID_STORE] })
class NeedsUnknown {
  constructor(readonly ids: IdStore) {}
}

const moduleOf = (owner: string, ...providers: Provider[]): ProviderModule => ({
  owner,
  providers,
  declaredIn: "@Application",
});

const containerOf = (modules: readonly ProviderModule[]) =>
  createContainer({ modules, core: new Map() });

describe("#891 AC2: provide(TOKEN, Class) — the container creates the class under the token only", () => {
  const modules = [
    moduleOf(
      "app",
      Connection,
      CoordinationLeaseStore,
      LeaseUser,
      provide(ID_STORE, DurableLeaseStore),
    ),
  ];

  it("AC2: the token gets an instance of the class, its own deps injected — no new", () => {
    const container = containerOf(modules);

    const ids = (container.get(CoordinationLeaseStore) as CoordinationLeaseStore).ids;

    expect(ids).toBeInstanceOf(DurableLeaseStore);
    expect((ids as DurableLeaseStore).connection).toBeInstanceOf(Connection);
    expect(container.get(ID_STORE)).toBe(ids);
  });

  it("AC2: the class is no second implementation of the contract it extends — no [di.ambiguous-implementation]", () => {
    expect(() => {
      checkGraph([LeaseUser], modules, []);
    }).not.toThrow();
    const container = containerOf(modules);

    expect((container.get(LeaseUser) as LeaseUser).leases.kind()).toBe("coordination");
  });

  it("AC2: the class listed too is one instance, the token's and the class's", () => {
    const container = containerOf([
      moduleOf("app", DurableLeaseStore, NeedsUnknown, provide(ID_STORE, DurableLeaseStore)),
    ]);

    expect((container.get(NeedsUnknown) as NeedsUnknown).ids).toBe(
      container.get(DurableLeaseStore),
    );
  });

  it("AC2: the class's own deps are checked at assembly", () => {
    @Injectable({ deps: [LIMIT] })
    class LimitedLeaseStore extends LeaseStore implements IdStore {
      constructor(readonly limit: number) {
        super();
      }
      kind(): string {
        return "limited";
      }
      claim(): boolean {
        return false;
      }
    }

    expect(() => {
      checkGraph([NeedsUnknown], [moduleOf("app", provide(ID_STORE, LimitedLeaseStore))], []);
    }).toThrow('LimitedLeaseStore: "LIMIT" is not registered in @Workflow({ providers })');
  });

  it("AC2: two classes for one token are [di.conflicting-values]; the same class twice is one", () => {
    const twice = [
      moduleOf("app", provide(ID_STORE, DurableLeaseStore)),
      moduleOf("other", provide(ID_STORE, DurableLeaseStore)),
    ];
    @Injectable()
    class OtherIdStore implements IdStore {
      claim(): boolean {
        return false;
      }
    }

    expect(() => containerOf(twice)).not.toThrow();
    expect(() => {
      checkGraph(
        [],
        [moduleOf("app", provide(ID_STORE, DurableLeaseStore), provide(ID_STORE, OtherIdStore))],
        [],
      );
    }).toThrow('[di.conflicting-values] ID_STORE has two different values in @Application "app"');
  });

  it("AC2: a class and a value for one token are [di.conflicting-values]", () => {
    const value: IdStore = { claim: () => true };

    expect(() => {
      checkGraph(
        [],
        [
          moduleOf("app", provide(ID_STORE, DurableLeaseStore)),
          moduleOf("other", provide(ID_STORE, value)),
        ],
        [],
      );
    }).toThrow("[di.conflicting-values] ID_STORE has different values");
  });

  it("AC2: a value that is a function stays a value", () => {
    const FORMAT = new InjectionToken<(id: string) => string>("FORMAT");
    const format = (id: string): string => `#${id}`;

    const container = containerOf([moduleOf("app", provide(FORMAT, format))]);

    expect(container.get(FORMAT)).toBe(format);
  });

  it("AC2: a class whose instances are not the token's type, or a raw literal, does not compile", () => {
    // @ts-expect-error — Connection is no IdStore
    const wrong = provide(ID_STORE, Connection);
    // @ts-expect-error — only provide() builds a ClassProvider
    const literal: ClassProvider<IdStore> = { provide: ID_STORE, useClass: DurableLeaseStore };

    expect([wrong, literal]).toHaveLength(2);
  });
});
