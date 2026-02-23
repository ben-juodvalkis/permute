Plan: Add Note Chance (Probability) to Permute
Issue: #8 — Migrate note chance/probability from Looping to Permute

Context
Permute has mute sequencing, pitch sequencing, and temperature-based note shuffling. We need to add a "chance" parameter that sets note.probability (0.0–1.0) on all notes in the current clip. This is a simple value like temperature, not a step-sequenced pattern. Default is 1.0 (always play).

Key architectural rules from ADRs:

ADR-006: UI elements with parameter_enable: 1 are the sole persistence/source of truth. JS has no defaults — it receives initial state from UI on load via request_ui_values.
ADR-008: Pre-allocated broadcast buffers filled in-place.
ADR-004: Mixin pattern for coupled features; flat CommonJS modules.
Files to Create/Modify
1. NEW: permute-chance.js — Chance mixin
Follow the permute-temperature.js mixin pattern. Export applyChanceMethods(proto) with:

setChanceValue(value) — Clamp 0.0–1.0, skip if unchanged, apply to clip, activate playback observers if < 1.0
applyChanceToClip() — Guard on trackState.type === 'midi', get clip, read notes via get_all_notes_extended, set note.probability on all notes, call apply_note_modifications
restoreChance() — If chanceValue < 1.0, set all notes' probability back to 1.0 (called on transport stop)
sendChanceState() — outlet(0, "chance", this.chanceValue)
Dependencies: permute-utils only.

2. MODIFY: permute-device.js — 15 change points
a. Import (after line 22): var chance = require('permute-chance');

b. Constructor (after line 80): Add this.chanceValue = 1.0;

c. Constructor buffers (lines 101–107): Grow _stateBuffer from 28→29, _outletBuffer from 31→32

d. setupCommandHandlers() (after line 200): Register seq_chance command handler — parse float, call setChanceValue, sendChanceState, broadcastState('chance')

e. set_state handler (lines 203–259): Add optional chance arg at end (backward compatible — only parse if idx < args.length)

f. checkAndActivateObservers() (line 434): Add this.chanceValue < 1.0 to the activation condition

g. onTransportStart() (after line 461): Call applyChanceToClip() if chanceValue < 1.0

h. onTransportStop() (after line 584): Call this.restoreChance()

i. Apply mixin (after line 794): chance.applyChanceMethods(SequencerDevice.prototype);

j. buildStateData() (after line 1103): Add buf[28] = this.chanceValue;

k. broadcastToOSC() (line 1140): Change loop bound from 28 to 29

l. handleOSCCommand() (after line 1196): Add else if (parts[0] === 'chance') { command = 'seq_chance'; }

m. handleMaxUICommand() (after line 1274): Add chance message handler — parse float, call setChanceValue, broadcastToOSC('chance')

n. onClipChanged() (after line 1328): Re-apply chance if chanceValue < 1.0

o. getState()/setState(): Include chance in state object, restore on setState; bump version to '3.2'

3. MODIFY: docs/api.md
Add /looping/sequencer/chance [deviceId, value] under OSC Input Commands
Update state broadcast format: 29→30 args, add index 29 = chance
Update set/state: 26→27 args, add index 26 = chance
Add chance to Max UI inlet 2 and outlet 0 message tables
Add chance to origin values table
Add data flow examples for OSC/Max UI chance changes
4. NEW: docs/adr/009-note-chance-probability.md
Document the feature addition, key design decisions (mixin pattern, no capture/restore needed, observer activation for chance, MIDI-only), and how it follows ADR-006 (UI source of truth).

5. MODIFY: CLAUDE.md
Add permute-chance.js to Key Files table
Update state broadcast arg count reference (29→30)
Key Design Decisions
UI source of truth (ADR-006): The chance dial in the Max patch needs parameter_enable: 1. JS constructor sets 1.0 as a safe placeholder, but the real initial value comes from the UI re-emitting on request_ui_values.

Observer activation: Unlike temperature (which relies on sequencers being active), chance < 1.0 activates playback observers directly. This ensures onTransportStop fires to restore probability to 1.0 even when no sequencer pattern is active.

No capture/restore complexity: Temperature needs note ID tracking for reversible pitch shuffling. Chance just sets a single probability value — restoring means setting back to 1.0. No note ID maps needed.

MIDI-only: Audio clips have no notes. applyChanceToClip() guards with trackState.type === 'midi'.

Backward compatible: set_state parses chance only if extra arg exists. Older clients sending 26 args still work. State broadcast adds arg 29 — older listeners ignore it.

Verification
Since this is a Max4Live device with no automated tests:

Save all changed files
Delete and re-add Permute.amxd to reload (module files changed)
Check Max console for errors/debug output
Test matrix:
Set chance to 0.5 → play clip → notes play ~50% of time
Set chance to 0.0 → no notes play
Set chance to 1.0 → all notes play
Stop transport → verify probability restored to 1.0 (check with MIDI note inspector)
Change clips while chance < 1.0 → new clip gets chance applied
Save and reload Live Set → chance value persists via UI element
OSC: send /looping/sequencer/chance [deviceId, 0.5] → verify Max UI updates
State broadcast → verify chance appears at index 29
Note: Max Patch Changes
The Max patch (Permute.maxpat) will need a live.dial (or similar) for the chance control, wired to inlet 2 with [prepend chance] and receiving outlet 0 chance messages for OSC-driven updates. The dial needs parameter_enable: 1 for persistence. This is a JSON file that's best edited in Max's visual editor, not by hand.