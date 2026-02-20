# Implementation Plan: Separate Input/Output Pathways

**Issue:** #3 - Refactor: Separate input/output pathways for UI and OSC
**Status:** Ready
**Created:** 2026-01-26
**Updated:** 2026-02-20

> **Previously blocked by Issue #4** (state persistence bug). Issue #4 was fully resolved on 2026-02-19 via the robustness refactor (see `robustness-refactor-plan.md`). The codebase was also modularized into 10 CommonJS modules as part of that work — all `outlet()` calls are now isolated in `permute-device.js`, making this refactor cleaner.

---

## Executive Summary

This plan implements separate input/output pathways for UI and OSC communication to eliminate circular feedback issues. Based on analysis, we recommend a **phased approach** that starts with outlet separation (lower risk) before tackling inlet separation (higher risk).

The current architecture uses origin-based filtering (ADR-163) to prevent feedback loops. While effective, it adds complexity. Structural separation through multiple inlets/outlets provides cleaner routing without conditional logic.

---

## Current Architecture

```
                    ┌─────────────────────────────────────┐
                    │         permute-device.js           │
                    │                                     │
All messages ──────►│ Inlet 0                   Outlet 0 │──────► All outputs
  - song_time       │   │                           ▲    │         - UI feedback
  - OSC commands    │   ▼                           │    │         - state_broadcast
  - Max UI          │ anything() ─► handlers ─► output() │         - pattr_state
  - pattr restore   │                                    │
                    └─────────────────────────────────────┘
```

**Pain Points:**
1. Single outlet requires message-tag demuxing via `[route]` in Max patch
2. Origin tags required to filter echo messages (complex, error-prone)
3. High-frequency position updates compete with state changes
4. pattr feedback loop requires special handling (skip position updates)

---

## Target Architecture

```
                    ┌─────────────────────────────────────┐
                    │         permute-device.js           │
                    │                                     │
song_time ─────────►│ Inlet 0                   Outlet 0 │──────► UI feedback
                    │                                     │         (step values, positions)
OSC commands ──────►│ Inlet 1                   Outlet 1 │──────► OSC broadcasts
                    │                                     │         (state_broadcast)
Max UI commands ───►│ Inlet 2                   Outlet 2 │──────► pattr state
                    │                                     │         (persistence)
                    └─────────────────────────────────────┘
```

**Benefits:**
1. No demuxing required - outputs already separated by type
2. Routing rules eliminate most origin-tag filtering
3. Clear mental model for debugging
4. Scales well for new features (MIDI input = Inlet 3)

---

## Pre-Existing Issues to Fix During Refactor

### Temperature Global Handlers Don't Broadcast

The `temperature()` global function (line 1508) calls `setTemperatureValue()` but **never calls `broadcastState()`**. By contrast, the `seq_temperature` OSC command handler (line 275) calls both `setTemperatureValue()` and `broadcastState('temperature')`.

This means when temperature is changed via the Max UI dial, the change takes effect locally but:
- No OSC broadcast is sent (external displays don't update)
- No pattr update is sent (change isn't persisted)

The same gap exists for `temperature_reset()` (line 1524) and `temperature_shuffle()` (line 1546) — neither broadcasts.

**Resolution:** Phase 3's `handleMaxUICommand()` must include broadcast calls for all temperature-related UI actions. During Phase 0.5, the temporary JS handlers for `temperature_ui` should also add the missing broadcast.

### `setState()` Triggers Multiple Broadcasts During Restore

When `restoreState()` calls `setState()`, the internal `sendSequencerFeedback()` calls trigger `broadcastState('position')` once per sequencer, then `restoreState()` itself calls `broadcastState('pattr_restore')`. This produces 3 broadcasts total (2x position + 1x pattr_restore).

In the new architecture with separate outlets, this is redundant but not harmful (position broadcasts skip pattr). **Optimization opportunity:** During Phase 1, `setState()` could be updated to use `sendSequencerFeedbackLocal()` instead of `sendSequencerFeedback()`, with a single explicit broadcast at the end. This would reduce restore from 3 broadcasts to 1.

---

## Phased Implementation

### Phase 0: Preparation & Testing
**Risk: Low | Effort: 1-2 hours**

Establish baseline measurements and validate assumptions before making changes.

#### Tasks

- [ ] **0.1** Add debug logging to measure message frequency
  - Count messages per second on inlet 0
  - Count outputs per second by type (UI feedback, state_broadcast, pattr_state)
  - Log to Max console with `DEBUG_MODE = true`

- [ ] **0.2** Document current Max patch routing
  - Screenshot current `[route]` structure in Permute.maxpat
  - Document which messages go where

- [ ] **0.3** Test pattr feedback loop hypothesis
  - In Max, manually send to a separate outlet
  - Verify whether pattr still triggers feedback
  - Document findings

- [ ] **0.4** Create test Live Set
  - Save a Live Set with Permute state
  - Document expected state values
  - This becomes the regression test

#### Exit Criteria
- Baseline metrics captured
- pattr behavior with multiple outlets understood
- Test Live Set created

---

### Phase 0.5: Max Patch UI Message Wiring
**Risk: Low | Effort: 1-2 hours**

Set up the Max patch to send properly formatted messages from UI objects to JS. This must be done before Phase 3 so the JS handlers have correctly formatted input.

#### Background

The Max UI objects (step toggles, number boxes, etc.) need to send messages in a consistent format that the JS can parse. Currently the mute/pitch step UI sends an "active steps list" format (e.g., `4 7` meaning steps 4 and 7 are on). We need to:
1. Prefix these with a message name so JS can route them
2. Ensure all UI controls send to a dedicated path (future Inlet 2)

#### Legacy Handler Retirement Strategy

The existing `mute()` and `pitch()` global functions (lines 1421-1433) route Max UI messages through `handleSequencerMessage()` → `CommandRegistry` using legacy command names (`step`, `pattern`, `length`, `division`, etc.). These are the **current** Max UI entry points.

**Phase 0.5:** Rewire Max patch UI objects to send new prefixed messages (`mute_ui_steps`, `temperature_ui`, etc.). Add temporary JS handlers in `anything()` that parse the new formats and delegate to existing setters. The old `mute()`/`pitch()` globals remain in the code but become **unused by the Max patch** — they are no longer wired to any UI object.

**Phase 3:** When inlet separation is implemented, the new `handleMaxUICommand()` replaces the temporary `anything()` handlers from Phase 0.5. At this point, remove the legacy `mute()` and `pitch()` global functions and `handleSequencerMessage()` entirely — they have no remaining callers. Also remove the legacy command registrations (`tick`, `pattern`, `step`, `division`, `length`, `reset`, `bypass`) from `setupCommandHandlers()` unless they are still needed for OSC backward compatibility.

**Verification:** After each phase, confirm no Max patch objects still route to the old `mute`/`pitch` message names. Search the `.maxpat` JSON for references.

#### Tasks

- [ ] **0.5.1** Audit current UI object outputs in Permute.maxpat
  - Document what each UI control currently outputs
  - Identify which controls send to v8 and in what format
  - Note any controls that bypass v8 entirely

- [ ] **0.5.2** Wire mute step UI to send `mute_ui_steps` messages
  - Add `[prepend mute_ui_steps]` after the mute step UI object
  - Route to v8 inlet (currently inlet 0, will become inlet 2 in Phase 3)
  - Test: Toggling steps should send `mute_ui_steps 0 2 4` etc.

- [ ] **0.5.3** Wire pitch step UI to send `pitch_ui_steps` messages
  - Add `[prepend pitch_ui_steps]` after the pitch step UI object
  - Route to v8 inlet
  - Test: Toggling steps should send `pitch_ui_steps 1 3 5` etc.

- [ ] **0.5.4** Wire other UI controls with appropriate prefixes
  - Length controls: `mute_ui_length`, `pitch_ui_length`
  - Division controls: `mute_ui_division`, `pitch_ui_division`
  - Temperature: `temperature_ui`
  - Use `[prepend]` objects to add message names

- [ ] **0.5.5** Add temporary JS handlers for new message formats
  - In `anything()`, add routing for `mute_ui_steps`, `pitch_ui_steps`, etc.
  - For now, these can call existing handlers (e.g., convert active steps list to pattern array and call existing pattern setter)
  - This validates the wiring before Phase 3's full refactor

- [ ] **0.5.6** Test round-trip behavior
  - Toggle UI → JS receives correct message → state updates → OSC broadcasts
  - Verify no regressions in current functionality

#### Exit Criteria
- All UI controls send named messages to v8
- JS can parse and handle the new message formats
- Existing functionality preserved
- Ready for Phase 3 inlet separation (just need to change which inlet UI messages arrive on)

---

### Phase 1: Outlet Separation (JS Only)
**Risk: Medium | Effort: 3-4 hours**

Add outlets 1 and 2, but keep inlet 0 unified. This gives routing benefits without multi-inlet complexity.

#### Architecture After Phase 1

```
                    ┌─────────────────────────────────────┐
                    │         permute-device.js           │
                    │                                     │
All messages ──────►│ Inlet 0                   Outlet 0 │──────► UI feedback
                    │   │                                 │
                    │   ▼                       Outlet 1 │──────► OSC broadcasts
                    │ anything() ─► handlers             │
                    │                           Outlet 2 │──────► pattr state
                    └─────────────────────────────────────┘
```

#### Tasks

- [ ] **1.1** Update inlet/outlet definitions
  ```javascript
  // permute-device.js lines 13-14
  inlets = 1;
  outlets = 3;  // 0: UI, 1: OSC, 2: pattr
  ```

- [ ] **1.2** Create separate broadcast functions
  ```javascript
  // Replace single broadcastState() with:
  function broadcastToUI(seqName, field, value) {
      outlet(0, seqName + "_" + field, value);
  }

  function broadcastToOSC(origin) {
      var args = buildStateArgs(origin);
      outlet(1, "state_broadcast", args);
  }

  function broadcastToPattr() {
      var args = buildPattrArgs();
      outlet(2, "pattr_state", args);
  }
  ```

- [ ] **1.3** Refactor `sendSequencerFeedbackLocal()`
  - Currently outputs to outlet 0 (will remain outlet 0)
  - No functional change, but extract to `broadcastToUI()`

- [ ] **1.4** Refactor `broadcastState()`
  - Split into `broadcastToOSC()` + `broadcastToPattr()`
  - Keep origin parameter for OSC broadcasts
  - Remove origin from pattr (not needed)

- [ ] **1.5** Update position-only handling
  ```javascript
  // Current: Skip pattr for position updates
  if (origin !== 'position') {
      outlet(0, "pattr_state", ...);
  }

  // New: Same logic, different outlet
  if (origin !== 'position') {
      outlet(2, "pattr_state", ...);
  }
  ```

- [ ] **1.6** Update `init()`, `restoreState()`, `clip_changed()`
  - These should broadcast to all outlets
  - UI needs full state, OSC needs full state, pattr needs confirmation

- [ ] **1.7** Optimize `setState()` restore broadcasts (optional)
  - Change `setState()` to call `sendSequencerFeedbackLocal()` instead of `sendSequencerFeedback()`
  - This avoids 2 redundant `broadcastState('position')` calls during restore
  - `restoreState()` and `setvalueof()` already call `broadcastState('pattr_restore')` explicitly after `setState()`
  - Net effect: restore goes from 3 broadcasts to 1

- [ ] **1.8** Test JS changes without Max patch updates
  - Load device in Ableton
  - Verify no errors in Max console
  - Outlets 1 and 2 will be unconnected (outputs dropped)
  - Outlet 0 (UI feedback) should still work

#### Exit Criteria
- JS file compiles without errors
- Device loads in Ableton
- UI feedback works (outlet 0)
- No regressions in current functionality

---

### Phase 2: Max Patch Updates (Outlet Routing)
**Risk: Medium | Effort: 2-3 hours**

Wire up the new outlets in Permute.maxpat.

#### Tasks

- [ ] **2.1** Update v8 object outlet connections
  - Outlet 0 → UI display objects (existing route, verify)
  - Outlet 1 → OSC output chain (udpsend or formatting)
  - Outlet 2 → pattr system

- [ ] **2.2** Simplify existing `[route]` chains
  - Remove `[route state_broadcast pattr_state ...]` after v8 outlet 0
  - Each outlet now has single purpose

- [ ] **2.3** Update pattr routing
  - Connect outlet 2 to `[pattr]` input
  - Verify feedback loop is broken (or still handled correctly)
  - Test: Change a step → should NOT trigger restoreState()

- [ ] **2.4** Regression test
  - Load test Live Set from Phase 0
  - Verify state restores correctly
  - Save Live Set, reload, verify persistence

- [ ] **2.5** Test OSC broadcasts
  - Connect OSC monitoring tool
  - Verify state_broadcast messages appear on outlet 1
  - Verify origin tags still present and correct

#### Exit Criteria
- All three outlets connected and functional
- pattr persistence works (save/load Live Set)
- OSC broadcasts received by external tools
- UI feedback still works

---

### Phase 3: Inlet Separation
**Risk: High | Effort: 4-6 hours**

This is the most complex phase. We add separate inlets for different message sources.

#### Architecture After Phase 3

```
song_time ─────────► Inlet 0 ─► processWithSongTime()
                                      │
OSC commands ──────► Inlet 1 ─► handleOSCCommand()  ──► Update state
                                      │                      │
Max UI commands ───► Inlet 2 ─► handleMaxCommand()          ▼
                                                    ┌───────────────┐
                                                    │ Outlet routing│
                                                    │ based on      │
                                                    │ inlet source  │
                                                    └───────────────┘
```

#### Routing Rules

| Input Source | Update State | Output to UI (0) | Output to OSC (1) | Output to pattr (2) |
|--------------|--------------|------------------|-------------------|---------------------|
| Inlet 0 (song_time) | Position only | Yes (position) | Yes (origin='position') | No |
| Inlet 1 (OSC) | Yes | Yes | Yes (echo for other listeners) | Yes |
| Inlet 2 (Max UI) | Yes | No (UI already knows) | Yes | Yes |
| restoreState (pattr) | Yes | Yes | Yes (origin='pattr_restore') | No (avoid loop) |
| init | N/A | Yes | Yes (origin='init') | Yes |

#### Tasks

- [ ] **3.1** Update inlet definition
  ```javascript
  inlets = 3;
  // Inlet 0: Transport (song_time)
  // Inlet 1: OSC commands
  // Inlet 2: Max UI commands
  ```

- [ ] **3.2** Implement inlet-aware message handling
  ```javascript
  function anything() {
      var args = arrayfromargs(arguments);
      var inletNum = inlet;  // Max provides this global

      switch (inletNum) {
          case 0:
              handleTransport(messagename, args);
              break;
          case 1:
              handleOSCCommand(messagename, args);
              break;
          case 2:
              handleMaxUICommand(messagename, args);
              break;
      }
  }
  ```

- [ ] **3.3** Create `handleTransport()`
  - Process `song_time` messages
  - Update sequencer positions
  - Broadcast position to UI (outlet 0) and OSC (outlet 1)
  - Skip pattr (outlet 2)

- [ ] **3.4** Create `handleOSCCommand()`
  - Parse OSC address and route to command handlers
  - Update state
  - Broadcast to UI (outlet 0) - external change, UI needs update
  - Broadcast to OSC (outlet 1) - echo for other listeners
  - Broadcast to pattr (outlet 2) - persistence

- [ ] **3.5** Create `handleMaxUICommand()`
  - Process direct Max commands (mute step, pitch length, etc.)
  - **Handle "active steps list" format** - Max UI sends `mute_ui_steps 4 7` meaning only steps 4 and 7 are on (see Appendix D)
  - Parse active indices and convert to full pattern array
  - **Handle temperature UI messages** - `temperature_ui`, `temperature_reset_ui`, `temperature_shuffle_ui`
    - These must call `setTemperatureValue()` AND broadcast (fixing the pre-existing gap where the old `temperature()` global never broadcast)
  - Update state
  - Skip UI output (outlet 0) - UI already reflects the change
  - Broadcast to OSC (outlet 1) - external world needs to know
  - Broadcast to pattr (outlet 2) - persistence

- [ ] **3.6** Simplify origin handling
  - With inlet-based routing, many origin tags become unnecessary
  - Keep origin for OSC broadcasts (still useful for frontend caching)
  - Remove origin-based conditional routing within JS

- [ ] **3.7** Update Max patch inlet connections
  - Inlet 0 ← Transport messages (song_time from metro)
  - Inlet 1 ← OSC input (via udpreceive → route)
  - Inlet 2 ← Max UI controls (toggles, number boxes, etc.)

- [ ] **3.8** Handle initialization edge cases
  ```javascript
  function init() {
      // Called via loadbang, not through any inlet
      // Broadcast to all outlets
      broadcastToUI(...);
      broadcastToOSC('init');
      broadcastToPattr();
  }
  ```

- [ ] **3.9** Handle restoreState edge cases
  ```javascript
  function restoreState() {
      // Called via pattr restore, comes through inlet 0 currently
      // After refactor: Could come through dedicated inlet or direct call
      // Broadcast to UI and OSC, skip pattr (avoid loop)
      broadcastToUI(...);
      broadcastToOSC('pattr_restore');
      // Do NOT broadcastToPattr() - would cause loop
  }
  ```

- [ ] **3.10** Remove legacy handlers
  - Remove `mute()` and `pitch()` global functions (lines 1421-1433) — no longer wired from Max patch after Phase 0.5
  - Remove `handleSequencerMessage()` (line 1024) — no remaining callers
  - Remove legacy command registrations from `setupCommandHandlers()`: `tick`, `pattern`, `step`, `division`, `length`, `reset`, `bypass` (lines 152-207) — unless still needed for OSC backward compat
  - Remove `temperature()`, `temperature_reset()`, `temperature_shuffle()` globals (lines 1508-1554) — replaced by `handleMaxUICommand()` routing
  - Verify `.maxpat` has no remaining references to removed message names

#### Exit Criteria
- All three inlets functional
- Routing rules correctly implemented
- No feedback loops
- UI responsive to OSC changes
- OSC responsive to UI changes
- pattr persistence works

---

### Phase 4: Documentation & Cleanup
**Risk: Low | Effort: 2-3 hours**

Update all documentation to reflect new architecture.

#### Tasks

- [ ] **4.1** Create ADR for this change
  - `docs/adr/005-separate-io-pathways.md`
  - Document decision, alternatives considered, consequences
  - Note: ADRs 001-004 already exist

- [ ] **4.2** Update `docs/api.md`
  - Document new inlet/outlet structure
  - Update message format tables
  - Add routing rules section

- [ ] **4.3** Update `CLAUDE.md`
  - Update architecture section
  - Update "Key Files" if needed

- [ ] **4.4** Update `README.md`
  - If any user-facing changes

- [ ] **4.5** Remove obsolete code
  - Remove unused origin-based routing logic (most should already be gone after Phase 3)
  - Clean up any dead code paths
  - Verify all legacy handler removal from Phase 3.10 is complete

- [ ] **4.6** Close Issue #3

---

## Risk Mitigation

### pattr Feedback Loop
**Risk:** Separating pattr to outlet 2 might break feedback loop prevention.

**Mitigation:**
- Test in Phase 0.3 before committing
- Keep position-skip logic regardless of outlet
- Monitor for infinite loops during testing

### Multi-Inlet Race Conditions
**Risk:** Simultaneous messages on different inlets could cause state corruption.

**Mitigation:**
- Max/JS processes messages sequentially (single-threaded)
- Document expected behavior
- Test with rapid simultaneous inputs

### Backward Compatibility
**Risk:** Existing Live Sets might break.

**Mitigation:**
- Phase 1 (JS only) is backward compatible
- Phase 2 (Max patch) is a breaking change
- Document migration path
- Version the Max patch

### Performance Regression
**Risk:** Additional outlets might increase overhead.

**Mitigation:**
- Measure baseline in Phase 0
- Compare after each phase
- Position updates are highest frequency; ensure no regression

---

## Rollback Plan

Each phase can be rolled back independently:

1. **Phase 1 rollback:** Revert JS changes, outlets 1-2 become unused
2. **Phase 2 rollback:** Rewire Max patch to use only outlet 0
3. **Phase 3 rollback:** Rewire Max patch to use only inlet 0, revert JS inlet handling

Git tags will be created after each phase for easy rollback.

---

## Success Metrics

1. **No origin-based routing in JS** - routing determined by inlet/outlet topology
2. **Simplified Max patch** - fewer `[route]` objects
3. **Same or better performance** - position updates ≤ current latency
4. **pattr persistence works** - save/load Live Set with no data loss
5. **OSC echo filtering still works** - frontend can use origin tags (preserved for caching)

---

## Timeline

This plan does not include time estimates. Each phase should be completed and validated before proceeding to the next. The phases are ordered by risk (lowest first) to allow early identification of issues.

---

## Appendix A: Current Code Locations

> **Updated 2026-02-20** — line numbers reflect post-modularization codebase (~1720 lines in `permute-device.js`).

| Area | File | Lines | Notes |
|------|------|-------|-------|
| Inlet/outlet definition | `permute-device.js` | 13-14 | `inlets = 1; outlets = 1;` |
| Message routing (anything) | `permute-device.js` | 1645-1677 | Filters for `/looping/sequencer/` prefix, delegates to CommandRegistry |
| Command handlers (setup) | `permute-device.js` | 139-337 | `setupCommandHandlers()` — legacy + OSC handlers |
| State broadcast | `permute-device.js` | 1220-1300 | `broadcastState()` — sends `state_broadcast` + conditional `pattr_state` |
| UI feedback (local) | `permute-device.js` | 1155-1170 | `sendSequencerFeedbackLocal()` — step values, position, active flag |
| UI feedback (+ broadcast) | `permute-device.js` | 1179-1186 | `sendSequencerFeedback()` — calls local + `broadcastState('position')` |
| pattr restore (flat format) | `permute-device.js` | 1596-1635 | `restoreState()` — 28-arg flat format, delegates to `setState()` |
| pattr restore (JSON format) | `permute-device.js` | 1701-1713 | `setvalueof()` — JSON from pattrstorage, delegates to `setState()` |
| Initialization | `permute-device.js` | 345-409 | `SequencerDevice.prototype.init()` |
| Global Max handlers | `permute-device.js` | 1414-1720 | All `function name()` globals exposed to Max |
| Legacy mute/pitch handlers | `permute-device.js` | 1421-1433 | `mute()`, `pitch()` → `handleSequencerMessage()` |
| Temperature globals | `permute-device.js` | 1508-1554 | `temperature()`, `temperature_reset()`, `temperature_shuffle()` |
| Global instance | `permute-device.js` | 1412 | `var sequencer = new SequencerDevice()` |
| All `outlet()` calls | `permute-device.js` | 1162, 1166, 1169, 1285, 1298, 1570 | No outlet calls in any module file |

## Appendix B: Message Formats

### State Broadcast (Outlet 1)
29 arguments (unchanged):
```
[trackIndex, origin, mutePattern[8], muteLength, muteBars, muteBeats, muteTicks,
 mutePosition, pitchPattern[8], pitchLength, pitchBars, pitchBeats, pitchTicks,
 pitchPosition, temperature]
```

### pattr State (Outlet 2)
28 arguments (no origin field):
```
[trackIndex, mutePattern[8], muteLength, muteBars, muteBeats, muteTicks,
 mutePosition, pitchPattern[8], pitchLength, pitchBars, pitchBeats, pitchTicks,
 pitchPosition, temperature]
```

### UI Feedback (Outlet 0)
Individual messages:
```
mute_step_0 [value]
mute_step_1 [value]
...
mute_current [position]
mute_active [0/1]
pitch_step_0 [value]
...
temperature [value]
```

## Appendix C: Origin Tags (Retained for OSC)

Even with inlet-based routing, origin tags remain useful for frontend state caching:

| Origin | When Sent | Frontend Action |
|--------|-----------|-----------------|
| `init` | Device initialized | Apply full state |
| `pattr_restore` | Restored from Live Set | Apply full state |
| `position` | Playhead moved | Update positions only |
| `mute_step`, etc. | Echo of command | Skip (already have state) |

## Appendix D: Max UI Message Formats

### Active Steps List Format

The Max UI objects for mute/pitch steps use a compact "active steps list" format rather than sending individual step values. This format sends only the indices of steps that are ON.

**Format:**
```
mute_ui_steps [index1] [index2] ...
pitch_ui_steps [index1] [index2] ...
```

**Examples:**
| UI State (steps 0-7) | Message Sent |
|---------------------|--------------|
| Steps 4 and 7 on | `mute_ui_steps 4 7` |
| Steps 0, 2, 4, 6 on | `mute_ui_steps 0 2 4 6` |
| All steps off | `mute_ui_steps` (no args) |
| All steps on | `mute_ui_steps 0 1 2 3 4 5 6 7` |

**Parsing Logic for `handleMaxUICommand()`:**
```javascript
function parseActiveStepsList(args, patternLength) {
    // Initialize all steps to 0 (off)
    var pattern = [];
    for (var i = 0; i < patternLength; i++) {
        pattern[i] = 0;
    }

    // Set specified indices to 1 (on)
    for (var j = 0; j < args.length; j++) {
        var stepIndex = parseInt(args[j]);
        if (stepIndex >= 0 && stepIndex < patternLength) {
            pattern[stepIndex] = 1;
        }
    }

    return pattern;
}

// In handleMaxUICommand():
function handleMaxUICommand(messagename, args) {
    if (messagename === 'mute_ui_steps') {
        var pattern = parseActiveStepsList(args, sequencers.muteSequencer.length);
        sequencers.muteSequencer.setPattern(pattern);
        broadcastToOSC('mute_pattern');
        broadcastToPattr();
        // Note: Skip broadcastToUI() - UI already reflects the change
    }
    else if (messagename === 'pitch_ui_steps') {
        var pattern = parseActiveStepsList(args, sequencers.pitchSequencer.length);
        sequencers.pitchSequencer.setPattern(pattern);
        broadcastToOSC('pitch_pattern');
        broadcastToPattr();
    }
    // ... other UI commands
}
```

**Why This Format?**
- Max UI objects (like `[matrixctrl]` or step sequencer UIs) often output selected indices
- More efficient for sparse patterns (few steps on)
- Requires conversion to full pattern array in JS

**Phase 3 Task Addition:**
This format handling should be implemented in task 3.5 (`handleMaxUICommand()`). The function must:
1. Recognize `mute_ui_steps` and `pitch_ui_steps` messages
2. Parse the active indices list
3. Convert to full 8-element pattern array
4. Update sequencer state
5. Broadcast to OSC and pattr (but NOT to UI)
