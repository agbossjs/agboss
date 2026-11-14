import type { Class, Provider, ResolvedAll, Token } from "../components/injection.js";
import { isClassProvider } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import { kindSuffixProblem, NameKind } from "../flow/names.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import type {
  PauseListenerAnswerNotTakenEvent,
  PauseListenerClosedEvent,
  PauseListenerOpenedEvent,
} from "./notice-events.js";

/**
 * `@PauseListener` (#940, #910 D2): an application-wide listener of every pause — opened and closed
 * — listed in `@Application({ providers })`, created by the application's container at start (its
 * `onInit` / `onStart` run with the application's), one instance. Notices are written with the
 * pause's change and delivered at least once, in order per pause, by any instance (Wiki → Pauses).
 */

/** What a `@PauseListener` class implements. */
export interface PauseListenerHandler {
  /** A pause was opened: its channel was asked. Deduplicate by `event.deliveryId`. */
  onPauseOpened(event: PauseListenerOpenedEvent): Promise<void>;
  /** A pause closed (answered, expired, cancelled, withdrawn, its tree ended). */
  onPauseClosed(event: PauseListenerClosedEvent): Promise<void>;
  /** A recorded answer was never applied: its run ended first. */
  onPauseAnswerNotTaken?(event: PauseListenerAnswerNotTakenEvent): Promise<void>;
}

/** `@PauseListener` options. */
export interface PauseListenerOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Ends with `-pause-listener` (`backoffice-pause-listener`), unique in the application. */
  readonly name: string;
  readonly description?: string;
  /** The constructor's dependencies, in order (compiler-checked), injected by the container. */
  readonly deps?: TDeps;
  /**
   * Trusted to answer: its events carry the raw `pauseId` of channel pauses (#267 AC3, D4) —
   * by default a listener gets `pauseKey` (a correlation key that answers nothing). Such a
   * listener holds the right to answer every channel pause of the application: a trusted
   * component; `app.resume` still needs `answeredBy`.
   */
  readonly allowAnswering?: boolean;
}

/** What `@PauseListener` records about a class. */
export interface PauseListenerMeta {
  readonly name: string;
  readonly description?: string;
  readonly deps: readonly Token[];
  readonly allowAnswering: boolean;
}

/** `@PauseListener({ name, deps?, allowAnswering? })` on a class that `implements PauseListenerHandler`. */
export function PauseListener<const TDeps extends readonly Token[] = []>(
  options: PauseListenerOptions<TDeps>,
) {
  return <TClass extends new (...args: ResolvedAll<TDeps>) => PauseListenerHandler>(
    value: TClass,
  ): TClass => {
    const { name, description, allowAnswering = false } = options;
    const meta = { name, deps: options.deps ?? [], allowAnswering };
    recordComponent(value, {
      kind: "pause-listener",
      meta: description === undefined ? meta : { ...meta, description },
    });
    return value;
  };
}

/** What `@PauseListener` recorded on a class; `undefined` when it is not a listener. */
export function pauseListenerOf(cls: Class): PauseListenerMeta | undefined {
  const component = componentOf(cls);
  return component?.kind === "pause-listener" ? component.meta : undefined;
}

const classNameOf = (cls: Class): string => cls.name || "(anonymous class)";

/** The listener classes among an application's providers, in the order listed. */
export const listenersOf = (providers: readonly Provider[] | undefined): readonly Class[] =>
  (providers ?? []).flatMap((provider) => {
    const cls = isClassProvider(provider) ? provider.useClass : provider;
    return typeof cls === "function" && pauseListenerOf(cls) !== undefined ? [cls] : [];
  });

/** Whether a class has the two functions a listener must have. */
const isHandler = (cls: Class): boolean => {
  const { prototype } = cls as { prototype: Partial<PauseListenerHandler> };
  return (
    typeof prototype.onPauseOpened === "function" && typeof prototype.onPauseClosed === "function"
  );
};

/**
 * The rules of the listeners an application lists: a name ending `-pause-listener`
 * (`[name.kind-suffix]`), one class per name (`[pause-listener.duplicate-name]`) and both
 * `onPauseOpened` and `onPauseClosed` (`[pause-listener.not-a-handler]`).
 */
export function pauseListenerRuleViolations(
  application: string,
  providers: readonly Provider[] | undefined,
): RuleViolation[] {
  const listeners = listenersOf(providers);
  const byName = new Map<string, Class[]>();
  const found: RuleViolation[] = [];
  for (const cls of listeners) {
    const name = pauseListenerOf(cls)?.name ?? "";
    byName.set(name, [...(byName.get(name) ?? []), cls]);
    const problem = kindSuffixProblem(name, NameKind.PauseListener);
    if (problem !== undefined) found.push(violation(problem.code, problem.message, [application]));
    if (!isHandler(cls)) {
      const message = `${classNameOf(cls)} (@PauseListener "${name}") must implement onPauseOpened(event) and onPauseClosed(event)`;
      found.push(violation("pause-listener.not-a-handler", message, [application]));
    }
  }
  for (const [name, classes] of byName) {
    if (classes.length < 2) continue;
    const message = `"${name}" names ${classes.map(classNameOf).join(" and ")} in ${application}'s providers — give each its own name`;
    found.push(violation("pause-listener.duplicate-name", message, [application]));
  }
  return found;
}
