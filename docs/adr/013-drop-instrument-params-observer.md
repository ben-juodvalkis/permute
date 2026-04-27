# ADR-013: Drop the `instrument_params` Observer to Eliminate Rack-Load Listener Race

**Status:** Accepted
**Date:** 2026-04-27
**Refines:** ADR-011 (observer-driven clip cache); the April 24 fix sequence in `BUG_REPORT_path_listener_flood.md` (`6eac67e` hard-detach, `076e9f5` device sync-detach + debounce, `1512fd1` `instrument_params` debounce).

## Context

After the April 24 fix landed, a new variant of the same `_path_listener_callback` / `SendMessage error 2: Bad parameter value` flood was reported on 2026-04-27 ([Looping repo `documentation/bug-reports/permute-listener-storm-log-excerpt.txt`](../../../Looping/documentation/bug-reports/permute-listener-storm-log-excerpt.txt)).

Trigger profile:

- **Old (April 24):** `Simpler.replace_sample` mid-session — fixed by debouncing the `'devices'` and `'parameters'` notification bursts plus hard-detaching observers on unregister.
- **New (April 27):** Loading any sample-based instrument rack (`.adg`) onto a track containing Permute. No `replace_sample` involved. Burst of 66 `SendMessage error 2` exceptions within ~205ms of the rack landing, then `Last message repeated 59 time(s)` over the next 2.5 minutes — the listener stayed bound and re-fired on every subsequent LOM mutation, driving 110 control-thread hiccups (502–2805 ms each).

User confirmed the trigger empirically: deleting Permute from the track restored snappiness; re-adding restored the lag. Reproducible on `Long Tremolo.adg` (4 nested `MultiSampler`s, ~1.6s load) and `Short Pizzicato.adg` (1 `MultiSampler`). Omnisphere (a `PluginDevice`) did not reproduce.

### Root cause

The asymmetry between rack instruments and `PluginDevice` is the diagnostic. Permute's `detectInstrumentType` only takes the slow path on devices in `parameterTransposeDevices` (`DrumGroupDevice`, `InstrumentGroupDevice`, `OriginalSimpler`):

1. `findTransposeParameterByName(rack)` iterates the rack's 16 macros via `new LiveAPI(devicePath + " parameters " + i)` — synchronous IPC against a device tree that Live is still constructing during rack load.
2. `setupInstrumentParamsObserver()` then binds a `LiveAPI(callback)` to the rack's `parameters` property — a property that is *actively mutating* during rack instantiation as Live registers nested chains, samplers, and macro names.

Step (2) is the racy bind. When Permute lives inside an `.adg`, the JS box is not yet fully addressable in the patcher graph at the moment `init()` runs. Live's `_path_listener_callback` fires the bind-time "current value" notification, `SendMessage` errors with "Bad parameter value", and **on Live 12.4 the listener is not auto-detached** — it remains bound and re-fires on every subsequent LOM mutation for the rest of the session. The April 24 hard-detach only sequences `property=""; path=""; id=0` on **explicit unregister**; it cannot defend against an observer whose *initial bind* lands during the rack-load init-order race.

A `defer()` of the entire init block was tried and rejected: it pushed `detectInstrumentType` past the first `song_time` tick, so `instrumentType` stayed `'unknown'` and mute/pitch silently no-op'd through the early window. Splitting "synchronous detection" from "deferred observer binds" was workable but added complexity to keep the hot path safe across the deferred boundary.

## Decision

Drop `setupInstrumentParamsObserver` entirely. Detection still reads the rack's parameters once via `findTransposeParameterByName` — that is sufficient because the `'device'` observer already re-runs `detectInstrumentType` on instrument add/remove/replace, which re-reads the parameter list of the *new* instrument.

The only behavior we lose: if the user renames a macro on an *unchanged* instrument (e.g., relabels Macro 8 to "Transpose" without swapping the rack), Permute will not auto-redetect. The user must toggle the device off/on or swap the instrument to trigger re-detection. This is a rare workflow; the device-toggle remediation is one click.

`init()` reverts to fully synchronous — no `defer()` needed. The remaining observers (`device` on `track devices`, `transport` on `live_set is_playing`, `timeSignature` on `live_set signature_numerator`, `playing_slot` / `fired_slot` on the track) all bind to LOM nodes that exist before Permute is instantiated and are not destroyed during a rack-load. They do not race.

## Changes

### `permute-device.js` — observer setup

- **Remove `SequencerDevice.prototype.setupInstrumentParamsObserver`.** No replacement.
- **Remove the call from `detectInstrumentType`** — final line `this.setupInstrumentParamsObserver()` deleted.
- **Remove the unregister at the top of `detectInstrumentType`** — no observer to unregister.
- **Simplify the `'device'` observer callback** — drop the synchronous `unregister('instrument_params')` line that was specifically for tearing down this observer before re-detection.
- **Update stale comment in `scheduleDetectionRetries`** — removed the parenthetical "(e.g. params observer beat us to it)" since no params observer exists anymore.

`init()` is unchanged from before the April 27 investigation — the brief `defer()` experiment was reverted.

## Consequences

### Positive

- Loading any rack on a Permute track no longer triggers the `_path_listener_callback` flood. Empirically confirmed by the user with both Long Tremolo and Short Pizzicato.
- Eliminates the entire class of "racy initial bind" failures for this observer rather than timing around them.
- Removes ~30 lines of code plus the supporting debounce reasoning in `_scheduleDetection` (which still applies to the `'device'` observer; only the `'parameters'` path is gone).
- The hot path is unchanged. Detection state is populated synchronously in `init()`, before the first `song_time` tick.

### Negative / accepted trade-offs

- **Macro renames on an unchanged instrument no longer auto-redetect.** Workflow impact: the user adds a "Transpose" macro to a rack that's already on a Permute track and expects Permute to notice. They now need to toggle the device off/on (one click) or swap the instrument. Detection-on-instrument-change still covers the much more common case (adding/replacing the instrument itself).
- **`scheduleDetectionRetries` is now the only mechanism that re-runs detection without a device change.** It already exists and is gated to the "listed rack but no named param at first detection" case — covers init-time races where the rack's macros aren't populated yet (the case that originally motivated the params observer). Up to 4 retries with 50/200/500/1200ms backoff.

### Out of scope / explicitly not done

- **Defer-the-init experiment.** Briefly explored (and tested by the user — fixed lag but broke mute/pitch). Reverted in favor of dropping the racy observer outright. Splitting init into "sync detection + deferred observer binds" is a workable alternative if a future observer needs to be reintroduced, but adds boundary complexity that this approach avoids.
- **Generalizing this to other observers.** The four remaining observers all bind to stable LOM paths that pre-date Permute's instantiation; none have shown the same race. If a future feature needs to observe a property on a still-mutating subtree (e.g., per-chain device lists inside a rack), the same diagnosis would apply and the same answer — read once on a stable trigger — should be considered first.

## Verification

- Load `Long Tremolo.adg` on a fresh track in Live 12.4 with Permute already present. Confirm UI snappiness retained, no `SendMessage error 2: Bad parameter value` lines in `Log.txt`, no `Last message repeated N time(s)` at session shutdown.
- Repeat with `Short Pizzicato.adg` and any other rack-of-samplers preset.
- Confirm `parameter_transpose` still engages on a rack with a "Transpose" macro: load the rack, observe `[Sequencer DEBUG:instrument]` line in Max Console (with `DEBUG_MODE=true`) lands on `parameter_transpose`.
- Swap the rack for a different instrument on the same track — confirm the `'device'` observer fires and re-detection lands on the new instrument's strategy.
