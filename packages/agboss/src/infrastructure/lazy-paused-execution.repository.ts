import type { OnInit } from "../components/container/lifecycle.js";
import { PausedExecutionRepository } from "./paused-execution.repository.js";

/** The store behind each repository that loads its logic on first use (see `usingStore`). */
const loading = new WeakMap<object, Promise<PausedExecutionRepository>>();
const loaded = new WeakMap<object, PausedExecutionRepository>();

/** `use(store)`, a store's synchronous failure a rejection: no method of a contract throws. */
function attempt<T>(
  use: (store: PausedExecutionRepository) => Promise<T>,
  store: PausedExecutionRepository,
): Promise<T> {
  try {
    return use(store);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/**
 * `use` on the store of `owner` (internal: the core's built-in stores load their logic on first
 * use, so the root import stays lean). `load` runs once; a loaded store adds no wait of its own,
 * and a load that failed (a busy file) is forgotten, so the next call tries again.
 */
export function usingStore<T>(
  owner: object,
  load: () => Promise<PausedExecutionRepository>,
  use: (store: PausedExecutionRepository) => Promise<T>,
): Promise<T> {
  const ready = loaded.get(owner);
  if (ready !== undefined) return attempt(use, ready);
  const pending =
    loading.get(owner) ??
    load().catch((error: unknown) => {
      loading.delete(owner);
      throw error;
    });
  loading.set(owner, pending);
  return pending.then((store) => {
    loaded.set(owner, store);
    return attempt(use, store);
  });
}

/** What a pause store's method takes and answers: handed on unchanged to the store that loads on first use. */
type Args<K extends keyof PausedExecutionRepository> = Parameters<PausedExecutionRepository[K]>;
type Returns<K extends keyof PausedExecutionRepository> = ReturnType<PausedExecutionRepository[K]>;

/**
 * A pause store of the core whose logic loads on first use (or at start), so the root import stays
 * lean (internal): every method of the contract but `ping` is handed on, unchanged, to the store
 * `loadStore` makes — once; a load that failed is tried again by the next call.
 */
export abstract class LazyPausedExecutionRepository
  extends PausedExecutionRepository
  implements OnInit
{
  /** Makes the store that holds the logic. */
  protected abstract loadStore(): Promise<PausedExecutionRepository>;

  /** Loads the store when the application starts: no call waits for it. */
  async onInit(): Promise<void> {
    await this.run(() => Promise.resolve());
  }

  findByTenantIdAndThreadId(
    ...args: Args<"findByTenantIdAndThreadId">
  ): Returns<"findByTenantIdAndThreadId"> {
    return this.run((store) => store.findByTenantIdAndThreadId(...args));
  }

  save(...args: Args<"save">): Returns<"save"> {
    return this.run((store) => store.save(...args));
  }

  deleteByTenantIdAndThreadId(
    ...args: Args<"deleteByTenantIdAndThreadId">
  ): Returns<"deleteByTenantIdAndThreadId"> {
    return this.run((store) => store.deleteByTenantIdAndThreadId(...args));
  }

  deleteByTenantIdAndThreadIdAndRunId(
    ...args: Args<"deleteByTenantIdAndThreadIdAndRunId">
  ): Returns<"deleteByTenantIdAndThreadIdAndRunId"> {
    return this.run((store) => store.deleteByTenantIdAndThreadIdAndRunId(...args));
  }

  findOrCreateByStepKey(...args: Args<"findOrCreateByStepKey">): Returns<"findOrCreateByStepKey"> {
    return this.run((store) => store.findOrCreateByStepKey(...args));
  }

  findByTenantIdAndPauseId(
    ...args: Args<"findByTenantIdAndPauseId">
  ): Returns<"findByTenantIdAndPauseId"> {
    return this.run((store) => store.findByTenantIdAndPauseId(...args));
  }

  findAllByTenantIdAndRootExecutionId(
    ...args: Args<"findAllByTenantIdAndRootExecutionId">
  ): Returns<"findAllByTenantIdAndRootExecutionId"> {
    return this.run((store) => store.findAllByTenantIdAndRootExecutionId(...args));
  }

  findByTenantIdAndRootExecutionIdAndStepKey(
    ...args: Args<"findByTenantIdAndRootExecutionIdAndStepKey">
  ): Returns<"findByTenantIdAndRootExecutionIdAndStepKey"> {
    return this.run((store) => store.findByTenantIdAndRootExecutionIdAndStepKey(...args));
  }

  markSentByTenantIdAndPauseId(
    ...args: Args<"markSentByTenantIdAndPauseId">
  ): Returns<"markSentByTenantIdAndPauseId"> {
    return this.run((store) => store.markSentByTenantIdAndPauseId(...args));
  }

  resolveByTenantIdAndPauseId(
    ...args: Args<"resolveByTenantIdAndPauseId">
  ): Returns<"resolveByTenantIdAndPauseId"> {
    return this.run((store) => store.resolveByTenantIdAndPauseId(...args));
  }

  decideByTenantIdAndPauseId(
    ...args: Args<"decideByTenantIdAndPauseId">
  ): Returns<"decideByTenantIdAndPauseId"> {
    return this.run((store) => store.decideByTenantIdAndPauseId(...args));
  }

  cancelByTenantIdAndPauseId(
    ...args: Args<"cancelByTenantIdAndPauseId">
  ): Returns<"cancelByTenantIdAndPauseId"> {
    return this.run((store) => store.cancelByTenantIdAndPauseId(...args));
  }

  expireByTenantIdAndPauseId(
    ...args: Args<"expireByTenantIdAndPauseId">
  ): Returns<"expireByTenantIdAndPauseId"> {
    return this.run((store) => store.expireByTenantIdAndPauseId(...args));
  }

  closeUntakenByTenantIdAndPauseId(
    ...args: Args<"closeUntakenByTenantIdAndPauseId">
  ): Returns<"closeUntakenByTenantIdAndPauseId"> {
    return this.run((store) => store.closeUntakenByTenantIdAndPauseId(...args));
  }

  extendByTenantIdAndPauseId(
    ...args: Args<"extendByTenantIdAndPauseId">
  ): Returns<"extendByTenantIdAndPauseId"> {
    return this.run((store) => store.extendByTenantIdAndPauseId(...args));
  }

  remindByTenantIdAndPauseId(
    ...args: Args<"remindByTenantIdAndPauseId">
  ): Returns<"remindByTenantIdAndPauseId"> {
    return this.run((store) => store.remindByTenantIdAndPauseId(...args));
  }

  noticeOnceByTenantIdAndPauseId(
    ...args: Args<"noticeOnceByTenantIdAndPauseId">
  ): Returns<"noticeOnceByTenantIdAndPauseId"> {
    return this.run((store) => store.noticeOnceByTenantIdAndPauseId(...args));
  }

  markTakenByTenantIdAndPauseId(
    ...args: Args<"markTakenByTenantIdAndPauseId">
  ): Returns<"markTakenByTenantIdAndPauseId"> {
    return this.run((store) => store.markTakenByTenantIdAndPauseId(...args));
  }

  findPendingByExpiresAtBefore(
    ...args: Args<"findPendingByExpiresAtBefore">
  ): Returns<"findPendingByExpiresAtBefore"> {
    return this.run((store) => store.findPendingByExpiresAtBefore(...args));
  }

  findPendingByRemindAtBefore(
    ...args: Args<"findPendingByRemindAtBefore">
  ): Returns<"findPendingByRemindAtBefore"> {
    return this.run((store) => store.findPendingByRemindAtBefore(...args));
  }

  findOpenAfter(...args: Args<"findOpenAfter">): Returns<"findOpenAfter"> {
    return this.run((store) => store.findOpenAfter(...args));
  }

  findPageByTenantId(...args: Args<"findPageByTenantId">): Returns<"findPageByTenantId"> {
    return this.run((store) => store.findPageByTenantId(...args));
  }

  findClosedByResolvedAtBefore(
    ...args: Args<"findClosedByResolvedAtBefore">
  ): Returns<"findClosedByResolvedAtBefore"> {
    return this.run((store) => store.findClosedByResolvedAtBefore(...args));
  }

  deleteByResolvedAtBefore(
    ...args: Args<"deleteByResolvedAtBefore">
  ): Returns<"deleteByResolvedAtBefore"> {
    return this.run((store) => store.deleteByResolvedAtBefore(...args));
  }

  claimNoticesDue(...args: Args<"claimNoticesDue">): Returns<"claimNoticesDue"> {
    return this.run((store) => store.claimNoticesDue(...args));
  }

  ackNotice(...args: Args<"ackNotice">): Returns<"ackNotice"> {
    return this.run((store) => store.ackNotice(...args));
  }

  retryNotice(...args: Args<"retryNotice">): Returns<"retryNotice"> {
    return this.run((store) => store.retryNotice(...args));
  }

  setAsideNotices(...args: Args<"setAsideNotices">): Returns<"setAsideNotices"> {
    return this.run((store) => store.setAsideNotices(...args));
  }

  setAsideStaleNoticesBefore(
    ...args: Args<"setAsideStaleNoticesBefore">
  ): Returns<"setAsideStaleNoticesBefore"> {
    return this.run((store) => store.setAsideStaleNoticesBefore(...args));
  }

  countNotices(...args: Args<"countNotices">): Returns<"countNotices"> {
    return this.run((store) => store.countNotices(...args));
  }

  private run<T>(use: (store: PausedExecutionRepository) => Promise<T>): Promise<T> {
    return usingStore(this, () => this.loadStore(), use);
  }
}
