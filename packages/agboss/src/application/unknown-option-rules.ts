import { recordedOptionsOf, type UnknownOption } from "../components/option-keys.js";
import type { Class } from "../components/injection.js";
import type { FlowGraph } from "../flow/analyse/flow-graph.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";

/**
 * `[decorator.unknown-option]` (#1313, #1318, #1324): an option a decorator does not take. TypeScript
 * misses it behind a spread, an untyped variable and in JS, and the runtime would ignore it — a
 * `maxToolCalls` that never limits, a `guardrail` that never guards. The message names the option and
 * the decorator, never the value.
 */

const MAX_NAME = 60;
const MAX_VISITED = 20_000;
const MAX_DEPTH = 8;

/** A key shown in a message: short, on one line. */
const shown = (key: string): string => {
  const clean = key.replaceAll(/[^\p{L}\p{N}_$.-]/gu, "?");
  return clean.length > MAX_NAME ? `${clean.slice(0, MAX_NAME)}…` : clean;
};

const at = (rows: readonly (readonly number[])[], i: number, j: number): number =>
  rows[i]?.[j] ?? 0;

/** One cell of the edit-distance table: an insert, a delete, a change, or a swap of two neighbours. */
function cell(a: string, b: string, rows: readonly (readonly number[])[], i: number, j: number) {
  const change = a[i - 1] === b[j - 1] ? 0 : 1;
  const best = Math.min(
    at(rows, i - 1, j) + 1,
    at(rows, i, j - 1) + 1,
    at(rows, i - 1, j - 1) + change,
  );
  const swapped = i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1];
  return swapped ? Math.min(best, at(rows, i - 2, j - 2) + 1) : best;
}

/** Edit distance with a swap as one edit (`modle` → `model`), for "did you mean". */
function distance(a: string, b: string): number {
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    const row: number[] = [];
    rows.push(row);
    for (let j = 0; j <= b.length; j++)
      row.push(i === 0 || j === 0 ? i + j : cell(a, b, rows, i, j));
  }
  return at(rows, a.length, b.length);
}

/** The allowed key closest to `key`: a case-only difference, or within a third of its length (at least 1, at most `most` edits). */
export function closestKey(key: string, allowed: readonly string[], most = 3): string | undefined {
  const lower = key.toLowerCase();
  const same = allowed.find((name) => name.toLowerCase() === lower);
  if (same !== undefined) return same;
  const limit = Math.min(most, Math.max(1, Math.floor(key.length / 3)));
  const costs = allowed.map((name) => ({ name, cost: distance(lower, name.toLowerCase()) }));
  const [best] = costs.filter((one) => one.cost <= limit).sort((a, b) => a.cost - b.cost);
  return best?.name;
}

/** A one-edit typo of an allowed key is a typo; else a key of a nested bag is a key that moved; else the nearest. */
const hint = (item: UnknownOption): string => {
  const near = closestKey(item.key, item.allowed, 1);
  if (near !== undefined) return ` — did you mean ${shown(near)}?`;
  if (item.belongsIn !== undefined) {
    return ` — move it into ${item.belongsIn}: { ${shown(item.key)}: … }`;
  }
  const close = closestKey(item.key, item.allowed);
  return close === undefined ? "" : ` — did you mean ${shown(close)}?`;
};

const nameOf = (cls: Class): string => cls.name || "(anonymous class)";

const isBag = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The `name` a decorator's options give their class (a provider's `openai-model-provider`), shown after it. */
const namedOf = (options: unknown): string => {
  const name = isBag(options) ? options.name : undefined;
  return typeof name === "string" ? ` (${shown(name)})` : "";
};

/**
 * The keys a factory value among a decorator's options was given and does not take: a model driver's
 * (`driver: OpenRouterDriver({ baseURL })`, bughunt 2026-11-25 #5), reported under the class that uses it.
 */
function factoryViolationsOf(cls: Class, options: unknown, owner: string): RuleViolation[] {
  if (!isBag(options)) return [];
  return Object.entries(options).flatMap(([field, value]) =>
    typeof value === "object" && value !== null
      ? recordedOptionsOf(value).flatMap((made) =>
          made.unknown.map((item) => {
            const bag = item.bag === undefined ? "" : `${shown(item.bag)} of `;
            const message =
              `${nameOf(cls)}${namedOf(options)}: ${shown(item.key)} is not an option of ` +
              `${made.decorator}(…) (in ${bag}${owner} ${shown(field)})` +
              hint(item);
            return violation("decorator.unknown-option", message, [nameOf(cls)]);
          }),
        )
      : [],
  );
}

/** The violations of one class's recorded options. */
function violationsOf(cls: Class): RuleViolation[] {
  return recordedOptionsOf(cls).flatMap((recorded) => [
    ...recorded.unknown.map((item) => {
      const place = item.bag === undefined ? "" : ` (in ${shown(item.bag)})`;
      const message =
        `${nameOf(cls)}: ${shown(item.key)} is not an option of @${recorded.decorator}${place}` +
        hint(item);
      return violation("decorator.unknown-option", message, [nameOf(cls)]);
    }),
    ...factoryViolationsOf(cls, recorded.options, `@${recorded.decorator}`),
  ]);
}

const isPlain = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** What a walk keeps: the classes seen, how many things it looked at, what it found. */
interface Walk {
  readonly seen: WeakSet<object>;
  readonly found: RuleViolation[];
  visited: number;
}

/** The things a value holds that may be classes: a class's recorded options and its parent class, a list's items, a plain object's values. */
function childrenOf(value: object, walk: Walk): readonly unknown[] {
  if (typeof value === "function") {
    const own = recordedOptionsOf(value);
    walk.found.push(...(own.length === 0 ? [] : violationsOf(value as Class)));
    // an overlay subclass (`profile`) is listed, its decorated parent is not
    return [...own.map((recorded) => recorded.options), Object.getPrototypeOf(value)];
  }
  if (Array.isArray(value)) return value;
  return isPlain(value) ? Object.values(value) : [];
}

function visit(value: unknown, depth: number, walk: Walk): void {
  const isThing = typeof value === "function" || (typeof value === "object" && value !== null);
  if (!isThing || walk.seen.has(value) || depth > MAX_DEPTH || ++walk.visited > MAX_VISITED) return;
  walk.seen.add(value);
  for (const child of childrenOf(value, walk)) visit(child, depth + 1, walk);
}

/**
 * The violations of the classes `roots` and of every class their recorded options list (providers,
 * tools, guardrails, … at any depth), each class once.
 */
export function unknownOptionViolations(roots: readonly Class[]): RuleViolation[] {
  const walk: Walk = { seen: new WeakSet(), found: [], visited: 0 };
  for (const root of roots) visit(root, 0, walk);
  return walk.found;
}

/** What a workflow's flow is made of: the workflow, every node's class and the arbiters of its launches. */
export const graphClassesOf = (workflow: Class, graph: FlowGraph): readonly Class[] => [
  workflow,
  ...[...graph.nodes.values()].map((node) => node.component),
  ...graph.edges.flatMap((edge) => edge.launch?.arbitratedBy ?? []),
];
