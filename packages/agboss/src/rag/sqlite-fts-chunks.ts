const MAX_TERMS = 12;

/** Splits Markdown at headings, then merges paragraphs into chunks of at most `max` characters. */
export function chunkMarkdown(text: string, max: number): string[] {
  const paragraphs = text
    .split(/\n(?=#{1,6} )|\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs.flatMap((p) =>
    p.length <= max ? [p] : (p.match(new RegExp(`[\\s\\S]{1,${String(max)}}`, "g")) ?? []),
  )) {
    const startsSection = /^#{1,6} /.test(paragraph);
    if (current !== "" && (startsSection || current.length + paragraph.length + 2 > max)) {
      chunks.push(current);
      current = "";
    }
    current = current === "" ? paragraph : `${current}\n\n${paragraph}`;
  }
  if (current !== "") chunks.push(current);
  return chunks;
}

/** A user question as an FTS5 query: its distinct words (2+ letters), quoted, OR-ed. */
export function ftsQuery(query: string): string | undefined {
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((term) => term.length >= 2)
    .slice(0, MAX_TERMS);
  return terms.length === 0 ? undefined : terms.map((term) => `"${term}"`).join(" OR ");
}
