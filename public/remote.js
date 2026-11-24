// Host remote: a phone that controls the game and sees the answers, separate from the
// projected screen. Paired with a single-use code; the remote token lives in this tab's
// sessionStorage only (never in the URL after pairing).
import { api, el, show, stream, serverTime } from '/shared.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
let pin = params.get('pin') || '';
const hashCode = new URLSearchParams(location.hash.slice(1)).get('code');
const KEY = (p) => `blindtest.remote.${p}`;
let token = null;
let last = null;
let es = null;
let busy = false;
let tick = 0;

const PHASES = { LOBBY: '🟣 Lobby', GET_READY: '⏳ Compte à rebours', QUESTION: '🎵 Lecture · réponses ouvertes', REVEAL: '💡 Révélation', SCOREBOARD: '🏆 Classement', ENDED: '🏁 Fin de partie' };
const FLOWS = { manual: 'manuel', 'semi-auto': 'semi-auto', automatic: 'automatique' };

async function pair(code) {
  const r = await api(`/api/games/${encodeURIComponent(pin)}/remote-pair`, { code });
  token = r.remoteToken;
  try { sessionStorage.setItem(KEY(pin), token); } catch { /* ignore */ }
  history.replaceState(null, '', `/host/remote?pin=${pin}`); // drop the code from the address bar
  connect();
}

function connect() {
  es?.close();
  show('s-remote');
  es = stream(`/api/games/${pin}/remote-events?token=${encodeURIComponent(token)}`, render, (ok) => {
    $('r-live').classList.toggle('live', ok); $('r-live').classList.toggle('off', !ok);
    $('r-live').textContent = ok ? 'Connecté' : 'Reconnexion…';
  });
  es.addEventListener('error', async () => {
    if (es.readyState !== EventSource.CLOSED) return;
    try { await api(`/api/games/${pin}`); setTimeout(connect, 2000); }
    catch { $('m-text').textContent = 'Cette partie n’est plus disponible.'; show('s-msg'); }
  });
}

async function send(action, extra = {}, confirmText) {
  if (busy) return; // protection against double taps
  if (confirmText && !confirm(confirmText)) return;
  busy = true;
  document.querySelectorAll('#r-buttons button').forEach((b) => { b.disabled = true; });
  try { await api(`/api/games/${pin}/remote-action`, { token, action, expectState: last?.state, ...extra }); }
  catch (ex) { if (ex.code === 'REMOTE_DENIED') { sessionStorage.removeItem(KEY(pin)); location.reload(); } else if (ex.code !== 'STALE_STATE') alert(ex.message); }
  finally { busy = false; if (last) renderButtons(last); }
}

function info(card, label, x, showAnswer) {
  card.replaceChildren(el('span', { class: 'lbl' }, label));
  if (!x) { card.append(el('span', {}, '—')); return; }
  card.append(el('span', { class: 'big-title' }, x.title || '—'), x.artist ? el('span', {}, `${x.artist}${x.year ? ` · ${x.year}` : ''}`) : null);
  if (x.roundTitle) card.append(el('span', { class: 'sub' }, `${x.roundTitle}${x.multiplier > 1 ? ` · ⭐ x${x.multiplier}` : ''}`));
  if (showAnswer && x.correctText) card.append(el('span', { class: 'answer' }, `✔ ${x.correctText}`));
  if (x.notes) card.append(el('span', { class: 'sub' }, `📝 ${x.notes}`));
}

function renderButtons(m) {
  const b = (label, action, opts = {}) => el('button', { type: 'button', class: opts.cls || '', onclick: () => send(action, opts.extra, opts.confirm) }, label);
  const list = [];
  const s = m.state;
  if (s === 'LOBBY') list.push(b('▶ Lancer la partie', 'start', { cls: 'accent wide' }));
  if (s === 'GET_READY' || s === 'QUESTION') {
    list.push(b(m.paused ? '▶ Reprendre' : '⏸ Pause', m.paused ? 'resume' : 'pause', { cls: 'accent wide' }));
    list.push(b('⏭ Fermer et révéler', 'skip'));
    list.push(b('↺ Recommencer l’extrait', 'restart-track', { confirm: 'Relancer ce morceau ? Les réponses déjà données à ce morceau seront annulées.' }));
  }
  if (s === 'REVEAL') {
    list.push(b('🏆 Afficher le classement', 'next', { cls: 'accent wide' }));
    if (m.flow?.autoAt || m.paused) list.push(b(m.paused ? '▶ Reprendre l’enchaînement' : '⏸ Suspendre l’enchaînement', m.paused ? 'resume' : 'pause'));
  }
  if (s === 'SCOREBOARD') {
    const lastOne = m.secret && m.secret.index + 1 >= m.secret.total;
    list.push(b(lastOne ? '🏁 Résultats finaux' : '⏭ Morceau suivant', 'next', { cls: 'accent wide' }));
    list.push(b('◀ Masquer le classement', 'hide-board'));
    if (m.flow?.autoAt || m.paused) list.push(b(m.paused ? '▶ Reprendre l’enchaînement' : '⏸ Suspendre l’enchaînement', m.paused ? 'resume' : 'pause'));
  }
  if (s !== 'ENDED') {
    list.push(b('🛠 Débloquer', 'recover'));
    list.push(b('■ Terminer', 'end', { cls: 'warn', confirm: 'Terminer la partie maintenant ? Le classement actuel deviendra définitif.' }));
  }
  $('r-buttons').replaceChildren(...list);
}

function render(m) {
  if (m.type !== 'STATE') return;
  last = m;
  $('r-title').textContent = m.title;
  $('r-phase').textContent = m.paused ? '⏸ Pause' : PHASES[m.state] || m.state;
  $('r-flow').textContent = `Enchaînement : ${FLOWS[m.flow?.mode] || 'manuel'}`;
  $('r-flow-select').value = m.flow?.override || '';
  $('r-answers').textContent = m.secret?.answeredCount ?? 0;
  $('r-players').textContent = `${m.connectedCount ?? 0}/${(m.players || []).length}`;
  const revealed = ['REVEAL', 'SCOREBOARD'].includes(m.state);
  info($('r-current'), m.state === 'LOBBY' ? 'Premier morceau' : `Morceau en cours${m.secret ? ` (${m.secret.index + 1}/${m.secret.total})` : ''}`, m.state === 'LOBBY' ? null : m.secret?.current, true);
  info($('r-next'), 'Morceau suivant', m.secret?.next, false);
  const a = m.secret?.audio;
  $('r-audio').textContent = !a ? '—' : `${{ playing: '▶ lecture', paused: '⏸ en pause', ended: '⏹ extrait terminé', loading: '… chargement', error: '⚠️ erreur', blocked: '🔇 bloqué par le navigateur (cliquer sur l’écran)', idle: 'arrêté' }[a.status] || a.status}${a.error ? ` — ${a.error}` : ''}`;
  const amb = m.secret?.ambiguous || [];
  $('r-ambiguous').classList.toggle('hidden', !amb.length || !revealed);
  $('r-ambiguous').replaceChildren(el('span', { class: 'lbl' }, 'Réponses proches à valider'), ...amb.map((x) => el('div', { class: 'amb' },
    el('span', {}, `${x.name} · ${x.label} : « ${x.text} » (attendu : ${x.expected})`),
    el('button', { type: 'button', class: 'small accent', onclick: () => send('accept-answer', { playerId: x.playerId, part: x.key }) }, 'Accepter'))));
  clearInterval(tick);
  const end = m.secret?.endsAt || m.secret?.startsAt;
  const upd = () => { $('r-time').textContent = m.paused ? `${Math.ceil(m.paused.remainingMs / 1000)} s` : end ? `${Math.max(0, Math.ceil((end - serverTime()) / 1000))} s` : '–'; };
  upd();
  if (end && !m.paused) tick = setInterval(upd, 500);
  if (!busy) renderButtons(m);
}

$('r-flow-select').addEventListener('change', (e) => {
  const mode = e.target.value || null;
  if (mode === 'automatic' && !confirm('Activer l’enchaînement entièrement automatique ?')) { e.target.value = last?.flow?.override || ''; return; }
  send('set-flow', { mode });
});

$('pair-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('pair-err').textContent = '';
  pin = $('pair-pin').value.trim();
  try { await pair($('pair-code').value.trim()); } catch (ex) { $('pair-err').textContent = ex.message; }
});

$('btn-admin-pair').addEventListener('click', async () => {
  $('pair-err').textContent = '';
  pin = $('pair-pin').value.trim() || pin;
  try {
    const r = await api(`/api/admin/games/${encodeURIComponent(pin)}/remote-token`, {});
    token = r.remoteToken;
    sessionStorage.setItem(KEY(pin), token);
    history.replaceState(null, '', `/host/remote?pin=${pin}`);
    connect();
  } catch (ex) { $('pair-err').textContent = ex.status === 401 ? 'Connectez-vous d’abord sur /admin dans ce navigateur.' : ex.message; }
});

(async function boot() {
  $('pair-pin').value = pin;
  try { token = sessionStorage.getItem(KEY(pin)); } catch { token = null; }
  if (pin && hashCode) { try { await pair(hashCode); return; } catch (ex) { $('pair-err').textContent = ex.message; } }
  if (pin && token) { connect(); return; }
  try { if ((await api('/api/admin/me')).user) $('btn-admin-pair').classList.remove('hidden'); } catch { /* not an admin */ }
  show('s-pair');
}());
