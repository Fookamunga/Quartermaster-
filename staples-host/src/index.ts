import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PORT } from "./config.js";
import { registerFilterStaples } from "./tools/filterStaples.js";
import { registerGetItem } from "./tools/getItem.js";
import { registerIngestReceipt } from "./tools/ingestReceipt.js";
import { registerListStaples } from "./tools/listStaples.js";
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
  return server;
}

// Stateless streamable-HTTP: a fresh McpServer + transport per request. This
// container is a single low-traffic household service reached over Tailscale
// Funnel, so per-request overhead is a non-issue and it sidesteps session
// bookkeeping entirely — matches the project's "cold, one-shot" philosophy.
const allowedHosts = process.env.ALLOWED_HOSTS
  ? process.env.ALLOWED_HOSTS.split(",").map((h) => h.trim())
  : undefined;

const app = createMcpExpressApp({ host: "0.0.0.0", allowedHosts });

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
