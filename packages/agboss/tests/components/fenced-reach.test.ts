import { fenceOf } from "../../src/flow/context/execution-fence.js";
/**
 * #1356 — which components reach a writer under business keys (#825): the classes a token is given by the
 * application's providers, the walk through a component's `deps`, what a workflow's assembly remembers of it,
 * and `Idempotency`, a writer a component reaches by injecting it.
 */
import { describe, expect, it, vi } from "vitest";
import { Idempotency } from "../../src/app/idempotency.js";
import {
  businessKeyWriterPartOf,
  businessKeyWriterUseOf,
  markBusinessKeyWriter,
  rememberBusinessKeyWriter,
  tokenClassesOf,
} from "../../src/components/container/fenced-reach.js";
import { InjectionToken, type Class, type Token } from "../../src/components/injection.js";
import { ancestorFenceRead, liveFenceOf } from "../../src/flow/context/execution-fence.js";
import { ExecutionContextUnavailableError } from "../../src/flow/context/errors.js";
import type { Frame } from "../../src/flow/context/frame.js";

const OTHER = new InjectionToken<unknown>("other-token");
const ANOTHER = new InjectionToken<unknown>("another-token");
const WRITER_TOKEN = new InjectionToken<unknown>("writer-token");
const DATABASE = new InjectionToken<unknown>("database-token");

class Writer {
  readonly kind = "writer";
}
class Store {
  readonly kind = "store";
}
class SubStore extends Store {}
class Unrelated {
  readonly kind = "unrelated";
}
class Mock {
  readonly kind = "mock";
}
class Reaching {
  readonly kind = "reaching";
}
class Plain {
  readonly kind = "plain";
}
markBusinessKeyWriter(Writer);

describe("#1356: the classes a token is given by the providers", () => {
  it("a class is itself, and every listed class that extends it", () => {
    const classesOf = tokenClassesOf([Store, SubStore, Unrelated]);

    expect(classesOf(Store)).toEqual([Store, SubStore]);
    expect(classesOf(SubStore)).toEqual([SubStore]);
    expect(classesOf(Unrelated)).toEqual([Unrelated]);
  });

  it("a class that is not listed is itself, and nothing is extending it", () => {
    expect(tokenClassesOf([])(Store)).toEqual([Store]);
  });

  it("a value provider's value is given by its class, after the token's own", () => {
    const classesOf = tokenClassesOf([{ provide: DATABASE, useValue: new Mock() }]);

    expect(classesOf(DATABASE)).toEqual([Mock]);
    expect(tokenClassesOf([{ provide: Store, useValue: new Mock() }])(Store)).toEqual([
      Store,
      Mock,
    ]);
  });

  it("a class for a token is that class, ahead of the class of a value", () => {
    const classesOf = tokenClassesOf([
      { provide: DATABASE, useClass: Store, useValue: new Mock() },
      { provide: OTHER, useClass: Unrelated },
    ]);

    expect(classesOf(DATABASE)).toEqual([Store]);
    expect(classesOf(OTHER)).toEqual([Unrelated]);
  });

  it("the classes of one token add up, in the order listed", () => {
    const classesOf = tokenClassesOf([
      { provide: DATABASE, useClass: Store },
      { provide: DATABASE, useValue: new Mock() },
    ]);

    expect(classesOf(DATABASE)).toEqual([Store, Mock]);
  });

  it("a provider that is no class and gives no class is none: null, a text, a value that is no object", () => {
    const classesOf = tokenClassesOf([
      null,
      "text",
      7,
      { provide: DATABASE, useValue: "a text" },
      { provide: DATABASE, useValue: null },
      { provide: DATABASE },
    ]);

    expect(classesOf(DATABASE)).toEqual([]);
    expect(classesOf(Store)).toEqual([Store]);
    expect(classesOf(ANOTHER)).toEqual([]);
  });

  it("a provider object is not a class that extends a token", () => {
    const classesOf = tokenClassesOf([{ provide: "t", useValue: new Mock() }, Store]);

    expect(classesOf(Store)).toEqual([Store]);
    expect(classesOf(Mock)).toEqual([Mock]);
  });
});

/** Dependencies by class, as `depsOf` reads them. */
const depsOf =
  (deps: Map<Class, readonly Token[]>) =>
  (cls: Class): readonly Token[] =>
    deps.get(cls) ?? [];

describe("#1356: the component that reaches a writer", () => {
  it("is the first root that is a writer, or reaches one through its deps, with the writer", () => {
    const deps = depsOf(new Map<Class, readonly Token[]>([[Reaching, [Plain, Writer]]]));

    expect(businessKeyWriterUseOf([Plain, Reaching], deps)).toEqual({
      component: Reaching,
      writer: Writer,
    });
    expect(businessKeyWriterUseOf([Writer, Reaching], deps)).toEqual({
      component: Writer,
      writer: Writer,
    });
  });

  it("a class that extends a writer is one", () => {
    class Extending extends Writer {}

    expect(businessKeyWriterUseOf([Extending], depsOf(new Map()))).toEqual({
      component: Extending,
      writer: Extending,
    });
  });

  it("is none when no root reaches one", () => {
    const deps = depsOf(new Map<Class, readonly Token[]>([[Reaching, [Plain]]]));

    expect(businessKeyWriterUseOf([Plain, Reaching], deps)).toBeUndefined();
    expect(businessKeyWriterUseOf([], deps)).toBeUndefined();
  });

  it("reaches through a chain of deps, and a dep that loops back ends the walk", () => {
    const deps = depsOf(
      new Map<Class, readonly Token[]>([
        [Reaching, [Plain]],
        [Plain, [Reaching, Store]],
        [Store, [Writer]],
      ]),
    );

    expect(businessKeyWriterUseOf([Reaching], deps)?.writer).toBe(Writer);
    expect(
      businessKeyWriterUseOf(
        [Plain],
        depsOf(
          new Map<Class, readonly Token[]>([
            [Plain, [Reaching]],
            [Reaching, [Plain]],
          ]),
        ),
      ),
    ).toBeUndefined();
  });

  it("reads a token as the classes the providers give it: an abstract dependency gets the listed one", () => {
    const deps = depsOf(
      new Map<Class, readonly Token[]>([
        [Reaching, [DATABASE]],
        [Mock, [Writer]],
      ]),
    );
    const classesOf = tokenClassesOf([{ provide: DATABASE, useValue: new Mock() }]);

    expect(businessKeyWriterUseOf([Reaching], deps, classesOf)?.writer).toBe(Writer);
    // with no providers a text token gives no class
    expect(businessKeyWriterUseOf([Reaching], deps)).toBeUndefined();
  });

  it("by default a class token is the class itself, and any other token gives none", () => {
    const viaClass = depsOf(new Map<Class, readonly Token[]>([[Reaching, [Writer]]]));
    const viaText = depsOf(new Map<Class, readonly Token[]>([[Reaching, [WRITER_TOKEN]]]));

    expect(businessKeyWriterUseOf([Reaching], viaClass)?.writer).toBe(Writer);
    expect(businessKeyWriterUseOf([Reaching], viaText)).toBeUndefined();
  });

  it("by default only a class token is followed: a token that is no class is never read as one", () => {
    const readDeps = vi.fn((cls: Class): readonly Token[] =>
      cls === Reaching ? [WRITER_TOKEN, Plain] : [],
    );

    expect(businessKeyWriterUseOf([Reaching], readDeps)).toBeUndefined();
    expect(readDeps.mock.calls.map(([cls]) => cls)).toEqual([Reaching, Plain]);
  });

  it("`Idempotency` is a writer: a component that injects it reaches one", () => {
    const deps = depsOf(new Map<Class, readonly Token[]>([[Reaching, [Idempotency]]]));

    expect(businessKeyWriterUseOf([Reaching], deps)).toEqual({
      component: Reaching,
      writer: Idempotency,
    });
  });
});

describe("#1356: the fence of a step where none can be read", () => {
  it("an ancestor's fence says whose it is, and to read the current context's", () => {
    expect(() => ancestorFenceRead("PayAction")).toThrow(ExecutionContextUnavailableError);
    expect(() => ancestorFenceRead("PayAction")).toThrow(
      "PayAction read the lease fence of an ancestor execution: an ancestor of a child on any instance is rebuilt elsewhere and its lease may be yielded — read the fence of the current context.",
    );
  });

  it("a frame with no lease says where a fence is available", () => {
    const fence = liveFenceOf(() => ({ execution: {} }) as Frame, "PayAction");

    expect(() => fence.token).toThrow(
      "PayAction read the lease fence.token where no lease is held (a reply interpreter, a budget's maxSpend(), an eval judge, a tool called on its own).",
    );
  });
});

describe("#1356: what a workflow's assembly remembers", () => {
  it("the writer a component of the workflow reaches, as a part of the assembled ones", () => {
    const workflow = {};
    const use = { component: Reaching, writer: Writer };

    rememberBusinessKeyWriter(workflow, use);

    expect(businessKeyWriterPartOf(workflow)).toStrictEqual({ businessKeyWriter: use });
  });

  it("nothing for a workflow that reaches none", () => {
    const workflow = {};

    rememberBusinessKeyWriter(workflow, undefined);

    expect(businessKeyWriterPartOf(workflow)).toStrictEqual({});
    expect(businessKeyWriterPartOf({})).toStrictEqual({});
  });

  it("a later look that finds none leaves what an earlier one remembered", () => {
    const workflow = {};
    const use = { component: Reaching, writer: Writer };
    rememberBusinessKeyWriter(workflow, use);

    rememberBusinessKeyWriter(workflow, undefined);

    expect(businessKeyWriterPartOf(workflow)).toStrictEqual({ businessKeyWriter: use });
  });
});
