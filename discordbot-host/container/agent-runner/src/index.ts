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
