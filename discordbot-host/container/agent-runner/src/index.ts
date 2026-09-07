/**
 * discordbot-host agent runner. Runs inside a short-lived container, spawned
 * fresh per Discord message. Reads its input from stdin, makes exactly one
 * query() call, writes its output to stdout, and exits -- a cold, one-shot
 * invocation, never a warm/streaming session kept alive across turns. See
 * the non-negotiable constraint in CLAUDE.md: this is fine specifically
 * because the process exits after this single call.
 */
import { query, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

interface RemoteMcpServerConfig {
  url: string;
  headers?: Record<string, string>;
}

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  channelKey: string;
  mcpServers: Record<string, RemoteMcpServerConfig>;
}

interface ContainerOutput {
  status: "success" | "error";
  result: string | null;
  newSessionId?: string;
  error?: string;
}

const OUTPUT_START_MARKER = "---DISCORDBOT_OUTPUT_START---";
const OUTPUT_END_MARKER = "---DISCORDBOT_OUTPUT_END---";

// woolies-mcp tools deliberately kept off this agent's tool set: all five
// return product/price listings that plausibly answer the exact same
// "find/compare/price a product" phrasing staples-host's
// suggest_alternatives and build_shopping_list already exist to handle with
// purchase-history ranking, best-value comparison, and cart-awareness
// search_products alone has none of -- confirmed live that simply telling
// the agent to "prefer" the staples-host tools via prompt wording didn't
// change its behavior for price-comparison phrasing ("cheapest chilli
// option") even after two rounds of strengthening that wording; the model
// reached for search_products before ever weighing which tool's description
// fit better. This list is the structural fix: the agent can't reach for a
// tool that isn't available to it, regardless of phrasing. See CLAUDE.md's
// Architecture section.
//
// This MUST be passed as `disallowedTools`, not `allowedTools` -- confirmed
// live (deployed, rebuilt, re-tested against the identical failing prompt)
// that an `allowedTools` narrowing here had ZERO effect: this runner sets
// permissionMode: "bypassPermissions" below, and the bundled Agent SDK
// explicitly documents that bypassPermissions auto-approves every tool call
// and *ignores allow rules from --allowedTools* -- only deny rules
// (--disallowedTools) still apply under that mode. `allowedTools` below
// keeps its original wildcard shape for exactly this reason: it was never
// doing any real narrowing in this runner and still isn't.
//
// staples-host itself is unaffected -- it's always been the sole caller of
// woolies-mcp's search_products/get_cart/get_product (see CLAUDE.md's
// Ownership boundaries), calling them server-side via its own wooliesClient,
// never through the agent's tool list at all.
const WOOLIES_DISALLOWED_TOOLS = [
  "search_products",
  "search_products_batch",
  "browse_category",
  "get_buy_it_again",
  "get_product",
];

function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function buildMcpServers(remote: Record<string, RemoteMcpServerConfig>): Record<string, McpServerConfig> {
  return Object.fromEntries(
    Object.entries(remote).map(([name, cfg]) => [
      name,
      { type: "http" as const, url: cfg.url, headers: cfg.headers },
    ]),
  );
}

async function main(): Promise<void> {
  let input: ContainerInput;
  try {
    input = JSON.parse(await readStdin());
    log(`Received input for channel: ${input.channelKey}`);
  } catch (err) {
    writeOutput({
      status: "error",
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  const remoteServerNames = Object.keys(input.mcpServers);
  const allowedTools = [
    "Bash",
    "Read",
    "Write",
    "Glob",
    "Grep",
    ...remoteServerNames.map((name) => `mcp__${name}__*`),
  ];
  const disallowedTools = remoteServerNames.includes("woolies")
    ? WOOLIES_DISALLOWED_TOOLS.map((tool) => `mcp__woolies__${tool}`)
    : [];

  let result: string | null = null;
  let newSessionId: string | undefined;

  try {
    const model = process.env.CLAUDE_MODEL || undefined;

    for await (const message of query({
      prompt: input.prompt,
      options: {
        ...(model ? { model } : {}),
        cwd: "/workspace/group",
        resume: input.sessionId,
        allowedTools,
        disallowedTools,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        settingSources: ["project"],
        mcpServers: buildMcpServers(input.mcpServers),
        stderr: (data: string) => process.stderr.write(`[claude] ${data}`),
      },
    })) {
      if (message.type === "system" && message.subtype === "init") {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }
      if ("result" in message && message.result) {
        result = message.result as string;
      }
    }

    log("Agent completed successfully");
    writeOutput({ status: "success", result, newSessionId });
    process.exit(0);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({ status: "error", result: null, newSessionId, error: errorMessage });
    process.exit(1);
  }
}

main();
