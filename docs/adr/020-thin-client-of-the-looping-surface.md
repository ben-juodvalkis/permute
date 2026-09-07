# ADR-020: Permute Becomes a Thin Client of the Looping Surface

**Status:** Accepted (decision recorded; implementation not started)
**Date:** 2026-09-07
**Reverses:** ADR-001 (extraction from Looping) — the standalone rationale does not hold for the thin device this ADR describes
**Keeps:** ADR-010 (the `live.*` objects are the source of truth for pattern state; after this ADR that is the *only* job the device has)
**Retires once implemented:** ADR-017 (OSC step telemetry — the surface will emit step position itself); the ADR-018 hard rule (no JS remains to own handles); the baseline machinery of ADR-005 / ADR-014 / ADR-016 / ADR-019 (the surface owns the baseline); the observer machinery of ADR-011 / ADR-013 (the surface has its own listeners)
**Related:** Looping issue #489 (*Drum Rack kit map, per-pad control and virtual macros*) and the addendum posted on it the same day; Looping ADR-171 (the Looping-side record of the extraction)

## Context

### The trigger: per-pad drum pitch in Looping

Looping issue #489 explores giving the Drum Rack per-pad control. Its Option C
strips the kit files' macro mappings and rebuilds "the whole kit" gesture as a
*virtual macro* computed on the Python control surface: target per pad =
clamp(global + offset), thirty-two LOM writes in one undo step, the global and
the offsets persisted per track in `Track.set_data`.

Today the drum pitch offset is one number per rack — a macro found by name —
and Live's macro mapping fans it out to every DrumCell's Transpose. Three
writers touch that macro:

| Writer | How |
|---|---|
| Looping's Drum Rack view "Trnsp" slider | writes rack parameter 4 by fixed index |
| Looping's FX-grid Pitch slider and ±12 buttons | `findTransposeParameter()` name scan in `clipTranspose.ts` |
| Permute's pitch sequencer | `findTransposeParameterByName()` + `TransposeStrategy`, baseline + `shiftAmount` |

The unit is macro units, not semitones: sixteen units per octave (twenty-one for
the Komplete Kontrol `Custom E` macro) because the kit's mapping spans roughly
±48 semitones over 0..127. A macro-mapped cell parameter is locked by Live,
which is why "tune just the snare" is impossible today and why the issue needs
an offline unmapping stage.

Permute is the one writer with **no route to a virtual macro**. It talks to Live
directly through LiveAPI and only hears `song_time` on its transport inlet. On
an unmapped kit its pitch sequencer fails one of two ways:

- **Macro left in place but unmapped.** The name scan still finds it, writes
  it, and nothing moves. A silent no-op.
- **Macro renamed or removed.** Detection falls back to `note_transpose`,
  which moves every note up an octave. On a Drum Rack that triggers different
  pads, not a higher pitch. (Looping's clip-transpose buttons have the same
  fallback.)

The issue's "Components touched" list did not mention Permute. Fixing this
*inside* Permute — fanning out to every DrumCell Transpose parameter, one
baseline per cell, thirty-two owned handles from the HandlePool — would
duplicate the surface's global + offset arithmetic and make two writers of the
same cells. That is the shape of every baseline bug in this repo's history
(ADR-005, ADR-014, ADR-016, ADR-019): two writers inferring each other's
intent from a shared parameter.

### What "talking to the surface" means

Looping already uses one shape for hardware and Max lanes: **Max (or the
hardware) as input, the Python surface as the brain.** The foot pedal
(Looping ADR-422), the wah (ADR-407) and the Move drum-chain knob (ADR-412)
all send a small message to the surface's UDP port and let it resolve context
and write to Live. Permute is already halfway there:

- Step telemetry goes to the surface's port (ADR-017), where
  `PermuteStepComponent` translates it onto the v3 wire.
- The surface is what loads Permute onto every prepared track
  (`TrackPrepareComponent._ensure_sequencer`, matching the device by the
  literal name `Permute`).
- The iPad edits Permute's steps through the surface with ordinary
  `/looping/v3/param/set` writes on Permute's own parameters.
- The surface's `LOMListeners` attaches a value listener to **every parameter
  on every track**, so it already observes the whole pattern of every Permute
  device in the set.

The LiveAPI writes — mute, pitch, temperature, chance — are the last piece
still done from Max.

### What the surface already has that Permute re-implements

| Permute | Looping surface equivalent |
|---|---|
| `ObserverRegistry`, `HandlePool`, ADR-018 rule | `LOMListeners`, plain `add_*_listener` / `remove_*_listener` |
| `TrackState` / `ClipState` / clip cache (ADR-011) | v3 tree, `PlayheadComponent` playing-slot tracking |
| Instrument detection by `class_name` | the same scan in `SelectedTrackComponent` / `WahPedalComponent` |
| Note edits by `note_id` (temperature, chance, mute) | `ClipNotesComponent` — `apply_note_modifications` keyed by id, `probability` field already handled |
| Nothing | undo grouping (`begin_undo_step`), generation counters that reject stale writes, `Track.set_data` persistence, roles (ADR-425), the kit map and pad selection (#489) |
| Nothing | a pytest suite with fakes, `perf_profiler`, drain stats, heartbeat, `Log.txt` |
| `DEBUG_MODE` + the Max console | the above |

Permute has no automated tests at all.

### Benefits

1. **One owner of pitch, with an additive model.** Pitch becomes
   `global + padOffset + sequencerShift`, each a separate term the surface
   holds. Transport stop zeroes the last term. The surface routes the other
   writers (iPad slider, Move knob), so nothing has to be *inferred* from the
   parameter — the whole ADR-005/014/016/019 lineage stops being necessary.
2. **The Max runtime hazards disappear for the moved code.** The V8 finalizer
   abort (ADR-018), the `_path_listener_callback` flood (ADR-013) and the
   stale-handle audio-thread crash that `MuteStrategy` re-resolves around are
   all consequences of LiveAPI inside Max. Python listeners are plain calls.
   The surface has its own rules (keep writes out of listener callbacks), but
   they are codified and tested there.
3. **Surface state becomes reusable.** Selected track, device tree, clip
   cache, roles, the kit map and pad selection, generation counters, undo
   steps, `Track.set_data`. The drum fan-out lives in one place and serves the
   slider, the knob and the sequencer alike.
4. **Tests and observability** — see the table above.
5. **One engine instead of one JS instance per track.** Fewer transport and
   device observers on Live. Step telemetry becomes native output instead of
   the ADR-017 workaround for "Visible (Not Stored)" numboxes.
6. **The auto-load machinery stays but shrinks.** The device is a parameter
   holder; there is nothing in it to fail at load time.

### Costs

- **Dependence on the surface being installed and running.** Accepted: there
  is one user, and sharing later can ship the frozen standalone device.
- **Timing.** The transport-locked metro fires on the 1/16 grid; a surface
  clock rides the `current_song_time` listener and the control tick. Measured
  on the Looping side (2026-08-31):

  | Path | Measured |
  |---|---|
  | Permute clock today | transport-locked `metro @interval 0 0 120`, then Max's low-priority thread, then LiveAPI |
  | Surface UDP read wait after the drain pump, mean / p99 | 5.6 ms / 10.3 ms |
  | Surface drain pump rate | 92.8 Hz |
  | Surface fallback tick if the pump dies | ~100 ms |

  A grid-locked metro's precision is spent in the UDP hop anyway, and a
  surface clock can *lead* the boundary because it knows tempo and beat
  position — which is what `note.mute` and pitch actually need, since Live
  triggers the note at the boundary. Today's Permute is late by construction
  too. Still a measurement, not a fact — see below.
- **Iteration loop.** Python changes need the surface re-selected in Live's
  control-surface slot (its `disconnect` path is built for that). Max gives
  `autowatch` on the main file. About the same friction.
- **A contract to version, if any message remains.** With no JS in the
  device, the only candidate is a clock tick. If one is kept it fires blind
  over UDP, so it must carry absolute state, not deltas.

## Decision

1. **Permute becomes a parameter holder with no code.** The device keeps the
   `live.*` controls that define a pattern, and nothing else. The owner has
   confirmed that steps, rates and the rest are automated with clip
   envelopes, so every pattern value must stay a real Live parameter
   (persistence, undo, automation, Push mapping). No other home has those
   properties: `Track.set_data` persists but has no automation, undo or Push;
   surface memory is gone on restart.
2. **The Looping surface owns the sequencer engine.** A new component
   (proposed name `SequencerComponent`) owns the clock, the step math and the
   four actions, and emits step telemetry directly.
3. **The thin device and the Python component live in the Looping repo.**
   This repository is frozen as the last standalone release (see *Repo
   decision* below).
4. **The clock moves to the surface by default**, pending one measurement.
   If the listener proves too coarse, the patch keeps one `metro` and a
   `udpsend` tick — still with no JS.
5. **Parameters are named properly and resolved by name on both sides**, so
   the layout can change without another index shift.

### What stays in the device

| Control | Parameter names |
|---|---|
| 8 × `live.toggle` | `Mute 1` … `Mute 8` |
| 8 × `live.toggle` | `Pitch 1` … `Pitch 8` |
| 2 × `live.menu` | `Mute Length`, `Pitch Length` |
| 2 × `live.menu` | `Mute Rate`, `Pitch Rate` (same `ENUM_RATES` order) |
| 2 × `live.dial` | `Temperature`, `Chance` |
| `live.thisdevice` | (instantiation only) |

Twenty-two pattern parameters after Live's built-in `Device On`. Device name
stays `Permute` (load-bearing: `TrackPrepareComponent._track_has_sequencer`
matches on it). Device class stays an audio effect (`MxDeviceAudioEffect`) so
it loads on audio tracks too. The Live-side UI only needs to exist, not to be
pretty — the iPad is the interface.

### What goes

- The `v8 permute-device.js` object and every module it requires.
- `udpsend` (both the live `/looping/permute/step` sender to port 11020 and
  the leftover `/looping/sequencer/state` sender to the retired port 11003).
- The `coll rate`, `join`, `prepend` plumbing and the leftover message boxes.
- The `Mute Current` / `Pitch Current` display numboxes (telemetry; the surface
  emits it and the iPad already reads it from there).
- The `Reset` button (a command, not state; the iPad writes the parameters).
- The `transport` + `metro` clock, pending the measurement in Decision 4.

### What moves to Python

| Permute file | Lines | LiveAPI call sites (approx.) | Fate |
|---|---|---|---|
| `permute-sequencer.js` | 148 | 0 | port as is (pattern / timing math) |
| `permute-shuffle.js` | 168 | 0 | port as is |
| `permute-temperature.js` | 510 | 3 | port — the base-model logic (ADR-015) |
| `permute-chance.js` | 72 | 2 | port onto `ClipNotesComponent` |
| `permute-constants.js` | 125 | 0 | fold into `config/constants.json` (already the transpose table's home) |
| `permute-state.js` | 98 | 5 | replaced by the v3 tree |
| `permute-instruments.js` | 457 | 19 | shrinks: the surface owns the baseline; keep the *routing* (macro / virtual macro / `pitch_coarse` / notes) |
| `permute-device.js` | 1525 | 23 | Max plumbing, mostly dropped |
| `permute-utils.js` + `permute-observer-registry.js` | 527 | 28 | dropped; the surface has equivalents |

### Surface component responsibilities

- **Clock.** `current_song_time` listener (already attached by
  `SessionComponent`, throttled only for the readout) → step index per
  device via the ported `Sequencer` math. Option: apply the *next* step's
  state a few milliseconds before the boundary (lookahead), which neither
  implementation does today.
- **Pattern.** Cached per device from the existing per-parameter value
  listeners. **Read-only:** the component never writes a pattern parameter —
  writing would fight the envelope and flip Live into automation override on
  every step. **Sampled at step boundaries, not on every fire:** an envelope
  can change a toggle, a rate or a length mid-step; it takes effect at the
  next boundary, exactly as Permute behaves today.
- **Actions.** Mute (`note.mute` on MIDI clips via `apply_note_modifications`,
  clip `gain` on audio clips); pitch (the rack macro on mapped kits, the
  virtual macro on unmapped ones, `pitch_coarse` on audio clips, note
  transposition on melodic instruments — the routing `ClipNotesComponent`
  and `clipTranspose.ts` already encode); temperature (base model); chance
  (`probability`). Delta-based, as today: act on transitions only.
- **Telemetry.** Emits `/looping/v3/permute/step` itself; `PermuteStepComponent`
  retires.
- **Restore.** Transport stop restores clips and parameters as today. The
  component's `disconnect` must do the same — a surface reload mid-play must
  not leave clips shifted or muted. Runtime state (base models, `hasShifted`,
  last-applied values) lives in component memory keyed by device path, lost
  on reload exactly as it is today when Permute reloads.
- **Not changed by this ADR.** When the sequencer's *target* is itself
  automated (an envelope on a kit's Transpose macro), the sequencer's writes
  override the envelope, as they do today. On unmapped kits the virtual macro
  composes cleanly because the surface owns every term.

### Repo decision

The reasons ADR-001 gave for a separate repository — independent use,
independent versioning, a cleaner install — hold only for the fat device. A
thin client cannot run without the surface, so a separate repo for it buys
nothing, while the coupling that matters already lives in Looping, unversioned
against the surface that consumes it:

- `interface/src/lib/stores/v6/sequencerStore.svelte.ts` hardcodes Permute's
  whole parameter layout by index, with comments working around the naming
  bug below.
- `config/constants.json` (`devices.sequencer.devicePath`) and
  `devicePresets.ts` point into this checkout; `TrackPrepareComponent`
  matches the literal device name `Permute`.
- `/looping/permute/step` is a private ingest address the surface translates;
  the rate-enum order is documented as matching this repo's `ENUM_RATES`.
- Looping still carries the pre-extraction copy — `ableton/M4L devices/
  Sequencer.amxd`, `Sequencer.maxpat`, `sequencer-device.js` and its README.
  ADR-001's checklist item "remove extracted files from Looping" was never
  done.

So the thin device (`Permute.amxd` + `.maxpat`) and the Python component are
developed in Looping, where one commit can change the patch, the surface
component and the UI store together, under Looping's test suite, mock surface
and perf harness. This repository is tagged as the last standalone release,
its README points at Looping, and development stops here. The fat device
remains the shareable artifact if one is ever wanted: it works without the
surface, which the thin client never will.

## Consequences

### Positive

- The drum per-pad pitch work in #489 has one consumer for the virtual macro
  that also covers the sequencer, the slider and the knob.
- The baseline-inference bug class is gone by construction.
- The HandlePool rule, the observer registry and the V8 hazards leave with the
  JS.
- Sequencer logic becomes unit-testable in Python; behaviour is visible in
  `Log.txt` and the perf profiler.
- One clock and one engine for every track.

### Negative

- Permute no longer works without the Looping surface.
- A surface restart mid-song drops runtime state (base models, shift state)
  until the next transition; today a Permute reload does the same.
- Timing is unproven until measured (below).
- Sets built with the fat Permute keep working only until each track's device
  is swapped for the thin one — Looping's replace-instrument mode of
  `prepare_for_preset` can do that per track.

### Neutral

- ADR-010's principle is unchanged and now total: the `live.*` objects are
  the only thing the device is.
- The in-repo `.amxd` must live under a Places root so Live's browser can
  load it (today `paths.placesRoots.permute` points at this checkout).

## Measurements owed before implementation

1. **Surface clock granularity.** Cadence of the `current_song_time` listener
   versus the metro; jitter of `note.mute` / parameter writes at 1/16
   boundaries at performance tempos; whether lookahead is needed. Looping's
   `scripts/perf/scenario.mjs` harness, new scenario.
2. **Per-step note edits inside the control tick.** Cost of
   `apply_note_modifications` on large clips alongside the 30 Hz playhead and
   meter emits.
3. **Undo behaviour** of per-step note edits and parameter writes from the
   surface (#489's item 3 covers the parameter case).
4. **Browser load of the in-repo `.amxd`** from a Looping-owned Places root.

## Phasing

| Phase | Delivers | Depends on |
|---|---|---|
| 0 | Timing measurement; thin `Permute.amxd` built in Looping with the parameter names above; layout documented in `constants.json` and resolved by name in `sequencerStore` | — |
| 1 | `SequencerComponent`, pitch only (macro / virtual macro / `pitch_coarse` / notes); `devicePath` switched to the in-repo device; existing tracks swapped | 0, and #489 M2/M3 for the virtual-macro branch |
| 2 | Mute (`note.mute` / clip gain) | 1 |
| 3 | Temperature and chance, ported onto `ClipNotesComponent` | 2 |
| 4 | Retire `PermuteStepComponent` ingest; delete Looping's stale `Sequencer.*`; tag this repo; Looping ADR | 3 |

## Side findings recorded here

- **`Permute.maxpat` in this repo is stale against `Permute.amxd`.** The
  `.amxd` carries the 1/16-note metro (`@interval 0 0 120`), the step sender to
  port 11020 and a leftover sender to the retired port 11003; the `.maxpat`
  has a one-bar metro (`@interval 1 0 0`), no network objects and legacy
  `mute pattern` / `mute length` message boxes. Anyone editing the patch from
  the repo file would start from the wrong version. Moot once the thin device
  is rebuilt in Looping, but worth knowing until then.
- **`Mute Current` and `Pitch Current` both report the name `Mute Current`**
  (a copy-paste in the patch), which is why Looping matches Permute's
  parameters by index. The thin device drops both numboxes and names
  everything explicitly.
- **The two repos disagree on `transpose` / `octave` shift units.**
  `permute-constants.js` uses 12 (with an FX1/FX2 override to 16);
  Looping's `constants.json` uses 16 for every standard name. With the surface
  owning the routing there is one table.

## Related

- ADR-001 — extraction from Looping (reversed by this ADR)
- ADR-010 — UI-native revamp (kept; now the whole device)
- ADR-017 — OSC step telemetry (retired once the surface emits steps)
- ADR-018 — LiveAPI handle ownership (moot once no JS remains)
- ADR-005, ADR-014, ADR-016, ADR-019 — the baseline lineage this replaces
- Looping issue #489 and its addendum; Looping ADR-171, ADR-407, ADR-412,
  ADR-422, ADR-425
