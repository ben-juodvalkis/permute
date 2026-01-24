# Permute Extraction Plan

**Date:** 2026-01-24
**Status:** Planning
**Goal:** Extract the sequencer Max4Live device into a standalone repository called `permute`

## Summary

Extract `sequencer-device.js` and associated Max4Live files from the Looping repository into a new standalone repository. Minimal changes during extraction - refactoring (OSC namespace, configuration flexibility) happens post-extraction.

## Decisions Made

| Question | Decision |
|----------|----------|
| Repository name | `permute` |
| Hosting | GitHub (public) |
| License | MIT |
| Initial version | 1.0.0 |
| Installation | User clones/installs anywhere, updates hardcoded path in Looping |
| Documentation | Fresh docs in permute; ADRs stay in Looping as archive |
| Repo structure | Flattened (files at root or simple `src/` structure) |

---

## Phase 1: Create Permute Repository

### 1.1 Initialize Repository

- [ ] Create new GitHub repository `permute` (public)
- [ ] Initialize with MIT license
- [ ] Create initial README.md with project description
- [ ] Enable GitHub Issues for bug reports
- [ ] Create `CHANGELOG.md` starting with v1.0.0
- [ ] Tag initial release as `v1.0.0` after all files are in place

### 1.2 Copy Core Files

| Source (Looping) | Destination (Permute) |
|------------------|----------------------|
| `ableton/M4L devices/sequencer-device.js` | `sequencer-device.js` |
| `ableton/M4L devices/Sequencer.amxd` | `Sequencer.amxd` |
| `ableton/M4L devices/Sequencer.maxpat` | `Sequencer.maxpat` |

### 1.3 Write Fresh Documentation

Create new documentation based on existing knowledge (not copying ADRs):

- [ ] `README.md` - Project overview, features, installation, basic usage
- [ ] `docs/COMMANDS.md` - Complete OSC command reference
- [ ] `docs/ARCHITECTURE.md` - Delta-based state tracking, instrument strategies
- [ ] `docs/TROUBLESHOOTING.md` - Common issues and solutions

**Content sources** (for reference, not copying):
- `ableton/M4L devices/sequencer-device-README.md` - Most comprehensive
- `documentation/adr/110-sequencer-device-v3-refactor.md` - Architecture details
- `documentation/adr/163-sequencer-origin-tagged-broadcasts.md` - OSC broadcast format

### 1.4 Repository Structure

```
permute/
├── README.md                 # Overview, installation, quick start
├── LICENSE                   # MIT
├── CHANGELOG.md             # Version history (start with v1.0.0)
├── Sequencer.amxd           # Max4Live device (user installs this)
├── Sequencer.maxpat         # Max patch
├── sequencer-device.js      # Core JavaScript
└── docs/
    ├── COMMANDS.md          # OSC command reference
    ├── ARCHITECTURE.md      # Technical architecture
    └── TROUBLESHOOTING.md   # Common issues
```

---

## Phase 2: Update Looping Repository

### 2.1 Update Hardcoded Path

**Background:** Max/MSP JavaScript cannot import JSON files, so the sequencer device path must remain hardcoded in `liveAPI-v6.js`. This is documented in ADR-137.

**Current state** (`ableton/scripts/liveAPI-v6.js:63`):
```javascript
var SEQUENCER_DEVICE_PATH = "/Users/Shared/DevWork/GitHub/Looping/ableton/M4L devices/Sequencer.amxd";
```

**Actions:**
- [ ] Update `SEQUENCER_DEVICE_PATH` comment to reference permute repo
- [ ] Change path to a placeholder that clearly indicates user must configure:
  ```javascript
  // IMPORTANT: Update this path to your permute installation
  // Clone from: https://github.com/[org]/permute
  // See: https://github.com/[org]/permute#installation
  var SEQUENCER_DEVICE_PATH = "/path/to/your/permute/Sequencer.amxd";
  ```
- [ ] Update `CLAUDE.md` section about sequencer auto-load path to reference permute

### 2.2 Remove Extracted Files

- [ ] Delete `ableton/M4L devices/sequencer-device.js`
- [ ] Delete `ableton/M4L devices/Sequencer.amxd`
- [ ] Delete `ableton/M4L devices/Sequencer.maxpat`
- [ ] Delete `ableton/M4L devices/sequencer-device-README.md`

### 2.3 Update Documentation

- [ ] Update `CLAUDE.md` to reference permute as external dependency
- [ ] Update `documentation/v6-api.md` sequencer section to point to permute docs
- [ ] Add note to relevant ADRs that implementation now lives in permute repo

### 2.4 Keep in Looping (No Changes Needed)

These files stay as-is - they're the frontend integration layer:

- `interface/src/lib/stores/v6/sequencerStore.svelte.ts`
- `interface/src/lib/components/v6/clips/*Sequencer*.svelte` (7 components)
- `interface/src/lib/components/v6/tracks/TrackStrip/components/MiniSequencer.svelte`
- `interface/src/__tests__/unit/stores/sequencerStore.test.ts`
- `interface/bridge/` OSC routing code
- All ADRs in `documentation/adr/` (historical record)
- All files in `docs-archive/sequencer-*` (historical record)

---

## Phase 3: Validation

### 3.1 Test Permute Standalone

- [ ] Clone permute repo to test location
- [ ] Load `Sequencer.amxd` in Ableton Live
- [ ] Verify device initializes without errors
- [ ] Test OSC communication with a simple OSC client

### 3.2 Test Looping Integration

- [ ] Update Looping config to point to permute location
- [ ] Run `npm run dev`
- [ ] Verify sequencer auto-loads on new tracks
- [ ] Test mute/pitch/temperature controls from UI
- [ ] Verify state broadcasts and UI sync

### 3.3 Documentation Check

- [ ] Verify permute README has complete installation instructions
- [ ] Verify Looping setup docs mention permute as dependency
- [ ] Test fresh setup following only documented steps

---

## Phase 4: Migration Path

### 4.1 Existing User Communication

Existing Looping users will pull changes and find missing sequencer files. Address this proactively:

- [ ] Add `MIGRATION.md` to Looping explaining the extraction:
  ```markdown
  # Migration: Sequencer Extracted to Permute

  As of [date], the sequencer Max4Live device has been extracted to its own repository.

  ## What Changed
  - `ableton/M4L devices/Sequencer.amxd` removed from Looping
  - Sequencer now lives at: https://github.com/[org]/permute

  ## Migration Steps
  1. Clone permute: `git clone https://github.com/[org]/permute.git`
  2. Update path in `ableton/scripts/liveAPI-v6.js` (line ~63)
  3. Restart Ableton Live

  ## Why?
  The sequencer is now a standalone, reusable Max4Live device.
  ```

- [ ] Add breaking change notice to Looping CHANGELOG

### 4.2 Runtime Detection (Optional)

Consider adding a helpful error when sequencer is missing:

- [ ] In `liveAPI-v6.js`, check if `SEQUENCER_DEVICE_PATH` exists before auto-loading
- [ ] If missing, post clear error message to Max console with setup instructions
- [ ] Or: Add check to `npm run validate` that warns if path doesn't exist

---

## Versioning Strategy

- Permute uses semantic versioning (SemVer)
- Breaking OSC protocol changes = major version bump
- Looping README documents compatible permute versions
- For now, Looping just references "latest" since both repos are actively developed together

---

## Post-Extraction Improvements (Future)

These are explicitly out of scope for initial extraction:

1. **OSC namespace** - Make `/looping/` prefix configurable
2. **Configuration** - Externalize `TRANSPOSE_CONFIG`
3. **Port configuration** - Make OSC ports configurable
4. **Multi-instance support** - Better device identification
5. **Standalone testing** - Test harness without Looping frontend

---

## Files Reference

### Files Moving to Permute

| File | Lines | Description |
|------|-------|-------------|
| `sequencer-device.js` | ~2000 | Core sequencer logic |
| `Sequencer.amxd` | binary | Max4Live device |
| `Sequencer.maxpat` | JSON | Max patch |

### Files Staying in Looping (Frontend Integration)

| File | Description |
|------|-------------|
| `sequencerStore.svelte.ts` | Svelte 5 runes store, OSC send/receive |
| `MuteSequencerControl.svelte` | Mute sequencer UI |
| `PitchSequencerControl.svelte` | Pitch sequencer UI |
| `SequencerPatternGrid.svelte` | Shared grid component |
| `VerticalMuteSequencer.svelte` | Vertical mute UI variant |
| `VerticalPitchSequencer.svelte` | Vertical pitch UI variant |
| `VerticalSequencerGrid.svelte` | Vertical grid component |
| `MiniSequencer.svelte` | Track strip mini display |
| `sequencerStore.test.ts` | Store unit tests |

### ADRs (Staying in Looping as Archive)

| ADR | Title |
|-----|-------|
| 062 | Sequencer Position OSC Messages |
| 096 | Sequencer Device v2.0 Architecture |
| 106 | Temperature Transformation Architecture |
| 108 | Deferred Transformation Batching |
| 110 | Sequencer Device v3.0 Refactor |
| 111 | Name-Based Transpose Detection |
| 125 | Reversible Temperature Transformation |
| 150 | Sequencer Pending Param Race Condition |
| 155 | Multi-Track Sequencer Display |
| 157 | Sequencer State Persistence |
| 160 | Sequencer Loading Race Condition Fix |
| 163 | Sequencer Origin-Tagged Broadcasts |
| 166 | Sequencer Auto-Load Simplification |

---

## Estimated Effort

| Phase | Tasks | Complexity |
|-------|-------|------------|
| Phase 1: Create Permute | 4 sections | Medium (repo setup + writing fresh docs) |
| Phase 2: Update Looping | 3 sections | Low (delete files, update refs) |
| Phase 3: Validation | 3 sections | Medium (testing both repos) |
| Phase 4: Migration | 2 sections | Low (communication + optional detection) |

**Total:** 2-3 focused sessions. Documentation (Phase 1.3) is the most time-consuming part.
