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

/** Snapshot + pending admin edits, as the website should show it. */
function view({ includeStaffNotes }) {
  const now = Date.now();
  return punishments.map((p) => {
    let notes = p.notes.concat(pendingNotes.filter((n) => n.punishmentId === p.id).map(sanitizeNote));
    notes = notes.filter((n) => !pendingDeletes.includes(n.id));
    if (!includeStaffNotes) notes = notes.filter((n) => !n.staffOnly);
    const expired = p.expires !== -1 && now >= p.expires;
    const status = !p.active ? 'removed' : expired ? 'expired' : 'active';
    return { ...p, notes, status };
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
const adminLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
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

  res.json({ notes: pendingNotes, deletes: pendingDeletes });
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

// ---------------------------------------------------------------- pages

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.get('/healthz', (req, res) => res.send('ok'));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`DivineBans web listening on :${PORT}`));
