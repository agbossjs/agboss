// Lint rule `agboss/no-component-state` (#261, #388): a component is one instance for the whole
// application instance, and one execution is not tied to one instance (after a pause another
// instance may continue it), so a component keeps no state. Flags `this.x = …` (and `this.x++`,
// `this.x += …`) outside the constructor and the lifecycle hooks (`onInit`, `onReady`, `onBeforeDestroy`, `onDestroy`) of a class decorated with a framework component decorator.
// A component reads the execution from the live `ExecutionContext`; data that outlive a step live
// in the graph state; caches and deduplication are the project's own service over external storage.
import { AST_NODE_TYPES, type TSESLint, type TSESTree } from "@typescript-eslint/utils";
import { COMPONENT_DECORATORS } from "../components/component-decorators.js";

/** The decorators that make a class a component the container creates once (#402: one list). */
const COMPONENT_DECORATOR_NAMES: ReadonlySet<string> = new Set(COMPONENT_DECORATORS);

/** The message of the rule. */
export type ComponentStateMessageId = "state";

type ClassNode = TSESTree.ClassDeclaration | TSESTree.ClassExpression;

const nameOf = (callee: TSESTree.Expression): string | undefined => {
  if (callee.type === AST_NODE_TYPES.Identifier) return callee.name;
  if (
    callee.type === AST_NODE_TYPES.MemberExpression &&
    callee.property.type === AST_NODE_TYPES.Identifier
  )
    return callee.property.name;
  return undefined;
};

/** The component decorator's name on the class, else undefined. */
function componentDecorator(cls: ClassNode): string | undefined {
  for (const decorator of cls.decorators) {
    const call = decorator.expression;
    const name = call.type === AST_NODE_TYPES.CallExpression ? nameOf(call.callee) : undefined;
    if (name !== undefined && COMPONENT_DECORATOR_NAMES.has(name)) return name;
  }
  return undefined;
}

/** The container's lifecycle hooks: a field set only there is wired once, before or after the work (#1324). */
const LIFECYCLE_HOOKS: ReadonlySet<string> = new Set([
  "onInit",
  "onReady",
  "onBeforeDestroy",
  "onDestroy",
]);

const isLifecycleHook = (node: TSESTree.Node): boolean =>
  node.type === AST_NODE_TYPES.MethodDefinition &&
  node.key.type === AST_NODE_TYPES.Identifier &&
  !node.computed &&
  LIFECYCLE_HOOKS.has(node.key.name);

const isConstructor = (node: TSESTree.Node): boolean =>
  (node.type === AST_NODE_TYPES.MethodDefinition && node.kind === "constructor") ||
  isLifecycleHook(node);

const isStatic = (node: TSESTree.Node): boolean =>
  (node.type === AST_NODE_TYPES.MethodDefinition ||
    node.type === AST_NODE_TYPES.PropertyDefinition) &&
  node.static;

/** Whether the function at `ancestors[at]` is a member of its class (its `this` is the instance). */
const isMemberFunction = (ancestors: readonly TSESTree.Node[], at: number): boolean => {
  const parent = ancestors[at - 1];
  return (
    parent?.type === AST_NODE_TYPES.MethodDefinition ||
    parent?.type === AST_NODE_TYPES.PropertyDefinition
  );
};

const isClass = (node: TSESTree.Node | undefined): node is ClassNode =>
  node?.type === AST_NODE_TYPES.ClassDeclaration || node?.type === AST_NODE_TYPES.ClassExpression;

/**
 * The class whose instance `this` is at the node, when the node is outside its constructor; else
 * undefined (inside the constructor, a static member, or a plain function with its own `this`).
 */
function ownerOutsideConstructor(ancestors: readonly TSESTree.Node[]): ClassNode | undefined {
  for (let at = ancestors.length - 1; at >= 0; at--) {
    const node = ancestors[at];
    if (node === undefined || isConstructor(node) || isStatic(node)) return undefined;
    if (node.type === AST_NODE_TYPES.FunctionDeclaration) return undefined;
    if (node.type === AST_NODE_TYPES.FunctionExpression && !isMemberFunction(ancestors, at))
      return undefined;
    if (node.type === AST_NODE_TYPES.ClassBody) {
      const owner = ancestors[at - 1];
      return isClass(owner) ? owner : undefined;
    }
  }
  return undefined;
}

/** What an assignment, a `for … of` head or a pattern writes: `[this.a, { b: this.b }]` is two writes. */
function writeTargetsOf(target: TSESTree.Node | null): readonly TSESTree.Node[] {
  if (target === null) return [];
  switch (target.type) {
    case AST_NODE_TYPES.ArrayPattern:
      return target.elements.flatMap(writeTargetsOf);
    case AST_NODE_TYPES.ObjectPattern:
      return target.properties.flatMap((one) =>
        writeTargetsOf(one.type === AST_NODE_TYPES.Property ? one.value : one.argument),
      );
    case AST_NODE_TYPES.RestElement:
      return writeTargetsOf(target.argument);
    case AST_NODE_TYPES.AssignmentPattern:
      return writeTargetsOf(target.left);
    default:
      return [target];
  }
}

export const noComponentState: TSESLint.RuleModule<ComponentStateMessageId> = {
  defaultOptions: [],
  meta: {
    type: "problem",
    docs: { description: "No state on `this` outside the constructor of a component" },
    messages: {
      state:
        "`this.{{field}} = …` outside the constructor of a @{{decorator}}: a component is one instance for the whole application and keeps no state. Read the execution from ExecutionContext, keep data that outlive a step in the graph state, and caches or deduplication in your own service over external storage.",
    },
    schema: [],
  },
  create(context) {
    const check = (node: TSESTree.Node, written: TSESTree.Node | null): void => {
      for (const target of writeTargetsOf(written)) checkTarget(node, target);
    };
    const checkTarget = (node: TSESTree.Node, target: TSESTree.Node): void => {
      if (
        target.type !== AST_NODE_TYPES.MemberExpression ||
        target.object.type !== AST_NODE_TYPES.ThisExpression
      )
        return;
      const cls = ownerOutsideConstructor(context.sourceCode.getAncestors(node));
      const decorator = cls === undefined ? undefined : componentDecorator(cls);
      if (decorator === undefined) return;
      const { property } = target;
      const field =
        property.type === AST_NODE_TYPES.Identifier
          ? property.name
          : property.type === AST_NODE_TYPES.PrivateIdentifier
            ? `#${property.name}`
            : "[…]";
      context.report({ node, messageId: "state", data: { field, decorator } });
    };
    return {
      AssignmentExpression: (node) => {
        check(node, node.left);
      },
      UpdateExpression: (node) => {
        check(node, node.argument);
      },
      // `delete this.x` removes state as `this.x = …` writes it
      UnaryExpression: (node) => {
        if (node.operator === "delete") check(node, node.argument);
      },
      ForOfStatement: (node) => {
        check(node, node.left.type === AST_NODE_TYPES.VariableDeclaration ? null : node.left);
      },
      ForInStatement: (node) => {
        check(node, node.left.type === AST_NODE_TYPES.VariableDeclaration ? null : node.left);
      },
    };
  },
};
