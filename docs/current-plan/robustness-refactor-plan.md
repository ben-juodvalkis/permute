# Implementation Plan: Robustness Refactor - State Persistence & Code Quality

**Issue:** #4 - State not restoring properly when loading from saved Live Set
**Status:** Ready
**Created:** 2026-02-13

> **Unblocks:** Issue #3 (IO Pathway Refactor) - that plan is blocked on this fix.

---

## Executive Summary

The device state resets to defaults after loading a saved Live Set and changing parameters. The immediate bug is that `restoreState()` bypasses all setter methods, leaving the device in a partially-initialized state where pattern data looks correct but the sequencer infrastructure (transport observers, step timing, temperature activation) is never properly configured. The first parameter change then exposes this broken state.

This is a symptom of broader architectural fragility: dual pattr paths with divergent behavior, no initialization lifecycle management, and a 3000-line monolith with no separation of concerns. This plan addresses all of these.

---

## Root Cause Analysis

### Bug 1: `restoreState()` bypasses setter methods (CRITICAL)

`restoreState()` (line 2852) directly writes to `.pattern[i]`, `.patternLength`, `.division`, and `.temperatureValue` instead of using `setPattern()`, `setLength()`, `setDivision()`, and `setTemperatureValue()`.

**What gets skipped:**

| Setter | Side Effect Skipped | Consequence |
|--------|-------------------|-------------|
| `setPattern()` | `checkAndActivateObservers()` (line 849) | Transport/time-sig observers never created; sequencer doesn't respond to playback |
| `setDivision()` | `calculateTicksPerStep()` (line 907) | `ticksPerStep` stays at constructor default (1920); step timing wrong if non-default division was saved |
| `setTemperatureValue()` | State capture/restore logic (line 1886) | Temperature transitions not handled; can leave clips in modified state |
| `setLength()` | Bounds validation (line 879) | Minor: no validation on restored length |

### Bug 2: `init()` broadcasts default state to pattr

`init()` calls `broadcastState('init')` (line 1334) which outputs `pattr_state` with default patterns (all 1s for mute, all 0s for pitch). If init fires before `restoreState()` runs, the saved pattr data gets overwritten with defaults.

### Bug 3: Dual restoration paths with divergent behavior

Two separate pattr restoration mechanisms exist:
1. `restoreState()` (line 2852) - flat 28-arg format via Max patch routing. **BROKEN**: bypasses setters.
2. `setvalueof()` (line 2979) - JSON format via pattrstorage. **Works**: calls `setState()` which uses proper setters.

It's unclear which fires in which scenarios, and they have completely different behavior.

### Bug 4: `lastValues` not cleared on clip change during playback

`onClipChanged()` (line 2523) clears temperature state and sequencer caches, but the comment on line 2541 says "lastValues are tracked per clipId, so no need to clear." This is misleading — the old clip's `lastValues` entry is orphaned and never cleaned up. More importantly, if the old clip had transformations applied (e.g., muted notes, pitch-shifted notes), those transformations are never reverted because `onClipChanged()` doesn't undo them. The clip is left in a modified state.

---

## Max/MSP JS Modularization Constraints

The `v8` object in Max 9 supports `require()` with CommonJS modules, but with limitations:
- **Subdirectory paths don't work reliably** - all required files must be in the same directory or Max's search path
- **`autowatch = 1` doesn't detect changes in required modules** - only the main file triggers reload
- **No ES6 `import/export`** - must use CommonJS `module.exports`/`require()`
- Flat file structure required (no `./lib/foo.js` paths)

**Implication**: We can modularize using `require()` with flat filenames (e.g., `permute-sequencer.js`) placed alongside the main file. Editing a module won't auto-reload the device, which is acceptable for production.

---

## Phased Implementation

### Phase 1: Fix State Persistence Bug & Consolidate Restoration Path
**Risk: Low | Blocks: Everything else**

Fix `restoreState()` by rewriting it as a thin adapter that delegates to `setState()`, fix the init broadcast problem, and clean up debug logging. This combines the bug fix with path consolidation — there's no value in an intermediate step where `restoreState()` calls individual setters only to be rewritten immediately.

#### Tasks

- [ ] **1a** Rewrite `restoreState()` as a thin adapter (lines 2852-2898)
  - Parse flat 28-arg format into JSON state object
  - Delegate to `sequencer.setState()` (which already uses all proper setters)
  - Call `sequencer.broadcastState('pattr_restore')` after

  ```javascript
  function restoreState() {
      var args = arrayfromargs(arguments);
      if (args.length < 28) return;

      var idx = 1;
      var mutePattern = [];
      for (var i = 0; i < 8; i++) mutePattern.push(parseInt(args[idx++]));
      var muteLength = parseInt(args[idx++]);
      var muteDivision = [parseInt(args[idx++]), parseInt(args[idx++]), parseInt(args[idx++])];
      idx++; // skip position

      var pitchPattern = [];
      for (var i = 0; i < 8; i++) pitchPattern.push(parseInt(args[idx++]));
      var pitchLength = parseInt(args[idx++]);
      var pitchDivision = [parseInt(args[idx++]), parseInt(args[idx++]), parseInt(args[idx++])];
      idx++; // skip position

      var temp = parseFloat(args[idx++]);

      sequencer.setState({
          version: '3.1',
          sequencers: {
              mute: { pattern: mutePattern, patternLength: muteLength, division: muteDivision },
              pitch: { pattern: pitchPattern, patternLength: pitchLength, division: pitchDivision }
          },
          temperature: temp
      });

      sequencer.broadcastState('pattr_restore');
  }
  ```

- [ ] **1b** Keep `restoreState()` as adapter (don't remove yet)
  - Full removal requires rewiring the Max patch, deferred to IO pathway refactor
  - The adapter pattern means we maintain only ONE restoration implementation (`setState`)

- [ ] **1c** Exclude `'init'` origin from pattr_state output (line 2512)
  ```javascript
  // Before:
  if (origin !== 'position' && origin !== 'pattr_restore') {
  // After:
  if (origin !== 'position' && origin !== 'pattr_restore' && origin !== 'init') {
  ```

- [ ] **1d** Clean up excessive debug logging in `getvalueof()` / `setvalueof()` (lines 2955-3001)
  - Reduce verbose investigation logging to single-line summaries
  - Keep error logging

#### Exit Criteria
- `restoreState()` delegates to `setState()` — no direct property writes
- State restores correctly when loading a Live Set
- Sequencer responds to transport after restore (proves observers activated)
- Changing a parameter doesn't reset state

---

### Phase 2: Add Initialization Lifecycle Management
**Risk: Low | Depends on: Phase 1**

Add a proper init/restore lifecycle to prevent race conditions during startup.

#### Max Initialization Sequence

**Important:** Before implementing, investigate and document the actual Max initialization order by adding temporary logging to `init()`, `restoreState()`, and `setvalueof()`. The expected sequence is:

1. `loadbang()` / `bang()` → `init()` fires first
2. pattr fires `restoreState()` (flat format via Max patch routing) and/or `setvalueof()` (JSON via pattrstorage)

**Open question:** Can both `restoreState()` and `setvalueof()` fire on the same load? If so, which fires first? The `initialized` flag implementation must handle both single and double restoration gracefully. If both fire, the second call is harmless (setState is idempotent for same data), but this should be verified.

#### Tasks

- [ ] **2a** Add `initialized` flag to `SequencerDevice` constructor (around line 1047)
  ```javascript
  this.initialized = false;
  ```

- [ ] **2b** Guard pattr_state output with initialized flag in `broadcastState()` (line 2512)
  ```javascript
  if (this.initialized && origin !== 'position' && origin !== 'pattr_restore' && origin !== 'init') {
      var pattrArgs = ["pattr_state", args[1]].concat(args.slice(3));
      outlet.apply(null, [0].concat(pattrArgs));
  }
  ```

- [ ] **2c** Set `initialized = true` at end of `init()` (after line 1334)
  ```javascript
  this.initialized = true;
  ```

- [ ] **2d** Also set `initialized = true` in `restoreState()` and `setvalueof()`
  - Ensures the flag is set regardless of which path runs last

- [ ] **2e** Add temporary initialization sequence logging (remove before final commit)
  - Log with timestamps in `init()`, `restoreState()`, and `setvalueof()` to document the actual Max startup order
  - Record findings in the ADR for Phase 5

#### Exit Criteria
- No pattr_state output during init/restore window
- Device functions normally after initialization completes
- Max initialization sequence documented from empirical testing

---

### Phase 3: Modularize into Focused Files
**Risk: Medium | Depends on: Phase 2**

Extract logical units into separate CommonJS modules. All files placed alongside `permute-device.js` (flat structure per Max constraint).

#### New Files

| New File | Extracted From | Contents | ~Lines |
|----------|---------------|----------|--------|
| `permute-constants.js` | Lines 45-102 | Constants, config, value types | 60 |
| `permute-utils.js` | Lines 104-335 | Utilities (debug, defer, createObserver, calculateTicksPerStep) | 230 |
| `permute-sequencer.js` | Lines 798-960 | `Sequencer` class | 165 |
| `permute-observer-registry.js` | Lines 501-547 | `ObserverRegistry` class | 50 |
| `permute-state.js` | Lines 549-635 | `TrackState`, `ClipState`, `TransportState` | 90 |
| `permute-instruments.js` | Lines 636-787 | `InstrumentDetector`, strategy classes | 155 |
| `permute-commands.js` | Lines 961-995 | `CommandRegistry` class | 35 |
| `permute-shuffle.js` | Lines 338-493 | Pure functions: `fisherYatesShuffle`, `generateSwapPattern`, `applySwapPattern` | 160 |
| `permute-temperature.js` | Lines 1843-2147 | SequencerDevice temperature mixin only | 310 |

**Note:** Temperature is split into two files. `permute-shuffle.js` contains pure, testable functions with no device coupling. `permute-temperature.js` contains only the `SequencerDevice` prototype methods (the mixin). This separation makes the shuffle logic independently testable and keeps the mixin focused on device integration.

#### Module Pattern

Each module exports via CommonJS:
```javascript
// permute-sequencer.js
var constants = require('permute-constants');

function Sequencer(name, transformation, valueType, patternLength) { ... }
Sequencer.prototype.setPattern = function(pattern) { ... };
// ...

module.exports = { Sequencer: Sequencer };
```

Main file imports:
```javascript
// permute-device.js
var constants = require('permute-constants');
var utils = require('permute-utils');
var Sequencer = require('permute-sequencer').Sequencer;
var ObserverRegistry = require('permute-observer-registry').ObserverRegistry;
var stateClasses = require('permute-state');
var instruments = require('permute-instruments');
var CommandRegistry = require('permute-commands').CommandRegistry;
var shuffle = require('permute-shuffle');
var temperature = require('permute-temperature');
```

#### Temperature Mixin Pattern

Temperature methods live on `SequencerDevice.prototype` but are logically separate. Use a mixin:

```javascript
// permute-temperature.js
var shuffle = require('permute-shuffle');

function applyTemperatureMethods(proto) {
    proto.setTemperatureValue = function(value) { ... };
    proto.captureTemperatureState = function(clipId) { ... };
    proto.restoreTemperatureState = function(clipId) { ... };
    proto.onTemperatureLoopJump = function() { ... };
    proto.setupTemperatureLoopJumpObserver = function() { ... };
    proto.clearTemperatureLoopJumpObserver = function() { ... };
}

module.exports = {
    applyTemperatureMethods: applyTemperatureMethods
};
```

```javascript
// permute-device.js (after SequencerDevice is defined)
temperature.applyTemperatureMethods(SequencerDevice.prototype);
```

#### Extract `getCurrentPitchOffset()` Helper

The same pitch offset calculation is duplicated in three places:
- `captureTemperatureState()` (lines 1958-1967) — calculates offset to get base pitch
- `restoreTemperatureState()` (lines 2028-2037) — calculates adjustment for restore
- `onTemperatureLoopJump()` (lines 2104-2115) — calculates adjustment for re-shuffle

All three check `lastValues[clipId].pitch === 1` and `instrumentType !== 'parameter_transpose'` to decide whether to add/subtract `OCTAVE_SEMITONES`. Extract into a shared helper in `permute-temperature.js`:

```javascript
// Inside applyTemperatureMethods:
proto._getCurrentPitchOffset = function(clipId) {
    if (this.lastValues[clipId] && this.lastValues[clipId].pitch === 1
        && this.instrumentType !== 'parameter_transpose') {
        return OCTAVE_SEMITONES;
    }
    return 0;
};
```

Then `captureTemperatureState` uses `-this._getCurrentPitchOffset(clipId)`, while `restoreTemperatureState` and `onTemperatureLoopJump` use `+this._getCurrentPitchOffset(clipId)`.

#### Consolidate Dual Value Tracking

The codebase has two overlapping tracking mechanisms:
- `Sequencer.lastAppliedValue` — used only in the `parameter_transpose` pitch path (line 2348)
- `SequencerDevice.lastValues[clipId]` — used everywhere else for delta tracking

These serve different purposes (`lastAppliedValue` is clip-independent for parameter-based transpose; `lastValues` is per-clip for note-based operations), but the naming overlap is confusing. During modularization:
- Rename `Sequencer.lastAppliedValue` to `Sequencer.lastParameterValue` to clarify its scope
- Add a comment in `Sequencer` class explaining the distinction

#### Main File After Modularization (~1200 lines)

What stays in `permute-device.js`:
- `require()` calls
- `autowatch = 1`, `inlets = 1`, `outlets = 1`
- `SequencerDevice` constructor and core methods (init, observers, transport, batching, clip management, broadcast, state persistence)
- All global Max message handler functions (`init()`, `bang()`, `mute()`, `pitch()`, `song_time()`, `restoreState()`, `getvalueof()`, `setvalueof()`, `anything()`, etc.)
- Global instance: `var sequencer = new SequencerDevice()`

Global functions MUST stay in the main file because Max's `v8` object only exposes globals from the primary script file.

#### Autowatch Consideration

`autowatch = 1` on the main file won't detect changes in required modules. Options:
- **Recommended**: Accept this for production. The device is stable.
- Development workaround: Send `bang` to re-init (which re-runs the main file)
- Alternative: Add a dev-only `reload` message handler that clears require cache

#### Tasks

- [ ] **3.1** Create `permute-constants.js` - extract constants, config, value types
- [ ] **3.2** Create `permute-utils.js` - extract utilities (depends on constants)
- [ ] **3.3** Create `permute-sequencer.js` - extract Sequencer class (depends on constants); rename `lastAppliedValue` → `lastParameterValue`
- [ ] **3.4** Create `permute-observer-registry.js` - extract ObserverRegistry (no dependencies)
- [ ] **3.5** Create `permute-state.js` - extract TrackState, ClipState, TransportState (no dependencies)
- [ ] **3.6** Create `permute-instruments.js` - extract InstrumentDetector and strategies (depends on constants, utils)
- [ ] **3.7** Create `permute-commands.js` - extract CommandRegistry (depends on utils)
- [ ] **3.8** Create `permute-shuffle.js` - extract pure shuffle/swap functions (depends on constants)
- [ ] **3.9** Create `permute-temperature.js` - extract temperature mixin with `_getCurrentPitchOffset()` helper (depends on constants, utils, shuffle)
- [ ] **3.10** Update `permute-device.js` - add requires, remove extracted code, apply temperature mixin
- [ ] **3.11** Verify device loads and all functionality works

#### Exit Criteria
- `permute-device.js` reduced from ~3000 to ~1200 lines
- All modules load via `require()` without errors
- Pitch offset calculation exists in exactly one place (`_getCurrentPitchOffset`)
- Full verification suite passes (same as Phase 1 criteria)
- No behavioral changes - pure structural refactor

---

### Phase 4: Documentation
**Risk: None**

- [ ] **4.1** Create `docs/adr/003-robust-state-restoration.md` documenting Phases 1-2
- [ ] **4.2** Create `docs/adr/004-modularization.md` documenting Phase 3
- [ ] **4.3** Update `CLAUDE.md` key files table with new module files
- [ ] **4.4** Update `docs/api.md` if any broadcast behavior changes

---

## Implementation Order & Commits

| Commit | Phases | Risk | Description |
|--------|--------|------|-------------|
| 1 | 1 + 2 | Low | Fix state persistence bug, consolidate restoration path, add lifecycle guard |
| 2 | 3 | Medium | Modularize into focused files |
| 3 | 4 | None | Documentation |

---

## Verification

After each commit:
1. Save a Live Set with non-default patterns (mute: `[0,1,0,1,1,1,1,1]`, pitch: `[1,0,1,0,0,0,0,0]`, custom division `[0,2,0]`, temperature 0.5)
2. Reload the Live Set - check Max console for `[RESTORE]` message, verify patterns in UI
3. Press play - sequencer should respond to transport (proves observers activated)
4. Change a parameter (toggle a mute step) - state should NOT reset
5. Stop/restart transport - patterns should persist
6. Check Max console - clean logging, no errors, no excessive debug spam

---

## Known Issues (Out of Scope)

These issues were identified during analysis but are out of scope for this refactor. They should be tracked separately.

### `lastValues` not cleaned up on clip change

`onClipChanged()` (line 2523) doesn't revert transformations on the old clip or clean up its `lastValues` entry. If the user switches clips during playback, the old clip is left in a modified state (muted notes, shifted pitches). The comment on line 2541 ("no need to clear") is misleading — the old clip's transformations are orphaned.

**Why out of scope:** Fixing this properly requires reverting transformations on the old clip before switching, which touches the batch system and clip lifecycle. This is better addressed in a dedicated clip-management improvement.

### No error handling in temperature hot-path Live API calls

`clip.call("get_all_notes_extended")` in `onTemperatureLoopJump()` (line 2100), `captureTemperatureState()` (line 1945), and `restoreTemperatureState()` (line 2014) can fail silently if a clip becomes invalid mid-operation (user deletes it). `restoreTemperatureState()` has try-catch around `apply_note_modifications` (line 2061) but the other two don't.

**Why out of scope:** Adding error handling here is straightforward but should be part of a broader error-handling pass, not mixed into a state persistence fix.

### Parameter scan limit of 17 is fragile

`findTransposeParameterByName()` (line ~229) limits scanning to 17 parameters, based on typical rack macro count. Devices with more parameters won't have their transpose parameter detected.

**Why out of scope:** This is a detection limitation, not a state persistence issue. Could be made configurable or increased in a separate improvement.

---

## Appendix A: Current Code Structure

| Section | Lines | Description |
|---------|-------|-------------|
| Constants & Config | 45-102 | `TRANSPOSE_CONFIG`, `CONSTANTS`, `VALUE_TYPES` |
| Utilities | 104-335 | `debug()`, `handleError()`, `parseNotesResponse()`, `createObserver()`, `defer()`, `calculateTicksPerStep()` |
| Temperature Helpers | 338-493 | `fisherYatesShuffle()`, `generateSwapPattern()`, `applySwapPattern()` |
| ObserverRegistry | 501-547 | Observer lifecycle management |
| State Objects | 549-635 | `TrackState`, `ClipState`, `TransportState` |
| Instrument Detection | 636-787 | `InstrumentDetector`, strategy pattern classes |
| Sequencer Class | 798-960 | Generic pattern/timing wrapper |
| CommandRegistry | 961-995 | Message dispatch |
| SequencerDevice | 997-2625 | Main device controller (~1600 lines) |
| Global Instance | 2628 | `var sequencer = new SequencerDevice()` |
| Max Handlers | 2630-3012 | Global functions exposed to Max |

## Appendix B: Dependency Graph for Modules

```
permute-constants.js          (no deps)
    |
    +-- permute-utils.js      (depends on constants)
    |       |
    |       +-- permute-instruments.js  (depends on constants, utils)
    |       +-- permute-commands.js     (depends on utils)
    |       +-- permute-temperature.js  (depends on constants, utils, shuffle)
    |
    +-- permute-sequencer.js  (depends on constants)
    |
    +-- permute-shuffle.js    (depends on constants)

permute-observer-registry.js  (no deps)
permute-state.js              (no deps)
```

## Related

- ADR-002: Restore State Format Fix (previous partial fix for this issue)
- `docs/current-plan/io-pathway-refactor-plan.md` (blocked by this fix)
- Issue #3: Separate input/output pathways
- Issue #4: State not restoring properly

---

## Work Log

### 2026-02-19 — Phase 1 + Phase 2 Implementation

**Completed tasks:**

#### Phase 1a: Rewrite `restoreState()` as thin adapter (line 2902)
- Replaced direct property writes (`sequencer.sequencers.muteSequencer.pattern[i] = ...`) with flat-arg parsing into a JSON state object
- Delegates to `sequencer.setState()` which calls proper setters: `setPattern()`, `setLength()`, `setDivision()`, `setTemperatureValue()`
- All setter side effects now fire on restore: observer activation, timing calculation, temperature state handling

#### Phase 1c: Exclude `'init'` origin from pattr_state output (line 2562)
- Added `&& origin !== 'init'` to the pattr_state guard in `broadcastState()`
- Prevents `init()` from broadcasting default state to pattr, which would overwrite saved data before `restoreState()` runs

#### Phase 1d: Clean up debug logging in `getvalueof()` / `setvalueof()`
- `getvalueof()` (line 2999): Replaced 8 verbose `post()` investigation lines with single `debug()` call
- `setvalueof()` (line 3010): Replaced 7 verbose `post()` lines with `debug()` + `handleError()`, removed dead else branch

#### Phase 2a: Add `initialized` flag to constructor (line 1069)
- `this.initialized = false` in `SequencerDevice` constructor

#### Phase 2b: Guard pattr_state output with `initialized` flag (line 2562)
- Changed condition to `this.initialized && origin !== 'position' && origin !== 'pattr_restore' && origin !== 'init'`
- Prevents any pattr_state output during the init/restore startup window

#### Phase 2c-d: Set `initialized = true` in all three paths
- `init()` (line 1372): Set after `broadcastState('init')` completes
- `restoreState()` (line 2939): Set after `setState()` delegates to proper setters
- `setvalueof()` (line 3018): Set after `setState()` delegates to proper setters
- Whichever path runs last wins — idempotent, no race condition

#### Phase 2e: Temporary init sequence logging
- Added `[INIT-SEQ]` timestamped `post()` calls in `init()`, `restoreState()`, `setvalueof()`
- Purpose: Empirically verify Max startup order (init → restoreState? → setvalueof?)
- Marked with `// TEMP:` comments for easy removal after verification

**Net line change:** ~-25 lines (removed verbose logging, simplified restore paths)

**What's left:**
- Phase 3: Modularization into CommonJS modules (separate commit)
- Phase 4: Documentation (ADRs, CLAUDE.md update)
- Remove `[INIT-SEQ]` logging after empirical verification in Ableton
