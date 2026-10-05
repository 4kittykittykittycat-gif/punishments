'use strict';
(() => {
  const ADMIN = document.body.dataset.admin === '1';
  const API = ADMIN ? '/api/admin/punishments' : '/api/punishments';
  const $ = (s) => document.querySelector(s);
  const state = { q: '', type: '', status: '', page: 1, data: null, clockSkew: 0 };

  // ---------- tiny DOM helper (always textContent, never innerHTML with data) ----------
  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  }

  const now = () => Date.now() + state.clockSkew;
  const head = (p, size) => p.uuid ? `https://mc-heads.net/avatar/${p.uuid}/${size}` : `https://mc-heads.net/avatar/MHF_Steve/${size}`;
  const fmtDate = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  function remaining(ms) {
    if (ms <= 0) return 'expiring…';
    let s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400); s %= 86400;
    const h = Math.floor(s / 3600); s %= 3600;
    const m = Math.floor(s / 60); s %= 60;
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${m}m ${s}s`;
    return `${m}m ${s}s`;
  }

  function timeText(p) {
    if (p.status === 'removed') return 'Lifted';
    if (p.expires === -1) return 'Permanent';
    if (p.status === 'expired') return 'Expired';
    return remaining(p.expires - now());
  }

  function durationTotal(p) {
    if (p.expires === -1) return 'Permanent';
    return remaining(p.expires - p.created).replace(/ 0s$/, '');
  }

  // ---------- data ----------
  async function load() {
    const params = new URLSearchParams({ q: state.q, type: state.type, status: state.status, page: state.page });
    const res = await fetch(`${API}?${params}`, { credentials: 'same-origin' });
    if (res.status === 401 && ADMIN) return showLogin();
    if (res.status === 429) { $('#list').replaceChildren(el('p', { class: 'empty' }, 'Slow down a bit — try again in a minute.')); return; }
    const data = await res.json();
    state.data = data;
    state.clockSkew = data.serverTime - Date.now();
    render();
  }

  function render() {
    const d = state.data;
    $('#stats').replaceChildren(
      el('div', { class: 'stat ban' }, el('b', {}, d.stats.activeBans), el('span', {}, 'active bans')),
      el('div', { class: 'stat mute' }, el('b', {}, d.stats.activeMutes), el('span', {}, 'active mutes')),
      el('div', { class: 'stat' }, el('b', {}, d.stats.total), el('span', {}, 'total on record')),
    );
    const stale = $('#stale');
    if (!d.lastSync) { stale.hidden = false; stale.textContent = 'Waiting for the server to sync…'; }
    else if (now() - d.lastSync > 120_000) { stale.hidden = false; stale.textContent = `Server last synced ${fmtDate(d.lastSync)} — data may be out of date.`; }
    else stale.hidden = true;

    const list = $('#list');
    if (!d.items.length) {
      list.replaceChildren(el('p', { class: 'empty' }, state.q ? `No punishments found for “${state.q}”.` : 'Nothing here. Everyone is behaving.'));
    } else {
      list.replaceChildren(...d.items.map(rowFor));
    }

    const pager = $('#pager');
    pager.replaceChildren();
    if (d.pages > 1) {
      pager.append(
        el('button', { disabled: d.page <= 1, onclick: () => { state.page--; load(); } }, '← Prev'),
        el('span', { class: 'dim' }, ` ${d.page} / ${d.pages} `),
        el('button', { disabled: d.page >= d.pages, onclick: () => { state.page++; load(); } }, 'Next →'),
      );
    }
  }

  function rowFor(p) {
    const evidence = p.notes.length;
    return el('button', { class: 'row', onclick: () => openDetail(p.id) },
      el('img', { src: head(p, 44), alt: '', loading: 'lazy' }),
      el('div', { class: 'main' },
        el('div', { class: 'name' }, p.name,
          el('span', { class: `tag ${p.type}` }, p.type),
          p.ipBased ? el('span', { class: 'tag ip' }, 'IP') : null,
          el('span', { class: `tag status-${p.status}` }, p.status === 'removed' ? 'LIFTED' : p.status.toUpperCase()),
          p.liftPending ? el('span', { class: 'tag status-removed' }, 'LIFTING…') : null,
          evidence ? el('span', { class: 'tag ev' }, `${evidence} evidence`) : null),
        el('div', { class: 'reason' }, p.reason)),
      el('div', { class: 'meta' },
        el('div', { class: 'time', 'data-live': p.id }, timeText(p)),
        el('div', {}, `by ${p.by}`)));
  }

  // Live countdown
  setInterval(() => {
    if (!state.data) return;
    for (const p of state.data.items) {
      document.querySelectorAll(`[data-live="${p.id}"]`).forEach((n) => { n.textContent = timeText(p); });
    }
  }, 1000);

  // Refresh data every 30s so new punishments show up
  setInterval(() => { if (!document.hidden && !$('#detail').open) load(); }, 30_000);

  // ---------- detail modal ----------
  function embedFor(url) {
    try {
      const u = new URL(url);
      const host = u.hostname.replace(/^www\.|^m\./, '');
      let id = null;
      if (host === 'youtube.com') id = u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2] : u.searchParams.get('v');
      if (host === 'youtu.be') id = u.pathname.slice(1);
      if (id && /^[\w-]{6,20}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
      if (host === 'streamable.com') {
        const sid = u.pathname.replace(/^\/(e\/)?/, '');
        if (/^\w+$/.test(sid)) return `https://streamable.com/e/${sid}`;
      }
    } catch {}
    return null;
  }

  function noteView(n) {
    const delBtn = ADMIN ? el('button', { class: 'del', onclick: () => deleteNote(n.id) }, 'Delete') : null;
    const by = el('div', { class: 'by' },
      el('span', { class: `tag ${n.kind === 'video' ? 'ev' : 'ip'}` }, n.kind === 'video' ? 'VIDEO' : 'NOTE'),
      n.staffOnly ? el('span', { class: 'tag BAN' }, 'STAFF ONLY') : null,
      `${n.by} · ${fmtDate(n.created)}`, delBtn);
    if (n.kind === 'video') {
      const src = embedFor(n.content);
      return el('div', { class: 'note' }, by,
        src ? el('div', { class: 'video' }, el('iframe', { src, allowfullscreen: true, loading: 'lazy', title: 'Evidence video', referrerpolicy: 'strict-origin-when-cross-origin' })) : null,
        el('a', { href: n.content, target: '_blank', rel: 'noopener noreferrer nofollow' }, n.content));
    }
    return el('div', { class: 'note' }, by, el('div', { class: 'text' }, n.content));
  }

  function openDetail(id) {
    const p = state.data.items.find((x) => x.id === id);
    if (!p) return;
    const dlg = $('#detail');
    const fact = (label, value, mono) => el('div', { class: 'fact' }, el('span', {}, label), el('b', { class: mono ? 'mono' : null }, value));

    const children = [
      el('div', { class: 'd-head' },
        el('img', { src: head(p, 64), alt: '' }),
        el('div', {},
          el('h2', {}, p.name),
          el('div', { class: 'name' },
            el('span', { class: `tag ${p.type}` }, p.ipBased ? `IP ${p.type}` : p.type),
            el('span', { class: `tag status-${p.status}` }, p.status === 'removed' ? 'LIFTED' : p.status.toUpperCase()))),
        el('button', { class: 'd-close', 'aria-label': 'Close', onclick: () => dlg.close() }, '×')),
      el('div', { class: 'd-body' },
        el('div', { class: 'facts' },
          fact('Punished by', p.by),
          fact('Issued', fmtDate(p.created)),
          fact('Length', durationTotal(p)),
          el('div', { class: 'fact' }, el('span', {}, p.status === 'active' ? 'Expires in' : 'Status'),
            el('b', { class: 'mono', 'data-live': p.id }, timeText(p))),
          p.status === 'removed' ? fact('Lifted by', p.removedBy || '—') : null,
          fact('ID', `#${p.id}`, true)),
        ADMIN && p.status === 'active' ? liftBox(p) : null,
        el('h3', {}, 'Reason'),
        el('div', { class: 'reason-box' }, p.reason),
        el('h3', {}, `Evidence & notes (${p.notes.length})`),
        p.notes.length ? p.notes.map(noteView) : el('p', { class: 'hint' }, 'No evidence attached.'),
        ADMIN ? addForm(p) : null),
    ];
    dlg.replaceChildren(...children);
    if (!dlg.open) dlg.showModal();
  }
  $('#detail').addEventListener('click', (e) => { if (e.target.id === 'detail') e.target.close(); });

  // ---------- admin ----------
  function liftBox(p) {
    const verb = p.type === 'BAN' ? 'Unban' : 'Unmute';
    if (p.liftPending) {
      return el('div', { class: 'liftbox pending' },
        el('b', {}, `${verb} requested.`),
        el('span', {}, ' It happens on the next server sync (a few seconds) and is announced in-game.'));
    }
    const err = el('span', { class: 'err' });
    const btn = el('button', {
      class: 'btn lift',
      onclick: async () => {
        if (!confirm(`${verb} ${p.name}? This is announced to the whole network.`)) return;
        btn.disabled = true;
        const res = await fetch(`/api/admin/punishments/${encodeURIComponent(p.id)}/lift`, {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        const body = await res.json().catch(() => ({}));
        btn.disabled = false;
        if (!res.ok) { err.textContent = body.error || 'Failed'; return; }
        await load();
        openDetail(p.id);
      },
    }, `${verb} ${p.name}`);
    return el('div', { class: 'liftbox' }, btn, err);
  }

  function addForm(p) {
    let kind = 'video';
    const err = el('p', { class: 'err', role: 'alert' });
    const urlInput = el('input', { type: 'url', placeholder: 'https://youtube.com/watch?v=…  (YouTube, Streamable, Medal or any link)', maxlength: 500 });
    const text = el('textarea', { placeholder: 'Write a note…', maxlength: 2000, hidden: true });
    const staff = el('input', { type: 'checkbox' });
    const seg = el('div', { class: 'seg' });
    const setKind = (k) => {
      kind = k;
      seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === k));
      urlInput.hidden = k !== 'video';
      text.hidden = k !== 'note';
    };
    seg.append(
      el('button', { type: 'button', 'data-v': 'video', class: 'on', onclick: () => setKind('video') }, 'Video evidence'),
      el('button', { type: 'button', 'data-v': 'note', onclick: () => setKind('note') }, 'Note'));
    const submit = el('button', { class: 'btn', type: 'submit' }, 'Add');

    return el('form', {
      class: 'add',
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        const content = (kind === 'video' ? urlInput.value : text.value).trim();
        if (!content) return;
        submit.disabled = true;
        const res = await fetch(`/api/admin/punishments/${encodeURIComponent(p.id)}/notes`, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind, content, staffOnly: staff.checked }),
        });
        submit.disabled = false;
        const body = await res.json().catch(() => ({}));
        if (!res.ok) { err.textContent = body.error || 'Failed'; return; }
        await load();
        openDetail(p.id);
      },
    },
    el('h3', {}, 'Add evidence'),
    seg, urlInput, text,
    el('div', { class: 'row2' },
      el('label', { class: 'check' }, staff, 'Staff only (hidden from public)'),
      submit),
    err,
    el('p', { class: 'hint' }, 'Saved to the Minecraft server on the next sync (a few seconds).'));
  }

  async function deleteNote(id) {
    if (!confirm('Delete this evidence?')) return;
    const res = await fetch(`/api/admin/notes/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'same-origin' });
    if (!res.ok) { alert('Delete failed'); return; }
    const openId = state.data.items.find((p) => p.notes.some((n) => n.id === id))?.id;
    await load();
    if (openId) openDetail(openId);
  }

  function showLogin() {
    $('#panel').hidden = true;
    $('#login').hidden = false;
    $('#logout').hidden = true;
    $('#whoami').textContent = '';
  }

  async function initAdmin() {
    const res = await fetch('/api/admin/me', { credentials: 'same-origin' });
    if (!res.ok) return showLogin();
    const me = await res.json();
    $('#whoami').textContent = me.name;
    $('#logout').hidden = false;
    $('#login').hidden = true;
    $('#panel').hidden = false;
    load();
  }

  if (ADMIN) {
    $('#loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = e.target;
      $('#loginErr').textContent = '';
      const res = await fetch('/api/admin/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: f.name.value, password: f.password.value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { $('#loginErr').textContent = body.error || 'Login failed'; return; }
      f.password.value = '';
      initAdmin();
    });
    $('#logout').addEventListener('click', async () => {
      await fetch('/api/admin/logout', { method: 'POST', credentials: 'same-origin' });
      showLogin();
    });
  }

  // ---------- controls ----------
  let t;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.q = e.target.value.trim(); state.page = 1; load(); }, 250);
  });
  for (const [id, key] of [['#typeSeg', 'type'], ['#statusSeg', 'status']]) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      state[key] = b.dataset.v; state.page = 1; load();
    });
  }

  if (ADMIN) initAdmin(); else load();
})();
