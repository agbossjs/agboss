import { violation, type RuleViolation } from "../../graph/rule-error.js";

/** The media types taken by default: images, PDF, plain text, Markdown, CSV and JSON. */
export const DEFAULT_A2A_FILE_MEDIA_TYPES: readonly string[] = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/csv",
  "application/json",
]);

/** A media type as compared: its essence, lower case (`Text/Plain; charset=utf-8` → `text/plain`). */
export const mediaTypeEssenceOf = (mediaType: string): string => {
  const [essence] = mediaType.split(";", 1);
  // Stryker disable next-line StringLiteral: equivalent: `split` yields one element at least
  return (essence ?? "").trim().toLowerCase();
};

/**
 * How an Agent Card describes a skill's file fields (#904), its input's and its finishes' (#916):
 * they are sent as file parts, never in a data part, so no data schema of the skill asks for them.
 */
export enum A2ACardFileFields {
  /**
   * Out of the data `input` schema and each finish's output schema (and their `required`), declared
   * in the skills extension as `files: { <field>: { list, optional, mediaTypes } }` and, by finish,
   * `outputFiles: { <finish>: { <field>: … } }` (#916) — the default.
   */
  Extension = "extension",
  /**
   * In the data schemas, each one's schema `{ "x-agboss-file-part": { list, optional, mediaTypes },
   * description }` (#916: the declaration `Extension` makes) and never `required`: a validator that
   * does not know the keyword asks nothing of it in data.
   */
  Marker = "marker",
}

/** What an `@A2AExpose` says of its card's file fields: for all its skills, or for one. */
export interface CardFileFieldsSource {
  readonly cardFileFields?: A2ACardFileFields;
  readonly skills?: Readonly<Record<string, { readonly cardFileFields?: A2ACardFileFields }>>;
}

/** How the card of `expose` describes the file fields of the skill `start`: its own, the expose's, `Extension`. */
export const cardFileFieldsOf = (expose: CardFileFieldsSource, start: string): A2ACardFileFields =>
  expose.skills?.[start]?.cardFileFields ?? expose.cardFileFields ?? A2ACardFileFields.Extension;

const VALUES = new Set<unknown>(Object.values(A2ACardFileFields));

/**
 * `[a2a.file-options-invalid]`, a value that is none of the enum's (a JS caller, a cast), and
 * `[a2a.unknown-skill-option]`, one set for a skill the expose does not export.
 */
export function cardFileFieldsViolations(
  name: string,
  expose: CardFileFieldsSource,
  exported: ReadonlySet<string | undefined>,
  where: string,
): RuleViolation[] {
  const unknown = Object.entries(expose.skills ?? {})
    .filter(([skill, options]) => options.cardFileFields !== undefined && !exported.has(skill))
    .map(([skill]) =>
      violation(
        "a2a.unknown-skill-option",
        `${name} sets the cardFileFields of ${skill}, which it does not export — name an exported start`,
        [where],
      ),
    );
  return [...unknown, ...invalidValues(name, expose, where)];
}

function invalidValues(name: string, expose: CardFileFieldsSource, where: string): RuleViolation[] {
  const given: [string, unknown][] = [
    ["cardFileFields", expose.cardFileFields],
    ...Object.entries(expose.skills ?? {}).map(([skill, options]): [string, unknown] => [
      `skills["${skill}"].cardFileFields`,
      options.cardFileFields,
    ]),
  ];
  return given
    .filter(([, value]) => value !== undefined && !VALUES.has(value))
    .map(([at]) =>
      violation(
        "a2a.file-options-invalid",
        `${name}'s ${at} is not an A2ACardFileFields (Extension or Marker)`,
        [where],
      ),
    );
}
