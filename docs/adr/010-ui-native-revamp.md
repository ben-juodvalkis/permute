# ADR-010: UI-Native Revamp (Remove OSC, Remove request_ui_values)

**Status:** Accepted
**Date:** 2026-04-19
**Supersedes:** [ADR-006](006-remove-pattr-ui-source-of-truth.md)

## Context

The device carried three parallel communication paths:

1. Max UI messages via inlet 2 / outlet 0 (step toggles, length, division, temperature, chance — with a full echo back to the UI)
2. OSC via inlet 1 / outlet 1 (`/looping/sequencer/*` commands + 30-arg `state_broadcast`)
3. A `request_ui_values` bootstrap handshake so Max UI re-emitted stored values into JS after `init()`

This produced a recurring echo-filtering bug in the external Svelte UI, an init-order race on load, a dead-code path for `temperature_reset`/`temperature_shuffle` messages no patch ever emitted, and ~400 lines of dispatch/broadcast code across `permute-commands.js`, `handleOSCCommand`, `handleMaxUICommand`, `buildStateData`, `broadcastToOSC`, and the pre-allocated outlet buffers.

## Decision

Make the Max UI the sole surface. Each `live.*` object has `parameter_enable: 1` — Live handles persistence, automation, undo, and Push mapping directly on the UI objects. JS never echoes values back; the UI already holds them.

- **Inlets drop from 3 → 2:** `0` transport, `1` Max UI messages.
- **Outlets drop from 2 → 1:** `0` step position only (`mute_current`, `pitch_current`).
- **OSC removed entirely.** No `state_broadcast`, no command registry, no device-ID filtering.
- **`request_ui_values` removed.** `live.*` UI objects re-emit their stored values on instantiation; JS tolerates empty state until the first real UI message arrives.
- **Per-step toggles replace bulk pattern messages.** `mute_step N v` / `pitch_step N v` wire directly from 8 `live.toggle` objects per sequencer.
- **Rate menus replace `coll rate` lookup.** A single `live.menu` per sequencer emits an index into `ENUM_RATES` (8 entries, 8 bar through 1/16 — longest first, matching the old `coll rate`). JS resolves index → ticks via `ticksForRateEnum`.
- **No reset/shuffle.** `temperature_reset` and `temperature_shuffle` handlers were orphaned — no patcher ever emitted them. Deleted.
- **Current-step numboxes** use Live 12.3 beta Visibility "Visible (Not Stored)" — readable by Push/LiveAPI, excluded from automation and undo.

## Message protocol

Inlet 1 (UI → v8):

```
mute_step <i> <v>      i=0..7, v=0/1
mute_length <v>        1..8
mute_rate <i>          0..7 (ENUM_RATES index)
pitch_step <i> <v>
pitch_length <v>
pitch_rate <i>         0..7
temperature <v>        0.0..1.0
chance <v>             0.0..1.0
```

Outlet 0 (v8 → display numboxes):

```
mute_current <step>    -1..7, emitted on step change and transport stop
pitch_current <step>
```

## Consequences

**Gains**

- ~400 lines of dispatch/broadcast code removed.
- Echo-filtering bug gone by construction: JS can't echo to a UI that owns its own state.
- Init-order race gone: no handshake to get wrong.
- Persistence, automation, undo, Push mapping all handled by Live, no custom work.
- One source of truth per value (the UI object), not two (UI + JS shadow).

**Losses**

- External Svelte UI speaking OSC to this device is broken. Accepted.
- `*_current` numbox visibility depends on Live 12.3 beta for non-stored exposure. On stable Live it falls back to "Hidden" (display-only, not externally readable).
- Automation rate on step toggles can fire inlet messages at audio-block rate. `scheduleBatchApply` already debounces clip writes at 1 ms; not expected to be a problem.

## Related

- Supersedes [ADR-006](006-remove-pattr-ui-source-of-truth.md) (the `request_ui_values` handshake).
- Footnote on [ADR-004](004-modularization.md): `permute-commands.js` is deleted.
- [ADR-008](008-hot-path-efficiency.md) pre-allocated `_stateBuffer` / `_outletBuffer` for `state_broadcast` — both removed with OSC.
