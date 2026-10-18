// Lichess: connect an account, pick who your opponents are, tune the mistake
// search, and import studies.

import { h, add, clear, toast } from '../ui.js';
import { state, loadLichess, saveSettings, putRep } from '../store.js';
import { api } from '../api.js';
import { describeRatings, describeSpeeds } from '../puzzle-utils.js';

const TOKEN_URL = 'https://lichess.org/account/oauth/token/create?description=Repertoire%20Trainer';

export async function renderLichess(root, { connected, error }) {
  await loadLichess();
  const page = h('div.page.lichessview');
  root.append(page);
  const lc = state.lichess;
  const s = state.settings;

  if (connected && lc.connected) toast(`Connected as ${lc.username}`);

  // ---- connection ---------------------------------------------------------------
  const connection = h('section.lc-section');
  if (lc.connected) {
    const sug = lc.ratingSuggestion;
    add(connection,
      h('h2.section-title', 'Account'),
      h('p', 'Connected as ', h('b', lc.username), lc.via === 'oauth' ? ' (signed in with Lichess).' : ' (personal token).'),
      sug && sug.groups.length ? h('p.muted', `Your ${sug.speed} rating is ${sug.rating}. `,
        h('button.linklike.inline', { type: 'button', on: { click: async () => { await saveSettings({ lichessRatings: sug.groups.join(',') }); toast(`Opponents set to ${describeRatings(sug.groups)}`); dispatchEvent(new HashChangeEvent('hashchange')); } } },
          `Use opponents rated ${describeRatings(sug.groups)}`)) : null,
      h('div.tools-row',
        h('button.btn.ghost', {
          type: 'button',
          on: { click: async () => { await api.lichess.disconnect(); toast('Disconnected from Lichess'); location.hash = '#/lichess'; dispatchEvent(new HashChangeEvent('hashchange')); } },
        }, 'Disconnect')));
  } else {
    const tokenInput = h('input', { type: 'password', placeholder: 'lip_…', autocomplete: 'off', 'aria-label': 'Personal access token' });
    add(connection,
      h('h2.section-title', 'Connect your account'),
      h('p.muted', 'Lichess now only lets signed-in apps read its opening explorer. The trainer needs no special permissions: it reads public game statistics and, if you allow it, your private studies. The token stays in this computer’s data folder.'),
      h('div.tools-row', h('a.btn.primary', { href: '/auth/lichess/start' }, 'Sign in with Lichess')),
      h('details.lc-token',
        h('summary', 'Or paste a personal access token'),
        h('p.muted', h('a', { href: TOKEN_URL, target: '_blank', rel: 'noopener' }, 'Create a token on Lichess'), ' with no scopes ticked (tick “Read private studies” if you want to import those), then paste it here.'),
        h('form.token-row', {
          on: {
            submit: async (e) => {
              e.preventDefault();
              try {
                const st = await api.lichess.connect(tokenInput.value);
                toast(`Connected as ${st.username}`);
                dispatchEvent(new HashChangeEvent('hashchange'));
              } catch (err) { toast(err.message, 'bad'); }
            },
          },
        }, tokenInput, h('button.btn', { type: 'submit' }, 'Save token'))));
  }

  // ---- where the filters live ----------------------------------------------------------
  const filters = h('section.lc-section',
    h('h2.section-title', 'Who your opponents are'),
    h('p', `Rated ${describeSpeeds(s.lichessSpeeds)} games, ${describeRatings(s.lichessRatings)}${s.lichessSince ? `, since ${s.lichessSince}` : ''}.`),
    h('p.muted', 'These filters decide which games the explorer and the mistake finder count.'),
    h('div.tools-row',
      h('a.btn', { href: '#/settings/opponents' }, 'Change opponents'),
      h('a.btn.ghost', { href: '#/settings/finder' }, 'Mistake finder settings')));

  // ---- studies -----------------------------------------------------------------------------
  const studyInput = h('input', { type: 'url', placeholder: 'https://lichess.org/study/…', 'aria-label': 'Study link' });
  const sideSelect = h('select', { 'aria-label': 'You play' }, h('option', { value: '' }, 'Side from the study'), h('option', { value: 'white' }, 'I play White'), h('option', { value: 'black' }, 'I play Black'));
  const studies = h('div.lc-studies');
  const importStudy = async (url, btn) => {
    if (btn) btn.disabled = true;
    try {
      const st = await api.lichess.study(url);
      const color = sideSelect.value || st.orientation || 'white';
      const rep = await api.create({ name: st.name, color, pgn: st.pgn });
      putRep(rep);
      toast(`Imported ${rep.name}`);
      location.hash = `#/rep/${rep.id}`;
    } catch (err) {
      toast(err.message, 'bad');
      if (btn) btn.disabled = false;
    }
  };
  const studySection = h('section.lc-section',
    h('h2.section-title', 'Import a study'),
    h('p.muted', 'Each chapter becomes a chapter here, with comments and arrows. Public studies work without connecting.'),
    h('form.token-row', { on: { submit: (e) => { e.preventDefault(); importStudy(studyInput.value, e.submitter); } } }, studyInput, sideSelect, h('button.btn', { type: 'submit' }, 'Import')),
    studies);

  add(page,
    h('h1.page-title', 'Lichess'),
    error ? h('div.notice.warn', h('p', error)) : null,
    h('div.lc-layout', h('div', connection, filters), studySection));

  if (lc.connected) {
    clear(studies, h('p.muted', 'Loading your studies…'));
    api.lichess.studies().then((list) => {
      if (!list.length) { clear(studies, h('p.muted', 'You have no studies on Lichess yet.')); return; }
      clear(studies, h('h3.field-label', 'Your studies'), h('ul.lc-study-list', list.slice(0, 30).map((st) => h('li',
        h('span', st.name),
        h('button.btn.small.ghost', { type: 'button', on: { click: (e) => importStudy(st.id, e.currentTarget) } }, 'Import')))));
    }).catch((err) => clear(studies, h('p.muted', err.message)));
  }
  return null;
}
