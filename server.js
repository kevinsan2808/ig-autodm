// AutoDM — self-hosted Instagram comment-to-DM automation
// Uses the official Instagram API with Instagram Login (graph.instagram.com)

const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

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

// ---------- rules storage ----------

function normalizeRules() {
  if (!Array.isArray(rules.commentRules)) rules.commentRules = [];
  if (!Array.isArray(rules.dmRules)) rules.dmRules = [];
  if (!rules.ai || typeof rules.ai !== 'object') rules.ai = {};
  if (typeof rules.ai.enabled !== 'boolean') rules.ai.enabled = false;
  if (!rules.ai.model) rules.ai.model = 'gemini-3.6-flash';
  if (!rules.ai.persona) rules.ai.persona = DEFAULT_PERSONA;
  if (typeof rules.ai.goal !== 'string') rules.ai.goal = '';
}

function loadRules() {
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

function saveRules() {
  try {
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2));
  } catch (e) {
    log('error', `Could not save rules.json: ${e.message}`);
  }
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

async function sendPrivateReply(commentId, text) {
  return igFetch(`${GRAPH}/me/messages`, {
    method: 'POST',
    body: JSON.stringify({ recipient: { comment_id: commentId }, message: { text } }),
  });
}

async function sendDM(userId, text) {
  return igFetch(`${GRAPH}/me/messages`, {
    method: 'POST',
    body: JSON.stringify({ recipient: { id: userId }, message: { text } }),
  });
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

function fillTemplate(text, username) {
  return (text || '').replaceAll('{{username}}', username || 'there');
}

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
    'Hard rules for every reply:\n' +
    '- Reply in the SAME language the person wrote in.\n' +
    '- Sound like a real person texting: short, natural, casual. Usually 1-2 sentences.\n' +
    '- Use the conversation history: never repeat something you already said, and move the goal forward one small step at a time — do not dump everything at once.\n' +
    '- Only share a link or an offer when it fits naturally in the flow.\n' +
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
  const template = fillTemplate(rule[field], username);
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
  const aiOn = rule.useAi && rules.ai && rules.ai.enabled;
  if (rule.dmMessage || aiOn) {
    try {
      const dmText = await resolveReply(rule, 'dmMessage', { incoming: text, username });
      if (dmText) {
        await sendPrivateReply(commentId, dmText);
        log('dm', `DM sent to @${username || from.id} (rule "${rule.name || rule.keyword || 'catch-all'}"${aiOn ? ', AI' : ''})`);
      }
    } catch (e) {
      log('error', `DM to @${username || from.id} failed: ${e.message}`);
    }
  }
  if (rule.publicReply) {
    try {
      await sendPublicReply(commentId, fillTemplate(rule.publicReply, username));
      log('reply', `Public reply posted under @${username || from.id}'s comment`);
    } catch (e) {
      log('error', `Public reply failed: ${e.message}`);
    }
  }
}

async function handleMessage(event) {
  const msg = event.message;
  if (!msg || msg.is_echo) return; // ignore reads, reactions, and our own sent messages
  const senderId = event.sender && event.sender.id;
  if (!senderId || selfIds.has(String(senderId))) return;
  if (alreadySeen(msg.mid)) return;

  const rule = matchRule(rules.dmRules, msg.text || '');
  if (!rule) return;

  const username = await fetchUsername(senderId);
  const aiOn = rule.useAi && rules.ai && rules.ai.enabled;
  if (aiOn && (msg.text || '').trim()) convoPush(senderId, 'user', msg.text);
  try {
    const replyText = await resolveReply(rule, 'reply', {
      incoming: msg.text || '',
      username,
      history: aiOn ? convoHistory(senderId) : null,
    });
    if (!replyText) return;
    await sendDM(senderId, replyText);
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
    activity: activity.slice(0, 50),
  });
});

app.get('/api/rules', auth, (req, res) => res.json(rules));

app.put('/api/rules', auth, (req, res) => {
  const body = req.body;
  if (!body || !Array.isArray(body.commentRules) || !Array.isArray(body.dmRules)) {
    return res.status(400).json({ error: 'Invalid rules format' });
  }
  rules = body;
  normalizeRules();
  saveRules();
  log('info', 'Rules updated via dashboard');
  res.json({ ok: true });
});

// One-click: tell Meta to send this account's comments & messages to our webhook
app.post('/api/subscribe', auth, async (req, res) => {
  try {
    await igFetch(`${GRAPH}/me/subscribed_apps?subscribed_fields=comments,messages`, {
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

loadRules();
app.listen(PORT, () => {
  log('info', `AutoDM running on port ${PORT}`);
  fetchSelf();
  setInterval(refreshToken, 24 * 60 * 60 * 1000); // refresh token daily
});
