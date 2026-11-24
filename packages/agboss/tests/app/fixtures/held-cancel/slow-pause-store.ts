import { Clock, Injectable } from "../../../../src/index.js";
import { SqlitePausedExecutionRepository } from "../../../../src/index.js";
import { SqliteConnection } from "../../../../src/infrastructure/sqlite/sqlite-connection.js";
import { seconds } from "../../../../src/units/index.js";

/**
 * #1093: the pause store of a slow database: an extension's compare-and-set (and a reassignment's transaction, #946) takes a second, spent
 * on `Clock.sleep` — the way a slow call waits in a bound — and `SystemClock.sleep`'s timer does
 * not keep Node running. A script that only calls `app.extendPause` has nothing else alive while
 * it waits, so only the call's own keep-alive stands between it and an exit with code 13.
 */
@Injectable({ deps: [SqliteConnection, Clock] })
export class SlowPauseStore extends SqlitePausedExecutionRepository {
  readonly #clock: Clock;

  constructor(connection: SqliteConnection, clock: Clock) {
    super(connection, clock);
    this.#clock = clock;
  }

  override async extendByTenantIdAndPauseId(
    ...args: Parameters<SqlitePausedExecutionRepository["extendByTenantIdAndPauseId"]>
  ): ReturnType<SqlitePausedExecutionRepository["extendByTenantIdAndPauseId"]> {
    await this.#clock.sleep(seconds(1));
    return super.extendByTenantIdAndPauseId(...args);
  }

  /** #946: a reassignment's transaction is as slow. */
  override async reassignByTenantIdAndPauseId(
    ...args: Parameters<SqlitePausedExecutionRepository["reassignByTenantIdAndPauseId"]>
  ): ReturnType<SqlitePausedExecutionRepository["reassignByTenantIdAndPauseId"]> {
    await this.#clock.sleep(seconds(1));
    return super.reassignByTenantIdAndPauseId(...args);
  }
}
