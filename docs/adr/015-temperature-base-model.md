# ADR 015: Temperature Base Model (lossless return-to-zero)

**Status:** Accepted
**Date:** 2026-05-25
**Supersedes the temperature state mechanism in:** ADR 106 (reference/106-temperature-transformation-architecture.md)

## Context

Returning the temperature control to 0 was supposed to restore the clip to its
pristine original. In practice notes were lost. The id-tracking math itself was
correct — a Node simulation of 200 loop jumps followed by return-to-0 was
lossless — but the *state that defined "original"* was being destroyed and
rebuilt at the wrong moments:

1. **Transport stop deleted `temperatureState`** while keeping
   `temperatureValue > 0`. The next transport start re-captured whatever
   pitches were currently in the clip as the new "original." If anything had
   scrambled them first, the scramble became the baseline and the true original
   was gone forever. This is the "same clip, never switched" failure.
2. **A deferred `loop_jump` callback could race return-to-0**, applying a swap
   after the restore had already run and deleted the state, leaving notes
   scrambled with nothing left to undo.
3. **Overdubbed notes corrupted the clip**: an overdubbed note could steal a
   captured note's pitch via a swap, and that wrong pitch stuck permanently.

The root cause is architectural: the design treated *the clip itself* as the
storage for the original and relied on being able to reverse every scramble.
Reversibility had to be actively maintained, and every place that rebuilt the
reverse-map was a chance to capture a corrupted baseline.

## Decision

The user's composition is the **source of truth**, held in an in-memory **base
model** per clip. The scrambled clip is never read back as truth.

```
displayed = applySwap(baseModel, temperature)
```

- **Base model:** `clipId -> { baseModel: { noteId -> {pitch,start_time,…} }, expected }`.
  Full note dicts (not just pitch) keyed by `note_id`, with the *true* base
  pitch (any pitch-sequencer octave shift removed).
- **Every variation** (initial enable, loop jump, post-edit) is derived by
  resetting known notes to their base pitch, generating a fresh swap, and
  writing. Variation is therefore non-cumulative by construction — it always
  starts from the base, never from the previous scramble.
- **Return to 0** rewrites the base model verbatim (+ current pitch-sequencer
  offset). Lossless by definition; it does not "reverse N swaps."
- **Transport stop** writes the base model back to the clip (so a saved Live set
  is clean) but **keeps the base model in memory**. Transport start re-derives
  from it instead of re-capturing from the live clip. The re-capture-on-start
  path is removed.

### Detecting user edits while hot (content diff, timing-independent)

Live fires the `notes` notification for our own writes as well as user edits.
We distinguish them by **content**, not timing:

- Before each write we record `expected = { noteId -> pitch }` — the exact
  pitches we are about to write. `expected` is recorded **before** the
  `apply_note_modifications` call, because that call queues the notification
  synchronously; recording after would race it.
- On a `notes` notification we read the clip and compare to `expected`:
  - exact match → our own swap write → ignore.
  - different id-set (add/remove) or any existing note repitched away from
    `expected` → **user edit** → re-baseline.

Because the decision is content-based, correctness no longer depends on which
callback runs first — this is what eliminates the loop-jump race.

### Re-baseline policy

A user edit while hot **supersedes** the prior original (accepted tradeoff, by
design): the current notes become the new base model. Notes we recognise that
the user did *not* touch (still at their `expected` swap pitch) are reverted to
base before snapshotting, so the new base reflects the user's composition rather
than our scramble. Notes the user added or repitched are kept as the new intent.
A fresh variation is then applied so playback stays consistent.

### Overdubs are never swapped until re-baselined

`applyTemperatureVariation` swaps only notes present in the base model. An
overdubbed note that is not yet folded in (its `notes` notification still
pending) is excluded from the swap pool, so it always keeps its recorded pitch.
Without this, a return-to-0 that lands *before* the notes observer fires would
leave the overdub at a scrambled pitch — `restoreBaseModel` only restores
base-model notes. Excluding non-base notes closes that window entirely.

### Disarm before restore on transport stop

On transport stop, the temperature observers are torn down and
`temperatureActive` is cleared **before** the notes are read and the base model
is written back. This guarantees any already-queued deferred
`onTemperatureNotesChanged` callback sees inactive state and bails, rather than
racing the restore write (which sets `expected = null`) and triggering a
spurious re-baseline of the just-cleaned clip.

### `captureBaseModel` self-enforces no-overwrite

Capture returns early if a base model already exists for the clip, so the
"never overwrite except via re-baseline" contract holds even if a future caller
forgets to guard. Re-baseline assigns `temperatureState` directly and is the
only path that replaces an existing base model.

## Consequences

### Positive
- Return-to-0 is provably lossless (single clip, across transport cycles, with
  pitch sequencer active).
- The loop-jump / return-to-0 race is gone (content diff, not timing).
- Overdubs and deliberate edits while hot no longer corrupt the clip; they
  re-baseline cleanly.
- The clip on disk is always clean after transport stop, so saved sets are safe.

### Negative / tradeoffs
- The pre-edit original is intentionally discarded when the user edits while
  hot. This was an explicit decision: an edit is treated as new intent.
- Base model is in-memory only; it does not survive closing/reopening the Live
  set while temperature is hot. Acceptable because transport stop always writes
  the clean original back to the clip, so nothing is lost on disk.
- If a user edit lands in the *same* notification coalesce window as one of our
  writes, that edit may not be re-baselined until the next change. Downside is a
  delayed re-baseline, never corruption.

## Verification

`get_all_notes_extended` / `apply_note_modifications` were exercised against a
mock clip with the real `permute-temperature.js` and `permute-shuffle.js`. The
notes notification is modelled as an async, manually-drained queue (matching
Max's `defer`) so callback ordering can be controlled:

- 200 loop jumps on one clip → return-to-0 lossless.
- Transport stop writes original; stop/start cycles → return-to-0 lossless.
- Overdub while hot, observer drained → re-baselined, overdub preserved.
- User repitches an existing note while hot → that note becomes new base,
  others restore.
- Pitch sequencer on during temperature → return-to-0 keeps the octave shift.
- **Race:** overdub → loop variation → return-to-0 *before* the notes observer
  fires → overdub kept at its recorded pitch. Confirmed to fail with the
  pre-fix full-array swap and pass with the base-note-only swap.

## Files

- `permute-temperature.js` — base model capture/restore/variation, notes
  observer, content diff, re-baseline.
- `permute-device.js` — transport start/stop, `onClipChanged`, `_setCachedClip`,
  `temperatureState` shape.
