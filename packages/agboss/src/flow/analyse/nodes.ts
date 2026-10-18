import type { Class } from "../../components/injection.js";
import { violation, type RuleViolation } from "../../graph/rule-error.js";
import type { NodeKind } from "../ast.js";
import { declarationOf } from "../decorators/declaration.js";
import { ComponentRegistry, type ComponentName } from "../registry.js";
import type { FlowNode } from "./flow-graph.js";
import { classLabel, toCallOf } from "./labels.js";

/**
 * The nodes of one workflow's graph, by `name` (#272: one class = one node). A class is looked up
 * where the flow mentions it; an undecorated class, a class of another kind than the transition
 * names, and a second class under a taken `name` are reported once each.
 */
export class NodeTable {
  private readonly registry = new ComponentRegistry();
  private readonly byName = new Map<ComponentName, FlowNode>();
  private readonly reported = new Set<string>();
  readonly violations: RuleViolation[] = [];

  /** The node of `component`, mentioned as `kind`; `undefined` when it cannot be a node. */
  resolve(component: Class, kind: NodeKind): ComponentName | undefined {
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
    if (!this.byName.has(name)) this.byName.set(name, { name, kind, component, declaration });
    return name;
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

const notANode = (component: Class, kind: NodeKind): string =>
  `${toCallOf(kind)}(${classLabel(component)}): ${classLabel(component)} has no ` +
  "@WorkflowStart / @Agent / @Action / @Router / @WorkflowFinish / @Workflow decorator — decorate it";

const wrongKind = (component: Class, name: string, actual: NodeKind, mentioned: NodeKind): string =>
  `${toCallOf(mentioned)}(${classLabel(component)}): ${name} is ${articled(actual)}, not ` +
  `${articled(mentioned)} — use ${toCallOf(actual)}(${classLabel(component)})`;

const articled = (kind: NodeKind): string =>
  /^[aeiou]/.test(kind) ? `an ${kind.replace(/-/g, " ")}` : `a ${kind.replace(/-/g, " ")}`;

const duplicateName = (name: string, first: Class, second: Class): string =>
  `${classLabel(first)} and ${classLabel(second)} are both named "${name}" — a name is unique ` +
  "in the application (it keys records and checkpoints); rename one";
