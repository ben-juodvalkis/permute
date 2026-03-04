# ACE Studio MCP Server — Investigation Plan

## Status: PENDING — Requires running ACE Studio instance

The specific MCP tool names are **not publicly documented**. They can only be discovered
by connecting to a running ACE Studio 2.0 instance via the MCP protocol.

## Why This Changes Everything

ACE Studio 2.0 ships with a built-in MCP (Model Context Protocol) server. If it exposes
the right tools, it replaces both the `.acep` file manipulation layer and the GUI automation
layer from our original plan.

```
BEFORE (original plan):
  Web Server → Python (.acep decompress → swap lyrics → recompress)
             → AppleScript (open file → trigger render → export WAV)

AFTER (MCP approach):
  Web Server → HTTP POST to ACE Studio MCP Server
             → (create project / set notes / set lyrics / render / export)
```

No zstd. No file manipulation. No GUI automation. Just API calls.

## MCP Server Details

| Item | Value |
|---|---|
| MCP endpoint | `http://localhost:21572/mcp` |
| Transport | Streamable HTTP (NOT legacy HTTP+SSE) |
| Enable in | ACE Studio 2.0 → Preferences → General → MCP Server |
| Requires | ACE Studio 2.0 running on the machine |
| Status | Experimental |
| Feedback | support@acestudio.ai |

## What We Know From Docs

The ACE Studio MCP server offers a "rich toolkit enabling AI agents to autonomously
navigate and execute creative edits." Based on the example prompts in the docs, the
server likely supports:

- **Project creation** — "create a new pop-style project with BPM 120, in C major"
- **Track management** — "add a lead vocal track and a violin accompaniment track"
- **Melody/note composition** — "write an 8-bar chorus section"
- **Lyrics** — implied by the vocal synthesis workflow
- **MIDI editing** — "add a piano chord progression in bars 9-16: C - Am - F - G"

But the actual tool names and schemas are **only discoverable at runtime**.

## Step 1: Enable & Verify (on Mac Mini)

```bash
# Verify MCP server is alive
curl -s http://localhost:21572/mcp \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "initialize", "params": {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {"name": "test", "version": "1.0"}}, "id": 1}'
```

## Step 2: Discover Tools (CRITICAL)

Run `scripts/ace-mcp-discover.js` on the Mac Mini (see script in this repo):

```bash
node scripts/ace-mcp-discover.js
```

Or use curl:

```bash
curl -s http://localhost:21572/mcp \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "tools/list", "id": 2}' | python3 -m json.tool
```

Save the output — it's the single most important piece of information for the project.

## Step 3: Connect via Claude Code (Fastest Interactive Discovery)

Already configured in this repo:

```bash
claude mcp add acestudio --transport http http://localhost:21572/mcp
```

Then ask Claude Code:
- "What tools are available from ACE Studio?"
- "What tracks are in the current project?"
- "Change the lyric on the first note of the Lead track to 'Hey'"

## Capability Checklist

Fill in after running discovery:

- [ ] MCP server enables and responds
- [ ] Tool list retrieved and saved
- [ ] Can open/load `.acep` project files
- [ ] Can read track names and note data
- [ ] Can read lyrics from notes
- [ ] Can modify lyrics on existing notes
- [ ] Can assign/change voice on a track
- [ ] Can trigger vocal synthesis/render
- [ ] Can export audio to a file path
- [ ] Can create a new project from scratch
- [ ] Can add MIDI notes programmatically
- [ ] Can set tempo and time signature

## Decision Matrix

| Result | Action |
|---|---|
| All critical capabilities present | Full MCP pipeline — no file manipulation needed |
| Can read/write lyrics but can't export | Hybrid — MCP for editing, AppleScript for Cmd+Shift+R export |
| Can create/edit but can't open files | MCP-first — build projects from scratch via MCP |
| Very limited tools (read-only, etc.) | Fall back to `.acep` file manipulation + GUI automation |

## If MCP Works — Revised Pipeline

```
Browser → Web Server (Node.js)
  1. Claude API (vision): photo + name → personalized lyrics
  2. HTTP POST to Mac Mini render server
  3. Return audio to browser

Mac Mini Render Server → MCP calls to localhost:21572/mcp:
  1. Open template project (or create from scratch)
  2. Set lyrics on each note of each vocal track
  3. Assign singer voice
  4. Trigger render
  5. Export audio → /Users/ben/renders/job_123.wav
  6. Return WAV path
```

---

*Created: March 3, 2026*
*Updated: March 4, 2026 — Added research findings, discovery script*
*Priority: HIGH — Run discovery on Mac Mini before any other implementation work*
