import { z } from "zod";
import type { ResolvedModelFiles } from "./file-settings.js";
import { AnswerFiles, FileSource, FileView, RedactionValues } from "./model-files.js";

/** An agent's files settings, every level applied (#899): what `files/file-settings.ts` resolves. */
export const AgentFilesSchema = z.object({
  sources: z.array(z.enum(FileSource)),
  views: z.array(z.enum(FileView)),
  maxFileSize: z.number(),
  maxTotalFileSize: z.number(),
  maxFiles: z.number(),
  allowedMediaTypes: z.array(z.string()),
  isTypesExplicit: z.boolean(),
  answerFiles: z.enum(AnswerFiles),
  guardToolResultFiles: z.boolean(),
  transcriptionModel: z.string(),
  redactionModel: z.string(),
  redactionValues: z.enum(RedactionValues),
  redactionSendsValues: z.boolean().optional(),
  transcriptionMaxTokens: z.number(),
}) satisfies z.ZodType<ResolvedModelFiles>;
