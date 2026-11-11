import type { Class } from "../components/injection.js";
import { recordComponent } from "../components/metadata.js";
import type { A2ASecurityScheme } from "./a2a-security.js";
import type { A2AFileOptions } from "./files/a2a-file-options.js";

/** What the Agent Card says of one exported start (#808): its tags and examples; its files (#859). */
export interface A2AExposedSkillOptions {
  /** Keywords of the skill; default the application's name. */
  readonly tags?: readonly string[];
  /** Example requests. */
  readonly examples?: readonly string[];
  /** How much it takes as files (#859), over `@Application({ a2aFiles })` field by field. */
  readonly files?: A2AFileOptions;
}

/** `@A2AExpose({ name, version, description, exports, skills?, provider?, security? })` (#398 PR 3, #808). */
export interface A2AExposeOptions {
  /** `billing-a2a-expose` — kebab-case, ending with `-a2a-expose` (`[name.kind-suffix]`): the card's `name`. */
  readonly name: string;
  /** The contract's version: the card's `version`, in `describe --json` and federation checks. */
  readonly version: string;
  /** What the agent does: the card's `description`. */
  readonly description: string;
  /** The workflow starts it serves (`@WorkflowStart` classes of the application's workflows): its skills. */
  readonly exports: readonly Class[];
  /** Per exported start's name: its tags and examples on the card. */
  readonly skills?: Readonly<Record<string, A2AExposedSkillOptions>>;
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
