# ADR-017: One-Way OSC Step-Telemetry Broadcast

**Status:** Accepted
**Date:** 2026-07-16
**Refines:** [ADR-010](010-ui-native-revamp.md) — narrows its "no OSC" outcome with a scoped, outbound-only exception. Does not reopen the inbound OSC command surface ADR-010 removed.

## Context

The device exposes two read-only telemetry values — `Mute Current` / `Pitch
Current` step position — via `live.numbox` objects using Live 12.3's "Visible
(Not Stored)" parameter mode. A companion Ableton-integration app tried to
read these externally through Live's LOM parameter-change listeners and found
the value frozen: Live never fires a value-changed notification for these two
params in that mode, on this Live install at least.

ADR-010 removed OSC entirely — inbound command dispatch, `state_broadcast`,
device-ID filtering — because that machinery caused a recurring echo-filtering
bug, an init-order race, and ~400 lines of dead/duplicate code. That rationale
applies to a *two-way* protocol where JS both received commands and echoed
state. It does not apply to a single, one-way, additive value push with no
inbound surface and no interaction with the UI-native inlet/outlet contract.

## Decision

Add a narrow, outbound-only OSC push of just the two step-position values,
straight from the device to a UDP listener, so the companion app can bypass
the frozen LOM read for these two values only.

- **New outlet-0 tag**, alongside the existing `mute_current`/`pitch_current`:
  `outlet(0, "step_broadcast", seqName, newStep, trackIndex, deviceIndex)`,
  emitted immediately after each existing `mute_current`/`pitch_current` call
  in `processSequencerTick` — same only-on-step-change condition, no new
  emission path.
- **New parallel patcher chain**, off the same `s ---fromjs` fan-out already
  used for `chance`/`temperature`/`*_step_N`:
  `r ---fromjs → route step_broadcast → prepend /looping/permute/step →
  udpsend 127.0.0.1 11020`.
- **Track/device index resolved fresh** via `LiveAPI("this_device").path` on
  every call — not cached — so it can't go stale after a track/device
  reorder the way the existing `trackState.index` (cached once in `init()`)
  can.
- **No inbound OSC.** No command registry, no device-ID filtering, no
  `state_broadcast`. The dead port-11003 `state_broadcast` skeleton already
  in the patcher (orphaned since ADR-010) is left untouched — this is a new,
  separate chain at a different port, not a repurposing of that skeleton.

Full wire contract in [docs/api.md](../api.md#osc-step-broadcast-telemetry-outbound-only).

## Consequences

**Gains**

- Companion app gets a working read path for step position without needing
  Live/Max to fix LOM notifications for "Visible (Not Stored)" params.
- Zero change to the UI-native inlet/outlet contract: the 3 existing
  `outlet(0, seqName + "_current", newStep)` call sites are untouched, and
  Max UI objects remain the sole source of truth for every other value.

**Losses / accepted tradeoffs**

- Reintroduces outbound OSC I/O, which ADR-010's summary describes as fully
  removed. This ADR is the documented exception — outbound telemetry only,
  no inbound command surface, so the echo-filtering and init-order-race
  failure modes ADR-010 fixed do not reapply.
- One additional `LiveAPI` call per actual step change (not per tick) to
  resolve track/device index freshly. Not on a hot per-audio-block path;
  accepted.
- `trackIndex` reports `-1` for a device on a return or master track rather
  than a distinguishing value (the `\btracks\s+(\d+)/` match intentionally
  excludes `return_tracks N`), and `deviceIndex` reflects only this device's
  own index in its immediate container, not full rack-chain nesting depth.
  Sufficient for the companion app's current use (top-level device on a
  regular track); revisit if return-track or nested-rack support is needed.

## Files

- `permute-device.js` — `SequencerDevice.prototype._emitStepBroadcast`,
  called from the 3 existing `processSequencerTick` outlet sites.
- `Permute.amxd` — new `r ---fromjs → route step_broadcast → prepend
  /looping/permute/step → udpsend 127.0.0.1 11020` chain.
- `docs/api.md` — outlet 0 table and new OSC telemetry section.

## Related

- Refines [ADR-010](010-ui-native-revamp.md) (narrows its "no OSC" outcome).
- Leaves the dead `state_broadcast`/port-11003 skeleton (orphaned by
  ADR-010) untouched.
