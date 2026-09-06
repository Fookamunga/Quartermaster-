import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { MCP_AUTH_TOKEN, PORT } from "./config.js";
import { registerAddStaple } from "./tools/addStaple.js";
import { registerBuildShoppingList } from "./tools/buildShoppingList.js";
import { registerFilterStaples } from "./tools/filterStaples.js";
import { registerGetBestValue } from "./tools/getBestValue.js";
import { registerGetItem } from "./tools/getItem.js";
import { registerIngestOrderText } from "./tools/ingestOrderText.js";
import { registerIngestReceipt } from "./tools/ingestReceipt.js";
import { registerListStaples } from "./tools/listStaples.js";
import { registerRecordPurchase } from "./tools/recordPurchase.js";
import { registerRemoveStaple } from "./tools/removeStaple.js";
import { registerSuggestAlternatives } from "./tools/suggestAlternatives.js";
import { registerUpdateStaple } from "./tools/updateStaple.js";

function buildServer(): McpServer {
  const server = new McpServer({ name: "staples-host", version: "0.1.0" });
  registerListStaples(server);
  registerGetItem(server);
  registerRecordPurchase(server);
  registerAddStaple(server);
  registerRemoveStaple(server);
  registerUpdateStaple(server);
  registerFilterStaples(server);
  registerIngestReceipt(server);
  registerIngestOrderText(server);
  registerSuggestAlternatives(server);
  registerGetBestValue(server);
  registerBuildShoppingList(server);
  return server;
}

// Stateless streamable-HTTP: a fresh McpServer + transport per request. This
// container is a single low-traffic household service reached over Tailscale
// Funnel, so per-request overhead is a non-issue and it sidesteps session
// bookkeeping entirely — matches the project's "cold, one-shot" philosophy.
const allowedHosts = process.env.ALLOWED_HOSTS
  ? process.env.ALLOWED_HOSTS.split(",").map((h) => h.trim())
  : undefined;

// Built directly rather than via the SDK's createMcpExpressApp() helper: that
// helper's own express.json() has no size-limit override and is registered
// before it hands the app back, so a too-large request (e.g. ingest_receipt's
// base64-encoded photos, easily 1-2MB+) is rejected by body-parser before our
// own route ever runs -- there's no way to raise the limit after the fact.
// Reimplements the same optional Host-header allowlist createMcpExpressApp
// would have applied, since that's real config surface (ALLOWED_HOSTS).
const app = express();
app.use(express.json({ limit: "25mb" }));
if (allowedHosts) {
  app.use((req, res, next) => {
    if (req.hostname && allowedHosts.includes(req.hostname)) {
      next();
      return;
    }
    res.status(400).json({ error: "Invalid Host header" });
  });
} else {
  console.warn(
    "Warning: no ALLOWED_HOSTS configured -- any Host header is accepted. " +
      "Set ALLOWED_HOSTS to restrict this in production.",
  );
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

if (!MCP_AUTH_TOKEN) {
  console.error(
    "MCP_AUTH_TOKEN is not set -- every /mcp/<token> request will be rejected. " +
      "Set MCP_AUTH_TOKEN to a random secret before exposing this over Funnel.",
  );
}

// Constant-time compare so a wrong-length or wrong-content token takes the
// same time either way -- avoids leaking the correct token length/prefix via
// response timing.
function tokenMatches(candidate: string): boolean {
  if (!MCP_AUTH_TOKEN) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(MCP_AUTH_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

// 404 (not 401/403) for a bad token, same as an unknown path -- an internet-
// wide prober can't tell "wrong token" from "route doesn't exist".
app.use("/mcp/:token", (req, res, next) => {
  if (!tokenMatches(req.params.token)) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  next();
});

app.post("/mcp/:token", async (req, res) => {
  const server = buildServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    res.on("close", () => {
      transport.close();
      server.close();
    });
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp/:token", (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
  );
});

app.delete("/mcp/:token", (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
  );
});

app.listen(PORT, () => {
  console.log(`staples-host listening on port ${PORT}`);
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
