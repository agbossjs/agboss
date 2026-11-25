---
section: Breaking
issue: 1318
---

**The `channels` shelf and the Q5 unions of a profile** (#1318, part 1318c).

- `channels: { "<channel name>": { ttl, timeout } }` in a `defineConfig` / `.config.yaml` profile changes a `@Channel`'s
  options through the carrier of the components' options (`ComponentOptions.channelMetaOf`): the assembly rules read the
  profile's values (`[channel.ttl-invalid]`, `[pause.setting-not-enforced]`). A name the application lacks is a
  `ProfileError`; so is a `ttl` for a channel bound to no pause target.
- `ConfigSpec.channels` is now `readonly Class[] | Readonly<Record<string, ChannelOverlay>>` and `ConfigSpec.mesh` is
  `Class | Readonly<Record<string, MeshOverlay>>`: a list of classes / a `@Mesh` class replaces what `@Application`
  declares, a record sets settings by name. The two fold independently across profiles, so a later `.config.yaml`
  record never clobbers an earlier `.config.ts` class replacement, nor the other way round. A `.config.yaml` holds only
  the record form.
- Removed: `channels` from the keys only a `.config.ts` may hold (its record form is YAML-able).
