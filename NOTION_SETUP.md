# EVA Oracle → Notion (HABITAT) — Setup

Two ways to get a reading into Notion. **Copy** works with zero setup. **Save**
auto-fills today's HABITAT row (cards, orientations, full read) via a free
Cloudflare Worker.

---

## 1. Copy for Notion (no setup)

In a reading, click **📓 Copy for Notion**. It copies the reading as
Notion-friendly markdown and opens your HABITAT database. Open today's entry and
paste (`Cmd/Ctrl+V`) into the page body.

> Pasting fills the page **body** only — not the card relation/orientation
> properties. For those, use **Save** below.

---

## 2. Save to HABITAT (serverless auto-fill)

Writes into **today's** HABITAT day-row: links each Celtic Cross card to its
🃏 GOLD FOIL TAROT page, sets `Card Read I–X` orientation, and appends the full
read to the page body.

### One-time setup (~10 min)

**a. Create a Notion integration + token**
1. https://www.notion.so/my-integrations → **New integration** (internal).
2. Copy the **Internal Integration Secret** (starts with `ntn_` / `secret_`).
   *Keep it private — it never goes in the website.*

**b. Share both databases with the integration**
Open each, **•••  → Connections → Connect to → (your integration)**:
- **HABITAT** — https://app.notion.com/p/19c6ae29a07c8188a5b4ec2df445bb6b
- **🃏 GOLD FOIL TAROT** (the card library the Celtic Cross relations point to)
- (optional) the **WILD MYSTICS** library, for mystic readings

**c. Deploy the Worker**
```bash
cd notion-worker
npm install -g wrangler        # if needed
wrangler login
wrangler secret put NOTION_TOKEN   # paste the integration secret
wrangler deploy
```
Wrangler prints a URL like `https://eva-oracle-notion.<you>.workers.dev`.

**d. Wire the app**
In `oracle.html`, set:
```js
const NOTION_WORKER_URL = 'https://eva-oracle-notion.<you>.workers.dev';
```
Commit + push. Done — **🌙 Save to HABITAT** now appears on readings.

### Verify
1. Do a Celtic Cross draw → **🌙 Save to HABITAT**.
2. Toast shows how many cards linked (e.g. `Saved ✓ 10/10 cards linked`).
3. Open today's HABITAT row: relations + orientations set, full read in the body.
4. Any names in `unmatched` → add them to `CARD_OVERRIDES` in `worker.js`
   (`'NORMALIZEDAPPNAME': 'Exact GOLD FOIL TAROT title'`) and `wrangler deploy`.

### Config (top of `worker.js`)
- `HABITAT_DB_ID`, `GOLDFOIL_DB_ID`, `WILDMYSTIC_DB_ID` — database IDs.
- `ALLOWED_ORIGINS` — add your GitHub Pages origin.
- `TIMEZONE` — which day counts as "today" (default `America/New_York`).
- `CARD_OVERRIDES` — manual fixes for unmatched card names.

### Notes
- The Worker never exposes the token to the browser.
- If `findOrCreateTodayRow` finds no row created today, it creates a minimal new
  HABITAT row (Day = today's date) rather than overwriting an older day.
- If Notion returns a data-source/version error on query, bump `NOTION_VERSION`.
