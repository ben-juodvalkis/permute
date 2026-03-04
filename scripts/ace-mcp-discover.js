#!/usr/bin/env node

/**
 * ACE Studio MCP Server Discovery Script
 *
 * Run this on the Mac Mini where ACE Studio 2.0 is running with MCP Server enabled.
 * Prerequisites:
 *   1. ACE Studio 2.0 open
 *   2. Preferences → General → MCP Server checked
 *   3. Node.js installed
 *
 * Usage:
 *   node scripts/ace-mcp-discover.js
 *   node scripts/ace-mcp-discover.js --save    # saves full output to ace_mcp_tools.json
 *   node scripts/ace-mcp-discover.js --test     # also tests critical operations
 */

const MCP_URL = "http://localhost:21572/mcp";
let requestId = 0;

async function mcpCall(method, params = {}) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
      id: ++requestId,
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

async function mcpTool(toolName, args = {}) {
  return mcpCall("tools/call", { name: toolName, arguments: args });
}

async function initialize() {
  console.log("=== Step 1: Initialize MCP Connection ===\n");
  try {
    const result = await mcpCall("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "ace-mcp-discover", version: "1.0" },
    });
    console.log("Server info:", JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    console.error("Failed to connect to ACE Studio MCP server.");
    console.error("Make sure ACE Studio 2.0 is running with MCP Server enabled.");
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

async function listTools() {
  console.log("\n=== Step 2: Discover Available Tools ===\n");
  const result = await mcpCall("tools/list");
  const tools = result.result?.tools || [];

  console.log(`Found ${tools.length} tools:\n`);

  // Categorize tools by likely function
  const categories = {
    project: [],
    track: [],
    note: [],
    lyrics: [],
    voice: [],
    render: [],
    export: [],
    other: [],
  };

  for (const tool of tools) {
    console.log(`  ${tool.name}`);
    console.log(`    ${tool.description || "(no description)"}`);
    if (tool.inputSchema?.properties) {
      const params = Object.keys(tool.inputSchema.properties);
      console.log(`    params: ${params.join(", ")}`);
    }
    console.log();

    // Categorize
    const name = tool.name.toLowerCase();
    if (name.includes("project") || name.includes("open") || name.includes("save") || name.includes("create_project")) {
      categories.project.push(tool.name);
    } else if (name.includes("track")) {
      categories.track.push(tool.name);
    } else if (name.includes("note") || name.includes("midi")) {
      categories.note.push(tool.name);
    } else if (name.includes("lyric") || name.includes("lyrics")) {
      categories.lyrics.push(tool.name);
    } else if (name.includes("voice") || name.includes("singer")) {
      categories.voice.push(tool.name);
    } else if (name.includes("render") || name.includes("synth")) {
      categories.render.push(tool.name);
    } else if (name.includes("export") || name.includes("bounce")) {
      categories.export.push(tool.name);
    } else {
      categories.other.push(tool.name);
    }
  }

  // Print feasibility summary
  console.log("\n=== Feasibility Summary ===\n");
  const critical = ["project", "lyrics", "render", "export"];
  const important = ["track", "note", "voice"];

  for (const cat of critical) {
    const found = categories[cat].length > 0;
    console.log(`  [${found ? "✓" : "✗"}] ${cat.toUpperCase()} tools: ${categories[cat].join(", ") || "NONE FOUND"} ${found ? "" : "⚠ CRITICAL"}`);
  }
  for (const cat of important) {
    const found = categories[cat].length > 0;
    console.log(`  [${found ? "✓" : " "}] ${cat.toUpperCase()} tools: ${categories[cat].join(", ") || "none found"}`);
  }
  if (categories.other.length > 0) {
    console.log(`  [ ] OTHER tools: ${categories.other.join(", ")}`);
  }

  return { tools, categories, result };
}

async function testCriticalOps(tools) {
  console.log("\n=== Step 3: Test Critical Operations ===\n");

  // Try to get project info (look for likely tool names)
  const toolNames = tools.map((t) => t.name.toLowerCase());

  // Test: Get project info
  const projectInfoTools = tools.filter(
    (t) =>
      t.name.toLowerCase().includes("project") &&
      (t.name.toLowerCase().includes("get") || t.name.toLowerCase().includes("info") || t.name.toLowerCase().includes("list"))
  );

  if (projectInfoTools.length > 0) {
    console.log(`Testing: ${projectInfoTools[0].name}`);
    try {
      const result = await mcpTool(projectInfoTools[0].name);
      console.log("  Result:", JSON.stringify(result, null, 2).slice(0, 500));
    } catch (err) {
      console.log(`  Error: ${err.message}`);
    }
  } else {
    console.log("No project info tool found to test.");
  }
}

async function main() {
  const args = process.argv.slice(2);
  const shouldSave = args.includes("--save");
  const shouldTest = args.includes("--test");

  await initialize();
  const { tools, categories, result } = await listTools();

  if (shouldTest) {
    await testCriticalOps(tools);
  }

  if (shouldSave) {
    const fs = require("fs");
    const path = require("path");
    const outPath = path.join(process.env.HOME || "~", "ace_mcp_tools.json");
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(`\nFull tool list saved to: ${outPath}`);
  }

  console.log("\n=== Next Steps ===\n");
  console.log("1. Share the tool list output above (or ace_mcp_tools.json if --save was used)");
  console.log("2. Try connecting Claude Code: claude mcp add acestudio --transport http http://localhost:21572/mcp");
  console.log("3. Ask Claude: 'What tools are available from ACE Studio?'");
  console.log("4. Fill in the capability checklist in docs/current-plan/ace-mcp-investigation.md");
}

main().catch((err) => {
  console.error("Unhandled error:", err);
  process.exit(1);
});
