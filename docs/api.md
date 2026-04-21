# Permute — Communication Reference

This file documents the messaging surface between the Max patcher and the v8 JS engine. See [ADR-010](adr/010-ui-native-revamp.md) for the design rationale (no OSC, no `request_ui_values`, live.* UI objects as the source of truth).

## Inlets and outlets

The `v8 permute-device.js` object has:

| Port | Direction | Purpose |
|------|-----------|---------|
| Inlet 0 | UI → v8 | Transport (`song_time <ticks>`) |
| Inlet 1 | UI → v8 | Max UI messages (step, length, rate, temperature, chance) |
| Outlet 0 | v8 → UI | Current step position (`mute_current`, `pitch_current`) |

There is no OSC I/O and no state broadcast. Persistence, automation, undo, and Push mapping are handled by Live directly on the `live.*` UI objects (`parameter_enable: 1`).

## Inlet 1 — Max UI messages

Each message is emitted by one `live.*` object in the patcher, prepended with the message name before hitting inlet 1.

| Message | Args | Source object | Notes |
|---------|------|---------------|-------|
| `mute_step <i> <v>` | i=0..7, v=0/1 | 8× `live.toggle` | 0=mute, 1=play |
| `mute_length <v>` | 1..8 | `live.menu` | Limits how many steps the sequencer reads |
| `mute_rate <i>` | 0..7 | `live.menu` | Index into `ENUM_RATES` |
| `pitch_step <i> <v>` | i=0..7, v=0/1 | 8× `live.toggle` | 1=shift up an octave |
| `pitch_length <v>` | 1..8 | `live.menu` | |
| `pitch_rate <i>` | 0..7 | `live.menu` | |
| `temperature <v>` | 0.0..1.0 | `live.dial` | 0=off, 1=max organic variation |
| `chance <v>` | 0.0..1.0 | `live.dial` | Note probability, 1=always play. Persists across transport start/stop (not reset like mute/pitch). |

JS never echoes these values back. The `live.*` object already holds the value.

## Outlet 0 — step position

| Message | Args | Consumer | When emitted |
|---------|------|----------|--------------|
| `mute_current <step>` | int -1..7 | `live.numbox` (display) | On mute sequencer step change and on transport stop (-1) |
| `pitch_current <step>` | int -1..7 | `live.numbox` (display) | On pitch sequencer step change and on transport stop (-1) |

The display numboxes use Visibility "Visible (Not Stored)" on Live 12.3 beta (externally readable via Push/LiveAPI, excluded from automation and undo). On stable Live they fall back to "Hidden".

## Rate enum

From [permute-constants.js](../permute-constants.js):

| Index | Label | Ticks per step |
|-------|-------|----------------|
| 0 | 8 bar | `8 * numer * 480` |
| 1 | 4 bar | `4 * numer * 480` |
| 2 | 2 bar | `2 * numer * 480` |
| 3 | 1 bar | `numer * 480` |
| 4 | 1/2 | 960 |
| 5 | 1/4 | 480 *(default)* |
| 6 | 1/8 | 240 |
| 7 | 1/16 | 120 |

`numer` is the current time-signature numerator. Bar-length entries recompute when the numerator changes (via `seq.refreshTicksPerStep(numer)`).

## Live parameter indices

The `live.*` UI objects are discovered by Live as ordered parameters. This is the mapping as of the current patcher — useful for Push/LiveAPI access (`live_set tracks N devices M parameters P`) or for automation lane references.

| # | Long name | Type | Visibility |
|---|-----------|------|------------|
| 1 | Mute 1 | `live.toggle` | Automated and Stored |
| 2 | Mute 2 | `live.toggle` | Automated and Stored |
| 3 | Mute 3 | `live.toggle` | Automated and Stored |
| 4 | Mute 4 | `live.toggle` | Automated and Stored |
| 5 | Mute 5 | `live.toggle` | Automated and Stored |
| 6 | Mute 6 | `live.toggle` | Automated and Stored |
| 7 | Mute 7 | `live.toggle` | Automated and Stored |
| 8 | Mute 8 | `live.toggle` | Automated and Stored |
| 9 | Mute Length | `live.menu` | Automated and Stored |
| 10 | Mute Rate | `live.menu` | Automated and Stored |
| 11 | Pitch 1 | `live.toggle` | Automated and Stored |
| 12 | Pitch 2 | `live.toggle` | Automated and Stored |
| 13 | Pitch 3 | `live.toggle` | Automated and Stored |
| 14 | Pitch 4 | `live.toggle` | Automated and Stored |
| 15 | Pitch 5 | `live.toggle` | Automated and Stored |
| 16 | Pitch 6 | `live.toggle` | Automated and Stored |
| 17 | Pitch 7 | `live.toggle` | Automated and Stored |
| 18 | Pitch 8 | `live.toggle` | Automated and Stored |
| 19 | Pitch Length | `live.menu` | Automated and Stored |
| 20 | Pitch Rate | `live.menu` | Automated and Stored |
| 21 | Chance | `live.dial` | Automated and Stored |
| 22 | Temperature | `live.dial` | Automated and Stored |
| 23 | Mute Current | `live.numbox` | Visible (Not Stored) |
| 24 | Pitch Current | `live.numbox` | Visible (Not Stored) |
| 25 | Reset | `live.button` | Automated and Stored |

Parameters 23 and 24 are display-only (driven from v8 outlet 0). On stable Live without the 12.3 "Visible (Not Stored)" feature they're set to `Hidden` and lose external readability.

## Transport flow

```
live.transport
   → metro 1n (or equivalent)
   → transport
   → prepend song_time
   → inlet 0
     → v8 handleTransport('song_time', [ticks])
       → processWithSongTime(ticks)
         → processSequencerTick('mute',  muteSeq,  ticks+120)
         → processSequencerTick('pitch', pitchSeq, ticks+120)
```

Each sequencer tick:

1. `seq.calculateStep(ticks)` → new step index
2. If step changed, update `currentStep`, emit `outlet(0, seqName + "_current", newStep)`
3. Schedule a 1 ms batch apply to the current clip (see `scheduleBatchApply` in [permute-device.js](../permute-device.js))

On transport stop, positions reset to `-1` and are emitted to outlet 0.

## Init flow

```
1. Max instantiates v8; live.* UI objects instantiate alongside
2. UI objects with parameter_enable:1 restore stored values from the Live Set
   and emit them downstream. These messages queue at inlet 1.
3. live.thisdevice → init()
     → track reference, instrument detection, device observer
     → transport + time-signature observers created unconditionally
4. Queued inlet-1 messages flush, populating state via handleMaxUICommand
```

No handshake, no `request_ui_values`. If a UI object emits a stored value before `init()`, JS stores it immediately; transport and time-sig observers are always active once `init()` completes.
