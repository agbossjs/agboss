import type { FlowNodeKind } from "../ast.js";
import { ComponentKind } from "../runtime/records.js";
import type { Class } from "../../components/injection.js";
import { violation, type RuleViolation } from "../../graph/rule-error.js";
import { declarationOf, type ComponentDeclaration } from "../decorators/declaration.js";
import { ComponentRegistry, type ComponentName } from "../registry.js";
import type { FlowNode } from "./flow-graph.js";
import { classLabel, toCallOf } from "./labels.js";

/**
 * The nodes of one workflow's graph, by `name` (#272: one class = one node). A class is looked up
 * where the flow mentions it; an undecorated class, a class of another kind than the transition
 * names, and a second class under a taken `name` are reported once each. `self`, the workflow whose
 * flow is walked, may name its own class (`toWorkflow(() => Self)`, #1287): a node of its own name
 * that launches the workflow again, marked `recursionOf`.
 */
export class NodeTable {
  private readonly registry = new ComponentRegistry();
  private readonly byName = new Map<ComponentName, FlowNode>();
  private readonly reported = new Set<string>();
  readonly violations: RuleViolation[] = [];

  constructor(private readonly self?: Class) {}

  /** The node of `component`, mentioned as `kind`; `undefined` when it cannot be a node. */
  resolve(component: Class | undefined, kind: FlowNodeKind): ComponentName | undefined {
    if (component === undefined) {
      this.reportOnce("graph.mutual-recursion", "undefined", undefinedNode(kind));
      return undefined;
    }
    const declaration = declarationOf(component);
    if (declaration === undefined) {
      this.reportOnce("graph.not-a-node", classLabel(component), notANode(component, kind));
      return undefined;
    }
    const name = declaration.options.name as ComponentName;
    if (declaration.kind !== kind) {
      const message = wrongKind(component, name, declaration.kind, kind);
      this.reportOnce("graph.wrong-kind", `${name}:${kind}`, message, name);
      return undefined;
    }
    const clash = this.registry.register(component);
    if (clash !== undefined) {
      const message = duplicateName(name, clash.registered.component, component);
      this.reportOnce("graph.duplicate-node-name", name, message, name);
      return name;
    }
    if (!this.byName.has(name)) this.byName.set(name, this.nodeOf(component, kind, declaration));
    return name;
  }

  /** The node of a class; the walked workflow's own class is a recursion (#264, #1287). */
  private nodeOf(
    component: Class,
    kind: FlowNodeKind,
    declaration: ComponentDeclaration,
  ): FlowNode {
    const name = declaration.options.name as ComponentName;
    return component === this.self
      ? { name, kind, component, declaration, recursionOf: component }
      : { name, kind, component, declaration };
  }

  /** The nodes, sorted by name. */
  get nodes(): ReadonlyMap<ComponentName, FlowNode> {
    const names = [...this.byName.keys()].sort();
    return new Map(names.map((name) => [name, this.node(name)]));
  }

  node(name: ComponentName): FlowNode {
    const node = this.byName.get(name);
    if (node === undefined) throw new RangeError(`no node named ${name}`);
    return node;
  }

  private reportOnce(code: RuleViolation["code"], key: string, message: string, node?: string) {
    if (this.reported.has(`${code}|${key}`)) return;
    this.reported.add(`${code}|${key}`);
    this.violations.push(violation(code, message, node === undefined ? [] : [node]));
  }
}

const undefinedNode = (kind: FlowNodeKind): string =>
  `${toCallOf(kind)}(…) names a class that is undefined while the flow is built — usually a ` +
  "circular import, as in mutual recursion (A → B → A), which is not supported: a workflow " +
  "launches itself with toWorkflow(() => ItsOwnClass), and one workflow never launches another " +
  "that launches it";

const notANode = (component: Class, kind: FlowNodeKind): string =>
  `${toCallOf(kind)}(${classLabel(component)}): ${classLabel(component)} has no ` +
  "@WorkflowStart / @Agent / @Action / @Router / @WorkflowFinish / @Workflow decorator — decorate it" +
  (kind === ComponentKind.ExternalTask
    ? "; a question is a @ChannelRole class — name the role, not a @Channel class that extends it"
    : "");

const wrongKind = (
  component: Class,
  name: string,
  actual: FlowNodeKind,
  mentioned: FlowNodeKind,
): string =>
  `${toCallOf(mentioned)}(${classLabel(component)}): ${name} is ${articled(actual)}, not ` +
  `${articled(mentioned)} — use ${toCallOf(actual)}(${classLabel(component)})`;

const articled = (kind: FlowNodeKind): string =>
  /^[aeiou]/.test(kind) ? `an ${kind.replace(/-/g, " ")}` : `a ${kind.replace(/-/g, " ")}`;

const duplicateName = (name: string, first: Class, second: Class): string =>
  `${classLabel(first)} and ${classLabel(second)} are both named "${name}" — a name is unique ` +
  "in the application (it keys records and checkpoints); rename one";
