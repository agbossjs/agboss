/** SQL text with its comments and quoted strings and identifiers blanked, so only keywords remain. */
const stripped = (sql: string): string =>
  sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/g, " ");

/** A statement that changes the database; `replace(` is the string function, not the statement. */
const WRITE = /\b(?:insert|update|delete|create|drop|alter)\b|\breplace\b(?!\s*\()/i;

/**
 * Whether the prepared `sql` writes (#1017): it holds a data or schema change keyword outside its
 * comments and quoted text. A write is a write whichever statement method runs it — an
 * `UPDATE … RETURNING` is read through `get` or `all` — so the SQL, not the method, decides. A
 * statement that is not a write (a `SELECT`, a `PRAGMA`) never is classified: reads are ordinary.
 */
export const isWriteSql = (sql: string): boolean => WRITE.test(stripped(sql));
