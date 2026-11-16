import { describe, expect, it } from "vitest";
import { protocolErrorBytesOf } from "../../../src/testing/faults/cluster-options.js";

/**
 * #1017 — the bytes `DatabaseProxy.answerAfter` writes in place of a PostgreSQL COMMIT's answer: an
 * ErrorResponse as PgBouncer sends it when its server connection breaks (FATAL, 08P01).
 */
describe("#1017: protocolErrorBytesOf", () => {
  const nul = (text: string): number[] => [...Buffer.from(text, "utf8"), 0];

  it("PostgreSQL: an ErrorResponse with severity FATAL, SQLSTATE 08P01 and PgBouncer's message", () => {
    const fields = [
      ...nul("SFATAL"),
      ...nul("VFATAL"),
      ...nul("C08P01"),
      ...nul("Mserver conn crashed?"),
      0,
    ];
    const length = Buffer.alloc(4);
    length.writeInt32BE(fields.length + 4);

    for (const scheme of ["postgres", "postgresql"])
      expect([...(protocolErrorBytesOf(`${scheme}://u:p@127.0.0.1:5432/db`) ?? [])]).toEqual([
        0x45,
        ...length,
        ...fields,
      ]);
  });

  it("another database, a file or text that is no URL: none", () => {
    for (const url of [
      "mongodb://127.0.0.1:27017/db",
      "mongodb+srv://example.com/db",
      "redis://127.0.0.1:6379",
      "file:///tmp/x.sqlite",
      "/tmp/x.sqlite",
    ])
      expect(protocolErrorBytesOf(url)).toBeUndefined();
  });
});
