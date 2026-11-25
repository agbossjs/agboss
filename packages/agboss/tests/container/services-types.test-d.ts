import { describe, expectTypeOf, it } from "vitest";
import {
  Injectable,
  InjectionToken,
  provide,
  type ApplicationOptions,
  type Class,
  type OnBeforeDestroy,
  type OnReady,
  type ServiceEntry,
  type WorkflowOptions,
} from "../../src/index.js";

/** #1324a: `injectAs` is checked by the compiler; `services` takes classes and values, never a class for a token. */

abstract class Notifier {
  abstract send(text: string): string;
}

abstract class Pager {
  abstract page(): string;
}

describe("#1324a: injectAs", () => {
  it("a class that is assignable to its port compiles", () => {
    @Injectable({ injectAs: Notifier })
    class Email {
      send(text: string): string {
        return text;
      }
    }
    expectTypeOf(Email).toBeConstructibleWith();
  });

  it("a class that is not assignable to its port is a type error", () => {
    // @ts-expect-error the class has no `send`
    @Injectable({ injectAs: Notifier })
    class Silent {}
    expectTypeOf(Silent).toBeConstructibleWith();
  });

  it("several ports: the class is assignable to all of them", () => {
    @Injectable({ injectAs: [Notifier, Pager] })
    class Both {
      send(text: string): string {
        return text;
      }
      page(): string {
        return "paged";
      }
    }
    expectTypeOf(Both).toBeConstructibleWith();
    // @ts-expect-error `Half` lacks `page`
    @Injectable({ injectAs: [Notifier, Pager] })
    class Half {
      send(text: string): string {
        return text;
      }
    }
    expectTypeOf(Half).toBeConstructibleWith();
  });

  it("a class with no injectAs is unconstrained", () => {
    @Injectable()
    class Plain {}
    expectTypeOf(Plain).toBeConstructibleWith();
  });
});

describe("#1324a: services", () => {
  it("both levels take classes and values, and the same type", () => {
    expectTypeOf<ApplicationOptions["services"]>().toEqualTypeOf<
      readonly ServiceEntry[] | undefined
    >();
    expectTypeOf<WorkflowOptions["services"]>().toEqualTypeOf<
      readonly ServiceEntry[] | undefined
    >();
  });

  it("a value is bound with provide(TOKEN, value); a class for a token is no service", () => {
    const LIMIT = new InjectionToken<number>("LIMIT");
    class Concrete {
      readonly kind = "concrete";
    }
    const CONCRETE = new InjectionToken<Concrete>("CONCRETE");
    expectTypeOf(provide(LIMIT, 3)).toExtend<ServiceEntry>();
    expectTypeOf<Class>().toExtend<ServiceEntry>();
    // @ts-expect-error provide(TOKEN, Class) is no service: the class says injectAs
    const bound: ServiceEntry = provide(CONCRETE, Concrete);
    expectTypeOf(bound).toBeObject();
  });
});

describe("#1324a: the lifecycle hooks of 0.1.1", () => {
  it("onReady and onBeforeDestroy are hooks", () => {
    expectTypeOf<OnReady["onReady"]>().toBeFunction();
    expectTypeOf<OnBeforeDestroy["onBeforeDestroy"]>().toBeFunction();
  });
});
