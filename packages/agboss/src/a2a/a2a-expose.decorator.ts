import type { Class } from "../components/injection.js";
import { recordComponent } from "../components/metadata.js";
import type { A2ASecurityScheme } from "./a2a-security.js";
import type { A2AFileOptions } from "./files/a2a-file-options.js";

/**
 * How a skill answers a message (#860): a durable task (the default) or a direct, stateless message —
 * no task, the reply kept only to answer a resend of its `messageId` (`retention.a2aMessages`).
 */
export enum A2AReply {
  /** One A2A task, one root execution: it may pause, it outlives its connection. */
  Task = "task",
  /**
   * A direct `Message`: the skill's workflow is stateless — no pause, no fenced effect, no outbound
   * call, no undo, no child, only `readOnly` tools (`[a2a.message-skill-*]`) — and its reply is kept
   * in the `A2ADirectMessageRepository` for a resend.
   */
  Message = "message",
}

/**
 * What the Agent Card says of one exported start (#808): its tags and examples; its files (#859);
 * how it answers (#860).
 */
export interface A2AExposedSkillOptions {
  /** Keywords of the skill; default the application's name. */
  readonly tags?: readonly string[];
  /** Example requests. */
  readonly examples?: readonly string[];
  /** How much it takes as files (#859), over `@Application({ a2aFiles })` field by field. */
  readonly files?: A2AFileOptions;
  /** A task (`A2AReply.Task`, the default) or a direct message (`A2AReply.Message`, #860). */
  readonly reply?: A2AReply;
}

/** `@A2AExpose({ name, version, description, exports, skills?, defaultSkill?, provider?, security? })` (#398 PR 3, #808, #860). */
export interface A2AExposeOptions {
  /** `billing-a2a-expose` — kebab-case, ending with `-a2a-expose` (`[name.kind-suffix]`): the card's `name`. */
  readonly name: string;
  /** The contract's version: the card's `version`, in `describe --json` and federation checks. */
  readonly version: string;
  /** What the agent does: the card's `description`. */
  readonly description: string;
  /** The workflow starts it serves (`@WorkflowStart` classes of the application's workflows): its skills. */
  readonly exports: readonly Class[];
  /** Per exported start's name: its tags and examples on the card, how it answers (#860). */
  readonly skills?: Readonly<Record<string, A2AExposedSkillOptions>>;
  /**
   * The skill a message runs when it names none (#860) — a foreign caller that sends no
   * `metadata[A2A_SKILLS_EXTENSION].skill` to an agent of several skills; one of `exports`
   * (`[a2a.default-skill-unknown]`). Unset: with several skills a message must name one.
   */
  readonly defaultSkill?: Class;
  /** Who runs the agent: the card's `provider`. */
  readonly provider?: { readonly organization: string; readonly url: string };
  /**
   * How callers authenticate (`A2ASecurity.bearer()`, …): the card's `securitySchemes`, any one of
   * them accepted. Described only: the listener's caller resolver enforces it.
   */
  readonly security?: readonly A2ASecurityScheme[];
}

/**
 * `@A2AExpose` (#398 PR 3, mirrors `@McpExpose`) — what an application serves over A2A v1.0 (#808):
 * its Agent Card's name, version and description, and the starts a caller may run — one skill each,
 * named by the start. Put it on an empty class, list it in `@Application({ exposes })` and serve it
 * with `a2aHttpListener(app, { expose, callerResolver, publicUrl })`; `agboss describe --json` lists
 * it among the application's exported contracts.
 */
export function A2AExpose(options: A2AExposeOptions) {
  return <C extends Class>(target: C): C => {
    recordComponent(target, { kind: "a2a-expose", meta: options });
    return target;
  };
}
