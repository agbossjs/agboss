/**
 * The HTML report's markup (#397 PR 1): a small tree of elements and texts rendered to a string.
 * Every text and every attribute value is escaped here — the one place the artifact's values (case
 * names, reasons, error messages) become markup — so no section writes HTML by hand.
 */

/** An attribute's value; `true` writes the bare attribute, `false` / undefined leave it out. */
export type HtmlAttributeValue = string | number | boolean | undefined;

export type HtmlAttributes = Readonly<Record<string, HtmlAttributeValue>>;

/** A text node: escaped when rendered. */
export interface HtmlText {
  readonly kind: "text";
  readonly text: string;
}

/** An element: its tag, attributes and children (none for a void element). */
export interface HtmlElement {
  readonly kind: "element";
  readonly tag: string;
  readonly attributes: HtmlAttributes;
  readonly children: readonly HtmlNode[];
}

export type HtmlNode = HtmlText | HtmlElement;

/** A child as written: a node, a plain string (a text), or nothing (left out). */
export type HtmlChild = HtmlNode | string | false | undefined;

/** Elements without a closing tag. */
const VOID_TAGS: ReadonlySet<string> = new Set(["meta", "br", "hr", "link", "img", "input"]);

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text or an attribute value made safe for HTML. */
export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, (found) => ESCAPES[found] ?? found);

const nodeOf = (child: HtmlChild): HtmlNode | undefined => {
  if (child === false || child === undefined) return undefined;
  return typeof child === "string" ? { kind: "text", text: child } : child;
};

/** An element; children that are `false` / undefined are left out. */
export function element(
  tag: string,
  attributes: HtmlAttributes = {},
  children: readonly HtmlChild[] = [],
): HtmlElement {
  const nodes = children.map(nodeOf).filter((node): node is HtmlNode => node !== undefined);
  return { kind: "element", tag, attributes, children: nodes };
}

function attributesOf(attributes: HtmlAttributes): string {
  return Object.entries(attributes)
    .filter(([, value]) => value !== undefined && value !== false)
    .map(([name, value]) =>
      value === true ? ` ${name}` : ` ${name}="${escapeHtml(String(value))}"`,
    )
    .join("");
}

/** The node as markup. */
export function renderHtml(node: HtmlNode): string {
  if (node.kind === "text") return escapeHtml(node.text);
  const open = `<${node.tag}${attributesOf(node.attributes)}>`;
  if (VOID_TAGS.has(node.tag)) return open;
  return `${open}${node.children.map(renderHtml).join("")}</${node.tag}>`;
}
