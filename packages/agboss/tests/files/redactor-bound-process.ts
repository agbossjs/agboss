/**
 * #1257: the process of the memory test — `node --import tsx redactor-bound-process.ts <regions>`
 * redacts a solid 6324 x 6324 PNG (about 40 MP, ~18 KiB) with that many model-given regions and reports
 * its peak resident memory in MB (IPC; stdout is only logs).
 */
import { FakeListChatModel } from "@langchain/core/utils/testing";
import sharp from "sharp";
import { sha256Of } from "../../src/files/file-bytes.js";
import { redacted } from "../../src/files/model-image-redactor-work.js";
import { usd } from "../../src/units/index.js";

const count = Number(process.argv[2]);
const SIDE = 6324;
const bytes = await sharp({
  create: { width: SIDE, height: SIDE, channels: 3, background: "#ffffff" },
})
  .png({ compressionLevel: 9 })
  .toBuffer();
const regions = Array.from({ length: count }, (_, at) => ({
  target: "value",
  x: (at % 20) / 25,
  y: Math.floor(at / 20) / 30,
  w: 0.2,
  h: 0.2,
}));
const settings = {
  model: "test/redactor",
  temperature: 0,
  maxTokens: 100,
  thinking: "default" as const,
  cache: true,
  timeout: 1000,
  maxRetries: 0,
  price: { inputPerMillion: usd(1), outputPerMillion: usd(1) },
};
sharp.cache(false);
const result = await redacted(
  { model: new FakeListChatModel({ responses: [JSON.stringify({ regions })] }), settings },
  "reader-agent",
  { mediaType: "image/png", bytes, sha256: sha256Of(bytes) },
  { targets: [], values: ["Dana Cohen"], signal: new AbortController().signal, tenantId: "acme" },
);
process.send?.({
  peakMb: Math.round(process.resourceUsage().maxRSS / 1024),
  bytes: result.file.bytes.length,
});
