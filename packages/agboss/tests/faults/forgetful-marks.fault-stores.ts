import {
  Injectable,
  SqliteConnection,
  SqliteExecutionTreeRepository,
  type ExecutionTree,
  type ExecutionTreeValue,
} from "../../src/index.js";
import { defineFaultStores } from "../../src/testing/faults/index.js";
import { faultStores as sqlite } from "./sqlite.fault-stores.js";

/**
 * #607 negative fixture: the SQLite set whose tree store forgets every undo's done mark
 * (`@agboss/compensated/…`) when it is read back — as the core did for a failed join's undo before
 * #607, which wrote none. The instance that takes the tree over undoes it again.
 */
@Injectable({ deps: [SqliteConnection] })
export class ForgetfulSqliteExecutionTreeRepository extends SqliteExecutionTreeRepository {
  override findByIdInTree(
    tree: ExecutionTree,
    key: string,
  ): Promise<ExecutionTreeValue | undefined> {
    if (key.startsWith("@agboss/compensated/")) return Promise.resolve(undefined);
    return super.findByIdInTree(tree, key);
  }
}

export const faultStores = defineFaultStores({
  ...sqlite,
  providers: sqlite.providers.map((store) =>
    store === SqliteExecutionTreeRepository ? ForgetfulSqliteExecutionTreeRepository : store,
  ),
});
