// Settings: the app's control panel. One section at a time, every option with
// a plain explanation, its default, and a way back to it. Changes save as you go.

import { h, add, clear, toast, confirmDialog, action } from '../ui.js';
import { state, saveSettings, loadLichess } from '../store.js';
import { api } from '../api.js';

const UNIT_HOURS = [['months', 720], ['weeks', 168], ['days', 24], ['hours', 1]];

export async function renderSettings(root, { section: sectionParam }) {
  const [meta] = await Promise.all([fetch('/api/settings/schema').then((r) => r.json()), loadLichess()]);
  const sections = meta.sections;
  const defaults = meta.defaults;
  let current = sections.find((s) => s.id === sectionParam) || sections[0];

  const page = h('div.page.settingsview');
  const nav = h('nav.settings-nav', { 'aria-label': 'Settings sections' });
  const body = h('div.settings-body');
  const status = h('span.save-status', { 'aria-live': 'polite' }, 'Changes save automatically');
  const search = h('input.settings-search', { type: 'search', placeholder: 'Find a setting', 'aria-label': 'Find a setting' });
  root.append(page);
  add(page,
    h('header.settings-head', h('h1.page-title', 'Settings'), status),
    h('div.settings-layout', h('aside.settings-side', search, nav), body));

  // ---- saving -----------------------------------------------------------------
  let pending = {};
  let timer = null;
  const queueSave = (key, value, field) => {
    pending[key] = value;
    status.textContent = 'Saving…';
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const patch = pending;
      pending = {};
      try {
        await saveSettings(patch);
        status.textContent = 'All changes saved';
        if (Object.keys(patch).some((k) => engineKeys.has(k))) {
          status.textContent = 'Saved. Stockfish is restarting with the new settings…';
          setTimeout(refreshEngineCard, 1500);
        }
        refreshDefaults();
        refreshVisibility();
      } catch (err) {
        status.textContent = 'Not saved';
        toast(err.message, 'bad');
      }
    }, field && (field.type === 'text' || field.type === 'int' || field.type === 'number') ? 500 : 150);
  };

  const engineKeys = new Set(sections.flatMap((s) => s.fields).filter((f) => f.restart).map((f) => f.key));
  const rows = new Map(); // key -> { field, row, defaultNote, setValue }

  // ---- navigation -------------------------------------------------------------------
  function renderNav() {
    clear(nav, sections.map((s) => h(`a.settings-tab${s === current && !search.value ? '.active' : ''}`, {
      href: `#/settings/${s.id}`,
      on: { click: (e) => { e.preventDefault(); search.value = ''; current = s; history.replaceState(null, '', `#/settings/${s.id}`); render(); } },
    }, s.title)));
  }

  function render() {
    renderNav();
    rows.clear();
    const q = search.value.trim().toLowerCase();
    if (q) {
      const hits = sections.map((s) => ({ s, fields: s.fields.filter((f) => `${f.label} ${f.help || ''} ${f.key}`.toLowerCase().includes(q)) })).filter((x) => x.fields.length);
      clear(body,
        hits.length ? hits.map(({ s, fields }) => h('section.settings-section',
          h('h2.settings-title', s.title),
          fields.map((f) => fieldRow(f)))) : h('p.muted', `No setting matches “${search.value}”.`));
    } else {
      clear(body, h('section.settings-section',
        h('div.settings-section-head',
          h('h2.settings-title', current.title),
          h('button.btn.small.ghost', { type: 'button', on: { click: action(() => resetSection(current)) } }, 'Restore defaults')),
        h('p.settings-intro', current.intro),
        current.id === 'engine' ? engineCard() : null,
        current.id === 'opponents' ? lichessCard() : null,
        withGroups(current.fields)));
    }
    refreshDefaults();
    refreshVisibility();
  }

  function withGroups(fields) {
    const out = [];
    let last = null;
    for (const f of fields) {
      if (f.group && f.group !== last) out.push(h('h3.setting-group', f.group));
      last = f.group;
      out.push(fieldRow(f));
    }
    return out;
  }

  async function resetSection(sec) {
    if (!(await confirmDialog(`Restore ${sec.title.toLowerCase()} defaults?`, 'Every setting in this section goes back to its default value.', 'Restore defaults'))) return;
    const patch = {};
    for (const f of sec.fields) patch[f.key] = defaults[f.key];
    await saveSettings(patch);
    toast(`${sec.title} restored to defaults`);
    if (sec.fields.some((f) => f.restart)) setTimeout(refreshEngineCard, 1500);
    render();
  }

  // ---- one setting ---------------------------------------------------------------------
  function fieldRow(f) {
    const id = `set-${f.key}`;
    const value = state.settings[f.key];
    const control = makeControl(f, id, value);
    const defaultNote = h('p.setting-default');
    const row = h('div.setting', { 'data-key': f.key },
      h('div.setting-text',
        h('label.setting-label', { id: `${id}-label`, for: control.focusId === null ? null : id }, f.label),
        f.help ? h('p.setting-help', f.help) : null,
        defaultNote),
      h('div.setting-control', control.el));
    rows.set(f.key, { field: f, row, defaultNote, setValue: control.set });
    return row;
  }

  function refreshDefaults() {
    for (const { field, defaultNote, setValue } of rows.values()) {
      const val = state.settings[field.key];
      const isDefault = JSON.stringify(val) === JSON.stringify(defaults[field.key]);
      clear(defaultNote,
        `Default: ${describe(field, defaults[field.key])}`,
        isDefault ? null : h('button.linklike.inline', {
          type: 'button',
          on: { click: () => { setValue(defaults[field.key]); queueSave(field.key, defaults[field.key], null); } },
        }, 'Use default'));
    }
  }

  function refreshVisibility() {
    for (const { field, row } of rows.values()) {
      if (!field.showIf) continue;
      const [k, v] = field.showIf;
      row.hidden = state.settings[k] !== v && (pending[k] === undefined || pending[k] !== v);
    }
  }

  // ---- controls ---------------------------------------------------------------------------
  function makeControl(f, id, value) {
    switch (f.type) {
      case 'bool': {
        const input = h('input', { id, type: 'checkbox', role: 'switch', checked: !!value });
        input.addEventListener('change', () => { queueSave(f.key, input.checked, f); setTimeout(refreshVisibility, 0); });
        return { el: h('span.switch', input, h('span.switch-track', { 'aria-hidden': 'true' })), set: (v) => { input.checked = !!v; } };
      }
      case 'int':
      case 'number': {
        const input = h('input.num', { id, type: 'number', min: f.min, max: f.max, step: f.step || (f.type === 'int' ? 1 : 0.1), value: String(value), inputmode: 'decimal' });
        const extra = h('span.setting-extra');
        const showExtra = () => {
          const n = Number(input.value);
          extra.textContent = f.unit === 'centipawns' && Number.isFinite(n) ? `= ${(n / 100).toFixed(n % 100 ? 2 : 0)} pawn${n === 100 ? '' : 's'}` : '';
        };
        showExtra();
        input.addEventListener('input', () => {
          showExtra();
          const n = Number(input.value);
          if (input.value === '' || !Number.isFinite(n)) return;
          input.classList.toggle('out-of-range', n < f.min || n > f.max);
          if (n >= f.min && n <= f.max) queueSave(f.key, n, f);
        });
        input.addEventListener('blur', () => {
          const n = Math.max(f.min, Math.min(f.max, Number(input.value) || f.min));
          if (String(n) !== input.value) { input.value = String(n); queueSave(f.key, n, f); showExtra(); }
          input.classList.remove('out-of-range');
        });
        return {
          el: h('span.num-wrap', input, f.unit ? h('span.unit', f.unit) : null, extra, h('span.range-hint', `${f.min}–${f.max}`)),
          set: (v) => { input.value = String(v); showExtra(); },
        };
      }
      case 'select': {
        const name = `opt-${f.key}`;
        const radios = f.options.map(([k, label]) => {
          const input = h('input', { type: 'radio', name, value: k, checked: value === k });
          input.addEventListener('change', () => { if (input.checked) { queueSave(f.key, k, f); setTimeout(refreshVisibility, 0); } });
          return h('label.choice', input, h('span', label));
        });
        const long = f.options.length > 3 || f.options.some(([, l]) => l.length > 30);
        return {
          el: h(`div.choices${long ? '.stacked' : ''}`, { role: 'radiogroup', id, 'aria-labelledby': `${id}-label` }, radios),
          focusId: null,
          set: (v) => { for (const r of radios) r.firstChild.checked = r.firstChild.value === v; },
        };
      }
      case 'text': {
        const input = h('input.text', { id, type: 'text', value: value || '', placeholder: f.placeholder || '', spellcheck: false });
        input.addEventListener('input', () => queueSave(f.key, input.value, f));
        return { el: input, set: (v) => { input.value = v; } };
      }
      case 'month': {
        const input = h('input.text.month', { id, type: 'month', value: value || '', max: new Date().toISOString().slice(0, 7) });
        input.addEventListener('change', () => queueSave(f.key, input.value, f));
        const clearBtn = h('button.btn.small.ghost', { type: 'button', on: { click: () => { input.value = ''; queueSave(f.key, '', f); } } }, 'All games');
        return { el: h('span.num-wrap', input, clearBtn), set: (v) => { input.value = v || ''; } };
      }
      case 'chips': {
        const selected = new Set(String(value || '').split(',').filter(Boolean));
        const boxes = f.options.map(([k, label]) => {
          const input = h('input', { type: 'checkbox', value: k, checked: selected.has(k) });
          input.addEventListener('change', () => {
            const chosen = boxes.map((b) => b.firstChild).filter((i) => i.checked).map((i) => i.value);
            if (!chosen.length) { input.checked = true; toast('Keep at least one selected.'); return; }
            queueSave(f.key, chosen.join(','), f);
          });
          return h('label.chip', input, h('span', label));
        });
        return {
          el: h('div.chips', { id, role: 'group', 'aria-labelledby': `${id}-label` }, boxes),
          focusId: null,
          set: (v) => { const s = new Set(String(v).split(',')); for (const b of boxes) b.firstChild.checked = s.has(b.firstChild.value); },
        };
      }
      case 'intervals':
        return intervalsControl(f, id, value);
      default:
        return { el: h('span.muted', 'Not editable here'), set: () => {} };
    }
  }

  function intervalsControl(f, id, value) {
    const warn = h('p.setting-warn', { hidden: true }, 'Each wait should be longer than the one before.');
    let hours = [...value];
    const rowsEl = h('ol.intervals', { id });
    const draw = () => {
      clear(rowsEl, hours.map((hrs, i) => {
        const [unit, per] = UNIT_HOURS.find(([, p]) => hrs >= p && Math.abs(hrs / p - Math.round(hrs / p)) < 1e-9) || ['hours', 1];
        const num = h('input.num.small', { type: 'number', min: 1, max: 999, step: 1, value: String(Math.round(hrs / per)), 'aria-label': `Level ${i + 1} wait` });
        const sel = h('select.unit-select', { 'aria-label': `Level ${i + 1} unit` }, UNIT_HOURS.map(([u, p]) => h('option', { value: String(p), selected: p === per }, u)));
        const update = () => {
          const n = Number(num.value);
          if (!Number.isFinite(n) || n <= 0) return;
          hours[i] = n * Number(sel.value);
          warn.hidden = hours.every((x, j) => j === 0 || x > hours[j - 1]);
          queueSave(f.key, [...hours], f);
        };
        num.addEventListener('input', update);
        sel.addEventListener('change', update);
        return h('li', h('span.level-name', `Level ${i + 1}`), num, sel);
      }));
      warn.hidden = hours.every((x, j) => j === 0 || x > hours[j - 1]);
    };
    draw();
    return { el: h('div', { role: 'group', 'aria-labelledby': `${id}-label` }, rowsEl, warn), focusId: null, set: (v) => { hours = [...v]; draw(); } };
  }

  // ---- extra cards ---------------------------------------------------------------------------
  let engineBox = null;
  function engineCard() {
    engineBox = h('div.engine-card');
    paintEngine(meta.engine);
    return engineBox;
  }
  async function refreshEngineCard() {
    try {
      const info = await api.engine();
      paintEngine(info);
      if (status.textContent.startsWith('Saved. Stockfish')) status.textContent = 'All changes saved';
    } catch (err) { /* server busy */ }
  }
  function paintEngine(info) {
    if (!engineBox || !info) return;
    const line = (label, e) => h('li', h('span.muted', label), ' ',
      `${e.name || (e.kind === 'native' ? 'Native Stockfish' : 'Built-in Stockfish')} (${e.file || '—'}), ${e.threads} thread${e.threads === 1 ? '' : 's'}, ${e.hash} MB${e.running ? '' : ', starts when needed'}`);
    const warnings = [...new Set([...(info.analysis.warnings || []), ...(info.tasks.warnings || [])])];
    clear(engineBox,
      h('h3.engine-card-title', 'Running now'),
      h('ul', line('Analysis:', info.analysis), line('Background jobs:', info.tasks)),
      warnings.map((w) => h('p.setting-warn', w)));
  }

  function lichessCard() {
    const lc = state.lichess || {};
    return h('div.engine-card',
      lc.connected
        ? h('p', 'Connected to Lichess as ', h('b', lc.username), '. ', h('a', { href: '#/lichess' }, 'Account and studies'))
        : h('p', 'Not connected yet. The explorer and the mistake finder need a Lichess sign-in. ', h('a', { href: '#/lichess' }, 'Connect Lichess')));
  }

  search.addEventListener('input', render);
  render();

  return () => {
    clearTimeout(timer);
    if (Object.keys(pending).length) saveSettings(pending).catch(() => {});
  };
}

function describe(f, v) {
  switch (f.type) {
    case 'bool': return v ? 'on' : 'off';
    case 'select': return (f.options.find(([k]) => k === v) || [, v])[1];
    case 'chips': return String(v).split(',').map((k) => (f.options.find(([o]) => o === k) || [, k])[1]).join(', ');
    case 'text': return v ? v : 'empty';
    case 'month': return v || 'all games';
    case 'intervals': return v.map((hrs) => {
      const [unit, per] = UNIT_HOURS.find(([, p]) => hrs >= p && Math.abs(hrs / p - Math.round(hrs / p)) < 1e-9) || ['hours', 1];
      const n = Math.round(hrs / per);
      return `${n} ${n === 1 ? unit.replace(/s$/, '') : unit}`;
    }).join(', ');
    default: return `${v}${f.unit ? ` ${v === 1 && /[^s]s$/.test(f.unit) ? f.unit.slice(0, -1) : f.unit}` : ''}`;
  }
}
