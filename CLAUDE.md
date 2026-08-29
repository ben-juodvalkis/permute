# Permute - Claude Code Context

This file provides context for Claude Code when working on the Permute project.

## Project Overview

Permute is a Max4Live device that provides mute sequencing, pitch sequencing, and temperature-based organic variation for Ableton Live clips. It was extracted from the Looping project to be a standalone, reusable device.

## Key Files

| File | Purpose |
|------|---------|
| `permute-device.js` | Main controller - SequencerDevice, Max handlers |
| `permute-constants.js` | Constants, TRANSPOSE_CONFIG, VALUE_TYPES, ENUM_RATES |
| `permute-utils.js` | Debug, error handling, LiveAPI helpers |
| `permute-sequencer.js` | Generic Sequencer class (pattern/timing) |
| `permute-observer-registry.js` | ObserverRegistry for Live API observers |
| `permute-state.js` | TrackState, ClipState, TransportState classes |
| `permute-instruments.js` | Instrument detection, transpose strategies |
| `permute-shuffle.js` | Fisher-Yates shuffle, swap pattern generation |
| `permute-temperature.js` | Temperature mixin (applied to SequencerDevice prototype) |
| `permute-chance.js` | Chance/note probability mixin (applied to SequencerDevice prototype) |
| `Permute.amxd` | Max4Live device file (load this in Ableton) |
| `Permute.maxpat` | Max patch (UI and routing) |
| `docs/api.md` | **Complete communication reference** — inlets, outlets, rate enum |
| `docs/adr/` | Architecture decision records |

## HARD RULE: LiveAPI handle ownership

> A `LiveAPI` object must never become garbage while it still holds a Live path
> listener. Every handle is either **owned and reachable**, or **explicitly
> detached** — never merely dropped.

**Every `LiveAPI` registers a path listener with Live, whether or not you passed
it an observer callback.** If V8 collects such an object, its finalizer sends a
detach into Live; Live answers synchronously by dispatching a notification back,
which tries to call JS from inside a GC weak callback. That is illegal — V8 hits
`V8_Fatal` and **aborts the entire Live process**. It is intermittent: it needs a
scavenge to land on a dropped handle, which can take an hour of playing.

**No bare `new LiveAPI(...)` outside `permute-utils.js`.** Check it:

```bash
grep -n "new LiveAPI" *.js | grep -v permute-utils.js
```

Any hit is a defect. Every handle comes from the device's `HandlePool`
(`this.handles` on `SequencerDevice`; anything else that makes handles is
passed the pool):

| Need | Use |
|------|-----|
| A handle for a stable role, queried repeatedly | `this.handles.repoint(this._h, path)` — re-point, never re-construct |
| A genuine one-shot lookup | `this.handles.borrow(path, fn)` — detaches in a `finally` |
| A new owned handle | `this.handles.create(path)` |
| An observer | `this.handles.observer(path, property, cb)` |
| Done with a handle | `this._h = this.handles.release(this._h)` — safe on null, safe twice |
| Teardown | `SequencerDevice.releaseAllHandles()` (from `notifydeleted`) |

**The pool is per-device, never module state.** Permute is routinely loaded
several times in one set, and a module-level pool would let one device's
teardown drain detach the others' observers — they would keep sequencing while
silently deaf to slot and transport changes. If you add a class that creates
handles, take the pool as a constructor argument; don't reach for a global.

Detach only handles genuinely being released — over-eager detaching silently
breaks observation, which is worse than the crash because it fails quietly.
`this.handles.size()` is the diagnostic: a count that climbs while playing means
something is creating handles per tick. See `docs/adr/018-liveapi-handle-ownership.md`.

## Communication Architecture

See `docs/api.md` for the complete reference. Summary:

### JS Interface: 2 Inlets, 1 Outlet

| Port | Purpose | Messages |
|------|---------|----------|
| Inlet 0 | Transport | `song_time <ticks>` |
| Inlet 1 | Max UI | `mute_step N v`, `mute_length v`, `mute_rate i`, `pitch_step N v`, `pitch_length v`, `pitch_rate i`, `temperature v`, `chance v` |
| Outlet 0 | Position display | `mute_current <step>`, `pitch_current <step>` |

`live.*` UI objects with `parameter_enable: 1` own their own values. Live handles persistence, automation, undo, and Push mapping. JS never echoes values back.

## Initialization

Triggered by `live.thisdevice`. `live.*` UI objects emit their stored values into inlet 1 on instantiation; JS populates state from those emissions. No handshake, no `request_ui_values`. See `docs/adr/010-ui-native-revamp.md`.

## Architecture

### Delta-Based State Tracking (v3.0)

Tracks `lastValues` per clip, applies deltas only on change:
- `0→1`: Apply transformation (shift up, mute)
- `1→0`: Reverse transformation (shift down, unmute)
- `0→0` or `1→1`: No action

### Key Classes

- `SequencerDevice` - Main device controller
- `Sequencer` - Generic pattern/timing wrapper
- `TransposeStrategy` - Parameter-based pitch shifting
- `ObserverRegistry` - Centralized Live API observer management

### Temperature Transformation (v3.3 — base model)

The user's composition is the source of truth, held in an in-memory **base
model** per clip; the scrambled clip is never read back as truth. Each variation
is derived from the base model (`displayed = applySwap(baseModel, temp)`), so
return-to-0 rewrites the base verbatim and is lossless by construction. See
`docs/adr/015-temperature-base-model.md`.
- Captures full base notes by `note_id` when temp goes 0→>0
- Variations (enable, loop jump, post-edit) always derive from the base model
- Return-to-0 rewrites the base model verbatim (+ current pitch-seq offset)
- Transport stop writes the original back to the clip but keeps the base model
  in memory; transport start re-derives (no re-capture from the live clip)
- A `notes` observer + content diff distinguishes our own writes from user edits
  (timing-independent); a user edit while hot re-baselines to the new notes

### Note Chance (v3.2)

Sets `note.probability` on all notes in the current clip (MIDI only):
- Value 0.0–1.0 (0=never, 1=always play)
- Applied immediately on value change, on clip change, and on transport start
- Persists across transport start/stop (the slider value is authoritative; notes always reflect it)

## Common Development Tasks

### Enable Debug Logging
In `permute-utils.js`:
```javascript
var DEBUG_MODE = true;
```

### Test Changes
1. Save the changed file(s)
2. If only `permute-device.js` changed, saving triggers `autowatch` reload
3. If a module file changed, delete and re-add `Permute.amxd` to reload (autowatch only watches the main file)
4. Check Max console for errors/debug output

### Add New UI Control
1. Add the `live.*` object to the patcher with `parameter_enable: 1` and a long name
2. Prepend its output with a new message name and merge into inlet 1
3. Add a handler branch in `handleMaxUICommand` in `permute-device.js`
4. Update `docs/api.md`

## Documentation Maintenance

| Change Type | Update |
|-------------|--------|
| Messaging change | `docs/api.md` |
| Architecture change | Create new ADR in `docs/adr/` |
| New `LiveAPI` creation site | Stop — see the hard rule above |

## Instrument Detection

Scans for transpose parameters by name (case-insensitive):
1. "custom e" (shift: 21)
2. "pitch" (shift: 16)
3. "transpose" (shift: 16)
4. "octave" (shift: 16)

If found, uses parameter-based shifting. Otherwise, modifies note pitches directly.

### Pitch baseline (v3.4)

The "home" value the pitch sequencer shifts away from is **reconciled on every
write, not snapshotted**. `TransposeStrategy.reconcileBaseline()` reads the live
param immediately before each write and folds any user edit into the baseline —
so setting the knob and *then* enabling pitch steps shifts from the new value,
and nudging the knob mid-sequence moves home by the same delta. Audio clips do
the same with `pitch_coarse` (relative, never a flat 12/0).

There is deliberately **no observer on the transpose param** — nothing acts on a
new baseline until the next write, so a listener inside the instrument's subtree
would buy no behavior for real risk. See `docs/adr/013` and `docs/adr/019`.
