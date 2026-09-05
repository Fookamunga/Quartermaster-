# Deployment & Environment Brief

This supplements CLAUDE.md with the actual machines/credentials involved in getting
Quartermaster from local development to running on the NAS. Read alongside
CLAUDE.md before starting work.

## Workflow

Development happens **locally**, in this repo (`D:\docker\Quartermaster-` on the
PC), via Claude Code Desktop in Local mode. The NAS is the deploy target, not the
dev environment:

1. Write/iterate on code locally in this repo
2. Test locally where possible (Docker Desktop if available, unit tests, linting)
3. Commit and push to `git@github.com-quartermaster:Fookamunga/Quartermaster-.git`
   (the `github.com-quartermaster` SSH host alias is already configured in
   `D:\docker\.ssh\config`, using the deploy key at
   `D:\docker\.ssh\quartermaster_deploy_key`)
4. Get the code onto the NAS — either `git pull` on the NAS from this same repo, or
   `scp`/`rsync` the folder over via SSH
5. Build and run the containers **on the NAS itself** (`docker build` /
   `docker compose up`) — images are built there, not shipped pre-built from the PC
6. Test against the real Discord bot / Tailscale Funnel / Woolworths login
7. Loop back to local dev for fixes

## NAS details

- Model: Synology DS418play, DSM 7.4.1
- Hostname on the LAN: `192.168.50.205`
- Tailscale hostname: `fooknas.tail41d444.ts.net`
- Named "Fooknas"
- Does **not** support Synology Virtual Machine Manager (ruled out running a VM on
  the NAS itself for anything)
- A move off the NAS to a VPS (or a spare Ryzen 3200 box arriving later) is being
  considered for unrelated DSM-specific pain points, but is a separate, not-yet-decided
  thread — build and deploy against the NAS for now. Keep all three
  containers plain Docker with state in mounted volumes (not baked into images,
  no DSM-specific APIs) so nothing here needs rework if/when that migration happens.

## SSH access to the NAS

- Dedicated NAS user account: `claude` (created specifically for Claude Code
  Desktop's remote access, not tied to Nick's own NAS login)
- Passwordless SSH keypair: `D:\docker\.ssh\claude_nas_key` (private) /
  `claude_nas_key.pub` (added to the `claude` user's `authorized_keys` on the NAS)
- Recommended: add a matching alias to `D:\docker\.ssh\config` so commands can just
  use `ssh nas` instead of the full path/user/host each time:
  ```
  Host nas
      HostName 192.168.50.205
      User claude
      IdentityFile D:\docker\.ssh\claude_nas_key
  ```
- Access is broad (full SSH, not just Docker-socket-scoped) — there's nothing on
  this NAS considered irreplaceable, so this was set up deliberately permissive.
  Still worth being deliberate about destructive commands run against it.

## Docker on the NAS — known quirks

- **Native Claude Code install on the DSM host itself is broken** — `npm install`
  there installs the Windows `claude.exe` binary instead of the Linux one. This is
  why the old nanoclaw-host existed as a workaround: a separate Ubuntu container
  with Node, Docker CLI, and Claude Code installed inside it, with the NAS's real
  `/var/run/docker.sock` mounted in so it can control sibling containers on the
  actual Docker daemon. If discordbot-host's rebuild still needs to run Claude Code
  *from inside a NAS-side container* for any reason, follow the same pattern —
  don't attempt a native DSM install.
- Ordinary `docker build` / `docker compose` over SSH (i.e., not going through DSM's
  Container Manager GUI) should work fine — the broken part was specifically the
  native npm/Claude Code install path, not Docker itself. Worth confirming Docker
  CLI access over the `claude` SSH session works cleanly before assuming the deploy
  step is friction-free.
- Existing containers on the NAS for reference/context (do not touch woolies-mcp):
  - `woolies-mcp` — at whatever path it was deployed to via Container Manager;
    exposed via Tailscale Funnel on port **8480**. staples-host needs a different
    port.
  - `nanoclaw-host` — was at `/volume1/docker/nanoclaw-host`; being replaced by the
    rebuilt discordbot-host per CLAUDE.md. Fine to inspect for reference before
    removing/replacing.
  - `claude-discord` — the original abandoned attempt, was at
    `/volume1/docker/claude-discord`; already fully removed, nothing to reference.

## Networking

- Tailscale Funnel is how remote/mobile Claude.ai reaches self-hosted MCP servers
  on this NAS from the public internet. It's a network-exposure mechanism only —
  unrelated to any service's own internal auth (e.g. it has nothing to do with the
  Woolworths login inside woolies-mcp).
- staples-host will need its own Funnel endpoint on its own port (next free after
  8480) and its own Claude.ai custom connector registration, separate from
  woolies-mcp's.

## Repo / git

- Repo: `Fookamunga/Quartermaster-` (private)
- Local clone: `D:\docker\Quartermaster-`
- Push/pull uses the `github.com-quartermaster` SSH alias (deploy key has write
  access)
- `core.autocrlf` is on for this Windows checkout — harmless for docs, but worth
  adding a `.gitattributes` (`* text=auto eol=lf`) once real code lands, so shell
  scripts and configs don't pick up CRLF line endings that could break on the
  Linux containers they'll run in
