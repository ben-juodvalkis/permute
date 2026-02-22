# Permute Communication Reference

Permute is a Max4Live device with three communication interfaces:

1. **OSC** — bidirectional communication with external UIs (e.g., Svelte frontend)
2. **Max UI** — bidirectional communication between JS engine and Max patch UI elements
3. **Transport** — receives song position ticks from Ableton's transport

---

## Architecture Overview

```
                        ┌─────────────────────────┐
   Ableton Transport ──►│ Inlet 0: song_time       │
                        │                         │
   OSC Bridge ─────────►│ Inlet 1: OSC commands    │
                        │                         │
   Max UI elements ────►│ Inlet 2: UI values       │
                        │                         │
                        │         JS Engine        │
                        │                         │
   Max UI elements ◄────│ Outlet 0: UI feedback    │
                        │                         │
   OSC Bridge ◄─────────│ Outlet 1: state_broadcast│
                        └─────────────────────────┘
```

### Three Sources Can Change State

| Source | Inlet | What happens |
|--------|-------|-------------|
| Max UI (user clicks button/dial) | Inlet 2 | JS updates state → broadcasts to OSC (outlet 1) |
| OSC command (Svelte sends command) | Inlet 1 | JS updates state → sends to Max UI (outlet 0) → broadcasts to OSC (outlet 1) |
| Transport tick | Inlet 0 | JS advances position → sends position to Max UI (outlet 0) → broadcasts to OSC (outlet 1) |

**Key rule:** When the Max UI is the source, JS does NOT echo back to the UI (it already shows the correct value). When OSC is the source, JS DOES send to the UI (so the Max patch reflects the change).

---

## OSC Input Commands (Inlet 1)

Commands sent TO Permute from an external UI. All commands include `deviceId` as the first argument for multi-device filtering.

### Mute Sequencer

```
/looping/sequencer/mute/step [deviceId, stepIndex, value]
```
- `stepIndex`: Integer 0-7
- `value`: Integer 0 or 1 (0=muted, 1=unmuted)

```
/looping/sequencer/mute/length [deviceId, length]
```
- `length`: Integer 1-8

```
/looping/sequencer/mute/rate [deviceId, bars, beats, ticks]
```
- Division in bars.beats.ticks format (see Timing section)

### Pitch Sequencer

```
/looping/sequencer/pitch/step [deviceId, stepIndex, value]
/looping/sequencer/pitch/length [deviceId, length]
/looping/sequencer/pitch/rate [deviceId, bars, beats, ticks]
```
Same format as mute.

### Temperature

```
/looping/sequencer/temperature [deviceId, value]
```
- `value`: Float 0.0-1.0

### Complete State

```
/looping/sequencer/set/state [deviceId, ...26 args]
```
Sets everything at once. Used for ghost editing sync.

| Index | Field |
|-------|-------|
| 0 | deviceId |
| 1-8 | mutePattern[8] |
| 9 | muteLength |
| 10-12 | muteDivision [bars, beats, ticks] |
| 13-20 | pitchPattern[8] |
| 21 | pitchLength |
| 22-24 | pitchDivision [bars, beats, ticks] |
| 25 | temperature |

---

## OSC Output Broadcast (Outlet 1)

One message type, sent whenever state changes:

```
/looping/sequencer/state [trackIndex, origin, ...27 state values]
```

**Format (29 arguments total):**

| Index | Field | Type |
|-------|-------|------|
| 0 | trackIndex | Integer (0-based track index in Ableton) |
| 1 | origin | String (see Origin Values below) |
| 2-9 | mutePattern[8] | 8 integers (0=muted, 1=unmuted) |
| 10 | muteLength | Integer (1-8) |
| 11-13 | muteDivision | 3 integers [bars, beats, ticks] |
| 14 | mutePosition | Integer (-1=idle, 0-7=current step) |
| 15-22 | pitchPattern[8] | 8 integers (0=original, 1=octave up) |
| 23 | pitchLength | Integer (1-8) |
| 24-26 | pitchDivision | 3 integers [bars, beats, ticks] |
| 27 | pitchPosition | Integer (-1=idle, 0-7=current step) |
| 28 | temperature | Float (0.0-1.0) |

### Origin Values

The `origin` field tells the frontend WHY this broadcast occurred:

| Origin | Trigger | Description |
|--------|---------|-------------|
| `init` | Device initialized | First broadcast after load — not currently sent (see note) |
| `mute_step` | OSC mute/step command | A mute step was toggled via OSC |
| `mute_length` | OSC mute/length command | Mute length changed via OSC |
| `mute_rate` | OSC mute/rate OR Max UI | Mute division changed |
| `mute_pattern` | Max UI mute_steps | Mute pattern changed via Max UI |
| `pitch_step` | OSC pitch/step command | A pitch step was toggled via OSC |
| `pitch_length` | OSC pitch/length command | Pitch length changed via OSC |
| `pitch_rate` | OSC pitch/rate OR Max UI | Pitch division changed |
| `pitch_pattern` | Max UI pitch_steps | Pitch pattern changed via Max UI |
| `temperature` | OSC or Max UI temperature | Temperature changed |
| `position` | Transport tick | Playhead moved to a new step |
| `set_state_ack` | OSC set/state command | Acknowledgment of full state set |
| `unknown` | Fallback | Should not normally occur |

### Echo Filtering — IMPORTANT

**The current origin-based echo filtering is broken.** Here's why:

State can change from TWO sources: the Svelte UI (via OSC) or the Max UI (physical dials/buttons). Both produce the same origin tags. For example:

- User clicks a mute step in **Svelte** → OSC command → JS broadcasts with origin `mute_step`
- User clicks a mute step in **Max** → inlet 2 → JS broadcasts with origin `mute_pattern`

The Svelte frontend currently skips ALL broadcasts that aren't `init`, `position`, or `unknown`. This means **changes made from the Max UI are never reflected in Svelte**.

**Correct approach:** The frontend should only skip a broadcast if IT was the source. Options:

1. **Timestamp-based:** Track when Svelte last sent each command type. Only skip broadcasts that arrive within ~100ms of a sent command with matching origin.
2. **Sequence number:** Add a sequence number to commands and broadcasts. Frontend includes seq# in its command; broadcast echoes it back. Frontend skips only broadcasts matching its own seq#.
3. **Always apply:** Accept all broadcasts and use them as the source of truth. This is simplest but may cause UI flicker during rapid edits.

Option 1 (timestamp-based) is recommended — it's simple and handles the common case well.

---

## Max UI Messages (Inlet 2 / Outlet 0)

These messages flow between the JS engine and Max patch UI elements.

### Inlet 2: Max UI → JS

Sent when user interacts with Max UI elements, or when UI elements re-emit persisted values on load.

| Message | Format | Example |
|---------|--------|---------|
| `mute_steps` | `mute_steps <v0> <v1> ... <v7>` | `mute_steps 1 0 1 0 1 1 0 0` |
| `mute_length` | `mute_length <length>` | `mute_length 4` |
| `mute_division` | `mute_division <bars> <beats> <ticks>` | `mute_division 0 0 120` |
| `pitch_steps` | `pitch_steps <v0> <v1> ... <v7>` | `pitch_steps 0 0 1 0 0 1 0 0` |
| `pitch_length` | `pitch_length <length>` | `pitch_length 8` |
| `pitch_division` | `pitch_division <bars> <beats> <ticks>` | `pitch_division 0 1 0` |
| `temperature` | `temperature <value>` | `temperature 0.5` |
| `temperature_reset` | `temperature_reset` | `temperature_reset` |
| `temperature_shuffle` | `temperature_shuffle` | `temperature_shuffle` |

### Outlet 0: JS → Max UI

Sent when state changes from OSC or during playback. NOT sent when the change came from Max UI (no echo).

| Message | Format | When sent |
|---------|--------|-----------|
| `mute_step_0` ... `mute_step_7` | `mute_step_<n> <value:int>` | OSC changes a step |
| `mute_length` | `mute_length <length:int>` | OSC changes length |
| `mute_division` | `mute_division <bars> <beats> <ticks>` | OSC changes rate |
| `mute_current` | `mute_current <step:int>` | Every tick during playback (-1=idle) |
| `mute_active` | `mute_active <0\|1>` | When pattern becomes active/inactive |
| `pitch_step_0` ... `pitch_step_7` | `pitch_step_<n> <value:int>` | OSC changes a step |
| `pitch_length` | `pitch_length <length:int>` | OSC changes length |
| `pitch_division` | `pitch_division <bars> <beats> <ticks>` | OSC changes rate |
| `pitch_current` | `pitch_current <step:int>` | Every tick during playback (-1=idle) |
| `pitch_active` | `pitch_active <0\|1>` | When pattern becomes active/inactive |
| `temperature` | `temperature <value:float>` | OSC changes temperature |
| `request_ui_values` | `request_ui_values 1` | After init() — triggers UI re-emission |

**Note:** `mute_length`, `mute_division`, `pitch_length`, `pitch_division`, and `temperature` use the same message name in both directions. The JS knows direction by inlet vs outlet.

---

## Initialization

Initialization is triggered explicitly by `live.thisdevice` sending an `init` message (NOT by loadbang or bang).

### Startup Sequence

```
1. live.thisdevice fires → sends "init" to JS
2. init() establishes track reference via Live API
3. init() detects instrument type (for pitch transformation)
4. init() sets up device observer
5. init() sends "request_ui_values 1" on outlet 0
6. Max patch routes request_ui_values → [defer] → bangs all UI elements
7. UI elements re-emit persisted values → flow into inlet 2
8. handleMaxUICommand() processes each value → JS state matches UI
9. setPattern() triggers checkAndActivateObservers() → transport observers created if needed
10. broadcastToOSC() for each value → Svelte gets initial state
```

**UI elements are the source of truth for persistence.** They auto-persist via `parameter_enable: 1`. The JS has no defaults — it receives all initial state from the UI.

### State Persistence

Max UI elements with `parameter_enable: 1` automatically save/restore with the Ableton Live Set. On device load:

1. Ableton restores UI element values from the saved Live Set
2. `live.thisdevice` triggers `init`
3. JS requests UI values via `request_ui_values`
4. UI elements emit their restored values
5. JS state is populated from these values

No pattr. No JSON serialization. No race conditions.

---

## Transport (Inlet 0)

```
song_time <ticks:float>
```

Sent every 16th note (120 ticks) by `[metro] → [transport] → [prepend song_time]`. The JS applies a 120-tick lookahead internally.

During playback, position updates are efficient:
- JS sends only `mute_current <step>` and `pitch_current <step>` to outlet 0
- JS sends full `state_broadcast` to outlet 1 (OSC) with origin `position`
- No pattern/length/division data is resent on each tick

---

## Timing Reference

Ableton uses 480 ticks per quarter note.

| Musical Value | bars | beats | ticks | Total ticks |
|--------------|------|-------|-------|-------------|
| 2 bars | 2 | 0 | 0 | 3840 |
| 1 bar | 1 | 0 | 0 | 1920 |
| 1/2 note | 0 | 2 | 0 | 960 |
| 1 beat | 0 | 1 | 0 | 480 |
| 1/8 note | 0 | 0 | 240 | 240 |
| 1/16 note | 0 | 0 | 120 | 120 |
| 1/32 note | 0 | 0 | 60 | 60 |

(Total ticks assumes 4/4 time signature)

---

## Data Flow Diagrams

### User changes mute step in Svelte UI

```
Svelte → /looping/sequencer/mute/step [deviceId, 3, 0]
  → Inlet 1 → handleOSCCommand()
    → sequencer.setStep(3, 0)
    → sendSequencerState('mute')     → Outlet 0 → Max UI updates
    → broadcastState('mute_step')    → Outlet 1 → /looping/sequencer/state
                                                    (Svelte should SKIP — it was the source)
```

### User changes mute step in Max UI

```
Max live.text button → [i] → [join 8] → [prepend mute_steps] → Inlet 2
  → handleMaxUICommand('mute_steps', [1,0,1,0,1,1,0,0])
    → sequencer.setPattern([1,0,1,0,1,1,0,0])
    → broadcastToOSC('mute_pattern')  → Outlet 1 → /looping/sequencer/state
                                                     (Svelte should APPLY — Max was the source)
    → (NO outlet 0 — Max UI already shows correct value)
```

### OSC changes temperature

```
Svelte → /looping/sequencer/temperature [deviceId, 0.5]
  → Inlet 1 → handleOSCCommand()
    → setTemperatureValue(0.5)
    → sendTemperatureState()          → Outlet 0 → Max UI dial updates
    → broadcastState('temperature')   → Outlet 1 → /looping/sequencer/state
                                                     (Svelte should SKIP — it was the source)
```

### Max UI changes temperature

```
Max live.dial → [prepend temperature] → Inlet 2
  → handleMaxUICommand('temperature', [0.5])
    → setTemperatureValue(0.5)
    → broadcastToOSC('temperature')   → Outlet 1 → /looping/sequencer/state
                                                     (Svelte should APPLY — Max was the source)
    → (NO outlet 0 — Max UI already shows correct value)
```

### Transport tick (playback)

```
[metro] → [transport] → [prepend song_time] → Inlet 0
  → handleTransport('song_time', [1920.0])
    → processSequencerTick('mute', 2040)  (with 120-tick lookahead)
      → seq.currentStep = 1
      → apply mute transformation to clip
      → sendSequencerPosition('mute')
        → outlet 0: mute_current 1     → Max UI step indicator
        → outlet 1: state_broadcast     → Svelte position update
    → processSequencerTick('pitch', 2040)
      → (same pattern)
```
