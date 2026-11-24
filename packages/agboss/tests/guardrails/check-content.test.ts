/**
 * #1289 — a code guardrail has one `check(content)`: `content.files` is `[]` when none,
 * `content.text` carries the text of text files (D8), and `GuardrailVerdict.blocked(refusal?)` puts
 * the refusal on the verdict of its own call — never on the shared instance.
 */
import { describe, expect, it } from "vitest";
import {
  GuardFailedError,
  GuardrailVerdict,
  InputGuardrail,
  type GuardrailContent,
} from "../../src/index.js";
import type { Class } from "../../src/components/injection.js";
import { bareRecordOf, ComponentKind } from "../../src/flow/runtime/records.js";
import { GuardrailSide } from "../../src/components/policy-decorators.js";
import { loadedGuardrailOf } from "../../src/guardrails/assembly.js";
import { checkGuardrails, runtimeGuardrailOf } from "../../src/guardrails/runtime.js";
import { PromptLoader } from "../../src/components/prompt-render.js";
import type { GuardedText } from "../../src/guardrails/guarded-text.js";

const seen: GuardrailContent[] = [];

/** Blocks with the reason of its own call: two calls at once never mix them up. */
@InputGuardrail({
  name: "reasons-guardrail",
  description: "Blocks with a reason",
})
class ReasonsGuardrail {
  async check(content: GuardrailContent): Promise<GuardrailVerdict> {
    seen.push(content);
    await new Promise((resolve) => setTimeout(resolve, content.text === "slow" ? 20 : 1));
    return GuardrailVerdict.blocked(`reason of ${content.text}`);
  }
}

@InputGuardrail({
  name: "default-refusal-guardrail",
  description: "Blocks with the decorator's text",
  refusal: "Blocked by policy.",
})
class DefaultRefusalGuardrail {
  check(): GuardrailVerdict {
    return GuardrailVerdict.blocked();
  }
}

@InputGuardrail({
  name: "computed-refusal-guardrail",
  description: "Blocks, the class words the refusal",
})
class ComputedRefusalGuardrail {
  check(): GuardrailVerdict {
    return GuardrailVerdict.blocked();
  }

  refusal(content: GuardrailContent): string {
    return `no, ${content.component.name} (${content.side})`;
  }
}

@InputGuardrail({
  name: "mute-guardrail",
  description: "Blocks, says nothing",
})
class MuteGuardrail {
  check(): GuardrailVerdict {
    return GuardrailVerdict.blocked();
  }
}

const runtimeOf = async (cls: Class) => {
  const instance = new (cls as new () => unknown)();
  const [loaded] = await loadedGuardrailOf(cls, undefined, new PromptLoader());
  if (loaded === undefined) throw new Error("not a guardrail");
  return runtimeGuardrailOf(loaded, {
    resolve: () => instance,
    modelOf: () => {
      throw new Error("a code guardrail calls no model");
    },
    deciderDeps: undefined as never,
  });
};

const textOf = (text: string): GuardedText => ({
  text,
  component: bareRecordOf("writer-agent", ComponentKind.Agent),
  side: GuardrailSide.Input,
});

describe("#1289: check(content)", () => {
  it("gets files [] when there are none, and the component and the side", async () => {
    seen.length = 0;
    const runtime = await runtimeOf(ReasonsGuardrail);

    await checkGuardrails([runtime], textOf("hello"));

    expect(seen[0]).toEqual({
      text: "hello",
      files: [],
      component: bareRecordOf("writer-agent", ComponentKind.Agent),
      side: GuardrailSide.Input,
    });
  });

  it("blocked(refusal) carries the refusal of its own call: concurrent calls do not mix them", async () => {
    const runtime = await runtimeOf(ReasonsGuardrail);

    const [slow, fast] = await Promise.all([
      checkGuardrails([runtime], textOf("slow")),
      checkGuardrails([runtime], textOf("fast")),
    ]);

    const refusalOf = (checked: typeof slow): string | undefined =>
      checked.kind === "blocked" ? checked.error.refusal : undefined;
    expect(refusalOf(slow)).toBe("reason of slow");
    expect(refusalOf(fast)).toBe("reason of fast");
  });

  it("blocked() falls back to the decorator's refusal, then to the class's refusal(content)", async () => {
    const decorator = await checkGuardrails(
      [await runtimeOf(DefaultRefusalGuardrail)],
      textOf("x"),
    );
    const computed = await checkGuardrails(
      [await runtimeOf(ComputedRefusalGuardrail)],
      textOf("x"),
    );

    expect(decorator.kind === "blocked" && decorator.error.refusal).toBe("Blocked by policy.");
    expect(computed.kind === "blocked" && computed.error.refusal).toBe("no, writer-agent (input)");
  });

  it("blocked() with no refusal anywhere fails closed", async () => {
    const runtime = await runtimeOf(MuteGuardrail);

    await expect(checkGuardrails([runtime], textOf("x"))).rejects.toBeInstanceOf(GuardFailedError);
  });
});
