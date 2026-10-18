// Local lint rule (#261): a component is one instance for the whole application instance, and one
// execution is not tied to one instance (after a pause another instance may continue it), so a
// component keeps no state. Flags `this.x = …` (and `this.x++`, `this.x += …`) outside the
// constructor of a class decorated with a framework component decorator. A component reads the
// execution from the live `ExecutionContext`; data that outlive a step live in the graph state;
// caches and deduplication are the project's own service over external storage.

const COMPONENT_DECORATORS = new Set([
  "Injectable",
  "Tool",
  "McpTool",
  "McpServer",
  "Rag",
  "Action",
  "Router",
  "WorkflowFinish",
  "Channel",
  "Guardrail",
  "PiiPolicy",
  "Judge",
  "InboundChannelAdapter",
  "SemanticInboundChannelAdapter",
  "A2AAgent",
]);

const nameOf = (callee) =>
  callee.type === "Identifier"
    ? callee.name
    : callee.type === "MemberExpression" && callee.property.type === "Identifier"
      ? callee.property.name
      : undefined;

/** The component decorator's name on the class, else undefined. */
function componentDecorator(cls) {
  for (const decorator of cls.decorators ?? []) {
    const call = decorator.expression;
    const name = call.type === "CallExpression" ? nameOf(call.callee) : undefined;
    if (name !== undefined && COMPONENT_DECORATORS.has(name)) return name;
  }
  return undefined;
}

const isConstructor = (node) => node.type === "MethodDefinition" && node.kind === "constructor";

/** Whether the function at `ancestors[i]` is a member of its class (its `this` is the instance). */
const isMemberFunction = (ancestors, i) => {
  const parent = ancestors[i - 1];
  return parent?.type === "MethodDefinition" || parent?.type === "PropertyDefinition";
};

/**
 * The class whose instance `this` is at the node, when the node is outside its constructor; else
 * undefined (inside the constructor, a static member, or a plain function with its own `this`).
 */
function ownerOutsideConstructor(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (isConstructor(node) || node.static === true) return undefined;
    if (node.type === "FunctionDeclaration") return undefined;
    if (node.type === "FunctionExpression" && !isMemberFunction(ancestors, i)) return undefined;
    if (node.type === "ClassBody") return ancestors[i - 1];
  }
  return undefined;
}

export const noComponentState = {
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
    const check = (node, target) => {
      if (target.type !== "MemberExpression" || target.object.type !== "ThisExpression") return;
      const cls = ownerOutsideConstructor(context.sourceCode.getAncestors(node));
      const decorator = cls === undefined ? undefined : componentDecorator(cls);
      if (decorator === undefined) return;
      const field = target.property.type === "Identifier" ? target.property.name : "[…]";
      context.report({ node, messageId: "state", data: { field, decorator } });
    };
    return {
      AssignmentExpression: (node) => check(node, node.left),
      UpdateExpression: (node) => check(node, node.argument),
    };
  },
};
