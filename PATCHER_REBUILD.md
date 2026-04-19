# Permute — Patcher Rebuild Instructions

The JS side has been rewritten for the UI-native revamp (see [ADR-010](docs/adr/010-ui-native-revamp.md)). You need to rebuild `Permute.amxd` to match the new, much simpler message contract. Treat the `.amxd` as the working copy; [Permute.maxpat](Permute.maxpat) is a partial export.

The new `v8 permute-device.js` object is **2 inlets, 1 outlet**:

| Port | Role | Messages |
|------|------|----------|
| Inlet 0 | Transport | `song_time <ticks>` |
| Inlet 1 | Max UI | `mute_step N v`, `mute_length v`, `mute_rate i`, `pitch_step N v`, `pitch_length v`, `pitch_rate i`, `temperature v`, `chance v` |
| Outlet 0 | Position display | `mute_current <step>`, `pitch_current <step>` |

All OSC and `state_broadcast` infrastructure is gone. `request_ui_values` is gone. No more UI feedback on outlet 0 beyond the two `*_current` messages.

---

## Step 1 — Delete from the current patcher

- **OSC I/O:** `udpsend`, `udpreceive`, any `o.route` / `OSC-route` objects, any `prepend /looping/...` boxes, the outlet-1 OSC broadcast destination.
- **OSC command fanout:** every `prepend seq_*` chain and the dispatch that fed inlet 1.
- **Outlet-0 feedback fanout (except `*_current`):** anything routed from `mute_step_0..7`, `mute_length`, `mute_division`, `mute_active`, `pitch_step_0..7`, `pitch_length`, `pitch_division`, `pitch_active`, `temperature` *echo*, `chance` *echo*, `request_ui_values`.
- **Old step grid:** the 8× `live.text` buttons per sequencer and the `join 8` + `prepend mute pattern` / `prepend pitch pattern` chain.
- **Rate lookup:** `coll rate` and the `live.dial` that fed it — both sequencers.
- **Test boxes:** `mute pattern 1 1 1 1 0 0 1 1` and similar message boxes.
- **Request handshake:** the `request_ui_values` receive and its fanout into the UI objects.
- Any reset/shuffle buttons if they exist (they shouldn't — those message handlers never existed in JS either).

## Step 2 — Set the v8 object

- Change the v8 object text to: `v8 permute-device.js`
- **Inlets: 2**, **Outlets: 1**
- `autowatch 1` is already set inside the JS; no patcher change needed.

## Step 3 — Build the mute sequencer row

Per sequencer (you'll do this twice — once for mute, once for pitch):

### Step toggles

- 8× `live.toggle`
- Inspector on each:
  - **Parameter Visibility:** Automated and Stored
  - **Long Name:** `Mute Step 1` .. `Mute Step 8` (and `Pitch Step 1..8` for the pitch row)
  - **Short Name:** `mStep1` .. `mStep8` (similar for pitch)
  - **Initial Value:** `1` for mute (unmuted), `0` for pitch
- Wire the right outlet of each toggle into `[prepend mute_step 0]` .. `[prepend mute_step 7]`
  (For pitch: `[prepend pitch_step 0]` .. `[prepend pitch_step 7]`)
- Merge all 8 outputs into inlet 1 of the v8.

### Length menu

- 1× `live.menu`
- Inspector:
  - Parameter Visibility: Automated and Stored
  - Long Name: `Mute Length` / `Pitch Length`
  - Range: enum items `1`, `2`, `3`, `4`, `5`, `6`, `7`, `8`
  - Initial Value: index `7` (which displays `8`)
- Wire to `[prepend mute_length]` / `[prepend pitch_length]` → merge into inlet 1.

### Rate menu

- 1× `live.menu`
- Inspector:
  - Parameter Visibility: Automated and Stored
  - Long Name: `Mute Rate` / `Pitch Rate`
  - Range: enum items in this exact order (longest first, matching the old `coll rate`):
    ```
    8 bar
    4 bar
    2 bar
    1 bar
    1/2
    1/4
    1/8
    1/16
    ```
  - Initial Value: index `5` (`1/4`)
- Wire to `[prepend mute_rate]` / `[prepend pitch_rate]` → merge into inlet 1.

### Current-step display

- 1× `live.numbox`
- Inspector:
  - **Parameter Visibility: Visible (Not Stored)** — Live 12.3 beta feature. On stable Live, set to `Hidden` instead.
  - **Parameter Enable: on** (needed for the visibility setting)
  - Long Name: `Mute Current` / `Pitch Current`
  - Type: int, Range: `-1` to `7`
- This numbox is **driven by outlet 0** of v8 — it has no connection into inlet 1.
- From v8 outlet 0, add `[route mute_current pitch_current]`. Wire the `mute_current` output to the mute numbox, `pitch_current` to the pitch numbox.

## Step 4 — Build the global controls

### Temperature dial

- 1× `live.dial`
- Inspector:
  - Parameter Visibility: Automated and Stored
  - Long Name: `Temperature`
  - Type: Float, Range: `0.0` to `1.0`
  - Initial Value: `0.0`
- Wire to `[prepend temperature]` → merge into inlet 1.

### Chance dial

- 1× `live.dial`
- Inspector:
  - Parameter Visibility: Automated and Stored
  - Long Name: `Chance`
  - Type: Float, Range: `0.0` to `1.0`
  - Initial Value: `1.0`
- Wire to `[prepend chance]` → merge into inlet 1.

## Step 5 — Transport wiring (unchanged topology)

Keep whatever you had before for driving the sequencer:

```
live.thisdevice ──┐
                  ├── anything else that triggers init (or nothing)
                  ↓
                [init] → v8 (init() is still a global function)

live.transport ── (playing?) ── metro 1n → transport → prepend song_time → inlet 0
```

## Step 6 — Save and test

1. Save `Permute.amxd`.
2. Drop it onto a MIDI track in Ableton.
3. **Fresh load check:** device loads, no Max console errors. Step toggles, menus, and dials show defaults (mute toggles all on, pitch toggles all off, both rate menus at `1/4`, temperature `0`, chance `1`).
4. **Persistence check:** set some non-default pattern + rate, save the Live set, close, reopen. All values restored. You did nothing in JS to make this happen — `parameter_enable:1` did it.
5. **Automation check:** automate `Mute Step 3` in a MIDI clip. Play it back and watch the toggle follow. Automation passes through inlet 1 the same way a user click would.
6. **Step display check:** start transport with a pattern active. The two `*_current` numboxes should cycle 0..length-1. Stop transport — they should show `-1`.
7. **Undo check:** play 10+ seconds, then Cmd-Z repeatedly. Undo should jump straight to your last real edit, not through thousands of tick writes.
8. **Rate change mid-playback:** change a rate menu while playing — step timing should change immediately.

## Step 7 — Sanity grep

From the repo root:

```
grep -l 'udpsend\|udpreceive\|osc-route\|/looping/sequencer' Permute.amxd Permute.maxpat
```

Should return nothing.

```
grep -l 'request_ui_values\|state_broadcast\|seq_mute_\|seq_pitch_\|temperature_reset\|temperature_shuffle\|mute pattern\|pitch pattern\|mute_division\|pitch_division' Permute.amxd Permute.maxpat
```

Should also return nothing.

---

## What the JS file expects, verbatim

Inlet 1 accepts exactly these messages. Anything else gets a `Unknown UI message` debug line and is ignored:

```
mute_step  <i:0..7> <v:0|1>
mute_length <v:1..8>
mute_rate  <i:0..7>
pitch_step <i:0..7> <v:0|1>
pitch_length <v:1..8>
pitch_rate  <i:0..7>
temperature <v:0.0..1.0>
chance      <v:0.0..1.0>
```

Outlet 0 emits exactly these during playback:

```
mute_current  <step:-1..7>
pitch_current <step:-1..7>
```

That's the whole contract.
