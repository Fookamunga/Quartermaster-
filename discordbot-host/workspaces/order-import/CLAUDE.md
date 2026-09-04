# order-import

This channel is for manually backfilling **past** grocery orders into the
household's purchase history — pasted order-confirmation text, partial
item lists, or photos of a receipt/invoice. This is data entry, not a
shopping request: never touch a cart, never call any `mcp__woolies__*` tool
(you don't have any registered in this channel), and never wait for a
confirmation reaction — record what's asked for and reply with a summary.

## Tools

Only native `mcp__staples__*` tools are available here —
`mcp__staples__record_purchase`, `mcp__staples__get_item`, etc.

## Handling Pasted Text

Two real-world formats show up here. Neither is rigid enough for a fixed
parser — read the message and extract items/date the way you'd read any
other messy real-world text.

**1. Full order confirmation**, with a header line like:

```
Order Confirmation/Invoice Number CD47859895 02 Apr, 2026
Deliver To: ...
Ref Description Order No/Item No Ordered Supplied Unit Price Amount
Chocolate, Sweets & Snacks
2 Jack link's beef sticks honey soy 25g 2 ea 2 ea $2.80/ea $5.60
```

Extract the date from the `Order Confirmation/Invoice Number <ID> <DD Mon,
YYYY>` line itself — don't ask the requester for the date separately when
this header is present. Category lines (no leading ref number, e.g.
"Chocolate, Sweets & Snacks") are section headers, not items — skip them.
Item lines carry a `Ref Description Order No/Item No Ordered Supplied Unit
Price Amount` shape, but real pastes from an order-confirmation page/PDF
often lose exact column alignment — use judgment on where the item name
starts and ends, same as you would reading it yourself. Ignore price/
quantity/order-number columns for the purpose of recording a purchase; only
the item name and the header date matter to `record_purchase`.

**2. Shorter or partial pastes** — just a category and item list, no header,
possibly no date anywhere. In that case:

1. Look for a date stated elsewhere in the same message (e.g. "bought this
   on the 3rd", "last Tuesday").
2. If neither a header date nor a stated date is present, use today's date
   (the message timestamp given in the `<messages>` block).

## Handling Photos

If the message mentions an attached image file (a path like
`incoming/<filename>` will be given), base64-encode it with Bash (e.g.
`base64 -w0 incoming/<filename>`) and call `mcp__staples__ingest_receipt`
with the result as `image_base64`, setting `media_type` from the file
extension. Pass a `date` argument only if you found one via the same rules
as the text case above (a stated date, or the header if the photo is of an
order confirmation) — otherwise let `ingest_receipt` default to today.

## Recording Purchases

For each extracted text line item, call:

```
mcp__staples__record_purchase({
  item_name: "<extracted name>",
  date: "<YYYY-MM-DD>",
  source: "receipt_scan",
  raw_ref: "<the original line text, or the order confirmation ID if present>"
})
```

one call per item — `record_purchase` does its own fuzzy-matching against
the tracked staples list. If a call comes back with no match, that item is
**unmatched**: note it, don't retry with a guessed different name, and don't
call any tool to create a new staple for it. (Photos go through
`ingest_receipt` instead, which already does this per-line matching itself
and returns its own matched/unmatched lists.)

When you're done, reply with a plain-text summary: which items were
recorded (grouped by date if the message covered more than one), and which
lines couldn't be matched, so the requester can add those manually via
Craft or a follow-up message. Follow the Discord Formatting rules below.

## Discord Formatting

Do NOT use markdown headings (##) in Discord messages. Only use:

- _Bold_ (asterisks)
- _Italic_ (underscores)
- • Bullets (bullet points)
- `Code blocks` (triple backticks)

Keep messages clean and readable for Discord.
