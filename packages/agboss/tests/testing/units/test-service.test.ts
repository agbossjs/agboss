/** #1328b: `testService(Class)` runs a multi-method service on its own container. */
import { describe, expect, expectTypeOf, it } from "vitest";
import { Injectable } from "../../../src/components/decorators.js";
import type { OnDestroy, OnInit, OnReady } from "../../../src/components/container/lifecycle.js";
import { ExecutionContext } from "../../../src/flow/context/execution-context.js";
import { testService, TestSetupError } from "../../../src/testing/index.js";
import { seconds } from "../../../src/units/index.js";

@Injectable()
class OrderBook {
  find(id: string): Promise<string> {
    return Promise.reject(new Error(`the real order book was asked for ${id}`));
  }
}

const events: string[] = [];

@Injectable({ deps: [OrderBook, ExecutionContext] })
class OrderDesk implements OnInit, OnReady, OnDestroy {
  constructor(
    private readonly book: OrderBook,
    private readonly executionContext: ExecutionContext,
  ) {}

  onInit(): void {
    events.push("init");
  }

  onReady(): void {
    events.push("ready");
  }

  onDestroy(): void {
    events.push("destroy");
  }

  async status(id: string): Promise<string> {
    return `${await this.book.find(id)} for ${this.executionContext.tenant.tenantId}`;
  }
}

describe("#1328b: testService", () => {
  it("runs a method in the frame of a step, its dependency mocked", async () => {
    const desk = testService(OrderDesk);
    desk.mockService(OrderBook).find.mockResolvedValue("shipped");

    const { output } = await desk.run((service) => service.status("7"));

    expect(output).toBe("shipped for default");
    expectTypeOf(desk.service).toEqualTypeOf<OrderDesk>();
  });

  it("start and stop run the lifecycle hooks, dependencies first", async () => {
    events.length = 0;
    const desk = testService(OrderDesk);
    desk.mockService(OrderBook);

    await desk.start();
    await desk.stop();

    expect(events).toEqual(["init", "ready", "destroy"]);
  });

  it("get gives the instance the service uses", () => {
    const desk = testService(OrderDesk);

    expect(desk.get(OrderDesk)).toBe(desk.service);
  });

  it("a mock after the service exists is a setup error", () => {
    const desk = testService(OrderDesk);
    expect(desk.service).toBeInstanceOf(OrderDesk);

    expect(() => desk.mockService(OrderBook)).toThrow(TestSetupError);
  });

  it("the clock is the runner's", async () => {
    const desk = testService(OrderDesk);

    await desk.clock.advance(seconds(5));

    expect(desk.clock.now().getTime()).toBeGreaterThan(0);
  });
});
