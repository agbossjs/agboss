import type { Class } from "../components/injection.js";
import type { LabeledSpan, SourceSpan } from "../core/diagnostics/source-span.js";
import type { Diagnostic } from "../core/diagnostics/render-diagnostic.js";
import { ruleExplanationOf } from "../core/diagnostics/rule-catalog.js";
import { componentClassOfName, declarationOf } from "../flow/decorators/declaration.js";
import { stepSpanOfTarget } from "../flow/step-spans.js";
import type { RuleViolation } from "./rule-error.js";

/**
 * A broken rule as a `rustc`-style diagnostic (#1325c): `^^^` under where the first node it names
 * is written in the flow — the step that enters it — else where its class is decorated, `---` under
 * the others. A node whose place is not told (two classes of one name, a flow built without a file)
 * is named in the message only. The rule's words are the framework's own; the places are the user's.
 */

/** Where a node, named by its component name or class name, is written: its step in the flow, else its decorator. */
function siteOf(node: string): SourceSpan | undefined {
  const target: Class | undefined = componentClassOfName(node);
  if (target === undefined) return undefined;
  return stepSpanOfTarget(target) ?? declarationOf(target)?.span;
}

/** `first line of a message`: a multi-line message keeps its first line in the header. */
const headline = (message: string): string => message.split("\n")[0] ?? message;

/** The diagnostic of one violation: its places, the catalog's `means` as a note, its fix as help. */
export function diagnosticOfViolation(violation: RuleViolation): Diagnostic {
  const sites = violation.nodes.flatMap((node) => {
    const span = siteOf(node);
    return span === undefined ? [] : [{ node, span }];
  });
  const [first, ...others] = sites;
  const explained = ruleExplanationOf(violation.code);
  const label = (text: string, span: SourceSpan): LabeledSpan => ({ span, label: text });
  return {
    code: violation.code,
    message: headline(violation.message),
    ...(first === undefined
      ? {}
      : { primary: label(`\`${first.node}\` breaks this rule`, first.span) }),
    secondary: others.map(({ node, span }) => label(`\`${node}\` is involved`, span)),
    notes: explained === undefined ? [] : [explained.means],
    ...(explained?.fix === undefined ? {} : { help: explained.fix }),
  };
}
