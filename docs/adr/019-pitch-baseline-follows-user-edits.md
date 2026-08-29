# ADR-019: The Pitch Baseline Follows the User's Edits

**Status:** Accepted
**Date:** 2026-08-28
**Supersedes:** ADR-014's "Out of scope: detecting external param changes between rebuilds."
**Refines:** ADR-005, ADR-014, ADR-016 (the transpose-baseline lineage).

## Context

The pitch sequencer shifts an instrument by writing a device parameter (MIDI,
`parameter_transpose`) or by writing `Clip.pitch_coarse` (audio). Both need a
**home value** to shift away from and return to.

Reported behavior: load an instrument with a pitch macro, play a clip with no
pitch steps enabled, turn the pitch knob away from its default, then enable a
pitch step. The knob jumps from the user's value to `old_home + shiftAmount`,
and the step going off returns it to `old_home` — the user's edit is discarded
on the very first step.

### Root cause

Two independent instances of the same mistake: **treating a value captured at
one moment as authoritative for the rest of the session.**

1. **MIDI.** ADR-014 moved baseline capture to instrument-detection time and
   cached it by device id in `transposeBaselines`. That cache is never re-read
   for the life of the JS instance, so a knob move after detection is invisible.
   Detection only re-runs on a *device-list* change; a parameter value change
   does not fire the `devices` observer. Reloading Permute was the only way to
   re-capture.

2. **Audio.** `executeBatchAudio` wrote `pitch_coarse` as flat absolute state —
   `12` on, `0` off — so any transposition on the clip was destroyed the first
   time the sequencer touched it. `onTransportStop` likewise restored a hardcoded
   `0`. There was also no equivalent of ADR-016's `hasShifted` gate: the first
   step-off after transport start wrote `0` onto a clip that had never been
   shifted at all.

ADR-014 explicitly declined to fix (1), on the grounds that "the alternative
(re-read on every rebuild) is exactly the bug we just fixed." That reasoning is
sound about *rebuild-time* re-reads and does not apply to the mechanism below.

## Decision

**Read the live value immediately before every write, and fold the difference
into the baseline.** The home position is no longer a snapshot; it is
continuously reconciled against what is actually on the parameter or clip.

`TransposeStrategy.reconcileBaseline(value)` is called from `applyTranspose`
just before it writes, and classifies what it sees:

| Observed | Meaning | Action |
|---|---|---|
| within ε of `_lastWritten` | nobody touched it | no change |
| differs, currently unshifted | the param IS home | `baseline = value` |
| differs, currently shifted | user adjusted what they hear | `baseline += (value - _lastWritten)` |

Using the **delta** rather than `value - shiftAmount` in the shifted case keeps
the result correct when our shifted write was clamped at a param rail.

The audio path mirrors this without needing a class: `_shiftAudioClipPitchUp`
re-reads `pitch_coarse` at the moment of the shift (the clip is unshifted then,
so the read *is* home), and `_restoreAudioClipPitch` compares against
`expectedPitch` and adopts any drift before writing home back.

### Why a read-before-write and not a `value` observer

An observer on the transpose parameter was built first and then removed. It
would notice the edit sooner, but **nothing acts on a new baseline until the
next write**, so it produced no behavioral difference — while binding a path
listener inside the instrument's own subtree, which is precisely the shape
ADR-013 removed after it flooded Live with `_path_listener_callback` errors on
every rack load. A listener that buys no behavior is not worth that risk.

Permute registers exactly the same seven observers it did before this change.

### Preserving ADR-014's race guard

Re-reading the param does reintroduce ADR-014's hazard in one window. A strategy
rebuilt by the `devices` observer is born unshifted; if Live has not yet
propagated the outgoing strategy's revert, the param still reads
`baseline + shiftAmount` — our value, not the user's — and adopting it would
compound the shift to `+24`.

Two changes close that window:

- **`_lastWritten` is seeded from `cachedBaseline`** on a rebuilt strategy. The
  outgoing strategy was reverted before this one was built, so the baseline is
  also what the param *should* read.
- **The first reconcile of a strategy ignores a value equal to
  `_lastWritten + shiftAmount`.** Only the first look can be stale this way, so
  the guard costs nothing afterward. Writing the baseline re-issues the revert
  as a side effect, so the state self-heals.

`transposeBaselines` is kept and still seeds rebuilt strategies — it remains the
defense for the race — but it is now *updated* whenever a strategy adopts a new
baseline, via an `onBaselineChanged` callback wired in `_wireTransposeStrategy`.
The cache follows the user instead of outliving them.

## Changes

### `permute-instruments.js`

- `TransposeStrategy`: add `_lastWritten` (seeded from `cachedBaseline`),
  `_firstReconcile`, `onBaselineChanged`.
- `applyTranspose`: read the param and call `reconcileBaseline` before writing;
  record `_lastWritten` *before* issuing the write (rolled back if it throws).
- New `reconcileBaseline(value)` and `_notifyBaselineChanged()`.
- `release()` clears `onBaselineChanged`.

### `permute-device.js`

- New `_wireTransposeStrategy(strategy, deviceId)` — keeps `transposeBaselines`
  in step with the strategy. Called from both construction sites
  (`detectInstrumentType` and `scheduleDetectionRetries`).
- `executeBatchAudio`: pitch now delegates to `_shiftAudioClipPitchUp` /
  `_restoreAudioClipPitch` instead of writing `12` / `0`.
- New `_readPitchCoarse`, `_shiftAudioClipPitchUp`, `_restoreAudioClipPitch`.
- `onTransportStop` (audio branch): restore via `_restoreAudioClipPitch`.

### `permute-constants.js`

- `PITCH_COARSE_MIN` / `PITCH_COARSE_MAX` (-48 / +48) for clamping the sum.

## Consequences

### Positive

- Setting the pitch knob (or an audio clip's transpose) and *then* enabling
  pitch steps now does what it looks like it does.
- Adjusting the knob mid-sequence keeps the octave as a constant offset from the
  new position, rather than being undone at the next step boundary.
- Audio clips keep their own transposition instead of being flattened to 0.
- The audio path gains ADR-016's "never write without a prior shift" gate, which
  it had been missing: a step-off on a clip we never shifted now writes nothing.
- Reloading the device is no longer the only way to re-baseline.

### Negative / accepted trade-offs

- **One extra `get()` per pitch on/off transition.** Not per tick — `applyTranspose`
  is only reached when the step value actually changes. This partially walks back
  ADR-008's "read the param value only once" optimization; honoring user edits is
  worth one IPC read per transition.
- **A knob parked at exactly `baseline + shiftAmount`** before the first step-on
  after a strategy rebuild is read as an un-propagated revert and ignored. Narrow
  by construction (first reconcile only, exact match) and self-correcting on the
  next edit to any other value.
- **An audio clip re-pitched while shifted is only noticed at the next write.**
  If the user re-pitches a shifted clip and then removes the device, the shifted
  value stands. Same trade as the MIDI path; no observer, by the same reasoning.

### Out of scope / explicitly not done

- **Gain / mute.** `originalGain` has the same snapshot-at-first-access shape and
  the same blind spot. Untouched here — this ADR is about pitch.
- **Automation of the transpose param.** Automation writes land the same way a
  knob move does and will be adopted as a new home. Permute is not automation-
  aware and this ADR does not make it so.

## Verification

Exercised against a stubbed Live API (36 assertions, all passing) covering:
knob moved before the first step; knob moved with no notification at all; knob
moved while shifted; no compounding across a strategy rebuild; no compounding
when the revert has *not* propagated; no write when nothing was ever shifted;
and the four audio cases (relative shift, re-pitch while shifted, no-write
without a prior shift, transport-stop restore).

In Live, with `DEBUG_MODE = true`:

1. Load Simpler (or a rack with a Transpose/Pitch macro) on a Permute track.
2. Play a clip with all pitch steps off. Move the pitch knob to a non-default value.
3. Enable a pitch step. Confirm the knob lands one shift above *your* value, and
   returns to *your* value when the step goes off — look for
   `[Sequencer DEBUG:transpose] external edit while unshifted -> baseline N`.
4. With a step holding the shift, nudge the knob. Confirm the step-off lands on
   the nudged position, not the original — `external edit while shifted`.
5. Drop an FX device on the track mid-shift. Confirm no compounding (ADR-014).
6. On an audio track: set a clip's Transpose to a non-zero value, run the pitch
   sequencer, confirm the shift is relative and stop restores the clip's value.

## Related

- ADR-005, ADR-014, ADR-016 — the baseline-correctness lineage this continues.
- ADR-013 — why there is no observer on the transpose parameter.
- ADR-008 — the once-only param read this trades away one IPC call against.
