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
- The `nas` alias is configured — `ssh nas` works as-is, no key path or user needed.
  Gotcha: `D:\docker\.ssh\config` and `%USERPROFILE%\.ssh\config` are two separate
  files with identical content, and `ssh` only reads the latter by default. The alias
  was added to both; keep them in sync if either is edited.
  ```
  Host nas
      HostName 192.168.50.205
      User claude
      IdentityFile D:\docker\.ssh\claude_nas_key
      IdentitiesOnly yes
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
- Docker CLI over SSH is **confirmed working** (2026-09-20), with two wrinkles the
  deploy steps need to account for:
  - `docker` is **not on `claude`'s PATH** — it lives at `/usr/local/bin/docker`
    (a symlink into `/var/packages/ContainerManager/target/usr/bin/docker`). Use the
    full path in scripts rather than relying on PATH.
  - `/var/run/docker.sock` is `root:root 0660`, so `claude` **cannot reach the daemon
    directly** — every Docker command needs `sudo`. Passwordless `sudo` is configured
    (`claude` is in the `administrators` group), so `sudo -n` works non-interactively.

  Working invocation: `ssh nas 'sudo -n /usr/local/bin/docker ps'`
- Deploy path convention on the NAS (as currently deployed):
  - code: `/volume1/docker/quartermaster/<service>`
  - persistent state: `/volume1/docker/quartermaster-data/<service>` (mounted in, not
    baked into images — keeps the possible VPS migration cheap)
- Existing containers on the NAS for reference/context (do not touch woolies-mcp):
  - `woolies-mcp` — at whatever path it was deployed to via Container Manager;
    exposed via Tailscale Funnel on the standard port 443 (its own container
    listens locally on port 8480; Funnel proxies `/` on 443 to it).
  - `staples-host` — running; listens on `127.0.0.1:8481`, exposed via the `/staples`
    Funnel path (see Networking). Mounts its `.env` from
    `/volume1/docker/quartermaster/staples-host/.env`.
  - `discordbot-host` — running; the rebuilt replacement for nanoclaw-host. Has
    `/var/run/docker.sock` mounted in, per the container-side Claude Code pattern above.
  - `claude-ssh` — `linuxserver/openssh-server`, at `/volume1/docker/claude-ssh`.
    Publishes **port 2222 on all interfaces** and mounts both `/volume1/docker` (as
    `/workspace`) and `/var/run/docker.sock`. Not part of Quartermaster, but it is a
    second, broader SSH path onto the NAS — worth knowing about before assuming the
    `claude` user's key is the only access route.
  - `nanoclaw-watchdog` — running, `/var/run/docker.sock` mounted. Left over from the
    nanoclaw era; its role relative to discordbot-host is undocumented. Check what it
    is actually doing before removing it.
  - `nanoclaw-host` — stopped (exited 2 weeks ago), not removed. Superseded by
    discordbot-host. Fine to inspect for reference before deleting.
  - `claude-discord` — the original abandoned attempt, was at
    `/volume1/docker/claude-discord`; already fully removed, nothing to reference.
  - Also stopped and unreferenced: `nanoclaw-warm-woolworths-ordering`,
    `wonderful_jennings`, `nice_vaughan`.

## Claude Code auth for discordbot-host

discordbot-host needs Claude credentials for both of its agent paths: the
warm session runs the Agent SDK in its own process, and the cold path
filters the same vars into each ephemeral container's env-dir mount
(`containerRunner.ts`'s `allowedVars`). `.env.example` is right that it's
**exactly one of** `CLAUDE_CODE_OAUTH_TOKEN` (a subscription) or
`ANTHROPIC_API_KEY` (pay-per-token) -- don't leave both set, even
commented, since a stale one is a trap.

### Minting an OAuth token

Confirmed working 2026-09-27. Run these on the PC, not the NAS -- they're
interactive browser sign-in flows, and a native Claude Code install on DSM
is broken anyway (see the Docker quirks above):

```
claude auth login     # sign in as the account whose subscription should pay
claude auth status    # confirm it took the account you meant
claude setup-token    # prints the long-lived token
```

Paste the result into `CLAUDE_CODE_OAUTH_TOKEN=` in the NAS's
`/volume1/docker/quartermaster/discordbot-host/.env`, then **restart the
container -- no rebuild needed**. `config.ts` calls `process.loadEnvFile()`
against the bind-mounted working directory, so the file is read fresh at
every start. An OAuth token has an `sk-ant-oat01-` prefix, distinguishing
it at a glance from an `sk-ant-api03-` API key.

### The failure mode that isn't a bug

An Anthropic **organization** setting can disable Claude subscription
access for Claude Code, which kills `CLAUDE_CODE_OAUTH_TOKEN` outright
while leaving everything else working. Confirmed live: the bot replied into
Discord with *"Your organization has disabled Claude subscription access
for Claude Code"*. Note the shape -- it is **not** a crash. The SDK starts
normally (`Warm session initialized`), the API refuses the request, and the
refusal text is relayed as the reply (`Reply sent`), so the logs look
healthy and the error only appears in Discord. Don't hunt for a code bug.

Fixes, in order of preference: re-enable the org setting, or sign in as an
account that has it enabled and mint a fresh token. An `ANTHROPIC_API_KEY`
also works and needs no code change, but bills per token, and the warm
session runs a full agent turn for every message in the channel -- flat
subscription billing is the cheaper shape for this workload.

### Verifying a token change

**Only a real Discord message proves it.** Two things that look like
verification but aren't:

- `docker exec discordbot-host printenv CLAUDE_CODE_OAUTH_TOKEN` returns
  empty even when the token is loaded correctly -- `loadEnvFile()`
  populates the Node process's in-memory `process.env`, not the container's
  OS environment.
- A clean startup proves nothing about auth. The SDK's streaming generator
  produces no messages until a prompt is written to it, and the health
  check that does deliver a prompt only runs on the *restart* path, never
  at boot (see `warmSession.ts`'s header comment -- this is deliberate).

So post a real request in `#woolworths-ordering` and watch for
`Warm session initialized` -> `Reply sent`, then the
`Candidate options posted` / `Candidate reaction confirmed` pair if you
react -- that last pair exercises the whole chain including the cart write.

## Networking

- Tailscale Funnel is how remote/mobile Claude.ai reaches self-hosted MCP servers
  on this NAS from the public internet. It's a network-exposure mechanism only —
  unrelated to any service's own internal auth (e.g. it has nothing to do with the
  Woolworths login inside woolies-mcp).
- staples-host needs its own Claude.ai custom connector registration, separate
  from woolies-mcp's, but **not its own Funnel port** — confirmed live (a real
  "couldn't reach this address" failure from Claude.ai's connector setup,
  ruled out as a config/token issue first) that Tailscale Funnel's two
  non-standard ports (8443, then 10000, tested in that order) are both
  unreachable from Claude.ai's own connector-verification infrastructure,
  even though both worked from every other network tested. **Only port 443
  is reachable.** Since woolies-mcp already owns `/` on 443, staples-host is
  exposed via path-based routing on the same port instead:
  ```
  tailscale funnel --bg --https=443 --set-path=/staples http://127.0.0.1:8481
  ```
  This is additive — confirmed live it doesn't touch woolies-mcp's own `/`
  handler on 443 — and Tailscale strips the `/staples` prefix before
  forwarding, so staples-host's own routes (`/mcp/:token`, `/healthz`) need
  no changes to receive it. The resulting connector URL is
  `https://<funnel-host>/staples/mcp/<token>` instead of a separate port.
  If staples-host is ever redeployed to a fresh NAS, re-run the command
  above rather than reaching for a new port — it will fail the same way.

## Repo / git

- Repo: `Fookamunga/Quartermaster-` (private)
- Local clone: `D:\docker\Quartermaster-`
- Push/pull uses the `github.com-quartermaster` SSH alias (deploy key has write
  access)
- `core.autocrlf` is on for this Windows checkout — harmless for docs, but worth
  adding a `.gitattributes` (`* text=auto eol=lf`) once real code lands, so shell
  scripts and configs don't pick up CRLF line endings that could break on the
  Linux containers they'll run in
