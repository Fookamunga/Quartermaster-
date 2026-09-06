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

## Suggestions and purchase history

When you ask for something like "add cheese," the recommendation depends on
what's known about it: if you've bought it before, it recommends whichever
option you buy most often and shows alternatives of the same type (other Edam
cheeses, say). If you haven't, it bases alternatives on anything related
already in your cart, or falls back to a general search if not. Either way,
it always includes a best-value pick — the cheapest price-per-unit option of
that type — regardless of which path found the recommendation.

These suggestions are only as good as your purchase history, so recording it
matters. Until Woolworths fixes their order-history API (at which point this
becomes automatic), that's manual: copy the whole order — including its date
and order/invoice number — from the Orders page on the Woolworths website,
and paste it into either the `#order-import` Discord channel or a Claude.ai
conversation with the staples-host connector. That paste becomes real
purchase history, which is exactly what the recommendations above draw on.

## More detail

- [CLAUDE.md](CLAUDE.md) — full build spec and architecture.
- [DEPLOYMENT.md](DEPLOYMENT.md) — NAS/environment details.
