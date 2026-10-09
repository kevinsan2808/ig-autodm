// Persistence for rules, stats and contacts.
// Uses Supabase (free Postgres) when SUPABASE_URL + SUPABASE_KEY are set, so
// nothing is lost when the free host restarts. Otherwise falls back to local
// JSON files (fine for testing, but wiped on every redeploy).

const fs = require('fs');
const path = require('path');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
// Strip stray spaces/line breaks that sneak in when the key is pasted.
const SB_KEY = (process.env.SUPABASE_KEY || '').replace(/\s+/g, '');
const useSupabase = !!(SB_URL && SB_KEY);

const DATA_DIR = path.join(__dirname, 'data');
const KV_FILE = path.join(DATA_DIR, 'kv.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');

// ---------- Supabase REST helper ----------

async function sb(pathAndQuery, { method = 'GET', body, prefer } = {}) {
  let res;
  try {
    res = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
      method,
      headers: {
        apikey: SB_KEY,
        // Legacy keys are JWTs and also go in Authorization; new sb_secret_ keys only use apikey.
        ...(SB_KEY.startsWith('eyJ') ? { Authorization: `Bearer ${SB_KEY}` } : {}),
        'Content-Type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    // Never let the key end up in logs via an error message.
    throw new Error(`Supabase request failed: ${e.message.split(SB_KEY).join('[key]')}`.replace(/sb_secret_\S+/g, '[key]'));
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// ---------- local JSON fallback ----------

function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return fallback;
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data));
  } catch {}
}

const localKv = readJson(KV_FILE, {});
const localContacts = readJson(CONTACTS_FILE, {});

// ---------- key/value (rules, stats) ----------

async function getKV(key) {
  if (!useSupabase) return localKv[key] ?? null;
  const rows = await sb(`kv?key=eq.${encodeURIComponent(key)}&select=value`);
  return rows && rows[0] ? rows[0].value : null;
}

async function setKV(key, value) {
  if (!useSupabase) {
    localKv[key] = value;
    writeJson(KV_FILE, localKv);
    return;
  }
  await sb('kv', {
    method: 'POST',
    body: { key, value, updated_at: new Date().toISOString() },
    prefer: 'resolution=merge-duplicates',
  });
}

// ---------- contacts ----------

async function getContact(id) {
  id = String(id);
  if (!useSupabase) return localContacts[id] || null;
  const rows = await sb(`contacts?id=eq.${encodeURIComponent(id)}&select=*`);
  return rows && rows[0] ? rows[0] : null;
}

async function saveContact(contact) {
  contact.id = String(contact.id);
  if (!useSupabase) {
    localContacts[contact.id] = contact;
    writeJson(CONTACTS_FILE, localContacts);
    return;
  }
  await sb('contacts', { method: 'POST', body: contact, prefer: 'resolution=merge-duplicates' });
}

async function listContacts({ search = '', limit = 2000 } = {}) {
  const q = search.trim().toLowerCase();
  if (!useSupabase) {
    return Object.values(localContacts)
      .filter((c) => !q || (c.username || '').toLowerCase().includes(q))
      .sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)))
      .slice(0, limit);
  }
  const filter = q ? `&username=ilike.*${encodeURIComponent(q)}*` : '';
  return sb(
    `contacts?select=id,username,first_seen,last_seen,comments,dms,keywords,posts,follows,last_text` +
      `${filter}&order=last_seen.desc&limit=${limit}`
  );
}

// ---------- funnel events ----------
// One row per step (comment matched, DM sent, link sent…) with the reel it came from,
// so Reel Lab can show reel → comment → DM → link → click. Never blocks a reply:
// if the dm_events table is missing the error is reported once and logging stops.

let eventsDisabled = false;

async function logEvent(row) {
  if (!useSupabase || eventsDisabled) return;
  try {
    await sb('dm_events', { method: 'POST', body: row, prefer: 'return=minimal' });
  } catch (e) {
    if (/dm_events/.test(e.message)) eventsDisabled = true;
    console.error(`[events] ${e.message}${eventsDisabled ? ' (event logging turned off until restart)' : ''}`);
  }
}

module.exports = { useSupabase, getKV, setKV, getContact, saveContact, listContacts, logEvent };
