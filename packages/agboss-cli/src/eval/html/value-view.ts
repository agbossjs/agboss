import { element, type HtmlElement } from "./html.js";

/**
 * A value of a trajectory on the page (#397 PR 2): a tool's input or output, a decision, a run's
 * output — as indented JSON, cut at a bound so one huge value cannot fill the page (the run
 * artifact keeps it whole).
 */

/** The most characters of one value the page shows. */
export const MAX_VALUE_CHARACTERS = 2000;

/** The value as JSON text, cut at the bound with what was left out. */
export function valueText(value: unknown): string {
  const text = JSON.stringify(value ?? null, null, 2);
  if (text.length <= MAX_VALUE_CHARACTERS) return text;
  const left = text.length - MAX_VALUE_CHARACTERS;
  return `${text.slice(0, MAX_VALUE_CHARACTERS)}\n… [${String(left)} more characters in the run artifact]`;
}

/** A labelled value: `<figure>` with its caption and the JSON. */
export const valueView = (label: string, value: unknown): HtmlElement =>
  element("figure", { class: "value" }, [
    element("figcaption", {}, [label]),
    element("pre", {}, [element("code", {}, [valueText(value)])]),
  ]);
