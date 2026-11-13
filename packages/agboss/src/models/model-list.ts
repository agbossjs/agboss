import { z } from "zod";
import type { ProviderConnection } from "./handler.js";

/** One model in an OpenAI-compatible `GET /models` reply; OpenRouter adds what each model supports. */
export interface ModelEntry {
  readonly id: string;
  readonly supported_parameters?: string[] | undefined;
  readonly reasoning?:
    | {
        readonly mandatory?: boolean | undefined;
        readonly supported_efforts?: string[] | undefined;
        readonly [key: string]: unknown;
      }
    | undefined;
  readonly pricing?: Record<string, unknown> | undefined;
  readonly [key: string]: unknown;
}

const ModelEntrySchema = z.looseObject({
  id: z.string(),
  supported_parameters: z.array(z.string()).optional(),
  reasoning: z
    .looseObject({
      mandatory: z.boolean().optional(),
      supported_efforts: z.array(z.string()).optional(),
    })
    .optional(),
  pricing: z.record(z.string(), z.unknown()).optional(),
}) satisfies z.ZodType<ModelEntry>;

const ModelListSchema = z.looseObject({ data: z.array(ModelEntrySchema) });

export class ModelListError extends Error {
  override name = "ModelListError";
}

/** The provider's model list (`GET {baseUrl}/models`), by model id. */
export async function fetchModelList(
  connection: ProviderConnection,
): Promise<ReadonlyMap<string, ModelEntry>> {
  const headers: Record<string, string> =
    connection.apiKey === undefined ? {} : { authorization: `Bearer ${connection.apiKey}` };
  const response = await connection.fetch(`${connection.baseUrl.replace(/\/$/, "")}/models`, {
    headers,
  });
  if (!response.ok) {
    throw new ModelListError(
      `${connection.provider}: GET /models answered ${String(response.status)}`,
    );
  }
  const parsed = ModelListSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new ModelListError(
      `${connection.provider}: GET /models: ${z.prettifyError(parsed.error)}`,
    );
  }
  return new Map(parsed.data.data.map((entry) => [entry.id, entry] as const));
}

/** The list fetched once per provider instance. */
export class ModelListCache {
  private list: Promise<ReadonlyMap<string, ModelEntry>> | undefined;

  entryOf(model: string, connection: ProviderConnection): Promise<ModelEntry | undefined> {
    this.list ??= fetchModelList(connection);
    return this.list.then((list) => list.get(model));
  }
}
