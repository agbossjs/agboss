import { METADATA_KEY } from "../../src/polyfills/symbol-metadata.js";
import { ListOf, Nested, Text } from "../../src/dto/index.js";
import type { DtoClass, FieldDecorator } from "../../src/dto/types.js";

/**
 * Cyclic DTO graphs for #1080. A class cannot name itself in its own decorators (its binding is not
 * initialised yet), so a cycle is closed after the fact: the decorator is applied to the finished class.
 */

/** Adds a field to a class that is already defined, as its decorator would have. */
export function addField<T>(owner: DtoClass, name: string, decorator: FieldDecorator<T>): void {
  const metadata: unknown = Reflect.get(owner, METADATA_KEY);
  decorator(undefined, { kind: "field", name, private: false, static: false, metadata } as never);
}

export class SelfDto {
  @Text({ prompt: "the name" })
  name!: string;
}
addField(SelfDto, "child", Nested(SelfDto, { optional: true }));

export class LeafDto {
  @Text({ prompt: "the leaf" })
  leaf!: string;
}

export class PingDto {
  @Nested(LeafDto)
  leaf!: LeafDto;
}

export class PongDto {
  @Nested(PingDto)
  ping!: PingDto;
}
addField(PingDto, "pong", Nested(PongDto, { optional: true }));

export class TreeDto {
  @Text({ prompt: "the label" })
  label!: string;
}
addField(TreeDto, "children", ListOf(TreeDto, { optional: true }));

/** Two fields hold the same DTO: a diamond, not a cycle. */
export class SharedDto {
  @Text({ prompt: "the value" })
  value!: string;
}

export class DiamondDto {
  @Nested(SharedDto)
  left!: SharedDto;

  @ListOf(SharedDto)
  right!: SharedDto[];
}

/** A chain `depth` DTOs long, each holding the next: deep and finite. */
export function chainOf(depth: number): DtoClass {
  let inner: DtoClass = SharedDto;
  for (let level = 0; level < depth; level += 1) {
    const holder: DtoClass = class {
      @Text({ prompt: "a level" })
      level!: string;
    };
    Object.defineProperty(holder, "name", { value: `Level${String(level)}Dto` });
    addField(holder, "next", Nested(inner));
    inner = holder;
  }
  return inner;
}
