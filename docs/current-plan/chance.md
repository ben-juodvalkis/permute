# Note Chance: Implementation Status & Migration Guide

## Part 1: Permute Side — DONE

See `docs/adr/009-note-chance-probability.md` for the full architecture decision record.

### What was added

| File | Change |
|------|--------|
| `permute-chance.js` | New mixin: `setChanceValue()`, `applyChanceToClip()`, `sendChanceState()` |
| `permute-device.js` | 15 integration points: import, constructor, buffers, command handlers, transport hooks, broadcast, UI routing, state persistence |
| `docs/api.md` | New OSC command, broadcast format (30 args), origin values, Max UI messages, data flow examples |
| `docs/adr/009-note-chance-probability.md` | Architecture decision record |
| `CLAUDE.md` | Updated key files, broadcast arg count, architecture sections |

### Permute API summary

| Direction | Address | Args |
|-----------|---------|------|
| OSC in | `/looping/sequencer/chance` | `[deviceId, value]` (0.0–1.0) |
| Max UI in | `chance` (inlet 2) | `<value>` (0.0–1.0) |
| Max UI out | `chance` (outlet 0) | `<value>` (0.0–1.0) |
| Broadcast | `state_broadcast` index 29 | Float 0.0–1.0 |
| set/state | arg index 26 (optional) | Float 0.0–1.0 |

### Still needed in Permute

The Max patch (`Permute.maxpat`) needs a `live.dial` for the chance control:
- Wired to inlet 2 with `[prepend chance]`
- Receives outlet 0 `chance` messages for OSC-driven updates
- Needs `parameter_enable: 1` for persistence (ADR-006 source of truth)
- Best edited in Max's visual editor, not by hand

---

## Part 2: Looping Side — Migration Guide

### The old path (what exists now)

```
ClipCentralView.svelte
  noteChance (local $state(100), resets on mount)
  handleNoteChanceChange(value)
    → send('/cmd/set_clip_note_chance', [track, scene, percentage])
      → bridge messageRouter.js routes to 'maxObserver'
        → liveAPI-v6.js handleSetClipNoteChance()
          → get_all_notes_extended → set probability → apply_note_modifications
```

**Problems:**
- `noteChance` is component-local — resets to 100 on every mount
- No persistence across track switches
- No incoming broadcast handling (fire-and-forget)
- Not in sequencerStore — no ghost editing, no cache, no echo filtering
- Uses percentage (0–100) while everything else uses 0.0–1.0

### Files touching the old path

| File | What | Lines |
|------|------|-------|
| `interface/src/lib/components/v6/central/views/ClipCentralView.svelte` | `noteChance` state, `handleNoteChanceChange()`, CHANCE slider | 81, 181–199, 614–620 |
| `interface/src/lib/services/clipOperations.ts` | Comment noting removal | 507 |
| `interface/bridge/routing/messageRouter.js` | Route `/cmd/set_clip_note_chance` → maxObserver | 114 |
| `ableton/scripts/liveAPI-v6.js` | `handleSetClipNoteChance()`, routing in `anything()` and `list()` | 3370–3376, 3554–3560, 4935–5029 |

---

### File 1: `maxObserverHandler.ts` — Parse chance from broadcast

**File:** `interface/src/lib/api/handlers/maxObserverHandler.ts`

The broadcast parser at line 323 reads args 0–28. Add chance at index 29.

**Line 326** — update log message:
```typescript
logger.debug('Sequencer state broadcast (30-arg)', { trackIndex, origin });
```

**After line 359** (after `const temperature = toNumber(args[28]);`):
```typescript
// Chance (arg 29) — backward compatible, defaults to 1.0 if absent
const chance = args.length >= 30 ? toNumber(args[29]) : 1.0;
```

**Line 385** — add to event detail state object:
```typescript
                temperature,
                chance
```

---

### File 2: `sequencerStore.svelte.ts` — Add chance state and handlers

**File:** `interface/src/lib/stores/v6/sequencerStore.svelte.ts`

Follow the temperature pattern exactly. Every touchpoint:

#### a. State variable (after line 98)
```typescript
let temperature = $state(0.0);
let chance = $state(1.0);
```

#### b. Sender function (after `sendTemperature` at line 182)
```typescript
function sendChance(value: number) {
  if (!device) return;
  const args = [device.id, value];
  logger.info('SEQ TX: chance', { args });
  markSent('chance');
  send('/looping/sequencer/chance', args);
}
```

#### c. `sendCompleteState()` — add chance to payload (line 199)
```typescript
    temperature,
    chance
  ]);
```

#### d. `SequencerBroadcastState` interface (after line 220)
```typescript
  temperature: number;
  chance: number;
}
```

#### e. `applyFullState()` (after line 247)
```typescript
  temperature = state.temperature;
  chance = state.chance ?? 1.0;
```

#### f. `resetToDefaults()` (after line 266)
```typescript
  temperature = 0.0;
  chance = 1.0;
```

#### g. Active handler (after `handleTemperatureChange` at line 478)
```typescript
function handleChanceChange(value: number) {
  if (!device) return;
  chance = value;
  sendChance(value);
}
```

#### h. Ghost handler (after `handleTemperatureChangeGhost` at line 527)
```typescript
function handleChanceChangeGhost(value: number) {
  chance = value;
  triggerLoad();
}
```

#### i. Store export — getter (after line 609)
```typescript
  get temperature() { return temperature; },
  get chance() { return chance; },
```

#### j. Store export — methods (after line 630 and 639)
```typescript
  handleTemperatureChange,
  handleChanceChange,
  // ...
  handleTemperatureChangeGhost,
  handleChanceChangeGhost,
```

---

### File 3: `ClipCentralView.svelte` — Route through store

**File:** `interface/src/lib/components/v6/central/views/ClipCentralView.svelte`

#### a. Add derived chance from store
After `let temperature = $derived(sequencerStore.temperature);` (~line 91):
```typescript
let chance = $derived(sequencerStore.chance);
```

#### b. Delete old local state and handler
**Delete line 81:**
```typescript
let noteChance = $state(100);
```

**Delete lines 181–199:**
```typescript
function handleNoteChanceChange(value: number) { ... }
```

#### c. Update the CHANCE slider template (lines 614–620)

**Before:**
```svelte
<DeviceSlider
    value={noteChance / 100}
    title="CHANCE"
    color={{ primary: 'rgb(59, 130, 246)', secondary: 'rgba(59, 130, 246, 0.1)', accent: 'rgb(96, 165, 250)' }}
    orientation="horizontal"
    onInteraction={(val) => handleNoteChanceChange(val * 100)}
/>
```

**After:**
```svelte
<DeviceSlider
    value={chance}
    title="CHANCE"
    color={{ primary: 'rgb(59, 130, 246)', secondary: 'rgba(59, 130, 246, 0.1)', accent: 'rgb(96, 165, 250)' }}
    orientation="horizontal"
    onInteraction={(val) => device
        ? sequencerStore.handleChanceChange(val)
        : sequencerStore.handleChanceChangeGhost(val)
    }
/>
```

Value is now 0.0–1.0 directly — no more `/ 100` or `* 100` conversion.

---

### File 4: `messageRouter.js` — Keep old route as fallback

**File:** `interface/bridge/routing/messageRouter.js`, line 114

Keep the old route. It remains a fallback for edge cases:
```javascript
// Legacy: direct clip note chance (for tracks without Permute)
if (address === '/cmd/set_clip_note_chance') return 'maxObserver';
```

The new `/looping/sequencer/chance` address is already handled by the existing `/looping/sequencer/` routing — no new route needed.

---

### File 5: `liveAPI-v6.js` — Keep as fallback, add deprecation note

**File:** `ableton/scripts/liveAPI-v6.js`, line 4935

Keep `handleSetClipNoteChance()` intact. Add a deprecation comment:
```javascript
// DEPRECATED: Prefer /looping/sequencer/chance via Permute device.
// Kept as fallback for tracks without Permute loaded.
function handleSetClipNoteChance(trackIndex, sceneIndex, chancePercentage) {
```

---

### What NOT to change

`VariationControl.svelte` has a "chance" parameter at device index 1 — this is an **unrelated feature** (audio effect variation control). Do not touch it.

---

## Value Range Reference

| Context | Range | Conversion? |
|---------|-------|-------------|
| Permute JS (`chanceValue`) | 0.0–1.0 | None |
| Permute OSC | 0.0–1.0 | None |
| Permute broadcast (index 29) | 0.0–1.0 | None |
| Live API (`note.probability`) | 0.0–1.0 | None |
| sequencerStore (`chance`) | 0.0–1.0 | None |
| DeviceSlider | 0.0–1.0 | None |
| **Old path** (`/cmd/set_clip_note_chance`) | **0–100 (%)** | **Converted in liveAPI-v6.js** |

The migration eliminates the percentage conversion — everything is 0.0–1.0 end-to-end.

---

## Testing Checklist

### New path (through Permute)
- [ ] Adjust CHANCE slider on track WITH Permute → notes play probabilistically
- [ ] Switch tracks → chance value persists (sequencerStore cache)
- [ ] Switch back → cached value restored from broadcast
- [ ] Ghost edit: adjust CHANCE on track WITHOUT Permute → device loads → chance applied
- [ ] Stop transport → probability stays at slider value
- [ ] Echo filtering → dragging slider doesn't cause jitter

### Backward compatibility
- [ ] Old `/cmd/set_clip_note_chance` route still works in liveAPI-v6.js

### Edge cases
- [ ] Chance = 0.0 → no notes play
- [ ] Chance = 1.0 → all notes play (default)
- [ ] Save/reload Live Set → chance persists via Permute UI element
