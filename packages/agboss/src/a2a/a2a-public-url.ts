import { ComponentError } from "../components/metadata.js";

/** A listener's `publicUrl` + `base`, checked: an absolute http(s) URL, no query or fragment. */
export function interfaceUrlOf(publicUrl: string, base: string): string {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    throw new ComponentError({
      message: `[a2a.public-url-invalid] a2aHttpListener's publicUrl is not an absolute URL`,
    });
  }
  const isHttp = url.protocol === "http:" || url.protocol === "https:";
  if (!isHttp || url.search !== "" || url.hash !== "")
    throw new ComponentError({
      message: `[a2a.public-url-invalid] a2aHttpListener's publicUrl is an http(s) URL without a query or fragment`,
    });
  if (base !== "" && (!base.startsWith("/") || base.endsWith("/")))
    throw new ComponentError({
      message: `[a2a.base-invalid] a2aHttpListener's base starts with "/" and does not end with one`,
    });
  return `${publicUrl.replace(/\/+$/, "")}${base}`;
}
