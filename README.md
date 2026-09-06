# Quartermaster

A household-ops system for Woolworths NZ shopping and staples tracking. Built
as a pair of MCP servers you can use directly from Claude mobile/desktop, with
an optional Discord bot on top for a chat-based front end.

## Components

- **[woolies-mcp](https://github.com/adrian-baker/woolies-mcp)** — owns
  Woolworths NZ login, product search, and cart/order actions. External
  dependency, not built in this repo.
- **[staples-host](staples-host/)** — tracks your staples: what you buy, how
  often, restock rates, cheaper alternatives, best value across brands.

  `woolies-mcp` and `staples-host` are the required core, and both work
  standalone as Claude.ai custom connectors — no Discord needed.
- **[discordbot-host](discordbot-host/)** — an optional additional front end:
  a Discord-based way to talk to the same two servers. Nothing else in the
  system depends on it.

## Managing staples

Fully conversational, no external doc or sync required — just talk to either
front end (Claude mobile/desktop or Discord):

- "Add bread as a staple"
- "Remove fish sauce"
- "Update oat milk's restock rate to every 10 days"

**Tip: name staples generically when brand/type doesn't matter, specifically
when it does.** "Bread" is fine if any bread counts. But if you regularly buy
two different Otis Oat Milk variants, track them as two separate staples
rather than one generic "oat milk" — each staple's purchase history and
restock rate are computed independently, so lumping different products
together blends their buying patterns into one misleading rate.

## More detail

- [CLAUDE.md](CLAUDE.md) — full build spec and architecture.
- [DEPLOYMENT.md](DEPLOYMENT.md) — NAS/environment details.
