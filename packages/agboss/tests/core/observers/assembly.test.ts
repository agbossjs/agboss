import { describe, expect, it } from "vitest";
import { createApp } from "../../../src/application/create-app.js";
import {
  ComponentError,
  Injectable,
  type OnAgentStart,
  type OnRunRejected,
  type OnWorkflowPause,
  type OnWorkflowResume,
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
class PauseObserver implements OnWorkflowPause, OnWorkflowResume {
  onWorkflowPause(): void {
    /* real hook */
  }
  onWorkflowResume(): void {
    /* real hook */
  }
}

/** A typo of the pause hook next to the real one. */
@Injectable()
class PausedTypo implements OnWorkflowPause {
  onWorkflowPause(): void {
    /* real hook */
  }
  onWorkflowPaused(): void {
    /* never a hook */
  }
}

/** Only the refused-request hook (#246): a valid observer. */
@Injectable()
class RejectedObserver implements OnRunRejected {
  onRunRejected(): void {
    /* real hook */
  }
}

/** A typo of the refused-request hook next to the real one. */
@Injectable()
class RejectedTypo implements OnRunRejected {
  onRunRejected(): void {
    /* real hook */
  }
  onRunRejection(): void {
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

describe("@Workflow observers are checked at assembly", () => {
  it("rejects a misspelled hook with a did-you-mean", async () => {
    expect(await assemblyError([TypoObserver])).toBe(
      "[observer.unknown-hook] TypoObserver.onAgentStarted is not an observer hook — did you mean onAgentStart?",
    );
  });

  it("rejects an observer that implements no hook", async () => {
    expect(await assemblyError([EmptyObserver])).toMatch(
      /^\[observer\.no-hooks\] EmptyObserver is listed in @Workflow observers but implements no hook/,
    );
  });

  it("rejects a class with only a misspelled hook, at tsc and at assembly", async () => {
    // @ts-expect-error — OnlyTypo shares no hook with WorkflowObserver
    expect(await assemblyError([OnlyTypo])).toContain("did you mean onToolEnd?");
  });

  it("accepts lifecycle hooks next to observer hooks", async () => {
    expect(await assemblyError([LifecycleObserver])).toBe("assembled");
  });

  it("#244: knows onWorkflowPause / onWorkflowResume — accepted, and suggested for a typo", async () => {
    expect(await assemblyError([PauseObserver])).toBe("assembled");
    expect(await assemblyError([PausedTypo])).toBe(
      "[observer.unknown-hook] PausedTypo.onWorkflowPaused is not an observer hook — did you mean onWorkflowPause?",
    );
    expect(closestHook("onWorkflowResumed")).toBe("onWorkflowResume");
  });

  it("#246: knows onRunRejected — accepted, and suggested for a typo", async () => {
    expect(await assemblyError([RejectedObserver])).toBe("assembled");
    expect(await assemblyError([RejectedTypo])).toBe(
      "[observer.unknown-hook] RejectedTypo.onRunRejection is not an observer hook — did you mean onRunRejected?",
    );
  });

  it("suggests the closest hook", () => {
    expect(closestHook("onWorkflowStarted")).toBe("onWorkflowStart");
    expect(closestHook("onEror")).toBe("onError");
    expect(closestHook("onToolFinish")).toBe("onToolEnd");
  });
});
