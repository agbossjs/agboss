/**
 * Where an e-mail address found by its broad pattern ends (#729): a file named after an address
 * (`anna@acme.com.pdf`, `anna@acme.com.mp4`) loses its extension, nothing else. The cut is made only
 * when the last label — with the letters and digits glued to it — is a common file extension that is
 * no top-level domain, and what is left is still a whole address; otherwise the match stays as it
 * is, so an address is never left partly unmasked (fail-closed).
 */

/** File extensions that are no top-level domain; one that is (`.md`, `.zip`, `.mov`, `.py`) is not here. */
const FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  (
    "pdf csv tsv txt json xml yaml yml html htm doc docx xls xlsx ppt pptx odt rtf png jpg jpeg " +
    "gif svg webp bmp tif tiff heic wav mp3 mp4 m4a eml msg vcf ics gz tar rar log bak tmp exe"
  ).split(" "),
);

/** An address that ends at its top-level domain. */
const WHOLE_ADDRESS = /@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/u;

/** Letters and digits glued right after a match: the rest of a label it split (`mp` + `4`). */
const GLUED = /^[A-Za-z0-9]*/u;

export function emailEndOf(text: string, start: number, end: number): number {
  const found = text.slice(start, end);
  const lastDot = found.lastIndexOf(".");
  const glued = GLUED.exec(text.slice(end))?.[0] ?? "";
  const label = `${found.slice(lastDot + 1)}${glued}`.toLowerCase();
  const head = found.slice(0, lastDot);
  return FILE_EXTENSIONS.has(label) && WHOLE_ADDRESS.test(head) ? start + lastDot : end;
}
