/**
 * The keys a decorator's options may carry (#1313, #1318, #1324): each decorator lists them once, in a
 * list the compiler holds equal to `keyof` its options type, and records the keys it was given that
 * are not on it. TypeScript does not see a stray key behind a spread, an untyped variable or a JS
 * caller; the assembly rule `[decorator.unknown-option]` reads what was recorded here.
 */

/** Every key of every member of a union of option types. */
type KeysOfUnion<T> = T extends unknown ? keyof T & string : never;

/** The keys of the options type `T` the list does not name. */
type Missing<T, K extends readonly string[]> = Exclude<KeysOfUnion<T>, K[number]>;

/** The list is the type's keys, no more and no fewer: a key added to the type and not here is a compile error. */
type EqualsKeys<T, K extends readonly string[]> = [Missing<T, K>] extends [never]
  ? unknown
  : { readonly "missing from the list": Missing<T, K> };

/** What a decorator allows: its own keys, and the keys of its nested bags (`executionLimits`, `defaults`). */
export interface OptionKeys {
  readonly keys: ReadonlySet<string>;
  readonly nested: ReadonlyMap<string, OptionKeys>;
  /** `key → bag`: a key that is a member of a nested bag of this decorator (`maxToolCalls → executionLimits`). */
  readonly moved: ReadonlyMap<string, string>;
  /** `key → [bag, name]`: a removed key whose value is a member of a nested bag under another name (`maxConcurrentExecutions → executionLimits.maxConcurrency`). */
  readonly renamed: ReadonlyMap<string, readonly [bag: string, name: string]>;
}

/**
 * The allowlist of the options type `T`: `optionKeys<AgentOptions>()(["name", …], { executionLimits: … })`.
 * The keys given are checked to be exactly `keyof T` (every member's, for a union).
 */
export const optionKeys =
  <T>() =>
  <const K extends readonly KeysOfUnion<T>[]>(
    keys: K & EqualsKeys<T, K>,
    nested?: Readonly<Partial<Record<KeysOfUnion<T>, OptionKeys>>>,
    renamed: Readonly<Record<string, readonly [bag: KeysOfUnion<T>, name: string]>> = {},
  ): OptionKeys => {
    const bags = new Map(Object.entries<OptionKeys | undefined>(nested ?? {}));
    const moved = new Map<string, string>();
    for (const [bag, allowed] of bags) {
      if (allowed === undefined) continue;
      for (const key of allowed.keys)
        if (!(keys as readonly string[]).includes(key)) moved.set(key, bag);
    }
    return {
      keys: new Set<string>(keys),
      nested: new Map(
        [...bags].flatMap(([bag, allowed]) => (allowed === undefined ? [] : [[bag, allowed]])),
      ),
      moved,
      renamed: new Map(Object.entries(renamed)),
    };
  };

/** One key a decorator was given that it does not take: `path` is `key`, or `bag.key` inside a nested bag. */
export interface UnknownOption {
  readonly path: string;
  readonly key: string;
  /** The bag it was found in (`executionLimits`, `defaults.agents`); absent at the top. */
  readonly bag?: string;
  /** The keys that were allowed where it was found. */
  readonly allowed: readonly string[];
  /** A top-level key that belongs in a nested bag of this decorator. */
  readonly belongsIn?: string;
  /** The name it has in that bag, when it is not the same (`maxConcurrency`). */
  readonly renamedTo?: string;
}

/** What a decorator recorded of the options a class was declared with. */
interface RecordedOptions {
  readonly decorator: string;
  /** The options as written: the rule follows the classes they list. */
  readonly options: unknown;
  readonly unknown: readonly UnknownOption[];
}

/** A class may carry several framework decorators (`@Channel` and `@ChannelRole`): each is kept. */
const recorded = new WeakMap<object, readonly RecordedOptions[]>();

const isBag = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Where a top-level key that this decorator no longer takes went: into which bag, and under which name if it changed. */
function movedTo(allow: OptionKeys, key: string): Pick<UnknownOption, "belongsIn" | "renamedTo"> {
  const renamed = allow.renamed.get(key);
  if (renamed !== undefined) return { belongsIn: renamed[0], renamedTo: renamed[1] };
  const bag = allow.moved.get(key);
  return bag === undefined ? {} : { belongsIn: bag };
}

function unknownIn(
  options: Readonly<Record<string, unknown>>,
  allow: OptionKeys,
  bag: string | undefined,
): UnknownOption[] {
  const prefix = bag === undefined ? "" : `${bag}.`;
  const found: UnknownOption[] = [];
  for (const key of Object.keys(options)) {
    const value = options[key];
    if (value === undefined) continue;
    const nested = allow.nested.get(key);
    if (nested !== undefined && isBag(value))
      found.push(...unknownIn(value, nested, `${prefix}${key}`));
    if (allow.keys.has(key)) continue;
    found.push({
      path: `${prefix}${key}`,
      key,
      ...(bag === undefined ? {} : { bag }),
      allowed: [...allow.keys],
      ...(bag === undefined ? movedTo(allow, key) : {}),
    });
  }
  return found;
}

/**
 * Called by a decorator with the options it was given. A key whose value is not `undefined` and that is not on
 * `allow` is kept for the assembly rule; nothing is thrown here, so a class still loads and the rule names
 * every stray key of the application at once.
 */
export function recordOptionKeys(
  target: object,
  decorator: string,
  options: unknown,
  allow: OptionKeys,
): void {
  const found = isBag(options) ? unknownIn(options, allow, undefined) : [];
  recorded.set(target, [...(recorded.get(target) ?? []), { decorator, options, unknown: found }]);
}

/** What a class's decorators recorded; empty for a class no decorator of the framework recorded. */
export const recordedOptionsOf = (target: object): readonly RecordedOptions[] =>
  recorded.get(target) ?? [];
