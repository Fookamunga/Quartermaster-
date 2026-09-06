# Quartermaster

A household-ops system for Woolworths NZ shopping and staples tracking. Built
as a pair of MCP servers you can use directly from Claude mobile/desktop, with
an optional Discord bot on top for a chat-based front end.

![Architecture](docs/architecture.png)
*Discord and Claude Mobile are two interchangeable front ends onto the same
two backend servers — woolies-mcp and staples-host do the real work either
way.*

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

## Restock calculation and messages

Once a staple has enough purchase history (3+ purchases), its restock rate is
learned automatically: the median days-per-unit between purchases, scaled by
how much you bought last time — a bigger last purchase means more runway
before the next nudge. A manual rate (set directly, e.g. "every 10 days") is
quantity-blind by design, and is never silently overwritten by the learned
calculation even once enough history exists to compute one.

Every Sunday at 5pm NZ time, staples-host checks every staple's restock rate
and posts straight to Discord (via a webhook) listing anything projected to
run out within the next 7 days — it always posts, including a "nothing due
this week" message when the list is empty, so a quiet week reads as
confirmed-empty rather than a silently broken check.

**Known limitation:** this proactive weekly nudge only works via Discord.
There's no mechanism for an MCP server to push a message into an idle Claude
mobile/desktop conversation, so a webhook is the only delivery path for now —
not a bug, just something Claude mobile/desktop can't currently do.

The on-demand alternative works from either front end: ask "what needs
restocking" anytime (Discord or Claude mobile) to get the same 7-day-runway
list on demand, using the exact same calculation as the weekly push.

## Suggestions and purchase history

When you ask for something like "add cheese," the recommendation depends on
what's known about it. If you've bought it before, it recommends whichever
option you buy most often, marks it ✅, and separately notes anything already
in your cart:

![Alternatives ranked from purchase history, with a recommended pick](docs/alternatives-with-purchase-history.png)

If you haven't, it bases alternatives on anything related already in your
cart, or falls back to a general search if not — just a plain numbered list,
nothing marked, since there's no real signal to recommend one over another:

![Alternatives from a plain search, no purchase history to rank from](docs/alternatives-no-history.png)

Either way, it always includes a best-value pick — the cheapest price-per-unit
option of that type — regardless of which path found the recommendation.

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
