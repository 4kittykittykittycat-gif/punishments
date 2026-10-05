'use strict';
// Staff panel extras: Swear log, Top offenders, Variants. Admin page only; all data comes from /api/admin/*.
(() => {
  const $ = (s) => document.querySelector(s);
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
  const head = (uuid, size) => `https://mc-heads.net/avatar/${uuid || 'MHF_Steve'}/${size}`;
  const fmtDate = (ms) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  function ago(ms) {
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const sevTag = (sev) => el('span', { class: `tag ${sev === 'SEVERE' ? 'SLUR' : 'SWEAR'}` }, sev === 'SEVERE' ? 'SLUR' : 'SWEAR');

  async function getJson(url) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (res.status === 401) { location.reload(); return null; }
    if (res.status === 429) return { error: 'Slow down a bit — try again in a minute.' };
    return res.json();
  }

  // ------------------------------------------------------------ tabs
  const loaded = {};
  let current = 'punishments';
  function openTab(name) {
    current = name;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== name; });
    if (name === 'swears') loadSwears();
    if (name === 'top') loadTop();
    if (name === 'words') loadWords();
    loaded[name] = true;
  }
  $('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) openTab(b.dataset.tab); });

  function seg(id, onChange) {
    $(id).addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      onChange(b.dataset.v);
    });
  }
  function setSeg(id, v) { $(id).querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === v)); }
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

  // ------------------------------------------------------------ swear log
  const sw = { q: '', severity: '', days: '', player: '', word: '', page: 1 };

  function highlight(message, variant) {
    const i = variant ? message.toLowerCase().indexOf(variant.toLowerCase()) : -1;
    if (i < 0) return [message];
    return [message.slice(0, i), el('mark', {}, message.slice(i, i + variant.length)), message.slice(i + variant.length)];
  }

  async function loadSwears() {
    const params = new URLSearchParams(sw);
    const d = await getJson(`/api/admin/swears?${params}`);
    if (!d) return;
    if (d.error) { $('#swList').replaceChildren(el('p', { class: 'empty' }, d.error)); return; }
    $('#swStats').replaceChildren(
      el('div', { class: 'stat ban' }, el('b', {}, d.stats.slurs), el('span', {}, 'slurs logged')),
      el('div', { class: 'stat' }, el('b', {}, d.stats.total), el('span', {}, 'swears + slurs')),
      el('div', { class: 'stat mute' }, el('b', {}, d.stats.today), el('span', {}, 'in the last 24h')),
      el('div', { class: 'stat' }, el('b', {}, d.stats.players), el('span', {}, 'players')),
    );
    const stale = $('#swStale');
    if (!d.lastSync) { stale.hidden = false; stale.textContent = 'Waiting for the server to sync…'; }
    else if (d.serverTime - d.lastSync > 120_000) { stale.hidden = false; stale.textContent = `Server last synced ${fmtDate(d.lastSync)}.`; }
    else stale.hidden = true;

    const chips = [];
    if (sw.player) chips.push(el('button', { class: 'chip on', onclick: () => { sw.player = ''; sw.page = 1; loadSwears(); } }, `Player: ${sw.player} ×`));
    if (sw.word) chips.push(el('button', { class: 'chip on', onclick: () => { sw.word = ''; sw.page = 1; loadSwears(); } }, `Word: ${sw.word} ×`));
    $('#swFilters').replaceChildren(...chips);

    const list = $('#swList');
    if (!d.items.length) {
      list.replaceChildren(el('p', { class: 'empty' }, sw.q || sw.player || sw.word ? 'Nothing matches that search.' : 'Nobody has sworn yet. Nice.'));
    } else {
      list.replaceChildren(...d.items.map((e) => el('div', { class: `logrow ${e.severity === 'SEVERE' ? 'severe' : ''}` },
        el('img', { src: head(e.uuid, 32), alt: '', loading: 'lazy' }),
        el('div', { class: 'main' },
          el('div', { class: 'line1' },
            el('button', { class: 'linky', title: 'Show everything this player said', onclick: () => { sw.player = e.name; sw.page = 1; loadSwears(); } }, e.name),
            sevTag(e.severity),
            el('button', { class: 'tag word', title: 'Show every use of this word', onclick: () => { sw.word = e.word; sw.page = 1; loadSwears(); } }, `= ${e.word}`),
            e.blocked ? null : el('span', { class: 'tag ev' }, 'ALLOWED'),
            el('span', { class: 'where' }, `${e.server} · ${e.where}`)),
          el('div', { class: 'msg' }, highlight(e.message, e.variant))),
        el('div', { class: 'meta', title: fmtDate(e.time) }, ago(e.time)))));
    }
    const pager = $('#swPager');
    pager.replaceChildren();
    if (d.pages > 1) {
      pager.append(
        el('button', { disabled: d.page <= 1, onclick: () => { sw.page--; loadSwears(); } }, '← Newer'),
        el('span', { class: 'dim' }, ` ${d.page} / ${d.pages} · ${d.total} results `),
        el('button', { disabled: d.page >= d.pages, onclick: () => { sw.page++; loadSwears(); } }, 'Older →'));
    }
  }
  $('#swSearch').addEventListener('input', debounce((e) => { sw.q = e.target.value.trim(); sw.page = 1; loadSwears(); }, 250));
  seg('#swSev', (v) => { sw.severity = v; sw.page = 1; loadSwears(); });
  seg('#swDays', (v) => { sw.days = v; sw.page = 1; loadSwears(); });

  function showLogFor({ player = '', word = '', q = '' }) {
    Object.assign(sw, { player, word, q, page: 1, severity: '', days: '' });
    $('#swSearch').value = q;
    setSeg('#swSev', ''); setSeg('#swDays', '');
    openTab('swears');
  }

  // ------------------------------------------------------------ top offenders
  const top = { severity: '', days: '' };
  async function loadTop() {
    const d = await getJson(`/api/admin/swears/top?${new URLSearchParams(top)}`);
    if (!d) return;
    const box = $('#topList');
    if (d.error) { box.replaceChildren(el('p', { class: 'empty' }, d.error)); return; }
    if (!d.rows.length) { box.replaceChildren(el('p', { class: 'empty' }, 'Nobody in this time range.')); return; }
    const max = d.rows[0].total || 1;
    box.replaceChildren(...d.rows.map((r, i) => {
      const bar = el('div', { class: 'bar' }, el('span', { class: 'b-sev' }), el('span', { class: 'b-prof' }));
      bar.children[0].style.width = `${(r.severe / max) * 100}%`;
      bar.children[1].style.width = `${(r.profanity / max) * 100}%`;
      return el('button', { class: 'toprow', onclick: () => showLogFor({ player: r.name }) },
        el('span', { class: `rank ${i < 3 ? 'podium' : ''}` }, `#${i + 1}`),
        el('img', { src: head(r.uuid, 40), alt: '', loading: 'lazy' }),
        el('div', { class: 'main' },
          el('div', { class: 'name' }, r.name, el('span', { class: 'dim small' }, ` last ${ago(r.last)}`)),
          bar,
          el('div', { class: 'words-mini' }, r.words.map((w) => el('span', { class: 'chip' }, `${w.word} ×${w.count}`)))),
        el('div', { class: 'counts' },
          el('b', {}, r.total),
          el('span', {}, el('span', { class: 'sev' }, plural(r.severe, 'slur')), ` · ${plural(r.profanity, 'swear')}`)));
    }));
  }
  seg('#topSev', (v) => { top.severity = v; loadTop(); });
  seg('#topDays', (v) => { top.days = v; loadTop(); });

  // ------------------------------------------------------------ variants
  const words = { q: '', days: '' };
  async function loadWords() {
    const d = await getJson(`/api/admin/swears/words?${new URLSearchParams(words)}`);
    if (!d) return;
    const box = $('#wList');
    if (d.error) { box.replaceChildren(el('p', { class: 'empty' }, d.error)); return; }
    if (!d.rows.length) { box.replaceChildren(el('p', { class: 'empty' }, 'Nothing logged yet.')); return; }
    box.replaceChildren(...d.rows.map((w) => el('div', { class: `wordcard ${w.severity === 'SEVERE' ? 'severe' : ''}` },
      el('div', { class: 'w-head' },
        el('h4', {}, w.word), sevTag(w.severity),
        el('span', { class: 'dim small' }, `${plural(w.total, 'time')} · ${plural(w.players, 'player')} · ${plural(w.distinct, 'spelling')}`),
        el('button', { class: 'ghost-link small', onclick: () => showLogFor({ word: w.word }) }, 'Show log')),
      el('div', { class: 'chips' }, w.variants.map((v) =>
        el('button', { class: 'chip', title: `Last used ${fmtDate(v.last)}`, onclick: () => showLogFor({ q: v.variant }) },
          el('code', {}, v.variant), el('span', { class: 'cnt' }, `×${v.count}`)))))));
  }
  $('#wSearch').addEventListener('input', debounce((e) => { words.q = e.target.value.trim(); loadWords(); }, 250));
  seg('#wDays', (v) => { words.days = v; loadWords(); });

  // Keep the open tab fresh.
  setInterval(() => {
    if (document.hidden || $('#panel').hidden) return;
    if (current === 'swears' && sw.page === 1) loadSwears();
    if (current === 'top') loadTop();
  }, 20_000);
})();
