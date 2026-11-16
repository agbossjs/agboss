import { describe, expect, it } from "vitest";
import { isWriteSql } from "../../../src/infrastructure/sqlite/sqlite-write-sql.js";

/** #1017: a statement is a write by its SQL — keywords outside comments and quoted text. */

describe("#1017: isWriteSql", () => {
  it.each([
    "insert into t values (1)",
    "INSERT INTO t VALUES (1)",
    "update t set a = 1",
    "UPDATE t SET a = 1 RETURNING a",
    "delete from t",
    "create table t (a)",
    "drop table t",
    "alter table t add b",
    "replace into t values (1)",
    "insert or replace into t values (1)",
    "/* c */ update t set a = 1 /* d */",
    "create/**/table t (a)",
    "-- a read?\nupdate t set a = 1",
    "select 'x'; update t set a = 1",
    'update "t" set a = 1',
    "with c as (select 1) insert into t select * from c",
  ])("%s is a write", (sql) => {
    expect(isWriteSql(sql)).toBe(true);
  });

  it.each([
    "select 1",
    "pragma journal_mode",
    "select 'update'",
    "select 'it''s an update'",
    'select "insert" from t',
    'select "a ""drop"" b" from t',
    "select `delete` from t",
    "select [replace] from t",
    "select 1 -- delete from t",
    "select 1 /* update */",
    "select /* a\n insert \n b */ 1",
    "select /* a */ 1 /* delete */ from t",
    "select replace(a, 'b', 'c') from t",
    "select replace (a, 'b', 'c') from t",
    "select updated, reinsert, created_at, replace_count, undelete from t",
  ])("%s is not", (sql) => {
    expect(isWriteSql(sql)).toBe(false);
  });
});
