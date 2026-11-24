import { expectTypeOf, test } from "vitest";
import { listOf, oneOf, type ValueOf } from "../../../src/flow/dto-wrappers.js";
import { Text } from "../../../src/dto/index.js";
import * as dto from "../../../src/dto/index.js";

class ScoreDto {
  @Text() vendor!: string;
}
class RejectedDto {
  @Text() reason!: string;
}

test("#1288a: listOf(A) is a list of A, listOf(A, B) a list of the union", () => {
  const one = listOf(ScoreDto);
  const many = listOf(ScoreDto, RejectedDto);
  const wrapped = listOf(ScoreDto, RejectedDto);

  expectTypeOf<ValueOf<typeof one>>().toEqualTypeOf<readonly ScoreDto[]>();
  expectTypeOf<ValueOf<typeof many>>().toEqualTypeOf<readonly (ScoreDto | RejectedDto)[]>();
  expectTypeOf<ValueOf<typeof wrapped>>().toEqualTypeOf<readonly (ScoreDto | RejectedDto)[]>();
});

test("#1288a: listOf takes classes only, and none of the wrappers is exported from /dto", () => {
  // @ts-expect-error a list of nothing
  listOf();
  // @ts-expect-error a string is no DTO class
  listOf("ScoreDto");
  expectTypeOf(dto).not.toHaveProperty("listOf");
  expectTypeOf(dto).not.toHaveProperty("oneOf");
  expectTypeOf(dto).not.toHaveProperty("optional");
  expectTypeOf(dto).not.toHaveProperty("historyOf");
});
