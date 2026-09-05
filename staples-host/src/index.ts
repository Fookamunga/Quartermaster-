import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { PORT } from "./config.js";
import { registerFilterStaples } from "./tools/filterStaples.js";
import { registerGetItem } from "./tools/getItem.js";
import { registerIngestReceipt } from "./tools/ingestReceipt.js";
import { registerListStaples } from "./tools/listStaples.js";
import { registerPushStatusToCraft } from "./tools/pushStatusToCraft.js";
import { registerRecordPurchase } from "./tools/recordPurchase.js";
import { registerSetInterval } from "./tools/setInterval.js";
import { registerSyncFromCraft } from "./tools/syncFromCraft.js";

function buildServer(): McpServer {
  const server = new McpServer({ name: "staples-host", version: "0.1.0" });
  registerListStaples(server);
  registerGetItem(server);
  registerRecordPurchase(server);
  registerSetInterval(server);
  registerSyncFromCraft(server);
  registerFilterStaples(server);
  registerIngestReceipt(server);
  registerPushStatusToCraft(server);
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

app.post("/mcp", async (req, res) => {
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

app.get("/mcp", (_req, res) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    }),
  );
});

app.delete("/mcp", (_req, res) => {
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
