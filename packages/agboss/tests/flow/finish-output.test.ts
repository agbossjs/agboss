import { describe, expect, it } from "vitest";
import { WorkflowStartTextDto } from "../../src/dto/index.js";
import { listOf, oneOf } from "../../src/flow/dto-wrappers.js";
import {
  listItemClassesOf,
  outputClassesOf,
  plainOutputClassOf,
} from "../../src/flow/finish-output.js";
import { CompanyDto, CompanyScoreDto } from "./fixtures/data-dtos.js";

describe("#1271: a finish's output, one DTO or a list", () => {
  it("a list is never read as its item class (judges, A2A file tier)", () => {
    expect(plainOutputClassOf(CompanyDto)).toBe(CompanyDto);
    expect(plainOutputClassOf(listOf(CompanyDto))).toBeUndefined();
    expect(plainOutputClassOf(listOf(CompanyDto, CompanyScoreDto))).toBeUndefined();
  });

  it("the item classes of a list, every oneOf variant included; none for a plain DTO", () => {
    expect(listItemClassesOf(CompanyDto)).toEqual([]);
    expect(listItemClassesOf(listOf(CompanyDto))).toEqual([CompanyDto]);
    expect(listItemClassesOf(listOf(CompanyDto, WorkflowStartTextDto))).toEqual([
      CompanyDto,
      WorkflowStartTextDto,
    ]);
    expect(outputClassesOf(listOf(CompanyDto, CompanyScoreDto))).toEqual([
      CompanyDto,
      CompanyScoreDto,
    ]);
  });
});
