/**
 * #1318c: the `channels` shelf (a record of settings by channel name) and its union with the class list
 * that replaces `@Application({ channels })`; the same union for `mesh` (a class, or a record by mesh name).
 * One carrier serves every reader of a channel's options; the declared classes are never changed; the
 * replacement and the settings of two profiles fold independently.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { ProfileError, ProfileErrorReason } from "../../src/config/profile-error.js";
import { meshOf } from "../../src/mesh/mesh.decorator.js";
import type { Class } from "../../src/components/injection.js";
import { minutes, hours, days } from "../../src/units/index.js";
import { componentOf } from "../../src/components/metadata.js";
import { DeskRefundChannel, InboxSpendingLimitChannel } from "../channels/pause-targets.fixture.js";
import { FilesConfigApplication } from "./fixtures/files-app/files.application.js";
import { PauseShelvesApplication } from "./fixtures/pause-app/pause.application.js";
import {
  ShelfApplication,
  ShelfMesh,
  ShelfOtherMesh,
} from "./fixtures/shelves-app/shelves.application.js";

const paused = (profile?: string | readonly string[]) =>
  applicationOf(PauseShelvesApplication, profile === undefined ? {} : { profile });

const failure = async (attempt: Promise<unknown>): Promise<ProfileError> => {
  try {
    await attempt;
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error("expected a ProfileError");
};

const ttlOf = (app: Awaited<ReturnType<typeof paused>>, channel: Class) =>
  app.componentOptions.channelMetaOf(channel)?.ttl;

describe("the channels shelf", () => {
  it("declared: the channels keep a closed pause as they say", async () => {
    const app = await paused();

    expect(ttlOf(app, InboxSpendingLimitChannel)).toBe(days(14));
    expect(ttlOf(app, DeskRefundChannel)).toBe(days(7));
  });

  it("a profile's ttl is the one the carrier gives, for that channel only", async () => {
    const app = await paused("channel-ttl");

    expect(ttlOf(app, InboxSpendingLimitChannel)).toBe(hours(1));
    expect(ttlOf(app, DeskRefundChannel)).toBe(days(7));
  });

  it("the assembly rules read the profile's ttl: one under the execution lease is [channel.ttl-invalid]", async () => {
    await expect(paused("channel-short")).rejects.toThrow(
      /channel\.ttl-invalid[\s\S]*inbox-spending-limit-channel/u,
    );
  });

  it("a timeout nothing reads is refused as it is when a channel declares it ([pause.setting-not-enforced])", async () => {
    await expect(paused("channel-timeout")).rejects.toThrow(
      /pause\.setting-not-enforced[\s\S]*desk-refund-channel[\s\S]*timeout/u,
    );
  });

  it("never changes the declared channel, nor another assembly of it", async () => {
    await paused("channel-ttl");
    const plain = await paused();
    const meta = componentOf(InboxSpendingLimitChannel);

    expect(meta?.kind === "channel" ? meta.meta.ttl : undefined).toBe(days(14));
    expect(ttlOf(plain, InboxSpendingLimitChannel)).toBe(days(14));
  });

  it("a name the application lacks is a ProfileError naming the key and the channels it has", async () => {
    const error = await failure(paused("ghost-channel"));

    expect(error.reason).toBe(ProfileErrorReason.Unknown);
    expect(error.message).toContain("channels.ghost-channel");
    expect(error.message).toContain("desk-refund-channel");
  });

  it("a ttl for a channel bound to no pause target is refused", async () => {
    const error = await failure(
      applicationOf(FilesConfigApplication, { profile: "channel-ttl-untargeted" }),
    );

    expect(error.reason).toBe(ProfileErrorReason.Invalid);
    expect(error.message).toContain("channels.file-caller-channel.ttl");
  });
});

describe("the channels union: a list of classes replaces, a record sets", () => {
  it("a list replaces the declared channels; the declared ones are untouched", async () => {
    const app = await paused("replace-channels");

    expect(
      app.providers.filter((one) => one === DeskRefundChannel || one === InboxSpendingLimitChannel),
    ).toEqual([DeskRefundChannel, InboxSpendingLimitChannel]);
  });

  it("a record of a later profile never clobbers an earlier profile's list, nor the other way round", async () => {
    const both = ["replace-channels", "channel-ttl"] as const;
    for (const order of [both, [...both].reverse()]) {
      const app = await paused(order);

      expect(app.providers).toContain(DeskRefundChannel);
      expect(ttlOf(app, InboxSpendingLimitChannel)).toBe(hours(1));
    }
  });

  it("a list with something that is no class is refused when the file loads", async () => {
    await expect(paused("bad-channels")).rejects.toThrow(/channels takes a list of classes/u);
  });
});

describe("the mesh union: a class replaces, a record sets", () => {
  const meshApp = (profile?: string | readonly string[]) =>
    applicationOf(ShelfApplication, profile === undefined ? {} : { profile });

  it("a class replaces the application's mesh, the declared one untouched", async () => {
    const app = await meshApp("replace-mesh");

    expect(app.mesh).toMatchObject({ name: "shelf-other-mesh", maxHops: 1 });
    expect(app.maxMeshHops).toBe(1);
    expect(meshOf(ShelfMesh)).toMatchObject({ maxHops: 5, deduplicationTtl: minutes(10) });
    expect(meshOf(ShelfOtherMesh)).toMatchObject({ maxHops: 1 });
  });

  it("the record of a later profile sets the replacement's limits, in either order", async () => {
    for (const order of [
      ["replace-mesh", "other-mesh-limits"],
      ["other-mesh-limits", "replace-mesh"],
    ]) {
      const app = await meshApp(order);

      expect(app.mesh).toMatchObject({ name: "shelf-other-mesh", maxHops: 2 });
      expect(app.maxMeshHops).toBe(2);
    }
  });

  it("a record for the mesh a class replaced away is a ProfileError", async () => {
    expect((await failure(meshApp("other-mesh-limits"))).message).toMatch(
      /mesh\.shelf-other-mesh: no such @Mesh/u,
    );
  });

  it("a class that is no @Mesh is refused when the file loads", async () => {
    await expect(meshApp("not-a-mesh")).rejects.toThrow(/mesh takes a @Mesh class/u);
  });
});
