import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  CONTAINER_IMAGE,
  CONTAINER_MAX_OUTPUT_SIZE,
  CONTAINER_TIMEOUT_MS,
  DATA_DIR,
  PROJECT_ROOT,
  STAPLES_HOST_URL,
  WOOLIES_MCP_URL,
  WORKSPACES_DIR,
} from "./config.js";
import { logger } from "./logger.js";
import type { ChannelKey, ContainerInput, ContainerOutput, ProposeAction, RemoteMcpServerConfig } from "./types.js";

// Sentinel markers for robust stdout parsing (must match container/agent-runner).
const OUTPUT_START_MARKER = "---DISCORDBOT_OUTPUT_START---";
const OUTPUT_END_MARKER = "---DISCORDBOT_OUTPUT_END---";

const PROPOSE_ACTION_FILENAME = "propose-action.json";

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly?: boolean;
}

function ensureWritableDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o777);
}

// In practice only ever called for woolworths-ordering -- order-import is a
// pure relay (src/orderImportPhotos.ts, src/orderImportText.ts) and never
// reaches a cold session at all, so this branch stays for type-completeness
// against ChannelKey rather than because order-import currently uses it.
// See CLAUDE.md.
function mcpServersFor(channelKey: ChannelKey): Record<string, RemoteMcpServerConfig> {
  const staples: Record<string, RemoteMcpServerConfig> = {
    staples: { url: STAPLES_HOST_URL },
  };
  if (channelKey === "woolworths-ordering") {
    return { woolies: { url: WOOLIES_MCP_URL }, ...staples };
  }
  return staples;
}

function buildVolumeMounts(channelKey: ChannelKey): VolumeMount[] {
  const mounts: VolumeMount[] = [];

  const workspaceDir = path.join(WORKSPACES_DIR, channelKey);
  ensureWritableDir(workspaceDir);
  mounts.push({ hostPath: workspaceDir, containerPath: "/workspace/group" });

  const claudeSessionDir = path.join(DATA_DIR, "sessions", channelKey, ".claude");
  ensureWritableDir(claudeSessionDir);
  mounts.push({ hostPath: claudeSessionDir, containerPath: "/home/node/.claude" });

  // Filtered env passthrough: only pass Claude Code's own auth vars into the
  // ephemeral container, never the whole host .env (which also holds the
  // Discord bot token etc.) -- same reasoning as the old nanoclaw-discord
  // build this replaces.
  const envDir = path.join(DATA_DIR, "env");
  mkdirSync(envDir, { recursive: true });
  const hostEnvFile = path.join(PROJECT_ROOT, ".env");
  if (existsSync(hostEnvFile)) {
    const allowedVars = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_MODEL"];
    const filteredLines = readFileSync(hostEnvFile, "utf8")
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return false;
        return allowedVars.some((v) => trimmed.startsWith(`${v}=`));
      });
    if (filteredLines.length > 0) {
      writeFileSync(path.join(envDir, "env"), filteredLines.join("\n") + "\n");
      mounts.push({ hostPath: envDir, containerPath: "/workspace/env-dir", readonly: true });
    } else {
      logger.warn(
        "No CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in .env -- container will run without Claude auth.",
      );
    }
  }

  return mounts;
}

function buildDockerArgs(mounts: VolumeMount[], containerName: string): string[] {
  const args = ["run", "-i", "--rm", "--name", containerName];
  for (const mount of mounts) {
    args.push("-v", `${mount.hostPath}:${mount.containerPath}${mount.readonly ? ":ro" : ""}`);
  }
  args.push(CONTAINER_IMAGE);
  return args;
}

/**
 * After a cold run exits, check the channel's workspace for a
 * propose-action.json the agent may have written instead of calling a tool.
 * Consumed (deleted) whether or not it parses, so a malformed file can't
 * wedge every future run in this channel. See CLAUDE.md's discordbot-host
 * "How a proposal is initiated" note.
 */
export function takeProposedAction(channelKey: ChannelKey): ProposeAction | null {
  const filePath = path.join(WORKSPACES_DIR, channelKey, PROPOSE_ACTION_FILENAME);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as ProposeAction;
  } catch (err) {
    logger.error("Failed to parse propose-action.json", { channelKey, err: String(err) });
    return null;
  } finally {
    try {
      unlinkSync(filePath);
    } catch {
      // already gone, fine
    }
  }
}

export async function runContainerAgent(
  channelKey: ChannelKey,
  prompt: string,
  sessionId: string | undefined,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const containerName = `discordbot-${channelKey}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const mounts = buildVolumeMounts(channelKey);
  const dockerArgs = buildDockerArgs(mounts, containerName);

  logger.info("Spawning container agent", { channelKey, containerName });

  const input: ContainerInput = {
    prompt,
    sessionId,
    channelKey,
    mcpServers: mcpServersFor(channelKey),
  };

  return new Promise((resolve) => {
    const container = spawn("docker", dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;

    container.stdin.write(JSON.stringify(input));
    container.stdin.end();

    container.stdout.on("data", (data: Buffer) => {
      if (stdoutTruncated) return;
      const chunk = data.toString();
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
      if (chunk.length > remaining) {
        stdout += chunk.slice(0, remaining);
        stdoutTruncated = true;
      } else {
        stdout += chunk;
      }
    });

    container.stderr.on("data", (data: Buffer) => {
      const chunk = data.toString();
      for (const line of chunk.trim().split("\n")) {
        if (line) logger.info(`[${channelKey}] ${line}`);
      }
      stderr += chunk;
    });

    const timeout = setTimeout(() => {
      logger.error("Container timed out, killing", { channelKey, containerName });
      spawn("docker", ["kill", containerName], { stdio: "ignore" }).on("error", () => {});
      container.kill("SIGKILL");
      resolve({ status: "error", result: null, error: `Container timed out after ${CONTAINER_TIMEOUT_MS}ms` });
    }, CONTAINER_TIMEOUT_MS);

    container.on("close", (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (code !== 0) {
        logger.error("Container exited with error", { channelKey, code, duration, stderr: stderr.slice(-500) });
        resolve({ status: "error", result: null, error: `Container exited with code ${code}: ${stderr.slice(-200)}` });
        return;
      }

      try {
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
        const jsonLine =
          startIdx !== -1 && endIdx !== -1 && endIdx > startIdx
            ? stdout.slice(startIdx + OUTPUT_START_MARKER.length, endIdx).trim()
            : stdout.trim().split("\n").pop() || "";

        const output: ContainerOutput = JSON.parse(jsonLine);
        logger.info("Container completed", { channelKey, duration, status: output.status });
        resolve(output);
      } catch (err) {
        logger.error("Failed to parse container output", { channelKey, err: String(err), stdout: stdout.slice(-500) });
        resolve({ status: "error", result: null, error: `Failed to parse container output: ${String(err)}` });
      }
    });

    container.on("error", (err) => {
      clearTimeout(timeout);
      logger.error("Container spawn error", { channelKey, err: String(err) });
      resolve({ status: "error", result: null, error: `Container spawn error: ${err.message}` });
    });
  });
}

export function ensureWorkspaceDirs(): void {
  for (const key of ["woolworths-ordering", "order-import"] as ChannelKey[]) {
    ensureWritableDir(path.join(WORKSPACES_DIR, key));
  }
}

// Exported for the manual test-trigger path (mirrors nanoclaw's
// run_staples_order_now) -- lets a maintainer force-clean a stuck workspace
// without reaching for `rm -rf` by hand.
export function clearWorkspaceState(channelKey: ChannelKey): void {
  const filePath = path.join(WORKSPACES_DIR, channelKey, PROPOSE_ACTION_FILENAME);
  if (existsSync(filePath)) rmSync(filePath);
}
