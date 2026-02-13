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

### Phase 1: Fix the Immediate Bug
**Risk: Low | Blocks: Everything else**

Fix `restoreState()` and `broadcastState()` to eliminate the state reset.

#### Tasks

- [ ] **1a** Fix `restoreState()` to use proper setter methods (lines 2852-2898)
  - Replace `sequencer.sequencers.muteSequencer.pattern[i] = parseInt(args[idx++])` with building a pattern array and calling `setPattern()`
  - Replace `.patternLength = parseInt(args[idx++])` with `setLength()`
  - Replace `.division = [bars, beats, ticks]` with `setDivision([bars, beats, ticks], sequencer.timeSignatureNumerator)`
  - Replace `.temperatureValue = parseFloat(args[idx++])` with `setTemperatureValue()`

- [ ] **1b** Exclude `'init'` origin from pattr_state output (line 2512)
  ```javascript
  // Before:
  if (origin !== 'position' && origin !== 'pattr_restore') {
  // After:
  if (origin !== 'position' && origin !== 'pattr_restore' && origin !== 'init') {
  ```

- [ ] **1c** Clean up excessive debug logging in `getvalueof()` / `setvalueof()` (lines 2955-3001)
  - Reduce verbose investigation logging to single-line summaries
  - Keep error logging

#### Exit Criteria
- State restores correctly when loading a Live Set
- Sequencer responds to transport after restore (proves observers activated)
- Changing a parameter doesn't reset state

---

### Phase 2: Consolidate pattr Restoration to Single Path
**Risk: Low | Depends on: Phase 1**

Eliminate the dual-path problem by making `restoreState()` a thin adapter that delegates to `setState()`.

#### Tasks

- [ ] **2a** Rewrite `restoreState()` as a thin adapter
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

- [ ] **2b** Keep `restoreState()` as adapter (don't remove yet)
  - Full removal requires rewiring the Max patch, deferred to IO pathway refactor
  - The adapter pattern means we maintain only ONE restoration implementation (`setState`)

#### Exit Criteria
- `restoreState()` delegates to `setState()` - no direct property writes
- Same verification as Phase 1 still passes

---

### Phase 3: Add Initialization Lifecycle Management
**Risk: Low | Depends on: Phase 2**

Add a proper init/restore lifecycle to prevent race conditions during startup.

#### Tasks

- [ ] **3a** Add `initialized` flag to `SequencerDevice` constructor (around line 1047)
  ```javascript
  this.initialized = false;
  ```

- [ ] **3b** Guard pattr_state output with initialized flag in `broadcastState()` (line 2512)
  ```javascript
  if (this.initialized && origin !== 'position' && origin !== 'pattr_restore' && origin !== 'init') {
      var pattrArgs = ["pattr_state", args[1]].concat(args.slice(3));
      outlet.apply(null, [0].concat(pattrArgs));
  }
  ```

- [ ] **3c** Set `initialized = true` at end of `init()` (after line 1334)
  ```javascript
  this.initialized = true;
  ```

- [ ] **3d** Also set `initialized = true` in `restoreState()` and `setvalueof()`
  - Ensures the flag is set regardless of which path runs last

#### Exit Criteria
- No pattr_state output during init/restore window
- Device functions normally after initialization completes

---

### Phase 4: Modularize into Focused Files
**Risk: Medium | Depends on: Phase 3**

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
| `permute-temperature.js` | Lines 338-493 + 1843-2147 | Temperature helpers + SequencerDevice temperature mixin | 460 |

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
var temperature = require('permute-temperature');
```

#### Temperature Mixin Pattern

Temperature methods live on `SequencerDevice.prototype` but are logically separate. Use a mixin:

```javascript
// permute-temperature.js
function applyTemperatureMethods(proto) {
    proto.setTemperatureValue = function(value) { ... };
    proto.captureTemperatureState = function(clipId) { ... };
    proto.restoreTemperatureState = function(clipId) { ... };
    proto.onTemperatureLoopJump = function() { ... };
    proto.setupTemperatureLoopJumpObserver = function() { ... };
    proto.clearTemperatureLoopJumpObserver = function() { ... };
}

module.exports = {
    applyTemperatureMethods: applyTemperatureMethods,
    fisherYatesShuffle: fisherYatesShuffle,
    generateSwapPattern: generateSwapPattern,
    applySwapPattern: applySwapPattern
};
```

```javascript
// permute-device.js (after SequencerDevice is defined)
temperature.applyTemperatureMethods(SequencerDevice.prototype);
```

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

- [ ] **4.1** Create `permute-constants.js` - extract constants, config, value types
- [ ] **4.2** Create `permute-utils.js` - extract utilities (depends on constants)
- [ ] **4.3** Create `permute-sequencer.js` - extract Sequencer class (depends on constants)
- [ ] **4.4** Create `permute-observer-registry.js` - extract ObserverRegistry (no dependencies)
- [ ] **4.5** Create `permute-state.js` - extract TrackState, ClipState, TransportState (no dependencies)
- [ ] **4.6** Create `permute-instruments.js` - extract InstrumentDetector and strategies (depends on constants, utils)
- [ ] **4.7** Create `permute-commands.js` - extract CommandRegistry (depends on utils)
- [ ] **4.8** Create `permute-temperature.js` - extract temperature helpers and mixin (depends on constants, utils)
- [ ] **4.9** Update `permute-device.js` - add requires, remove extracted code, apply temperature mixin
- [ ] **4.10** Verify device loads and all functionality works

#### Exit Criteria
- `permute-device.js` reduced from ~3000 to ~1200 lines
- All modules load via `require()` without errors
- Full verification suite passes (same as Phase 1 criteria)
- No behavioral changes - pure structural refactor

---

### Phase 5: Documentation
**Risk: None**

- [ ] **5.1** Create `docs/adr/003-robust-state-restoration.md` documenting Phases 1-3
- [ ] **5.2** Create `docs/adr/004-modularization.md` documenting Phase 4
- [ ] **5.3** Update `CLAUDE.md` key files table with new module files
- [ ] **5.4** Update `docs/api.md` if any broadcast behavior changes

---

## Implementation Order & Commits

| Commit | Phases | Risk | Description |
|--------|--------|------|-------------|
| 1 | 1 + 2 + 3 | Low | Fix state persistence bug + consolidate + lifecycle guard |
| 2 | 4 | Medium | Modularize into focused files |
| 3 | 5 | None | Documentation |

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
    |       +-- permute-temperature.js  (depends on constants, utils)
    |
    +-- permute-sequencer.js  (depends on constants)

permute-observer-registry.js  (no deps)
permute-state.js              (no deps)
```

## Related

- ADR-002: Restore State Format Fix (previous partial fix for this issue)
- `docs/current-plan/io-pathway-refactor-plan.md` (blocked by this fix)
- Issue #3: Separate input/output pathways
- Issue #4: State not restoring properly
