// Repertoire audit: ask Stockfish about every move you are expected to play.

import { h, clear, sanLabel, toast } from '../ui.js';
import { state, putRep } from '../store.js';
import { evaluate } from '../engine-client.js';
import { scoreToCp } from '../constants.js';
import { api } from '../api.js';

export async function runAudit(box, rep, model, onDone) {
  const cards = [...model.cards.values()];
  const depth = state.settings.auditDepth;
  const threshold = state.settings.auditThreshold;
  const pov = rep.color === 'black' ? -1 : 1;
  let stopped = false;
  const flags = {};
  const progress = h('progress', { max: cards.length, value: 0 });
  const label = h('span.muted', `0 of ${cards.length}`);
  const found = h('ul.audit-list');
  clear(box,
    h('div.audit-head',
      h('div', h('h3.section-title', 'Stockfish is checking your moves'), h('div.audit-progress', progress, label)),
      h('button.btn', { type: 'button', on: { click: () => { stopped = true; } } }, 'Stop')),
    found);

  let checked = 0;
  for (const card of cards) {
    if (stopped || !box.isConnected) break;
    try {
      const res = await evaluate(card.fenBefore, [card.uci], depth);
      const mine = res.moves[0];
      if (mine && mine.score && res.best && res.best.score) {
        const loss = (scoreToCp(res.best.score) - scoreToCp(mine.score)) * pov;
        if (loss >= threshold && res.best.move !== card.uci) {
          const f = {
            loss: Math.round(loss),
            label: sanLabel(card.fenBefore, card.uci),
            bestLabel: sanLabel(card.fenBefore, res.best.move),
            best: res.best.move,
          };
          flags[card.key] = f;
          found.append(h('li', h('span.audit-move', f.label), h('span.audit-loss', `−${(f.loss / 100).toFixed(2)}`), h('span.audit-alt', `Stockfish prefers ${f.bestLabel}`)));
        }
      }
    } catch (err) {
      toast(`Audit stopped: ${err.message}`, 'bad');
      break;
    }
    checked++;
    progress.value = checked;
    label.textContent = `${checked} of ${cards.length}`;
  }

  if (!box.isConnected) return;
  if (checked === 0) { onDone(); return; }
  const audit = { at: new Date().toISOString(), depth, threshold, checked, complete: checked === cards.length, flags };
  const updated = await api.update(rep.id, { audit });
  rep.audit = updated.audit;
  putRep({ ...updated, cards: rep.cards });
  toast(checked === cards.length ? 'Audit complete' : `Audit stopped after ${checked} moves`);
  onDone();
}
