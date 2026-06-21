/**
 * EVA Oracle → Notion (HABITAT) serverless bridge.
 *
 * A Cloudflare Worker that receives a finished reading from oracle.html and
 * writes it into TODAY's HABITAT day-row:
 *   - links each Celtic Cross card to its 🃏 GOLD FOIL TAROT page (relation),
 *   - sets the matching orientation (Card Read I–X = Upright / Reversed),
 *   - appends the full reading to the page body.
 *
 * The integration token is held here as a secret — never in the client HTML.
 *
 * Setup + deploy steps live in ../NOTION_SETUP.md.
 */

// ─── Config ────────────────────────────────────────────────────────────────
// Database IDs (from the page URLs). Override here if Notion reports a mismatch.
const HABITAT_DB_ID   = '19c6ae29-a07c-8188-a5b4-ec2df445bb6b';
const GOLDFOIL_DB_ID  = '1a06ae29-a07c-8049-a82f-de7066e0fcda';
const WILDMYSTIC_DB_ID = '2c16ae29-a07c-8078-863a-000be4d9ced0'; // optional; '' to disable

const NOTION_VERSION = '2022-06-28';
const TIMEZONE = 'America/New_York'; // used to decide which day is "today"

// Allowed browser origins (CORS). Add your GitHub Pages origin.
const ALLOWED_ORIGINS = [
  'https://dwinomarll.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

// HABITAT property names — must match the schema EXACTLY (note the double
// space in "8.  External Influences:").
const CC_RELATION_PROPS = [
  '1. Present / Significator:',
  '2. Challenge / Crossing:',
  '3. Below / Foundation:',
  '4. Past / Recent past:',
  '5. Above / Conscious:',
  '6. The Near Future:',
  '7. You / Your Attitude:',
  '8.  External Influences:',
  '9. Hopes and Fears:',
  '10. Outcome / Likely Result:',
];
const CC_ORIENTATION_PROPS = [
  'Card Read I', 'Card Read II', 'Card Read III', 'Card Read IV', 'Card Read V',
  'Card Read VI', 'Card Read VII', 'Card Read VIII', 'Card Read IX', 'Card Read X',
];

// Manual overrides for card names the normalizer can't reconcile.
// key = normalized app name (see normName), value = exact GOLD FOIL TAROT page title.
const CARD_OVERRIDES = {
  // 'STRENGTH': 'FORTITUDE',
};

// ─── Worker entry ────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), origin);
    if (request.method === 'GET')     return cors(json({ ok: true, service: 'eva-oracle-notion' }), origin);
    if (request.method !== 'POST')    return cors(json({ ok: false, error: 'Method not allowed' }, 405), origin);

    if (!env.NOTION_TOKEN) return cors(json({ ok: false, error: 'NOTION_TOKEN secret not set' }, 500), origin);

    let reading;
    try { reading = await request.json(); }
    catch { return cors(json({ ok: false, error: 'Invalid JSON body' }, 400), origin); }
    if (!reading || !reading.spread) return cors(json({ ok: false, error: 'Missing reading' }, 400), origin);

    try {
      const result = await saveReading(reading, env.NOTION_TOKEN);
      return cors(json({ ok: true, ...result }), origin);
    } catch (err) {
      return cors(json({ ok: false, error: String(err && err.message || err) }, 502), origin);
    }
  },
};

// ─── Core ────────────────────────────────────────────────────────────────────
async function saveReading(reading, token) {
  const api = notionClient(token);

  // 1. Find (or create) today's HABITAT row.
  const today = todayInTz(TIMEZONE);
  const page = await findOrCreateTodayRow(api, today);

  // 2. Build a normalized card-title → pageId index from GOLD FOIL TAROT.
  const cardIndex = await buildCardIndex(api, GOLDFOIL_DB_ID);

  // 3. Assemble property updates.
  const props = {};
  const matched = [];
  const unmatched = [];

  const cards = Array.isArray(reading.cards) ? reading.cards : [];
  const isCeltic = /celtic/i.test(reading.spread);

  cards.forEach((card, i) => {
    // Celtic Cross maps 1:1 by order; other spreads map by position name.
    const slot = isCeltic ? i : slotForPosition(card.position);
    if (slot == null || slot < 0 || slot > 9) return;

    if (CC_ORIENTATION_PROPS[slot]) {
      props[CC_ORIENTATION_PROPS[slot]] = { select: { name: card.reversed ? 'Reversed' : 'Upright' } };
    }
    const pid = lookupCard(cardIndex, card.name);
    if (pid) {
      props[CC_RELATION_PROPS[slot]] = { relation: [{ id: pid }] };
      matched.push(card.name);
    } else {
      unmatched.push(card.name);
    }
  });

  // Wild Mystic reading → link the WILD MYSTICS relation.
  if (reading.kind === 'mystic' && reading.animal && WILDMYSTIC_DB_ID) {
    try {
      const mysticIndex = await buildCardIndex(api, WILDMYSTIC_DB_ID);
      const mid = lookupCard(mysticIndex, reading.animal);
      if (mid) props['WILD MYSTICS'] = { relation: [{ id: mid }] };
    } catch { /* non-fatal */ }
  }

  if (Object.keys(props).length) {
    await api(`/pages/${page.id}`, 'PATCH', { properties: props });
  }

  // 4. Append the full reading to the page body.
  await api(`/blocks/${page.id}/children`, 'PATCH', { children: readingBlocks(reading, today) });

  return { pageId: page.id, pageUrl: page.url, created: page._created, matched, unmatched };
}

// Find newest HABITAT row; use it if it was created today, else create a new row.
async function findOrCreateTodayRow(api, today) {
  const q = await api(`/databases/${HABITAT_DB_ID}/query`, 'POST', {
    page_size: 5,
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
  });
  const newest = (q.results || [])[0];
  if (newest) {
    const created = dateInTz(newest.created_time, TIMEZONE);
    if (created === today) return { id: newest.id, url: newest.url, _created: false };
  }
  // No row for today — create a minimal one (Day title = today's date).
  const created = await api('/pages', 'POST', {
    parent: { database_id: HABITAT_DB_ID },
    properties: { 'Day': { title: [{ text: { content: today } }] } },
  });
  return { id: created.id, url: created.url, _created: true };
}

// Pull every page in a database and index by normalized title.
async function buildCardIndex(api, dbId) {
  const index = {};
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await api(`/databases/${dbId}/query`, 'POST', body);
    for (const pg of res.results || []) {
      const title = titleOf(pg);
      if (title) index[normName(title)] = pg.id;
    }
    cursor = res.has_more ? res.next_cursor : null;
  } while (cursor);
  return index;
}

function lookupCard(index, name) {
  if (!name) return null;
  const key = normName(name);
  if (CARD_OVERRIDES[key]) return index[normName(CARD_OVERRIDES[key])] || null;
  return index[key] || null;
}

// ─── Normalization ───────────────────────────────────────────────────────────
// Handles messy library titles: emojis, mixed case, "T H E   F O O L",
// singular/plural ("Sword" vs "Swords"), stray punctuation/whitespace.
function normName(s) {
  let n = String(s).toUpperCase().replace(/[^A-Z]/g, ''); // drops spaces, digits, emoji, punctuation
  if (n.length > 4 && n.endsWith('S')) n = n.slice(0, -1); // unify singular/plural
  return n;
}

// Map a non-Celtic position label to a HABITAT slot index (0-based), or null.
function slotForPosition(pos) {
  const p = String(pos || '').toLowerCase();
  if (p.includes('present')) return 0;
  if (p.includes('past'))    return 3;
  if (p.includes('future'))  return 5;
  return 0; // single draw → Present
}

// ─── Reading → Notion blocks ─────────────────────────────────────────────────
function readingBlocks(r, today) {
  const blocks = [];
  const h = (t) => blocks.push({ heading_3: { rich_text: [{ text: { content: t } }] } });
  const p = (t) => blocks.push({ paragraph: { rich_text: [{ text: { content: t.slice(0, 1900) } }] } });
  const bullet = (t) => blocks.push({ bulleted_list_item: { rich_text: [{ text: { content: t.slice(0, 1900) } }] } });

  h(`🔮 ${r.spread} — ${today}`);
  if (r.question) p(`🙋 Question: ${r.question}`);

  if (r.kind === 'mystic') {
    p(`${r.emoji || ''} ${r.animal || ''}${r.keyword ? ' — ' + r.keyword : ''}`.trim());
    if (r.body) p(r.body);
    if (r.shadow) p(`✦ Shadow: ${r.shadow}`);
  } else {
    (r.cards || []).forEach((c) => {
      bullet(`${c.position}: ${c.name} (${c.reversed ? 'Reversed ↓' : 'Upright ↑'})`);
      if (c.sage) p(`   ${c.sage}`);
    });
  }
  p('— via EVA Oracle');
  return blocks;
}

// ─── Notion helpers ──────────────────────────────────────────────────────────
function notionClient(token) {
  return async (path, method, body) => {
    const res = await fetch(`https://api.notion.com/v1${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Notion ${res.status}: ${data.message || res.statusText}`);
    return data;
  };
}

function titleOf(page) {
  const props = page.properties || {};
  for (const key in props) {
    if (props[key] && props[key].type === 'title') {
      return (props[key].title || []).map((t) => t.plain_text).join('');
    }
  }
  return '';
}

// ─── Date / TZ helpers ───────────────────────────────────────────────────────
function dateInTz(iso, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso)); // → "YYYY-MM-DD"
}
function todayInTz(tz) { return dateInTz(new Date().toISOString(), tz); }

// ─── HTTP helpers ────────────────────────────────────────────────────────────
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}
function cors(res, origin) {
  const allow = ALLOWED_ORIGINS.some((o) => origin === o || origin.startsWith(o)) ? origin : ALLOWED_ORIGINS[0];
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', allow);
  h.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type');
  h.set('Vary', 'Origin');
  return new Response(res.body, { status: res.status, headers: h });
}
