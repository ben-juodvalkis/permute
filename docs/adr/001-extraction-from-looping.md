# ADR-001: Extraction from Looping Repository

**Date:** 2026-01-24
**Status:** In Progress

## Context

The sequencer Max4Live device was originally developed as part of the Looping repository. As the device matured into a fully-featured standalone tool, we decided to extract it into its own repository called "Permute" to:

1. Enable independent versioning and releases
2. Allow use in projects beyond Looping
3. Simplify the Looping codebase
4. Provide a cleaner installation experience

## Decision

Extract the sequencer device into a new public GitHub repository named `permute`.

### Naming Changes

During extraction, files were renamed to reflect the new project identity:

| Original (Looping) | New (Permute) |
|-------------------|---------------|
| `sequencer-device.js` | `permute-device.js` |
| `Sequencer.amxd` | `Permute.amxd` |
| `Sequencer.maxpat` | `Permute.maxpat` |

### What Was Extracted

- Core JavaScript device (~3000 lines)
- Max4Live device file (.amxd)
- Max patch file (.maxpat)
- Reference documentation (ADRs from Looping, preserved for context)

### What Stays in Looping

- Frontend Svelte components (sequencerStore, UI components)
- OSC bridge routing code
- Integration tests
- Original ADRs (as historical archive)

## Current State

### Completed
- [x] Created permute repository
- [x] Copied and renamed core files
- [x] Copied reference documentation to `docs/reference/`
- [x] Created extraction plan document
- [x] Updated file names (sequencer → permute)

### Remaining
- [ ] Create README.md with installation instructions
- [ ] Add MIT LICENSE file
- [ ] Create CHANGELOG.md starting at v1.0.0
- [ ] Write fresh documentation (COMMANDS.md, ARCHITECTURE.md)
- [ ] Update Looping to reference permute as external dependency
- [ ] Remove extracted files from Looping
- [ ] Tag v1.0.0 release

## Technical Notes

### OSC Namespace

The device currently uses `/looping/sequencer/` as its OSC namespace. This will remain unchanged for initial extraction to maintain compatibility with existing Looping installations. Post-extraction, we may make this configurable.

### Hardcoded Path

Looping's `liveAPI-v6.js` contains a hardcoded path to the sequencer device. After extraction, users must update this path to point to their permute installation. This limitation exists because Max/MSP JavaScript cannot import JSON configuration files.

## Consequences

### Positive
- Clean separation of concerns
- Independent versioning
- Easier to share and install
- Reduced complexity in Looping repo

### Negative
- Users must configure path manually
- Two repos to maintain (temporarily, during transition)
- OSC namespace still references "looping" (to be addressed post-extraction)

## References

- [extraction-plan.md](../extraction-plan.md) - Detailed extraction plan
- [docs/reference/](../reference/) - Original ADRs from Looping
