import { contentSecurityPolicyOf } from "../html/document.js";

/** The answers of `agboss eval ui` (#397 PR 3–4): text, a page, a redirect — each with its headers. */

/** What the server sends back. */
export interface EvalUiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

const BASE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

export const textResponse = (
  status: number,
  body: string,
  extra: Readonly<Record<string, string>> = {},
): EvalUiResponse => ({
  status,
  headers: { ...BASE_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...extra },
  body: `${body}\n`,
});

/** A page; its forms post only to this server. */
export const htmlResponse = (body: string): EvalUiResponse => ({
  status: 200,
  headers: {
    ...BASE_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": contentSecurityPolicyOf(true),
  },
  body,
});

/** After a form: back to a page (POST, then GET). */
export const seeOther = (location: string): EvalUiResponse => ({
  status: 303,
  headers: { ...BASE_HEADERS, Location: location },
  body: "",
});
