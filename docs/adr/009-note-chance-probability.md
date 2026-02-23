# ADR-009: Note Chance (Probability) Feature

**Date:** 2026-02-23
**Status:** Implemented

## Context

Permute supports mute sequencing, pitch sequencing, and temperature-based note shuffling. Users need per-track control over note probability — Ableton Live's built-in feature where each note has a `probability` property (0.0-1.0) that determines whether it plays on each loop iteration.

This feature was previously implemented directly in the Looping project's `liveAPI-v6.js` as a per-clip operation. Migrating it to Permute centralizes all note modification features and enables OSC-based control with state broadcasting.

## Decision

Add a `chanceValue` property (default 1.0) to SequencerDevice, implemented as a mixin (`permute-chance.js`) following the temperature mixin pattern (ADR-004). The chance dial in the Max patch is the source of truth for persistence (ADR-006), with `parameter_enable: 1`.

### Key behaviors

- Setting chance applies `note.probability` to all notes in the current clip immediately
- Transport stop restores probability to 1.0
- Clip change re-applies the current chance value to the new clip
- Transport start applies chance if already set before playback
- Chance < 1.0 activates playback observers (improvement over temperature's approach)
- MIDI-only (audio clips have no notes)

### Why no capture/restore complexity

Temperature needs note ID tracking for reversible pitch shuffling — each note's original pitch must be remembered so shuffling doesn't drift. Chance just sets a single probability value on all notes. Restoring means setting probability back to 1.0. No note ID maps needed.

## Changes

### New: `permute-chance.js`

Mixin with `applyChanceMethods(proto)`:
- `setChanceValue(value)` — clamp, skip if unchanged, apply to clip, activate observers
- `applyChanceToClip()` — set `note.probability` on all notes via Live API
- `restoreChance()` — set probability back to 1.0
- `sendChanceState()` — outlet 0 feedback to Max UI

### Modified: `permute-device.js`

- Import and apply chance mixin
- `chanceValue` property in constructor (placeholder until UI re-emits)
- `seq_chance` command handler for OSC
- Chance in `set_state` parsing (optional arg for backward compat)
- `checkAndActivateObservers()` includes `chanceValue < 1.0`
- `onTransportStop()` calls `restoreChance()`
- `onTransportStart()` applies chance if active
- `onClipChanged()` re-applies chance to new clip
- `buildStateData()` includes chance at buffer index 28
- Broadcast buffers expanded: `_stateBuffer` 28→29, `_outletBuffer` 31→32
- `broadcastToOSC()` loop bound updated 28→29
- OSC routing for `/looping/sequencer/chance`
- Max UI handler for `chance` message
- `getState()`/`setState()` include chance (version bumped to 3.2)

### Modified: `docs/api.md`

- New OSC command: `/looping/sequencer/chance [deviceId, value]`
- State broadcast format: 29→30 args (index 29 = chance)
- set/state format: 26→27 args (index 26 = chance, optional)
- Max UI message tables updated
- Data flow examples added

## Consequences

### Positive
- Centralizes note probability control in Permute
- Consistent with existing temperature mixin pattern
- Backward compatible (chance is optional in set_state, extra broadcast arg ignored by older clients)
- Simple implementation — no capture/restore complexity

### Negative
- Broadcast buffer grows by 1 element (negligible per ADR-008 analysis)
- Max patch needs a new UI element wired to inlet 2 / outlet 0

### Neutral
- State version bumped to 3.2
- Chance < 1.0 activates playback observers even without sequencer patterns (intentional — ensures transport stop restores probability)

## Related
- GitHub Issue #8
- ADR-004: Modularization (mixin pattern)
- ADR-006: UI Source of Truth (persistence via `parameter_enable: 1`)
- ADR-008: Hot Path Efficiency (buffer pre-allocation pattern)
