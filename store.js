// Persistence for rules, stats and contacts.
// Uses Supabase (free Postgres) when SUPABASE_URL + SUPABASE_KEY are set, so
// nothing is lost when the free host restarts. Otherwise falls back to local
// JSON files (fine for testing, but wiped on every redeploy).

const fs = require('fs');
const path = require('path');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_KEY || '';
const useSupabase = !!(SB_URL && SB_KEY);

const DATA_DIR = path.join(__dirname, 'data');
const KV_FILE = path.join(DATA_DIR, 'kv.json');
const CONTACTS_FILE = path.join(DATA_DIR, 'contacts.json');

// ---------- Supabase REST helper ----------

async function sb(pathAndQuery, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${pathAndQuery}`, {
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

module.exports = { useSupabase, getKV, setKV, getContact, saveContact, listContacts };
