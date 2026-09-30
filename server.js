// AutoDM — self-hosted Instagram comment-to-DM automation
// Uses the official Instagram API with Instagram Login (graph.instagram.com)

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const GRAPH = 'https://graph.instagram.com/v23.0';
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || '';
const APP_SECRET = process.env.APP_SECRET || '';
const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const RULES_FILE = path.join(__dirname, 'rules.json');

const DEFAULT_PERSONA =
  'You are the friendly assistant replying on behalf of an Instagram creator. ' +
  'Be warm, casual and helpful. Nudge people to follow and to check the link when relevant, ' +
  'but never sound like a pushy salesperson.';

let accessToken = process.env.IG_ACCESS_TOKEN || '';
let selfIds = new Set(); // our own account ids, so we never reply to ourselves
let selfUsername = '';
let rules = { commentRules: [], dmRules: [], ai: { enabled: false, model: 'gemini-3.6-flash', persona: DEFAULT_PERSONA } };

const DEFAULT_GATE_BUTTON = 'Send me the link 🔗';
const DEFAULT_NOT_FOLLOWING =
  "Looks like you're not following me yet 👀 Follow @{{me}} then tap the button again and I'll send it right over!";

// ---------- rules storage ----------

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

function normalizeRules() {
  if (!Array.isArray(rules.commentRules)) rules.commentRules = [];
  if (!Array.isArray(rules.dmRules)) rules.dmRules = [];
  for (const r of [...rules.commentRules, ...rules.dmRules]) {
    if (!r.id) r.id = newId();
  }
  if (!rules.settings || typeof rules.settings !== 'object') rules.settings = {};
  if (typeof rules.settings.cooldownHours !== 'number') rules.settings.cooldownHours = 24;
  if (!rules.ai || typeof rules.ai !== 'object') rules.ai = {};
  if (typeof rules.ai.enabled !== 'boolean') rules.ai.enabled = false;
  if (!rules.ai.model) rules.ai.model = 'gemini-3.6-flash';
  if (!rules.ai.persona) rules.ai.persona = DEFAULT_PERSONA;
  if (typeof rules.ai.goal !== 'string') rules.ai.goal = '';
  if (!rules.ai.humanDelay || typeof rules.ai.humanDelay !== 'object') rules.ai.humanDelay = {};
  if (typeof rules.ai.humanDelay.enabled !== 'boolean') rules.ai.humanDelay.enabled = true;
  if (typeof rules.ai.humanDelay.minSec !== 'number') rules.ai.humanDelay.minSec = 40;
  if (typeof rules.ai.humanDelay.maxSec !== 'number') rules.ai.humanDelay.maxSec = 180;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Wait a random human-like pause before replying (so it never feels like an instant bot).
async function humanPause() {
  const d = rules.ai && rules.ai.humanDelay;
  if (!d || !d.enabled) return;
  const min = Math.max(0, d.minSec || 0);
  const max = Math.max(min, d.maxSec || min);
  const secs = min + Math.random() * (max - min);
  if (secs > 0) await sleep(secs * 1000);
}

// Wait a random time between a rule's min and max seconds (e.g. "DM them ~1 min after they comment").
async function rulePause(rule) {
  const min = Math.max(0, Number(rule.delayMin) || 0);
  const max = Math.max(min, Number(rule.delayMax) || 0);
  const secs = min + Math.random() * (max - min);
  if (secs > 0) await sleep(secs * 1000);
}

// Rules are kept in the database when one is configured, so they survive restarts.
async function loadRules() {
  if (store.useSupabase) {
    try {
      const saved = await store.getKV('rules');
      if (saved) {
        rules = saved;
        normalizeRules();
        return;
      }
    } catch (e) {
      log('error', `Could not load rules from database: ${e.message}`);
    }
  }
  try {
    if (fs.existsSync(RULES_FILE)) {
      rules = JSON.parse(fs.readFileSync(RULES_FILE, 'utf8'));
      normalizeRules();
      return;
    }
  } catch (e) {
    log('error', `Could not read rules.json: ${e.message}`);
  }
  if (process.env.RULES_JSON) {
    try {
      rules = JSON.parse(process.env.RULES_JSON);
      normalizeRules();
      return;
    } catch (e) {
      log('error', `RULES_JSON env var is not valid JSON: ${e.message}`);
    }
  }
  normalizeRules();
}

async function saveRules() {
  try {
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
  } catch (e) {
    log('error', `Could not save rules.json: ${e.message}`);
  }
  if (store.useSupabase) {
    try {
      await store.setKV('rules', rules);
    } catch (e) {
      log('error', `Could not save rules to database: ${e.message}`);
    }
  }
}

// ---------- per-rule stats ----------

let stats = {}; // ruleId -> { triggered, dmSent, linkSent, notFollowing, cooldown }
let statsTimer = null;

async function loadStats() {
  try {
    stats = (await store.getKV('stats')) || {};
  } catch (e) {
    log('error', `Could not load stats: ${e.message}`);
  }
}

function bump(ruleId, field) {
  if (!ruleId) return;
  const s = (stats[ruleId] = stats[ruleId] || {});
  s[field] = (s[field] || 0) + 1;
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    store.setKV('stats', stats).catch((e) => log('error', `Could not save stats: ${e.message}`));
  }, 3000);
}

// ---------- contacts ----------

// Load (or create) a contact, apply `update`, save it. Never lets a database
// problem stop a reply from going out.
async function touchContact(id, username, update) {
  let c = null;
  try {
    c = await store.getContact(id);
  } catch (e) {
    log('error', `Could not load contact: ${e.message}`);
  }
  const now = new Date().toISOString();
  c = c || { id: String(id), first_seen: now, comments: 0, dms: 0, keywords: [], posts: [], last_dm_at: {} };
  if (username) c.username = username;
  c.last_seen = now;
  if (!c.last_dm_at) c.last_dm_at = {};
  if (update) update(c);
  try {
    await store.saveContact(c);
  } catch (e) {
    log('error', `Could not save contact: ${e.message}`);
  }
  return c;
}

function addUnique(list, value) {
  const arr = Array.isArray(list) ? list : [];
  if (value && !arr.includes(value)) arr.push(value);
  return arr.slice(-50);
}

// ---------- activity log (shown in dashboard) ----------

const activity = [];
function log(type, detail) {
  const entry = { time: new Date().toISOString(), type, detail };
  activity.unshift(entry);
  if (activity.length > 100) activity.pop();
  console.log(`[${entry.time}] ${type}: ${detail}`);
}

// ---------- Instagram API helpers ----------

async function igFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error ? data.error.message : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function fetchSelf() {
  if (!accessToken) {
    log('warn', 'No IG_ACCESS_TOKEN set yet — set it in your environment variables.');
    return;
  }
  try {
    const me = await igFetch(`${GRAPH}/me?fields=user_id,username`);
    selfIds = new Set([String(me.id), String(me.user_id)].filter(Boolean));
    selfUsername = me.username || '';
    log('info', `Connected as @${selfUsername}`);
  } catch (e) {
    log('error', `Could not verify access token: ${e.message}`);
  }
}

// `button` (optional) = { title, payload } shown as a tap-to-reply quick reply.
// If Instagram rejects the button, resend as plain text asking them to reply instead.
async function sendMessage(recipient, text, button) {
  const message = { text };
  if (button) message.quick_replies = [{ content_type: 'text', title: button.title.slice(0, 20), payload: button.payload }];
  try {
    return await igFetch(`${GRAPH}/me/messages`, { method: 'POST', body: JSON.stringify({ recipient, message }) });
  } catch (e) {
    if (!button) throw e;
    log('warn', `Button not accepted (${e.message}); sending plain text instead.`);
    return igFetch(`${GRAPH}/me/messages`, {
      method: 'POST',
      body: JSON.stringify({ recipient, message: { text: `${text}\n\n👉 Reply "ok" and I'll send it!` } }),
    });
  }
}

async function sendPrivateReply(commentId, text, button) {
  return sendMessage({ comment_id: commentId }, text, button);
}

async function sendDM(userId, text, button) {
  return sendMessage({ id: userId }, text, button);
}

// Only works after the person has messaged us or tapped a button (Meta's consent rule).
async function checkFollows(userId) {
  try {
    const u = await igFetch(`${GRAPH}/${userId}?fields=username,is_user_follow_business`);
    return { ok: true, follows: !!u.is_user_follow_business, username: u.username || '' };
  } catch (e) {
    log('warn', `Could not check follow status: ${e.message}`);
    return { ok: false };
  }
}

async function sendPublicReply(commentId, text) {
  return igFetch(`${GRAPH}/${commentId}/replies`, {
    method: 'POST',
    body: JSON.stringify({ message: text }),
  });
}

async function fetchUsername(userId) {
  try {
    const u = await igFetch(`${GRAPH}/${userId}?fields=username`);
    return u.username || '';
  } catch {
    return '';
  }
}

// Long-lived tokens last 60 days; refresh daily to keep them alive.
async function refreshToken() {
  if (!accessToken) return;
  try {
    const res = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(accessToken)}`
    );
    const data = await res.json();
    if (data.access_token) {
      accessToken = data.access_token;
      log('info', 'Access token refreshed (valid for another 60 days).');
    } else if (data.error) {
      log('warn', `Token refresh skipped: ${data.error.message}`);
    }
  } catch (e) {
    log('warn', `Token refresh failed: ${e.message}`);
  }
}

// ---------- keyword matching ----------

function fillTemplate(text, username, rule) {
  return (text || '')
    .replaceAll('{{username}}', username || 'there')
    .replaceAll('{{me}}', selfUsername || 'me')
    .replaceAll('{{link}}', (rule && rule.link) || '');
}

// Pick one random variant so replies don't all look identical.
// DM variants are separated by a line containing only ---; public replies are one per line.
function pickVariant(text, separator) {
  const parts = (text || '')
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts[Math.floor(Math.random() * parts.length)] : '';
}
const DM_SEPARATOR = /^\s*---\s*$/m;
const LINE_SEPARATOR = /\r?\n/;

// ---------- conversation memory ----------
// Remembers the last messages exchanged with each person so the AI can carry a
// multi-turn conversation toward the goal. Kept in memory (resets if the free
// host spins the service down after long inactivity — fine for active chats).
const convos = new Map(); // userId -> [{ role: 'user'|'assistant', text }]
const CONVO_MAX = 24;

function convoHistory(userId) {
  return convos.get(String(userId)) || [];
}
function convoPush(userId, role, text) {
  const key = String(userId);
  const hist = convos.get(key) || [];
  hist.push({ role, text });
  convos.set(key, hist.slice(-CONVO_MAX));
  if (convos.size > 3000) convos.delete(convos.keys().next().value);
}

// ---------- AI replies (Gemini) ----------

// Ask Gemini to write a natural reply. `history` is the running conversation
// ([{role,text}...], oldest first). `instruction` is the rule's own text, used
// as extra guidance for this specific reply.
async function aiReply({ history, username, instruction }) {
  const model = (rules.ai && rules.ai.model) || 'gemini-3.6-flash';
  const persona = (rules.ai && rules.ai.persona) || DEFAULT_PERSONA;
  const goal = (rules.ai && rules.ai.goal) || '';
  const system =
    `${persona}\n\n` +
    (goal ? `Your goal across the whole conversation:\n${goal}\n\n` : '') +
    'How to steer every conversation:\n' +
    '- First, genuinely read and respond to what they actually said — never ignore it, or you sound like a robot.\n' +
    '- Then, no matter what topic they bring up, smoothly bridge back toward the goal. Acknowledge their point, then connect it to what you offer. Always be moving the conversation one small step closer to the goal.\n' +
    '- Be persuasive the natural way: ask questions, spark curiosity, relate to them, highlight what is in it for them. Never beg, never hard-sell, never sound scripted.\n' +
    '- If they resist or go cold, do not push harder — stay friendly, plant one hook, and leave the door open.\n\n' +
    'Hard rules for every reply:\n' +
    '- Reply in the SAME language the person wrote in.\n' +
    '- Sound like a real person texting a friend: short, natural, casual. Usually 1-2 sentences.\n' +
    '- Use the conversation history: never repeat yourself, and advance the goal step by step — do not dump everything at once.\n' +
    '- Only share a link or an offer once it fits naturally, ideally after they show some interest.\n' +
    '- Never reveal that you are an AI or an automated bot; you ARE the creator.\n' +
    '- Do not invent facts, prices, or promises you were not given.\n' +
    `- The person's username is @${username || 'there'}.` +
    (instruction ? `\n\nExtra instruction for THIS reply:\n${instruction}` : '');

  const contents = (history && history.length ? history : [{ role: 'user', text: '(no text)' }]).map(
    (m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.text || '' }] })
  );

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents,
      // gemini-3.x "thinks" before answering and thinking shares this budget, so
      // keep it high enough that the actual reply is never truncated.
      generationConfig: { temperature: 0.8, maxOutputTokens: 1200 },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ? data.error.message : `Gemini HTTP ${res.status}`);
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('').trim();
  if (!text) throw new Error('Gemini returned no text');
  return text;
}

// Decide what to actually send for a rule + field. Uses AI when the rule opts in
// and AI is configured; otherwise (or on any AI error) falls back to the template.
// Pass `history` for multi-turn DMs; comments pass a single `incoming` message.
async function resolveReply(rule, field, { incoming, username, history }) {
  const template = fillTemplate(pickVariant(rule[field], DM_SEPARATOR), username, rule);
  const useAi = rule.useAi && rules.ai && rules.ai.enabled && GEMINI_API_KEY;
  if (!useAi) return template;
  try {
    const hist = history && history.length ? history : [{ role: 'user', text: incoming || '' }];
    return await aiReply({ history: hist, username, instruction: rule[field] || '' });
  } catch (e) {
    log('warn', `AI reply failed (${e.message}); using template instead.`);
    return template;
  }
}

// Keyword rules win over catch-all ("any") rules.
function matchRule(ruleList, text, mediaId) {
  const t = (text || '').toLowerCase().trim();
  const candidates = (ruleList || []).filter(
    (r) => r.enabled !== false && (!r.mediaId || String(r.mediaId) === String(mediaId || ''))
  );
  for (const r of candidates) {
    if (r.matchType === 'any') continue;
    const kw = (r.keyword || '').toLowerCase().trim();
    if (!kw) continue;
    if (r.matchType === 'exact' ? t === kw : t.includes(kw)) return r;
  }
  return candidates.find((r) => r.matchType === 'any') || null;
}

// ---------- webhook handling ----------

const seen = new Set(); // dedupe: Meta retries webhooks
function alreadySeen(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 5000) {
    const first = seen.values().next().value;
    seen.delete(first);
  }
  return false;
}

async function handleComment(value) {
  const commentId = value.id;
  const from = value.from || {};
  const text = value.text || '';
  const mediaId = value.media ? value.media.id : '';

  if (alreadySeen(commentId)) return;
  if (selfIds.has(String(from.id))) return; // our own comment (e.g. our public reply)

  const rule = matchRule(rules.commentRules, text, mediaId);
  if (!rule) {
    log('skip', `Comment from @${from.username || from.id} matched no rule: "${text.slice(0, 60)}"`);
    return;
  }

  const username = from.username || '';
  const who = `@${username || from.id}`;
  const ruleName = rule.name || rule.keyword || 'catch-all';
  bump(rule.id, 'triggered');

  // Cooldown: don't DM the same person for the same rule again too soon.
  const contact = await touchContact(from.id, username, (c) => {
    c.comments = (c.comments || 0) + 1;
    c.keywords = addUnique(c.keywords, rule.keyword || ruleName);
    c.posts = addUnique(c.posts, mediaId);
    c.last_text = text.slice(0, 300);
  });
  const hours = Number(rules.settings.cooldownHours) || 0;
  const last = contact.last_dm_at[rule.id];
  if (hours > 0 && last && Date.now() - Date.parse(last) < hours * 3600 * 1000) {
    bump(rule.id, 'cooldown');
    log('skip', `${who} already got "${ruleName}" in the last ${hours}h — skipped`);
    return;
  }

  const aiOn = rule.useAi && rules.ai && rules.ai.enabled;
  // e.g. wait ~1 min so it doesn't feel instant; older AI rules without their own delay use the AI one
  if (rule.delayMax === undefined && aiOn) await humanPause();
  else await rulePause(rule);
  if (rule.dmMessage || aiOn) {
    try {
      const dmText = await resolveReply(rule, 'dmMessage', { incoming: text, username });
      if (dmText) {
        const button = rule.requireFollow
          ? { title: rule.gateButton || DEFAULT_GATE_BUTTON, payload: `GATE:${rule.id}` }
          : null;
        await sendPrivateReply(commentId, dmText, button);
        bump(rule.id, 'dmSent');
        await touchContact(from.id, username, (c) => {
          c.last_dm_at[rule.id] = new Date().toISOString();
          if (rule.requireFollow) c.pending = { ruleId: rule.id, at: new Date().toISOString() };
        });
        log('dm', `DM sent to ${who} (rule "${ruleName}"${aiOn ? ', AI' : ''}${rule.requireFollow ? ', follow-gated' : ''})`);
      }
    } catch (e) {
      log('error', `DM to ${who} failed: ${e.message}`);
    }
  }
  const publicText = pickVariant(rule.publicReply, LINE_SEPARATOR);
  if (publicText) {
    try {
      await sendPublicReply(commentId, fillTemplate(publicText, username, rule));
      log('reply', `Public reply posted under ${who}'s comment`);
    } catch (e) {
      log('error', `Public reply failed: ${e.message}`);
    }
  }
}

// Follow gate: the person tapped the button (or replied) after a follow-gated DM.
// Send the link if they follow us, otherwise ask them to follow and tap again.
async function handleGate(senderId, ruleId) {
  const rule = rules.commentRules.find((r) => r.id === ruleId);
  if (!rule) return;
  const check = await checkFollows(senderId);
  const username = check.username || '';
  const who = `@${username || senderId}`;
  // If Instagram won't tell us, send the link anyway rather than leave them stuck.
  if (!check.ok || check.follows) {
    const linkText = fillTemplate(pickVariant(rule.linkMessage, DM_SEPARATOR), username, rule);
    if (linkText) await sendDM(senderId, linkText);
    bump(rule.id, 'linkSent');
    await touchContact(senderId, username, (c) => {
      c.pending = null;
      if (check.ok) c.follows = true;
      c.dms = (c.dms || 0) + 1;
    });
    log('dm', `Link sent to ${who} (rule "${rule.name || rule.keyword}"${check.ok ? ', follows ✅' : ', follow status unknown'})`);
  } else {
    const nudge = fillTemplate(pickVariant(rule.notFollowingMessage || DEFAULT_NOT_FOLLOWING, DM_SEPARATOR), username, rule);
    await sendDM(senderId, nudge, { title: rule.gateButton || DEFAULT_GATE_BUTTON, payload: `GATE:${rule.id}` });
    bump(rule.id, 'notFollowing');
    await touchContact(senderId, username, (c) => {
      c.follows = false;
      c.dms = (c.dms || 0) + 1;
    });
    log('dm', `${who} isn't following yet — asked them to follow first`);
  }
}

async function handleMessage(event) {
  const msg = event.message;
  const postback = event.postback;
  if (msg && msg.is_echo) return; // our own sent messages
  if (!msg && !postback) return; // reads, reactions, etc.
  const senderId = event.sender && event.sender.id;
  if (!senderId || selfIds.has(String(senderId))) return;
  if (alreadySeen((msg && msg.mid) || (postback && postback.mid))) return;

  // Button tap or any reply from someone waiting on a follow-gated link
  const payload = (postback && postback.payload) || (msg && msg.quick_reply && msg.quick_reply.payload) || '';
  let gateRuleId = payload.startsWith('GATE:') ? payload.slice(5) : '';
  if (!gateRuleId) {
    let c = null;
    try {
      c = await store.getContact(senderId);
    } catch {}
    const pendingAge = c && c.pending ? Date.now() - Date.parse(c.pending.at) : Infinity;
    if (pendingAge < 7 * 24 * 3600 * 1000) gateRuleId = c.pending.ruleId;
  }
  if (gateRuleId) {
    try {
      await handleGate(senderId, gateRuleId);
    } catch (e) {
      log('error', `Follow-gate reply to ${senderId} failed: ${e.message}`);
    }
    return;
  }
  if (!msg) return;

  const rule = matchRule(rules.dmRules, msg.text || '');
  const username = await fetchUsername(senderId);
  await touchContact(senderId, username, (c) => {
    c.dms = (c.dms || 0) + 1;
    if (msg.text) c.last_text = msg.text.slice(0, 300);
  });
  if (!rule) return;
  bump(rule.id, 'triggered');
  const aiOn = rule.useAi && rules.ai && rules.ai.enabled;
  if (aiOn && (msg.text || '').trim()) convoPush(senderId, 'user', msg.text);
  try {
    const replyText = await resolveReply(rule, 'reply', {
      incoming: msg.text || '',
      username,
      history: aiOn ? convoHistory(senderId) : null,
    });
    if (!replyText) return;
    if (aiOn) await humanPause(); // human-like pause so it doesn't feel like an instant bot
    await sendDM(senderId, replyText);
    bump(rule.id, 'dmSent');
    if (aiOn) convoPush(senderId, 'assistant', replyText);
    log('dm', `Auto-replied to DM from @${username || senderId} (rule "${rule.name || rule.keyword || 'catch-all'}"${aiOn ? ', AI' : ''})`);
  } catch (e) {
    log('error', `DM auto-reply to @${username || senderId} failed: ${e.message}`);
  }
}

function verifySignature(req) {
  if (!APP_SECRET) return true; // signature check disabled until APP_SECRET is set
  const sig = req.get('x-hub-signature-256');
  if (!sig || !req.rawBody) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ---------- express app ----------

const app = express();
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.static(path.join(__dirname, 'public')));

// Serve the dashboard at the root URL too (so "/" works, not just "/dashboard.html")
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

app.get('/health', (req, res) => res.send('ok'));

// Meta webhook verification handshake
app.get('/webhook', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === VERIFY_TOKEN) {
    log('info', 'Webhook verified by Meta ✅');
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

app.post('/webhook', (req, res) => {
  res.sendStatus(200); // acknowledge immediately; Meta requires a fast response
  // DEBUG: log every incoming webhook POST so we can see if Instagram is sending anything at all
  log('webhook', `Incoming POST: ${JSON.stringify(req.body || {}).slice(0, 280)}`);
  if (!verifySignature(req)) {
    log('warn', 'Webhook dropped: signature mismatch (check APP_SECRET).');
    return;
  }
  const body = req.body || {};
  if (body.object !== 'instagram') return;
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field === 'comments') {
        handleComment(change.value || {}).catch((e) => log('error', e.message));
      }
    }
    for (const event of entry.messaging || []) {
      handleMessage(event).catch((e) => log('error', e.message));
    }
  }
});

// ---------- dashboard API ----------

function auth(req, res, next) {
  if (!DASHBOARD_PASSWORD) {
    return res.status(500).json({ error: 'Set the DASHBOARD_PASSWORD environment variable first.' });
  }
  if (req.get('x-dashboard-password') !== DASHBOARD_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  next();
}

app.get('/api/status', auth, async (req, res) => {
  res.json({
    connected: selfIds.size > 0,
    username: selfUsername,
    tokenSet: !!accessToken,
    aiKeySet: !!GEMINI_API_KEY,
    database: store.useSupabase,
    stats,
    activity: activity.slice(0, 50),
  });
});

// Recent posts/reels so the dashboard can show a "pick a video" grid instead of raw IDs.
app.get('/api/media', auth, async (req, res) => {
  try {
    const data = await igFetch(
      `${GRAPH}/me/media?fields=id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp&limit=30`
    );
    res.json(data.data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/contacts', auth, async (req, res) => {
  try {
    res.json(await store.listContacts({ search: String(req.query.q || '') }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Find one of our posts from its Instagram link (reel/post URL), paging back through older posts.
app.get('/api/media/resolve', auth, async (req, res) => {
  const m = String(req.query.url || '').match(/instagram\.com\/(?:[^/]+\/)?(?:reels?|p|tv)\/([A-Za-z0-9_-]+)/);
  if (!m) return res.status(400).json({ error: 'Link không hợp lệ' });
  const code = m[1];
  try {
    let url = `${GRAPH}/me/media?fields=id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp&limit=50`;
    for (let page = 0; url && page < 20; page++) {
      const data = await igFetch(url);
      const found = (data.data || []).find((x) => (x.permalink || '').includes(`/${code}`));
      if (found) return res.json(found);
      url = data.paging && data.paging.next;
    }
    res.status(404).json({ error: 'Không tìm thấy video này trong tài khoản của bạn' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/rules', auth, (req, res) => res.json(rules));

app.put('/api/rules', auth, async (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.commentRules) || !Array.isArray(body.dmRules)) {
    return res.status(400).json({ error: 'Invalid rules format' });
  }
  rules = body;
  normalizeRules();
  await saveRules();
  log('info', 'Rules updated via dashboard');
  res.json({ ok: true, rules });
});

// One-click: tell Meta to send this account's comments & messages to our webhook
app.post('/api/subscribe', auth, async (req, res) => {
  try {
    await igFetch(`${GRAPH}/me/subscribed_apps?subscribed_fields=comments,messages,messaging_postbacks`, {
      method: 'POST',
    });
    log('info', 'Account subscribed to webhooks (comments + messages) ✅');
    res.json({ ok: true });
  } catch (e) {
    log('error', `Subscribe failed: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// Retry connecting after the token env var is updated
app.post('/api/reconnect', auth, async (req, res) => {
  await fetchSelf();
  res.json({ connected: selfIds.size > 0, username: selfUsername });
});

// ---------- boot ----------

(async () => {
  await loadRules();
  await loadStats();
  app.listen(PORT, () => {
    log('info', `AutoDM running on port ${PORT} (storage: ${store.useSupabase ? 'Supabase database' : 'local files — resets on redeploy'})`);
    fetchSelf();
    setInterval(refreshToken, 24 * 60 * 60 * 1000); // refresh token daily
  });
})();
