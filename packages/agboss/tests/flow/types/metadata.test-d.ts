import { describe, expectTypeOf, it } from "vitest";
import {
  Metadata,
  type Tracked,
  type Untracked,
  type ValueMetadata,
} from "../../../src/flow/metadata.js";

class WriterAgent {
  readonly fixture = true;
}
class NoteDto {
  text = "";
}

describe("#1274a: Tracked, Untracked and Metadata", () => {
  it("with() gives a Tracked value; of / createdBy narrow on it and are optional on a plain one", () => {
    const tracked = Metadata.with(new NoteDto(), { createdBy: WriterAgent });

    expectTypeOf(tracked).toEqualTypeOf<Tracked<NoteDto, typeof WriterAgent>>();
    expectTypeOf(Metadata.createdBy(tracked)).toEqualTypeOf<typeof WriterAgent>();
    expectTypeOf(Metadata.of(tracked)).toEqualTypeOf<ValueMetadata<typeof WriterAgent>>();
    expectTypeOf(Metadata.of(new NoteDto())).toEqualTypeOf<ValueMetadata | undefined>();
    expectTypeOf(Metadata.ancestors(tracked)).toEqualTypeOf<readonly ValueMetadata[]>();
  });

  it("Untracked takes the brand off, and a plain DTO is no Tracked one", () => {
    expectTypeOf<Untracked<Tracked<NoteDto, typeof WriterAgent>>>().toExtend<NoteDto>();
    expectTypeOf<NoteDto>().not.toExtend<Tracked<NoteDto>>();
  });

  it("Metadata is an abstract class with static methods (#1274)", () => {
    expectTypeOf<typeof Metadata.has>().guards.toEqualTypeOf<Tracked<object>>();
    // @ts-expect-error an abstract class is never constructed
    new Metadata();
  });
});
