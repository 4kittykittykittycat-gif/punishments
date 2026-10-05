'use strict';
/**
 * DivineBans website.
 * The Velocity plugin POSTs a full snapshot to /api/sync every few seconds. The proxy is the source of
 * truth (including admin notes), so nothing is lost when Render restarts the free instance.
 * IP addresses are never stored or served: the plugin doesn't send them, and this server scrubs anything
 * that looks like one as a second line of defence.
 */
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const path = require('path');

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const SESSION_HOURS = 12;

if (!API_KEY || API_KEY.length < 16 || !ADMIN_PASSWORD) {
  console.error('Set API_KEY (16+ chars) and ADMIN_PASSWORD environment variables.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Render sits behind one proxy; needed for per-IP rate limits
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https://mc-heads.net'],
      frameSrc: ['https://www.youtube-nocookie.com', 'https://streamable.com', 'https://medal.tv'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));

// ---------------------------------------------------------------- state

let punishments = [];        // last snapshot from the proxy (sanitised)
let lastSync = 0;
let pendingNotes = [];       // notes added on the website, not yet confirmed by the proxy
let pendingDeletes = [];     // note ids deleted on the website, not yet confirmed
let pendingActions = [];     // unban/unmute clicked on the website, not yet done by the proxy
let chatLog = [];            // every swear/slur from the proxy (oldest first) — admin only, never public
let chatLogMax = 0;          // highest log id we have (the proxy re-sends anything newer)
const CHATLOG_LIMIT = 50000;

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b/gi;
const scrub = (s) => String(s ?? '').replace(IPV4, '[hidden]').replace(IPV6, '[hidden]').slice(0, 2000);
const looksLikeIp = (s) => { IPV4.lastIndex = 0; IPV6.lastIndex = 0; return IPV4.test(s) || IPV6.test(s); };

function sanitizeNote(n) {
  return {
    id: String(n.id ?? '').slice(0, 40),
    kind: n.kind === 'video' ? 'video' : 'note',
    content: n.kind === 'video' ? String(n.content ?? '').slice(0, 500) : scrub(n.content),
    by: scrub(n.by).slice(0, 32),
    staffOnly: !!n.staffOnly,
    created: Number(n.created) || 0,
  };
}

/** Whitelist fields only — an `ip` field can never get through. */
function sanitizePunishment(p) {
  const rawName = String(p.name ?? '');
  return {
    id: String(p.id ?? '').slice(0, 16),
    type: p.type === 'MUTE' ? 'MUTE' : 'BAN',
    name: looksLikeIp(rawName) || !rawName ? 'Hidden' : rawName.slice(0, 32),
    uuid: /^[0-9a-f-]{36}$/i.test(p.uuid ?? '') ? p.uuid : null,
    ipBased: !!p.ipBased,
    reason: scrub(p.reason),
    by: scrub(p.by).slice(0, 32),
    created: Number(p.created) || 0,
    expires: Number(p.expires) || -1,
    active: !!p.active,
    removedBy: p.removedBy ? scrub(p.removedBy).slice(0, 32) : null,
    removedAt: Number(p.removedAt) || 0,
    notes: Array.isArray(p.notes) ? p.notes.map(sanitizeNote) : [],
  };
}

function sanitizeLog(e) {
  return {
    id: Number(e.id) || 0,
    time: Number(e.time) || 0,
    uuid: /^[0-9a-f-]{36}$/i.test(e.uuid ?? '') ? e.uuid : null,
    name: scrub(e.name).slice(0, 32),
    server: scrub(e.server).slice(0, 32),
    where: scrub(e.where).slice(0, 32),
    severity: e.severity === 'SEVERE' ? 'SEVERE' : 'PROFANITY',
    word: scrub(e.word).slice(0, 40),
    variant: scrub(e.variant).slice(0, 100),
    message: scrub(e.message).slice(0, 300),
    blocked: !!e.blocked,
  };
}

const isActive = (p) => p.active && !(p.expires !== -1 && Date.now() >= p.expires);

/** Snapshot + pending admin edits, as the website should show it. */
function view({ includeStaffNotes }) {
  const now = Date.now();
  return punishments.map((p) => {
    let notes = p.notes.concat(pendingNotes.filter((n) => n.punishmentId === p.id).map(sanitizeNote));
    notes = notes.filter((n) => !pendingDeletes.includes(n.id));
    if (!includeStaffNotes) notes = notes.filter((n) => !n.staffOnly);
    const expired = p.expires !== -1 && now >= p.expires;
    const status = !p.active ? 'removed' : expired ? 'expired' : 'active';
    const liftPending = includeStaffNotes && pendingActions.some((a) => a.punishmentId === p.id);
    return { ...p, notes, status, liftPending };
  });
}

function query(list, q) {
  let out = list;
  const search = String(q.q ?? '').trim().toLowerCase();
  if (search) out = out.filter((p) => p.name.toLowerCase().includes(search));
  if (q.type === 'BAN' || q.type === 'MUTE') out = out.filter((p) => p.type === q.type);
  if (['active', 'expired', 'removed'].includes(q.status)) out = out.filter((p) => p.status === q.status);
  out = out.slice().sort((a, b) => b.created - a.created);
  const pageSize = 25;
  const pages = Math.max(1, Math.ceil(out.length / pageSize));
  const page = Math.min(Math.max(1, parseInt(q.page, 10) || 1), pages);
  return {
    items: out.slice((page - 1) * pageSize, page * pageSize),
    total: out.length, page, pages,
    serverTime: Date.now(), lastSync,
    stats: {
      activeBans: list.filter((p) => p.type === 'BAN' && p.status === 'active').length,
      activeMutes: list.filter((p) => p.type === 'MUTE' && p.status === 'active').length,
      total: list.length,
    },
  };
}

// ---------------------------------------------------------------- helpers

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));

const sessions = new Map(); // token -> { name, expires }
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t);
}, 60_000).unref();

function getCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function requireAdmin(req, res, next) {
  const s = sessions.get(getCookie(req, 'divine_session') || '');
  if (!s || s.expires < Date.now()) return res.status(401).json({ error: 'Not logged in' });
  req.admin = s;
  next();
}

function requireJson(req, res, next) {
  // Blocks cross-site form posts (CSRF) — browsers can't send JSON cross-site without CORS.
  if (!req.is('application/json')) return res.status(415).json({ error: 'JSON required' });
  next();
}

function videoUrlOk(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && u.length <= 500;
  } catch { return false; }
}

// ---------------------------------------------------------------- rate limits

const publicLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });
const adminLimiter = rateLimit({ windowMs: 60_000, limit: 180, standardHeaders: 'draft-7', legacyHeaders: false });
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 5,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});
const syncLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

// ---------------------------------------------------------------- plugin sync

app.post('/api/sync', syncLimiter, express.json({ limit: '10mb' }), (req, res) => {
  const auth = req.headers.authorization || '';
  if (!safeEqual(auth, `Bearer ${API_KEY}`)) return res.status(401).json({ error: 'Bad API key' });
  if (!Array.isArray(req.body?.punishments)) return res.status(400).json({ error: 'Bad payload' });

  punishments = req.body.punishments.map(sanitizePunishment);
  lastSync = Date.now();

  const ids = new Set(punishments.map((p) => p.id));
  const noteIds = new Set(punishments.flatMap((p) => p.notes.map((n) => n.id)));
  // Drop pending notes the proxy has now saved (or whose punishment no longer exists).
  pendingNotes = pendingNotes.filter((n) => ids.has(n.punishmentId) && !noteIds.has(n.id));
  // Drop pending deletes the proxy has carried out.
  pendingDeletes = pendingDeletes.filter((id) => noteIds.has(id));

  // Unban/unmute requests: drop the ones the proxy did, or whose punishment is no longer active.
  const done = new Set((Array.isArray(req.body.actionsDone) ? req.body.actionsDone : []).map(String));
  pendingActions = pendingActions.filter((a) => {
    if (done.has(a.id)) return false;
    const p = punishments.find((x) => x.id === a.punishmentId);
    return p && isActive(p);
  });

  // Swear log: the proxy is the source of truth. If it has fewer entries than us (log reset), start over.
  if (typeof req.body.chatLogLast === 'number' && req.body.chatLogLast < chatLogMax) { chatLog = []; chatLogMax = 0; }
  if (Array.isArray(req.body.chatLog)) {
    for (const raw of req.body.chatLog) {
      const e = sanitizeLog(raw);
      if (e.id > chatLogMax) { chatLog.push(e); chatLogMax = e.id; }
    }
    if (chatLog.length > CHATLOG_LIMIT) chatLog.splice(0, chatLog.length - CHATLOG_LIMIT);
  }

  res.json({ notes: pendingNotes, deletes: pendingDeletes, actions: pendingActions, chatLogHave: chatLogMax });
});

// ---------------------------------------------------------------- public API

app.get('/api/punishments', publicLimiter, (req, res) => {
  res.json(query(view({ includeStaffNotes: false }), req.query));
});

// ---------------------------------------------------------------- admin API

app.post('/api/admin/login', loginLimiter, requireJson, express.json({ limit: '4kb' }), (req, res) => {
  const name = String(req.body?.name ?? '').trim().slice(0, 32);
  const password = String(req.body?.password ?? '');
  if (!name || !/^[\w .-]+$/.test(name)) return res.status(400).json({ error: 'Enter your staff name' });
  if (!safeEqual(password, ADMIN_PASSWORD)) return res.status(401).json({ error: 'Wrong password' });

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { name, expires: Date.now() + SESSION_HOURS * 3600_000 });
  res.cookie('divine_session', token, {
    httpOnly: true, secure: process.env.NODE_ENV !== 'development', sameSite: 'strict',
    maxAge: SESSION_HOURS * 3600_000, path: '/',
  });
  res.json({ ok: true, name });
});

app.post('/api/admin/logout', (req, res) => {
  sessions.delete(getCookie(req, 'divine_session') || '');
  res.clearCookie('divine_session', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/me', adminLimiter, requireAdmin, (req, res) => res.json({ name: req.admin.name }));

app.get('/api/admin/punishments', adminLimiter, requireAdmin, (req, res) => {
  res.json(query(view({ includeStaffNotes: true }), req.query));
});

app.post('/api/admin/punishments/:id/notes', adminLimiter, requireAdmin, requireJson,
  express.json({ limit: '8kb' }), (req, res) => {
    const p = punishments.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: 'Punishment not found' });
    const kind = req.body?.kind === 'video' ? 'video' : 'note';
    const content = String(req.body?.content ?? '').trim();
    if (!content) return res.status(400).json({ error: 'Empty' });
    if (kind === 'video' && !videoUrlOk(content)) return res.status(400).json({ error: 'Video must be an https:// link' });
    if (content.length > 2000) return res.status(400).json({ error: 'Too long (2000 max)' });

    const note = {
      id: crypto.randomBytes(8).toString('hex'),
      punishmentId: p.id,
      kind, content,
      by: req.admin.name,
      staffOnly: !!req.body?.staffOnly,
      created: Date.now(),
    };
    pendingNotes.push(note);
    res.json({ ok: true, note: sanitizeNote(note) });
  });

app.delete('/api/admin/notes/:id', adminLimiter, requireAdmin, (req, res) => {
  const id = String(req.params.id);
  const pendingIdx = pendingNotes.findIndex((n) => n.id === id);
  if (pendingIdx >= 0) { pendingNotes.splice(pendingIdx, 1); return res.json({ ok: true }); }
  if (!punishments.some((p) => p.notes.some((n) => n.id === id))) return res.status(404).json({ error: 'Not found' });
  if (!pendingDeletes.includes(id)) pendingDeletes.push(id);
  res.json({ ok: true });
});

app.post('/api/admin/punishments/:id/lift', adminLimiter, requireAdmin, requireJson, express.json({ limit: '1kb' }), (req, res) => {
  const p = punishments.find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: 'Punishment not found' });
  if (!isActive(p)) return res.status(400).json({ error: 'That punishment is not active anymore' });
  if (!pendingActions.some((a) => a.punishmentId === p.id)) {
    pendingActions.push({
      id: crypto.randomBytes(8).toString('hex'),
      punishmentId: p.id,
      kind: p.type === 'BAN' ? 'unban' : 'unmute',
      by: req.admin.name,
      created: Date.now(),
    });
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------- swear log (admin only)

const DAY = 86_400_000;
function logWindow(q) {
  const days = parseInt(q.days, 10);
  let list = chatLog;
  if (days > 0) { const since = Date.now() - days * DAY; list = list.filter((e) => e.time >= since); }
  if (q.severity === 'SEVERE' || q.severity === 'PROFANITY') list = list.filter((e) => e.severity === q.severity);
  return list;
}

app.get('/api/admin/swears', adminLimiter, requireAdmin, (req, res) => {
  let list = logWindow(req.query);
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const player = String(req.query.player ?? '').trim().toLowerCase();
  const word = String(req.query.word ?? '').trim().toLowerCase();
  if (player) list = list.filter((e) => e.name.toLowerCase() === player);
  if (word) list = list.filter((e) => e.word.toLowerCase() === word);
  if (q) {
    list = list.filter((e) => e.name.toLowerCase().includes(q) || e.message.toLowerCase().includes(q)
      || e.variant.toLowerCase().includes(q) || e.word.toLowerCase().includes(q) || e.server.toLowerCase().includes(q));
  }
  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(list.length / pageSize));
  const page = Math.min(Math.max(1, parseInt(req.query.page, 10) || 1), pages);
  const newestFirst = list.slice().reverse();
  res.json({
    items: newestFirst.slice((page - 1) * pageSize, page * pageSize),
    total: list.length, page, pages,
    stats: {
      total: chatLog.length,
      slurs: chatLog.filter((e) => e.severity === 'SEVERE').length,
      players: new Set(chatLog.map((e) => e.uuid || e.name)).size,
      today: chatLog.filter((e) => e.time >= Date.now() - DAY).length,
    },
    lastSync, serverTime: Date.now(),
  });
});

app.get('/api/admin/swears/top', adminLimiter, requireAdmin, (req, res) => {
  const by = new Map();
  for (const e of logWindow(req.query)) {
    const key = e.uuid || e.name.toLowerCase();
    let r = by.get(key);
    if (!r) { r = { name: e.name, uuid: e.uuid, total: 0, severe: 0, profanity: 0, last: 0, words: new Map() }; by.set(key, r); }
    r.total++;
    if (e.severity === 'SEVERE') r.severe++; else r.profanity++;
    if (e.time >= r.last) { r.last = e.time; r.name = e.name; }
    r.words.set(e.word, (r.words.get(e.word) || 0) + 1);
  }
  const rows = [...by.values()]
    .sort((a, b) => b.severe - a.severe || b.total - a.total)
    .slice(0, 100)
    .map((r) => ({ ...r, words: [...r.words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([w, c]) => ({ word: w, count: c })) }));
  res.json({ rows, serverTime: Date.now() });
});

app.get('/api/admin/swears/words', adminLimiter, requireAdmin, (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase();
  const by = new Map();
  for (const e of logWindow(req.query)) {
    let w = by.get(e.word);
    if (!w) { w = { word: e.word, severity: e.severity, total: 0, players: new Set(), variants: new Map() }; by.set(e.word, w); }
    w.total++;
    w.players.add(e.uuid || e.name);
    const v = e.variant.toLowerCase();
    const cur = w.variants.get(v) || { variant: e.variant, count: 0, last: 0 };
    cur.count++; cur.last = Math.max(cur.last, e.time);
    w.variants.set(v, cur);
  }
  let rows = [...by.values()].map((w) => ({
    word: w.word, severity: w.severity, total: w.total, players: w.players.size, distinct: w.variants.size,
    variants: [...w.variants.values()].sort((a, b) => b.count - a.count).slice(0, 60),
  }));
  if (q) rows = rows.filter((w) => w.word.includes(q) || w.variants.some((v) => v.variant.toLowerCase().includes(q)));
  rows.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'SEVERE' ? -1 : 1) || b.total - a.total);
  res.json({ rows });
});

// ---------------------------------------------------------------- pages

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (req, res) => res.send('ok'));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`DivineBans web listening on :${PORT}`));
