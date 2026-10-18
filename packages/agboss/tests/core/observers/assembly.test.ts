import { describe, expect, it } from "vitest";
import { createApp } from "../../../src/application/create-app.js";
import {
  ComponentError,
  Injectable,
  type OnAgentStart,
  type OnExecutionRejected,
  type OnExecutionPause,
  type OnExecutionResume,
} from "../../../src/index.js";
import { closestHook } from "../../../src/components/observer-checks.js";
import { ScriptBook } from "../../../src/testing/script-book.js";
import { createScriptedGateway } from "../../../src/testing/scripted-gateway.js";
import { createSqliteTernStore } from "../../../src/terns/index.js";
import { applicationWith } from "./fixture.js";

/** A typo next to a real hook: compiles, rejected at assembly with the hook it meant. */
@Injectable()
class TypoObserver implements OnAgentStart {
  onAgentStart(): void {
    /* real hook */
  }
  onAgentStarted(): void {
    /* never a hook */
  }
}

/** No hook at all. */
@Injectable()
class EmptyObserver {}

/** Only a misspelled hook: rejected by `tsc` already, and at assembly. */
@Injectable()
class OnlyTypo {
  onToolFinish(): void {
    /* never a hook */
  }
}

/** Lifecycle hooks are not observer hooks, and not typos either. */
@Injectable()
class LifecycleObserver implements OnAgentStart {
  onStart(): void {
    /* lifecycle */
  }
  onAgentStart(): void {
    /* real hook */
  }
}

/** Only the pause / resume hooks (#244): a valid observer. */
@Injectable()
class PauseObserver implements OnExecutionPause, OnExecutionResume {
  onExecutionPause(): void {
    /* real hook */
  }
  onExecutionResume(): void {
    /* real hook */
  }
}

/** A typo of the pause hook next to the real one. */
@Injectable()
class PausedTypo implements OnExecutionPause {
  onExecutionPause(): void {
    /* real hook */
  }
  onWorkflowPaused(): void {
    /* never a hook */
  }
}

/** Only the refused-request hook (#246): a valid observer. */
@Injectable()
class RejectedObserver implements OnExecutionRejected {
  onExecutionRejected(): void {
    /* real hook */
  }
}

/** A typo of the refused-request hook next to the real one. */
@Injectable()
class RejectedTypo implements OnExecutionRejected {
  onExecutionRejected(): void {
    /* real hook */
  }
  onExecutionRejection(): void {
    /* never a hook */
  }
}

const assemblyError = async (observers: Parameters<typeof applicationWith>[1]): Promise<string> =>
  createApp(applicationWith("checked-workflow", observers), {
    processEnv: {},
    gateway: createScriptedGateway(new ScriptBook()),
  }).then(
    async (app) => {
      await app.close();
      return "assembled";
    },
    (error: unknown) => (error instanceof ComponentError ? error.message : String(error)),
  );

describe("@Application observers are checked at assembly", () => {
  it("rejects a misspelled hook with a did-you-mean", async () => {
    expect(await assemblyError([TypoObserver])).toBe(
      "[observer.unknown-hook] TypoObserver.onAgentStarted is not an observer hook — did you mean onAgentStart?",
    );
  });

  it("rejects an observer that implements no hook", async () => {
    expect(await assemblyError([EmptyObserver])).toMatch(
      /^\[observer\.no-hooks\] EmptyObserver is listed in @Application observers but implements no hook/,
    );
  });

  it("rejects a class with only a misspelled hook, at tsc and at assembly", async () => {
    // @ts-expect-error — OnlyTypo shares no hook with ExecutionObserver
    expect(await assemblyError([OnlyTypo])).toContain("did you mean onToolEnd?");
  });

  it("accepts lifecycle hooks next to observer hooks", async () => {
    expect(await assemblyError([LifecycleObserver])).toBe("assembled");
  });

  it("#244: knows onExecutionPause / onExecutionResume — accepted, and suggested for a typo", async () => {
    expect(await assemblyError([PauseObserver])).toBe("assembled");
    expect(await assemblyError([PausedTypo])).toBe(
      "[observer.unknown-hook] PausedTypo.onWorkflowPaused is not an observer hook — did you mean onExecutionPause?",
    );
    expect(closestHook("onWorkflowResumed")).toBe("onExecutionResume");
  });

  it("#246: knows onExecutionRejected — accepted, and suggested for a typo", async () => {
    expect(await assemblyError([RejectedObserver])).toBe("assembled");
    expect(await assemblyError([RejectedTypo])).toBe(
      "[observer.unknown-hook] RejectedTypo.onExecutionRejection is not an observer hook — did you mean onExecutionRejected?",
    );
  });

  it("suggests the closest hook", () => {
    expect(closestHook("onExecutionStarted")).toBe("onExecutionStart");
    expect(closestHook("onExecutionEror")).toBe("onExecutionError");
    expect(closestHook("onToolFinish")).toBe("onToolEnd");
  });
});
