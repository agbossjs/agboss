/**
 * #1366: what an A2A client reads of its class and its application: the origins `@A2AAgent({ allowedOrigins })` names
 * (none when it names none), the services an application remembers for its executions' calls (its stored-file reader among
 * them), and how a stored file is read before it is sent — through the application's `Files`, and refused outside one.
 */
import { describe, expect, it } from "vitest";
import { A2AAgent } from "../../../../src/a2a/a2a-decorator.js";
import { A2AClient } from "../../../../src/a2a/client/a2a-client.js";
import { allowedOriginsOfClass } from "../../../../src/a2a/client/a2a-client-options.js";
import {
  a2aClientServicesOf,
  rememberA2AClientServicesOf,
  storedFileReaderOf,
} from "../../../../src/a2a/client/a2a-client-services.js";
import { FileUnavailableReason } from "../../../../src/files/file-errors.js";
import type { FileDto } from "../../../../src/dto/standard/file.js";
import { Files } from "../../../../src/a2a/files/files.service.js";
import { Idempotency } from "../../../../src/app/idempotency.js";
import { WorkflowStartTextDto, WorkflowFinishTextDto } from "../../../../src/dto/index.js";
import { ApplicationContext } from "../../../../src/flow/context/application-context.js";
import { Clock } from "../../../../src/infrastructure/clock.js";
import { VirtualClock } from "../../../../src/testing/clock.js";

@A2AAgent({
  name: "origins-a2a-agent",
  url: "https://a.example",
  allowedOrigins: ["https://files.example", "https://cdn.example"],
  input: WorkflowStartTextDto,
  output: WorkflowFinishTextDto,
})
class OriginsAgent extends A2AClient<WorkflowStartTextDto, WorkflowFinishTextDto> {}

@A2AAgent({
  name: "plain-a2a-agent",
  url: "https://b.example",
  input: WorkflowStartTextDto,
  output: WorkflowFinishTextDto,
})
class PlainAgent extends A2AClient<WorkflowStartTextDto, WorkflowFinishTextDto> {}

describe("#1366: the origins a client's class names", () => {
  it("the ones @A2AAgent lists, in order; none when it lists none", () => {
    expect(allowedOriginsOfClass(OriginsAgent)).toEqual([
      "https://files.example",
      "https://cdn.example",
    ]);
    expect(allowedOriginsOfClass(PlainAgent)).toEqual([]);
  });
});

const stored: FileDto = { mediaType: "text/plain", fileId: "f-1" };

describe("#1366: a stored file is read before it is sent", () => {
  it("outside an execution (no services, or services with no files) it is unavailable as outside-execution", async () => {
    const reasonOf = async (read: Promise<Uint8Array>) =>
      read.then(
        () => undefined,
        (error: unknown) => (error as { reason?: string }).reason,
      );

    expect(await reasonOf(storedFileReaderOf(undefined)(stored))).toBe(
      FileUnavailableReason.OutsideExecution,
    );
    expect(
      await reasonOf(
        storedFileReaderOf({ outboundCalls: () => ({}) as never, clock: new VirtualClock() })(
          stored,
        ),
      ),
    ).toBe(FileUnavailableReason.OutsideExecution);
    expect(
      await reasonOf(
        storedFileReaderOf({
          outboundCalls: () => ({}) as never,
          clock: new VirtualClock(),
          files: () => undefined as never,
        })(stored),
      ),
    ).toBe(FileUnavailableReason.OutsideExecution);
  });

  it("inside an application the bytes are what the application's Files reads for that descriptor", async () => {
    const read: FileDto[] = [];
    const files = {
      read: (file: FileDto) => {
        read.push(file);
        return Promise.resolve(new Uint8Array([1, 2, 3]));
      },
    };

    const bytes = await storedFileReaderOf({
      outboundCalls: () => ({}) as never,
      clock: new VirtualClock(),
      files: () => files as never,
    })(stored);

    expect([...bytes]).toEqual([1, 2, 3]);
    expect(read).toEqual([stored]);
  });
});

describe("#1366: what an application remembers for its executions' A2A calls", () => {
  it("per application context: its clock, its outbound calls and files resolved on use, none for another", () => {
    const context = {} as ApplicationContext;
    const clock = new VirtualClock();
    const outbound = {} as Idempotency;
    const filesService = {} as Files;
    const resolved: unknown[] = [];
    const app = {
      resolve: (token: unknown) => {
        resolved.push(token);
        if (token === ApplicationContext) return context;
        if (token === Clock) return clock;
        if (token === Idempotency) return outbound;
        if (token === Files) return filesService;
        throw new Error("unexpected token");
      },
    };

    rememberA2AClientServicesOf(app as never);
    const services = a2aClientServicesOf(context);

    expect(services?.clock).toBe(clock);
    expect(resolved).not.toContain(Idempotency);
    expect(resolved).not.toContain(Files);
    expect(services?.outboundCalls()).toBe(outbound);
    expect(services?.files?.()).toBe(filesService);
    expect(a2aClientServicesOf({} as ApplicationContext)).toBeUndefined();
  });
});
