// Add or edit a repertoire: name, side, PGN — with a live preview of what the trainer will see.

import { h, add, clear, toast, plural } from '../ui.js';
import { getRep, putRep } from '../store.js';
import { buildRepertoire } from '../repertoire.js';
import { api } from '../api.js';

/**
 * New repertoire, or edit one when given its id.
 * @param {HTMLElement} root
 * @param {{ id?: string }} params
 */
export async function renderImport(root, { id }) {
  const editing = !!id;
  const rep = editing ? await getRep(id, { fresh: true }) : null;
  const page = h('div.page.importview');
  root.append(page);

  const name = h('input#rep-name', { type: 'text', required: true, placeholder: 'e.g. Queen’s Gambit Declined', value: rep ? rep.name : '', autocomplete: 'off' });
  const sideWhite = h('input', { type: 'radio', name: 'side', value: 'white', checked: !rep || rep.color === 'white' });
  const sideBlack = h('input', { type: 'radio', name: 'side', value: 'black', checked: !!rep && rep.color === 'black' });
  const pgn = h('textarea#rep-pgn', {
    spellcheck: false,
    rows: 16,
    placeholder: '[Event "My repertoire"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 (3. Bb5 a6) 3... Bc5 4. c3 *',
    value: rep ? rep.pgn : '',
  });
  const file = h('input', { type: 'file', accept: '.pgn,.txt,application/x-chess-pgn,text/plain', multiple: true, hidden: true });
  const preview = h('aside.preview', { 'aria-live': 'polite' });
  const samplesRow = h('div.samples');
  const studyUrl = h('input', { type: 'url', placeholder: 'https://lichess.org/study/…', 'aria-label': 'Lichess study link' });
  const studyBtn = h('button.btn.small', { type: 'button' }, 'Fetch study');
  studyBtn.addEventListener('click', async () => {
    if (!studyUrl.value.trim()) { studyUrl.focus(); return; }
    studyBtn.disabled = true;
    studyBtn.textContent = 'Fetching…';
    try {
      const st = await api.lichess.study(studyUrl.value);
      pgn.value = st.pgn;
      if (!name.value.trim()) name.value = st.name;
      if (st.orientation) (st.orientation === 'black' ? sideBlack : sideWhite).checked = true;
      refresh();
      toast('Study loaded. Check the preview, then save.');
    } catch (err) {
      toast(err.message, 'bad');
    }
    studyBtn.disabled = false;
    studyBtn.textContent = 'Fetch study';
  });
  const studyRow = h('div.study-row', h('span.muted', 'From a Lichess study: '), studyUrl, studyBtn);
  const saveBtn = h('button.btn.primary', { type: 'submit' }, editing ? 'Save changes' : 'Save repertoire');

  const color = () => (sideBlack.checked ? 'black' : 'white');

  let timer = null;
  const refresh = () => {
    clearTimeout(timer);
    timer = setTimeout(() => renderPreview(preview, pgn.value, color()), 200);
  };

  async function readFiles(files) {
    const texts = await Promise.all([...files].map((f) => f.text()));
    pgn.value = (pgn.value.trim() ? `${pgn.value.trim()}\n\n` : '') + texts.join('\n\n');
    if (!name.value.trim() && files[0]) name.value = files[0].name.replace(/\.(pgn|txt)$/i, '').replace(/[_-]+/g, ' ');
    refresh();
  }
  file.addEventListener('change', () => readFiles(file.files).catch((err) => toast(err.message, 'bad')));
  for (const el of [pgn, sideWhite, sideBlack]) el.addEventListener('input', refresh);

  const drop = h('div.dropzone',
    pgn,
    h('div.dropzone-bar',
      h('span.muted', 'Paste PGN, drop .pgn files here, or '),
      h('button.linklike', { type: 'button', on: { click: () => file.click() } }, 'choose files'),
      file));
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer.files.length) readFiles(e.dataTransfer.files).catch((err) => toast(err.message, 'bad'));
  });

  const form = h('form.import-form', {
    on: {
      submit: async (e) => {
        e.preventDefault();
        const model = buildRepertoire({ pgn: pgn.value, color: color() });
        if (!model.lines.length) { toast('There are no moves for your side in this PGN yet.', 'bad'); return; }
        saveBtn.disabled = true;
        try {
          const payload = { name: name.value, color: color(), pgn: pgn.value };
          // An edit names the version it started from, so it cannot overwrite a chapter added meanwhile.
          const saved = rep ? await api.update(id, { ...payload, baseUpdatedAt: rep.updatedAt }) : await api.create(payload);
          putRep(saved);
          toast(editing ? 'Changes saved' : `Saved ${saved.name}`);
          location.hash = `#/rep/${saved.id}`;
        } catch (err) {
          toast(err.message, 'bad');
          saveBtn.disabled = false;
        }
      },
    },
  },
    h('label.field', h('span.field-label', 'Name'), name),
    h('fieldset.segmented',
      h('legend.field-label', 'You play'),
      h('label', sideWhite, h('span', h('span.side-chip.white'), 'White')),
      h('label', sideBlack, h('span', h('span.side-chip.black'), 'Black'))),
    h('div.field', h('span.field-label', 'Moves'), drop),
    editing ? h('p.muted', 'Your memory is stored per position and move, so editing the PGN keeps progress on every move that is still in it.') : null,
    h('div.form-actions', saveBtn, h('a.btn.ghost', { href: editing ? `#/rep/${id}` : '#/' }, 'Cancel')));

  add(page,
    h('a.backlink', { href: editing ? `#/rep/${id}` : '#/' }, rep ? rep.name : 'Library'),
    h('h1.page-title', editing ? 'Edit repertoire' : 'Add a repertoire'),
    editing ? null : h('p.lede', 'Each game in the PGN becomes a chapter. Variations become separate lines, and comments show up while you train. Lichess studies and ChessBase exports work as they are, arrows included.'),
    samplesRow,
    editing ? null : studyRow,
    h('div.import-grid', form, preview));

  if (!editing) {
    api.samples().then((samples) => {
      if (!samples.length) return;
      clear(samplesRow, h('span.muted', 'Or start from a sample: '), samples.map((s) => h('button.btn.small.ghost', {
        type: 'button',
        on: {
          click: () => {
            name.value = s.name;
            (s.color === 'black' ? sideBlack : sideWhite).checked = true;
            pgn.value = s.pgn;
            refresh();
          },
        },
      }, s.name)));
    }).catch(() => {});
  }

  renderPreview(preview, pgn.value, color());
  return () => clearTimeout(timer);
}

function renderPreview(box, text, color) {
  if (!text.trim()) {
    clear(box, h('h2.section-title', 'Preview'), h('p.muted', 'Chapters and lines appear here as you paste.'));
    return;
  }
  const model = buildRepertoire({ pgn: text, color });
  const yourMoves = model.cards.size;
  clear(box,
    h('h2.section-title', 'Preview'),
    h('p.preview-total', `${plural(model.chapters.length, 'chapter')}, ${plural(model.lines.length, 'line')}, ${plural(yourMoves, 'move')} for you to remember`),
    h('ol.preview-chapters', model.chapters.map((c) => h('li', h('span', c.name), h('span.muted', plural(c.lines.length, 'line'))))),
    !model.lines.length && model.chapters.length
      ? h('p.bad', `None of these lines has a move for ${color === 'white' ? 'White' : 'Black'}. Did you pick the right side?`)
      : null,
    model.errors.length ? h('div.preview-errors', h('h3', 'Problems'), h('ul', model.errors.slice(0, 6).map((e) => h('li', e)))) : null);
}
