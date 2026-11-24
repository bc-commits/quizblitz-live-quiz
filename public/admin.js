// Administration single-page app: dashboard, blind tests, games, media and settings.
import { api, el, brand } from '/shared.js';
import { ExcerptPlayer } from '/audio-player.js';
import { renderEditor as renderBlindTestEditor } from '/admin-editor.js';
import { registerEditorHooks, renderLibrary, resizeImage } from '/admin-library.js';

const $ = (id) => document.getElementById(id);
const view = () => $('view');
const HOST_SESSION_KEY = 'quizblitz.hosting'; // read by host.js to resume a game

const STATE_LABELS = { LOBBY: 'Lobby', GET_READY: 'Compte à rebours', QUESTION: 'Réponses ouvertes', REVEAL: 'Révélation', SCOREBOARD: 'Classement', ENDED: 'Terminée' };

let me = null;
let leaveGuard = null; // returns a message if the current view has unsaved changes

// ---------------------------------------------------------------- helpers

function toast(text, bad = false) {
  const t = $('toast');
  t.textContent = text;
  t.classList.toggle('err', bad);
  t.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add('hidden'), bad ? 6000 : 2800);
}

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtSize = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`);
const btn = (label, onclick, cls = 'small') => el('button', { class: cls, type: 'button', onclick }, label);
const field = (label, input, help) => el('label', { class: 'field' }, label, input, help ? el('small', {}, help) : null);
const check = (label, checked, onchange) => {
  const box = el('input', { type: 'checkbox', onchange: (e) => onchange(e.target.checked) });
  box.checked = !!checked;
  return el('label', { class: 'field inline' }, box, label);
};
function select(options, value, onchange) {
  const s = el('select', { onchange: (e) => onchange(e.target.value) }, ...options.map(([v, l]) => el('option', { value: v }, l)));
  s.value = value ?? '';
  return s;
}
/** replaceChildren() that skips null/false (replaceChildren would print them as text). */
const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
const page = (title, ...children) => fill(view(), el('h1', { class: 'page' }, title), ...children);

/** Uploads a file as raw bytes; the server checks its real type. */
// Images are resized in the browser before upload (the server still checks type and size).
const RESIZE = { logo: [1200, 1200], cover: [1000, 1000], home: [1920, 1920] };

async function upload(kind, file, purpose) {
  if (kind === 'image' && RESIZE[purpose]) file = await resizeImage(file, ...RESIZE[purpose]);
  const res = await fetch(`/api/admin/media?kind=${encodeURIComponent(kind)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'X-QuizBlitz': '1', 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Échec du téléversement (${res.status})`);
  return data.media;
}

function pickFile(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept, class: 'hidden' });
    if (multiple) input.multiple = true;
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

/** Launch dialog: optional team mode, then the host screen opens. */
function launchGame(blindTestId) {
  const t = { enabled: false, count: 2, assignment: 'auto', method: '', topN: 3, lockOnStart: true, names: [] };
  const namesBox = el('div', { class: 'grid4' });
  const drawNames = () => namesBox.replaceChildren(...Array.from({ length: t.count }, (_, i) => el('input', { maxlength: '24', placeholder: `Équipe ${i + 1} (nom par défaut)`, value: t.names[i] || '', 'aria-label': `Nom de l’équipe ${i + 1}`, oninput: (e) => { t.names[i] = e.target.value; } })));
  const teamBox = el('div', { class: 'stack hidden' },
    el('div', { class: 'grid4' },
      field('Nombre d’équipes', select(['2', '3', '4', '5', '6', '7', '8'].map((n) => [n, n]), '2', (v) => { t.count = Number(v); drawNames(); })),
      field('Affectation', select([['auto', 'Automatique équilibrée'], ['free', 'Choix libre au lobby'], ['host', 'Par l’animateur']], 'auto', (v) => { t.assignment = v; })),
      field('Score d’équipe', select([['', 'Recommandé (somme si auto, sinon moyenne)'], ['sum', 'Somme des scores'], ['average', 'Moyenne des membres'], ['top-n', 'Somme des N meilleurs']], '', (v) => { t.method = v; })),
      field('N (top-n)', el('input', { type: 'number', min: '1', max: '10', value: '3', oninput: (e) => { t.topN = Number(e.target.value); } }))),
    check('Verrouiller les équipes au lancement', true, (v) => { t.lockOnStart = v; }),
    namesBox);
  drawNames();
  const overlay = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Lancer une partie' });
  const close = () => overlay.remove();
  overlay.append(el('div', { class: 'card stack modal-card', style: 'width:min(640px,100%)' },
    el('h2', { style: 'margin:0' }, '▶ Lancer une partie'),
    check('Mode équipes', false, (v) => { t.enabled = v; teamBox.classList.toggle('hidden', !v); }),
    teamBox,
    el('p', { class: 'hint' }, 'L’écran animateur va s’ouvrir : affichez-le sur le vidéoprojecteur. Vous pourrez ensuite associer votre téléphone comme télécommande.'),
    el('div', { class: 'row' }, el('span', { class: 'grow' }), btn('Annuler', close, 'ghost'), btn('Lancer', async () => {
      try {
        const teams = t.enabled ? { ...t, method: t.method || undefined, names: t.names.slice(0, t.count) } : undefined;
        const { pin, hostKey } = await api('/api/games', { blindTestId, options: { teams } });
        try { sessionStorage.setItem(HOST_SESSION_KEY, JSON.stringify({ pin, hostKey })); } catch { /* ignore */ }
        location.href = `/host?pin=${pin}`;
      } catch (ex) { toast(ex.message, true); }
    }, 'accent'))));
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.append(overlay);
}

async function resumeGame(pin) {
  try {
    const { hostKey } = await api(`/api/admin/games/${pin}/host-key`, {});
    sessionStorage.setItem(HOST_SESSION_KEY, JSON.stringify({ pin, hostKey }));
    location.href = `/host?pin=${pin}`;
  } catch (ex) { toast(ex.message, true); }
}

function download(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- auth

async function boot() {
  try { me = (await api('/api/admin/me')).user; } catch { me = null; }
  if (!me) { $('login').classList.remove('hidden'); $('app').classList.add('hidden'); $('login-email').focus(); return; }
  $('login').classList.add('hidden');
  $('app').classList.remove('hidden');
  $('who').textContent = me.email;
  route();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-err').textContent = '';
  try {
    await api('/api/admin/login', { email: $('login-email').value, password: $('login-pass').value });
    $('login-pass').value = '';
    boot();
  } catch (ex) { $('login-err').textContent = ex.message; }
});
$('btn-logout').addEventListener('click', async () => { await api('/api/admin/logout', {}); location.hash = ''; location.reload(); });
$('nav-toggle').addEventListener('click', () => $('nav').classList.toggle('open'));

// ---------------------------------------------------------------- router

const routes = [
  [/^#\/dashboard$/, 'dashboard', renderDashboard],
  [/^#\/blindtests$/, 'blindtests', renderBlindTests],
  [/^#\/blindtests\/new$/, 'new', () => renderEditor(null)],
  [/^#\/blindtests\/([\w-]+)$/, 'blindtests', (m) => renderEditor(m[1])],
  [/^#\/import$/, 'import', renderImport],
  [/^#\/games$/, 'games', renderGames],
  [/^#\/media\/(audio|image|favicon|unused)$/, null, (m) => renderMedia(m[1])],
  [/^#\/library$/, 'library', () => renderLibrary(libCtx(), 'list')],
  [/^#\/library\/new$/, 'library-new', () => renderLibrary(libCtx(), 'new')],
  [/^#\/library\/import$/, 'library-import', () => renderLibrary(libCtx(), 'import')],
  [/^#\/library\/edit\/([\w-]+)$/, 'library', (m) => renderLibrary(libCtx(), 'edit', m[1])],
  [/^#\/audit$/, 'audit', renderAudit],
  [/^#\/reports\/(\d+)$/, 'history', (m) => renderReport(m[1])],
  [/^#\/settings\/(general|appearance|game)$/, null, (m) => renderSettings(m[1])],
];

let currentHash = '';
function route() {
  if (!me) return;
  const hash = location.hash || '#/dashboard';
  if (leaveGuard && hash !== currentHash) {
    const msg = leaveGuard();
    if (msg && !confirm(msg)) { history.replaceState(null, '', currentHash); return; }
  }
  leaveGuard = null;
  previewPlayer.stop();
  currentHash = hash;
  $('nav').classList.remove('open');
  for (const [re, nav, fn] of routes) {
    const m = re.exec(hash);
    if (!m) continue;
    const key = nav || hash.slice(2).replace('/', '-');
    document.querySelectorAll('[data-nav]').forEach((a) => a.toggleAttribute('aria-current', a.dataset.nav === key));
    document.querySelectorAll('[aria-current]').forEach((a) => a.setAttribute('aria-current', 'page'));
    Promise.resolve(fn(m)).catch((ex) => page('Erreur', el('p', { class: 'errors' }, ex.message)));
    return;
  }
  location.hash = '#/dashboard';
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => { if (leaveGuard && leaveGuard()) e.preventDefault(); });

// ---------------------------------------------------------------- dashboard

let dashboardTimer = 0;
async function renderDashboard() {
  clearTimeout(dashboardTimer);
  const d = await api('/api/admin/dashboard');
  // Light polling (every 8 s) while the dashboard is open; stops as soon as another page opens.
  dashboardTimer = setTimeout(() => { if ((location.hash || '#/dashboard') === '#/dashboard') renderDashboard().catch(() => {}); }, 8000);
  const b = d.backend;
  const mb = (bytes) => `${Math.round(bytes / 1048576).toLocaleString('fr-FR')} Mo`;
  const disconnected = d.activeGames.reduce((n, g) => n + (g.state === 'ENDED' ? 0 : g.disconnected), 0);
  const s = d.stats;
  const stat = (n, label) => el('div', { class: 'stat' }, el('b', {}, n), el('span', {}, label));
  page('Tableau de bord',
    d.warnings.length ? el('div', { class: 'warnings' }, el('b', {}, '⚠️ Points de configuration à vérifier'), el('ul', {}, ...d.warnings.map((w) => el('li', {}, w)))) : null,
    el('div', { class: 'stats' },
      stat(s.blindTests, 'blind tests actifs'), stat(s.tracks, 'morceaux'), stat(s.activeGames, 'parties en cours'),
      stat(s.connectedPlayers, 'joueurs connectés'), stat(disconnected, 'déconnectés (temporaire)'), stat(s.gamesPlayed, 'parties jouées'), stat(s.libraryTracks, 'morceaux en bibliothèque')),
    el('div', { class: 'card stack', style: 'margin-bottom:16px' }, el('b', {}, '🖥️ Serveur'),
      el('div', { class: 'meta' }, `En ligne depuis ${Math.round(b.uptime / 60)} min · mémoire ${b.memoryMb} Mo · Node ${b.node} · ${b.media.count} média(s), ${mb(b.media.bytes)}${b.disk ? ` · disque libre ${mb(b.disk.freeBytes)} / ${mb(b.disk.totalBytes)}` : ''}`),
      d.recentErrors.length ? el('details', {}, el('summary', {}, `⚠️ ${d.recentErrors.length} erreur(s) récente(s)`), el('ul', {}, ...d.recentErrors.map((e) => el('li', {}, `${fmtDate(e.at)} — ${e.message}`)))) : el('span', { class: 'meta' }, 'Aucune erreur récente ✓'),
      el('span', { class: 'meta' }, 'Actualisation automatique toutes les 8 secondes.')),
    el('div', { class: 'toolbar' },
      el('a', { class: 'btn accent', href: '#/blindtests/new' }, '➕ Créer un blind test'),
      el('a', { class: 'btn ghost', href: '#/blindtests' }, '▶ Lancer une partie'),
      el('a', { class: 'btn ghost', href: '#/settings/appearance' }, '🎨 Personnaliser l’apparence')),
    el('h2', {}, 'Parties en cours'),
    gamesList(d.activeGames),
    el('h2', { style: 'margin-top:20px' }, 'Historique récent'),
    d.recentGames.length ? el('div', { class: 'list' }, ...d.recentGames.map((g) => el('div', { class: 'item' },
      el('div', { class: 'grow' }, el('div', { class: 'title' }, g.title), el('div', { class: 'meta' }, `${fmtDate(g.endedAt)} · ${g.players} joueur(s) · ${g.completed ? 'terminée' : 'interrompue'}`)),
      el('a', { class: 'btn ghost small', href: g.kind === 'music-blind-test' ? `#/reports/${g.id}` : `/reports?id=${g.id}` }, 'Rapport'))))
      : el('p', { class: 'muted' }, 'Aucune partie terminée pour le moment.'));
}

function gamesList(list, refresh) {
  if (!list.length) return el('p', { class: 'muted' }, 'Aucune partie en cours.');
  return el('div', { class: 'list' }, ...list.map((g) => el('div', { class: 'item' },
    el('div', { class: 'grow' },
      el('div', { class: 'title' }, `${g.title} `, el('span', { class: 'tag' }, `PIN ${g.pin}`), ' ', el('span', { class: `tag ${g.state === 'ENDED' ? '' : 'ok'}` }, g.paused ? 'Pause' : STATE_LABELS[g.state] || g.state)),
      el('div', { class: 'meta' }, `${g.connected}/${g.players} joueur(s) connecté(s)${g.answered !== null ? ` · ${g.answered} réponse(s)` : ''}${g.teams ? ` · ${g.teams} équipes` : ''} · morceau ${Math.min(g.question, g.questions)}/${g.questions} · animateur ${g.hostConnected ? 'connecté' : 'déconnecté'} · créée ${fmtDate(g.createdAt)}`)),
    g.state !== 'ENDED' ? btn('Reprendre l’animation', () => resumeGame(g.pin), 'small accent') : null,
    g.state !== 'ENDED' ? btn('Terminer', async () => {
      if (!confirm(`Terminer la partie ${g.pin} ? Le classement actuel deviendra définitif.`)) return;
      await api(`/api/admin/games/${g.pin}/end`, {}); toast('Partie terminée'); (refresh || route)();
    }, 'small ghost') : null,
    btn('Supprimer', async () => {
      if (!confirm(`Supprimer la partie ${g.pin} ? Les joueurs seront déconnectés. Les parties terminées restent dans l’historique.`)) return;
      await api(`/api/admin/games/${g.pin}`, undefined, 'DELETE'); toast('Partie supprimée'); (refresh || route)();
    }, 'small ghost'))));
}

async function renderGames() {
  const { games } = await api('/api/admin/games');
  page('Parties en cours',
    el('div', { class: 'toolbar' }, btn('↻ Actualiser', renderGames, 'small ghost'), el('a', { class: 'btn ghost small', href: '/reports' }, '🕘 Historique et rapports')),
    gamesList(games, renderGames));
}

// ---------------------------------------------------------------- blind test list

async function renderBlindTests() {
  const { blindTests } = await api('/api/admin/blind-tests');
  let showArchived = false;
  const listBox = el('div', { class: 'list' });
  const draw = () => {
    const shown = blindTests.filter((b) => b.archived === showArchived);
    listBox.replaceChildren(...(shown.length ? shown.map((b) => el('div', { class: 'item' },
      el('div', { class: 'grow' },
        el('div', { class: 'title' }, b.title, b.archived ? el('span', { class: 'tag', style: 'margin-left:8px' }, 'archivé') : null),
        el('div', { class: 'meta' }, `${b.rounds} manche(s) · ${b.tracks} morceau(x) · joué ${b.plays} fois · modifié ${fmtDate(b.updatedAt)}`),
        b.description ? el('div', { class: 'meta' }, b.description) : null),
      b.archived ? null : btn('▶ Lancer', () => launchGame(b.id), 'small accent'),
      el('a', { class: 'btn ghost small', href: `#/blindtests/${b.id}` }, '✏️ Modifier'),
      btn('⧉ Dupliquer', async () => { await api(`/api/admin/blind-tests/${b.id}/duplicate`, {}); toast('Blind test dupliqué'); renderBlindTests(); }, 'small ghost'),
      el('a', { class: 'btn ghost small', href: `/api/admin/blind-tests/${b.id}/export` }, '⬇ Exporter'),
      btn(b.archived ? '↩ Désarchiver' : '🗄 Archiver', async () => { await api(`/api/admin/blind-tests/${b.id}/archive`, { archived: !b.archived }); renderBlindTests(); }, 'small ghost'),
      btn('🗑 Supprimer', async () => {
        if (!confirm(`Supprimer définitivement « ${b.title} » ? Les fichiers audio qui ne servent plus ailleurs seront aussi supprimés. Cette action est irréversible.`)) return;
        await api(`/api/admin/blind-tests/${b.id}`, undefined, 'DELETE'); toast('Blind test supprimé'); renderBlindTests();
      }, 'small ghost')))
      : [el('p', { class: 'muted' }, showArchived ? 'Aucun blind test archivé.' : 'Aucun blind test. Créez-en un ou importez l’exemple fourni (docs/exemples).')]));
  };
  const tabs = select([['0', 'Actifs'], ['1', 'Archivés']], '0', (v) => { showArchived = v === '1'; draw(); });
  tabs.style.width = 'auto';
  page('Blind tests',
    el('div', { class: 'toolbar' }, el('a', { class: 'btn accent small', href: '#/blindtests/new' }, '➕ Nouveau'), el('a', { class: 'btn ghost small', href: '#/import' }, '📥 Importer'), el('span', { class: 'grow' }), tabs),
    listBox);
  draw();
}

// ---------------------------------------------------------------- import

function renderImport() {
  const out = el('div', { class: 'stack' });
  let parsed = null;
  const importBtn = btn('Importer ce blind test', async () => {
    try {
      const r = await api('/api/admin/blind-tests', { blindTest: parsed });
      toast(`Importé : ${r.blindTest.title}`);
      location.hash = `#/blindtests/${r.id}`;
    } catch (ex) { toast(ex.message, true); }
  }, 'accent');
  importBtn.disabled = true;
  const choose = btn('Choisir un fichier JSON…', async () => {
    const [file] = await pickFile('application/json,.json');
    if (!file) return;
    importBtn.disabled = true;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error('Fichier trop volumineux (2 Mo maximum)');
      parsed = JSON.parse(await file.text());
      const v = await api('/api/admin/blind-tests/validate', { blindTest: parsed });
      fill(out,
        el('p', {}, el('b', {}, file.name), ` · ${v.tracks} morceau(x)`),
        v.errors.length ? el('div', { class: 'errors' }, el('b', {}, `${v.errors.length} erreur(s) à corriger avant l’import`), el('ul', {}, ...v.errors.slice(0, 30).map((x) => el('li', {}, x.message)))) : el('p', { class: 'tag ok' }, 'Format valide ✓'),
        v.warnings.length ? el('div', { class: 'warnings' }, el('ul', {}, ...v.warnings.map((x) => el('li', {}, x.message)))) : null);
      importBtn.disabled = v.errors.length > 0;
    } catch (ex) { out.replaceChildren(el('div', { class: 'errors' }, `Fichier illisible : ${ex.message}`)); }
  }, 'ghost');
  const demo = btn('Importer le blind test de démonstration', async () => {
    try {
      const data = await (await fetch('/exemples/blindtest-demo.json')).json();
      const r = await api('/api/admin/blind-tests', { blindTest: data });
      toast('Blind test de démonstration importé');
      location.hash = `#/blindtests/${r.id}`;
    } catch (ex) { toast(ex.message, true); }
  }, 'ghost');
  page('Importer un blind test',
    el('div', { class: 'card stack' },
      el('div', { class: 'toolbar' }, demo, el('span', { class: 'hint' }, '3 mélodies synthétisées libres de droits, pour tester tout de suite.')),
      el('p', { class: 'hint' }, 'Format « music-blind-test » décrit dans docs/FORMAT_BLIND_TEST.md. Un exemple prêt à l’emploi est fourni dans docs/exemples/blindtest-exemple.json. Les fichiers audio référencés doivent être accessibles (téléversés dans Médias, placés dans public/audio, ou liens https).'),
      el('div', { class: 'toolbar' }, choose, importBtn), out));
}

// ---------------------------------------------------------------- blind test editor

const previewPlayer = new ExcerptPlayer({ fadeIn: 0.3, fadeOut: 0.6 });
const editorHooks = {};
const libCtx = () => ({ page, field, select, check, btn, toast, upload, pickFile, fmtDate, previewPlayer });
registerEditorHooks(editorHooks, libCtx());

function renderEditor(id) {
  return renderBlindTestEditor(id, {
    page, field, select, check, btn, toast, upload, pickFile, launchGame, download, fmtDate, previewPlayer,
    setLeaveGuard: (fn) => { leaveGuard = fn; }, hooks: editorHooks,
  });
}

// ---------------------------------------------------------------- media

async function renderMedia(kind) {
  const titles = { audio: 'Fichiers audio', image: 'Images et logos', favicon: 'Favicons' };
  const accepts = { audio: 'audio/*,.mp3,.m4a,.ogg,.wav', image: 'image/png,image/jpeg,image/webp', favicon: 'image/png,image/x-icon,.ico' };
  const hints = {
    audio: 'MP3, M4A/AAC, OGG ou WAV, 25 Mo maximum. N’ajoutez que des musiques que vous avez le droit de diffuser.',
    image: 'PNG, JPEG ou WebP, 2 Mo maximum. Le SVG est refusé pour des raisons de sécurité.',
    favicon: 'PNG ou ICO, 512 Ko maximum (idéalement carré, 64×64 ou plus).',
  };
  titles.unused = 'Médias inutilisés';
  hints.unused = 'Fichiers qui ne servent plus nulle part (paramètres, blind tests, bibliothèque). Vous pouvez les supprimer sans risque.';
  const all = (await api(`/api/admin/media${kind === 'unused' ? '' : `?kind=${kind}`}`)).media;
  const media = kind === 'unused' ? all.filter((m) => !m.inUse) : all;
  page(titles[kind],
    el('div', { class: 'toolbar' }, kind === 'unused' ? null :
      btn('⬆ Téléverser…', async () => {
        const files = await pickFile(accepts[kind], true);
        let ok = 0;
        for (const f of files) { try { await upload(kind, f); ok++; } catch (ex) { toast(`${f.name} : ${ex.message}`, true); } }
        if (ok) toast(`${ok} fichier(s) téléversé(s)`);
        renderMedia(kind);
      }, 'accent small'),
      el('span', { class: 'hint' }, hints[kind])),
    media.length ? el('div', { class: 'list' }, ...media.map((m) => el('div', { class: 'item' },
      m.kind === 'audio' ? el('audio', { controls: '', preload: 'none', src: m.url, style: 'max-width:260px' }) : el('div', { class: 'img-field' }, el('span', { class: 'thumb' }, el('img', { src: m.url, alt: '' }))),
      el('div', { class: 'grow' }, el('div', { class: 'title' }, m.originalName), el('div', { class: 'meta' }, `${fmtSize(m.size)} · ${fmtDate(m.createdAt)} · ${m.url}`)),
      el('span', { class: `tag ${m.inUse ? 'ok' : ''}` }, m.inUse ? 'utilisé' : 'inutilisé'),
      btn('📋 Copier l’URL', () => navigator.clipboard?.writeText(m.url).then(() => toast('URL copiée')), 'small ghost'),
      btn('🗑 Supprimer', async () => {
        if (!confirm(`Supprimer définitivement « ${m.originalName} » ?`)) return;
        try { await api(`/api/admin/media/${m.id}`, undefined, 'DELETE'); toast('Fichier supprimé'); renderMedia(kind); } catch (ex) { toast(ex.message, true); }
      }, 'small ghost')))) : el('p', { class: 'muted' }, 'Aucun fichier.'));
}

// ---------------------------------------------------------------- audit log

async function renderAudit() {
  const f = { page: 1, pageSize: 50, action: '' };
  const list = el('div');
  const pager = el('div', { class: 'row' });
  const LABELS = { 'admin.login': 'Connexion', 'admin.login_failed': 'Échec de connexion', 'admin.logout': 'Déconnexion', 'settings.update': 'Paramètres modifiés',
    'settings.reset_theme': 'Thème restauré', 'media.upload': 'Média téléversé', 'media.delete': 'Média supprimé', 'library.create': 'Morceau créé', 'library.update': 'Morceau modifié',
    'library.archive': 'Morceau archivé', 'library.unarchive': 'Morceau désarchivé', 'library.delete': 'Morceau supprimé', 'library.import': 'Import bibliothèque',
    'blindtest.create': 'Blind test créé', 'blindtest.update': 'Blind test modifié', 'blindtest.archive': 'Blind test archivé', 'blindtest.unarchive': 'Blind test désarchivé',
    'blindtest.delete': 'Blind test supprimé', 'blindtest.convert': 'Blind test lié à la bibliothèque', 'game.resume': 'Partie reprise', 'game.remote': 'Télécommande ouverte',
    'game.end': 'Partie terminée (forcée)', 'game.delete': 'Partie supprimée', 'game.kick': 'Joueur exclu', 'game.accept_answer': 'Réponse validée à la main' };
  async function load() {
    const r = await api(`/api/admin/audit?page=${f.page}&pageSize=${f.pageSize}&action=${encodeURIComponent(f.action)}`);
    list.replaceChildren(el('table', { class: 'report-table' },
      el('thead', {}, el('tr', {}, ...['Date', 'Qui', 'Action', 'Ressource', 'Détail', 'IP'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...r.items.map((x) => el('tr', {}, el('td', {}, fmtDate(x.at)), el('td', {}, x.actor || '—'), el('td', {}, LABELS[x.action] || x.action),
        el('td', {}, [x.resourceType, x.resourceId].filter(Boolean).join(' ')), el('td', {}, x.summary), el('td', {}, x.ip || ''))))));
    const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
    pager.replaceChildren(btn('◀', () => { if (f.page > 1) { f.page--; load(); } }, 'small ghost'), el('span', { class: 'sub' }, `Page ${r.page}/${pages} · ${r.total} entrée(s)`), btn('▶', () => { if (f.page < pages) { f.page++; load(); } }, 'small ghost'));
  }
  const filter = select([['', 'Toutes les actions'], ['admin', 'Connexions'], ['settings', 'Paramètres'], ['media', 'Médias'], ['library', 'Bibliothèque'], ['blindtest', 'Blind tests'], ['game', 'Parties']], '', (v) => { f.action = v; f.page = 1; load(); });
  filter.style.width = 'auto';
  page('Journal d’audit', el('p', { class: 'hint' }, 'Actions importantes des administrateurs. Aucun mot de passe, cookie, jeton ou contenu de fichier n’y est enregistré. L’adresse IP n’est conservée que pour les échecs de connexion. Conservation : AUDIT_RETENTION_DAYS (180 jours par défaut).'),
    el('div', { class: 'toolbar' }, filter), list, pager);
  load();
}

// ---------------------------------------------------------------- blind test report

async function renderReport(id) {
  const r = await api(`/api/admin/reports/${id}`);
  const pctTxt = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)} %`);
  const sec = (ms) => (ms === null || ms === undefined ? '—' : `${(ms / 1000).toFixed(1).replace('.', ',')} s`);
  const h = r.highlights;
  const fact = (label, value) => el('div', { class: 'stat' }, el('span', {}, label), el('b', { style: 'font-size:18px' }, value || '—'));
  const table = (head, rows) => el('table', { class: 'report-table' }, el('thead', {}, el('tr', {}, ...head.map((x) => el('th', {}, x)))), el('tbody', {}, ...rows.map((row) => el('tr', {}, ...row.map((c) => el('td', {}, c ?? '—'))))));
  page(`Rapport : ${r.title}`,
    el('div', { class: 'toolbar no-print' },
      btn('🖨 Imprimer', () => window.print(), 'accent small'),
      el('a', { class: 'btn ghost small', href: `/api/admin/reports/${id}?format=csv` }, '⬇ CSV'),
      el('a', { class: 'btn ghost small', href: `/api/admin/reports/${id}?format=json` }, '⬇ JSON'),
      el('a', { class: 'btn ghost small', href: `/reports?id=${id}` }, 'Rapport détaillé par question')),
    el('p', { class: 'muted' }, `${fmtDate(r.startedAt)} → ${fmtDate(r.endedAt)} · PIN ${r.pin} · ${r.completed ? 'partie terminée' : 'partie interrompue'}`),
    el('div', { class: 'stats' },
      fact('Participants', r.summary.participants), fact('Morceaux joués', `${r.summary.tracks}/${r.summary.tracksInBlindTest}`), fact('Réponses', r.summary.totalAnswers),
      fact('Taux de réponse', pctTxt(r.summary.responseRate)), fact('Bonnes réponses', pctTxt(r.summary.correctRate)), fact('Temps moyen', sec(r.summary.avgResponseMs)),
      fact('Durée', `${Math.round(r.summary.durationMs / 60000)} min`), fact('Reconnexions', r.summary.reconnections)),
    el('h2', {}, '✨ Faits marquants'),
    el('div', { class: 'stats' },
      fact('Podium', h.podium.map((p) => `${p.rank}. ${p.name}`).join(' · ')),
      fact('Meilleure série', h.bestStreak && h.bestStreak.bestStreak ? `${h.bestStreak.name} (${h.bestStreak.bestStreak})` : '—'),
      fact('Réponse juste la plus rapide', h.fastestCorrect ? `${h.fastestCorrect.name} (${sec(h.fastestCorrect.ms)})` : '—'),
      fact('Plus forte progression', h.biggestProgression ? `${h.biggestProgression.name} (+${h.biggestProgression.progression} places)` : '—'),
      fact('Joueur le plus régulier', h.mostRegular ? `${h.mostRegular.name} (${h.mostRegular.correct} bonnes réponses)` : '—'),
      fact('Morceau le mieux reconnu', h.bestTrack ? `${h.bestTrack.title} (${pctTxt(h.bestTrack.recognitionRate)})` : '—'),
      fact('Morceau le moins reconnu', h.worstTrack ? `${h.worstTrack.title} (${pctTxt(h.worstTrack.recognitionRate)})` : '—'),
      h.winningTeam ? fact('Équipe gagnante', `${h.winningTeam.icon} ${h.winningTeam.name} (${h.winningTeam.score})`) : null),
    r.teams ? el('h2', {}, `👥 Équipes (score : ${{ sum: 'somme', average: 'moyenne', 'top-n': 'meilleurs joueurs' }[r.teams.method] || r.teams.method})`) : null,
    r.teams ? table(['Équipe', 'Membres', 'Score', 'Meilleur joueur'], r.teams.list.map((t) => [`${t.icon} ${t.name}`, t.members, t.score.toLocaleString('fr-FR'), t.best ? `${t.best.name} (${t.best.score})` : '—'])) : null,
    el('h2', {}, '🏆 Classement'),
    table(['Rang', 'Joueur', 'Équipe', 'Score', 'Bonnes', 'Répondu', 'Série max', 'Temps moyen', 'Progression'],
      r.players.map((p) => [p.rank, p.name, p.team || '—', p.score.toLocaleString('fr-FR'), p.correct, p.answered, p.bestStreak, sec(p.avgMs), p.progression > 0 ? `+${p.progression}` : String(p.progression)])),
    el('h2', {}, '🎵 Par morceau'),
    table(['#', 'Morceau', 'Manche', 'Reconnu', 'Artiste', 'Titre', 'Temps moyen', 'Sans réponse', 'Difficulté', 'Mauvaises réponses fréquentes'],
      r.tracks.map((t) => [t.index + 1, `${t.title}${t.artist ? ` — ${t.artist}` : ''}${t.multiplier > 1 ? ` (x${t.multiplier})` : ''}`, t.roundTitle, pctTxt(t.recognitionRate), pctTxt(t.artistRate), pctTxt(t.titleRate), sec(t.avgMs), t.noAnswer, t.difficulty || '—',
        Object.values(t.wrongAnswers).flat().map((w) => `${w.text} (${w.count})`).join(', ') || '—'])));
}

// ---------------------------------------------------------------- settings

function hexToRgb(h) { return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)); }
function lum(hex) { const [r, g, b] = hexToRgb(hex).map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; }
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const ink = (bg) => (ratio(bg, '#ffffff') >= ratio(bg, '#14101f') ? '#ffffff' : '#14101f');

const COLORS = [
  ['primaryColor', 'Couleur principale', 'Boutons principaux'],
  ['secondaryColor', 'Couleur secondaire', 'Dégradé du fond, boutons secondaires'],
  ['accentColor', 'Couleur d’accentuation', 'Slogan, minuteur, mises en avant'],
  ['backgroundColor', 'Couleur de fond', ''],
  ['surfaceColor', 'Couleur des cartes', ''],
  ['textColor', 'Texte principal', 'Texte sur les cartes'],
  ['mutedTextColor', 'Texte secondaire', ''],
];
const IMAGES = [
  ['logoUrl', 'Logo principal', 'image'], ['darkLogoUrl', 'Logo pour fond sombre (facultatif)', 'image'],
  ['faviconUrl', 'Favicon', 'favicon'], ['homeImageUrl', 'Image de la page d’accueil', 'image'],
];

async function renderSettings(section) {
  const { settings, defaults } = await api('/api/admin/settings');
  const draft = structuredClone(settings);
  let dirty = false;
  const status = el('span', { class: 'sub' });
  leaveGuard = () => (dirty ? 'Des paramètres ne sont pas enregistrés. Quitter quand même ?' : null);
  const changed = () => { dirty = true; status.textContent = 'Modifications non enregistrées'; drawPreview(); };
  const text = (key, max, attrs = {}) => {
    const n = el(attrs.multiline ? 'textarea' : 'input', { maxlength: String(max), oninput: (e) => { draft[key] = e.target.value; changed(); } });
    n.value = draft[key] ?? '';
    return n;
  };

  async function save(fields) {
    try {
      const patch = Object.fromEntries(fields.map((k) => [k, draft[k]]));
      const r = await api('/api/admin/settings', { settings: patch }, 'PUT');
      Object.assign(draft, r.settings);
      dirty = false;
      status.textContent = `Enregistré ✓ ${new Date().toLocaleTimeString('fr-FR')} — visible immédiatement par les nouveaux visiteurs`;
      toast('Paramètres enregistrés');
    } catch (ex) { toast(ex.message, true); }
  }

  // ---- live preview (appearance)
  const preview = el('div', { class: 'preview' });
  function drawPreview() {
    if (section !== 'appearance') return;
    const light = draft.themeMode === 'light';
    const bg = light ? '#f3f0ff' : draft.backgroundColor;
    const logo = draft.logoUrl ? el('img', { src: draft.logoUrl, alt: draft.appName }) : draft.appName;
    const pv = el('div', { class: 'pv', style: [
      `--pv-bg:linear-gradient(160deg, ${light ? '#ffffff' : draft.secondaryColor}, ${bg} 65%)`, `--pv-on-bg:${ink(bg)}`,
      `--pv-surface:${draft.surfaceColor}`, `--pv-text:${draft.textColor}`, `--pv-muted:${draft.mutedTextColor}`,
      `--pv-primary:${draft.primaryColor}`, `--pv-primary-ink:${ink(draft.primaryColor)}`,
      `--pv-secondary:${draft.secondaryColor}`, `--pv-secondary-ink:${ink(draft.secondaryColor)}`,
      `--pv-accent:${draft.accentColor}`, `--pv-radius:${draft.buttonRadius}px`].join(';') },
    el('div', { class: 'pv-logo' }, logo),
    draft.tagline ? el('p', { class: 'pv-tag' }, draft.tagline) : null,
    el('div', { class: 'pv-card' }, el('b', {}, 'Exemple de carte'), el('small', {}, 'Texte secondaire sur une carte'),
      el('div', { class: 'pv-btn pv-primary' }, 'Bouton principal'), el('div', { class: 'pv-btn pv-secondary' }, 'Bouton secondaire')),
    el('small', { style: 'text-align:center;font-weight:800' }, 'Lobby (écran principal)'),
    el('div', { class: 'pv-lobby' }, el('span', { class: 'pv-qr', 'aria-hidden': 'true' }), el('div', {}, el('small', {}, draft.qrCodeText || ''), el('div', { class: 'pv-pin' }, '482 731'))),
    el('small', { style: 'text-align:center;font-weight:800' }, 'Écran joueur'),
    el('div', { class: 'pv-phone' }, el('div', { style: 'text-align:center;font-weight:900;font-size:12px' }, draft.shortName),
      el('div', { class: 'pv-card', style: 'padding:8px;font-size:12px;font-weight:800;text-align:center' }, 'Qui interprète ce morceau ?'),
      el('div', { class: 'pv-tiles' }, ...['#e5484d', '#3e63dd', '#f5a524', '#30a46c'].map((c, i) => el('span', { style: `background:${c}` }, ['Artiste A', 'Artiste B', 'Artiste C', 'Artiste D'][i])))));
    const contrastWarn = ratio(draft.surfaceColor, draft.textColor) < 4.5 ? el('p', { class: 'warnings', style: 'margin:8px 0 0' }, '⚠️ Contraste faible entre le texte et les cartes (lisibilité).') : null;
    preview.replaceChildren(...[pv, contrastWarn].filter(Boolean));
  }

  if (section === 'general') {
    page('Paramètres · Général',
      el('div', { class: 'card stack' },
        el('div', { class: 'grid2' },
          field('Nom public de l’application *', text('appName', 60), 'Titre de l’onglet, page d’accueil, lobby, podium…'),
          field('Nom court', text('shortName', 30), 'Utilisé sur mobile et dans les titres d’onglet'),
          field('Slogan / sous-titre', text('tagline', 120)),
          field('Organisateur ou marque', text('organizerName', 80)),
          field('Texte près du QR code', text('qrCodeText', 80)),
          field('Langue par défaut', select([['fr', 'Français'], ['en', 'English (partiel)']], draft.defaultLanguage, (v) => { draft.defaultLanguage = v; changed(); }))),
        field('Texte d’accueil (page d’accueil, facultatif)', text('welcomeText', 500, { multiline: true }))),
      el('div', { class: 'sticky-save' }, btn('💾 Enregistrer', () => save(['appName', 'shortName', 'tagline', 'organizerName', 'qrCodeText', 'defaultLanguage', 'welcomeText']), 'accent'), status));
    return;
  }

  if (section === 'game') {
    const numIn = (key, min, max) => el('input', { type: 'number', min: String(min), max: String(max), value: draft[key], oninput: (e) => { draft[key] = Number(e.target.value); changed(); } });
    const scoreIn = (key) => el('input', { type: 'number', min: '0', max: '5000', value: draft.scoring[key], oninput: (e) => { draft.scoring = { ...draft.scoring, [key]: Number(e.target.value) }; changed(); } });
    page('Paramètres · Jeu',
      el('div', { class: 'card stack' },
        el('h2', {}, 'Parties'),
        el('div', { class: 'grid2' },
          field('Expiration d’une partie inactive (heures)', numIn('gameExpiryHours', 1, 72)),
          field('Nombre maximal de joueurs par partie', numIn('maxPlayers', 2, 500))),
        check('Autoriser par défaut à rejoindre une partie commencée', draft.allowLateJoin, (v) => { draft.allowLateJoin = v; changed(); }),
        check('Conserver les joueurs déconnectés (sinon retirés du lobby après 2 min)', draft.keepDisconnectedPlayers, (v) => { draft.keepDisconnectedPlayers = v; changed(); })),
      el('div', { class: 'card stack', style: 'margin-top:12px' },
        el('h2', {}, 'Points'),
        el('p', { class: 'hint' }, 'Bonne réponse = points de base + bonus de rapidité (dégressif jusqu’à la fin du temps) + bonus de série. Mauvaise réponse ou absence de réponse : 0. Calcul toujours effectué par le serveur. S’applique aux nouvelles parties.'),
        el('div', { class: 'grid4' },
          field('Points de base', scoreIn('basePoints')), field('Bonus de rapidité max', scoreIn('speedBonus')),
          field('Bonus par réponse consécutive', scoreIn('streakStep')), field('Plafond du bonus de série', scoreIn('streakCap')))),
      el('div', { class: 'sticky-save' },
        btn('💾 Enregistrer', () => save(['gameExpiryHours', 'maxPlayers', 'allowLateJoin', 'keepDisconnectedPlayers', 'scoring']), 'accent'),
        btn('Valeurs de points par défaut', () => { draft.scoring = { ...defaults.scoring }; renderSettingsFromDraft(); }, 'ghost'), status));
    const renderSettingsFromDraft = () => { dirty = true; save(['scoring']).then(() => renderSettings('game')); };
    return;
  }

  // ---- appearance
  const colorRow = ([key, label, help]) => {
    const picker = el('input', { type: 'color', value: draft[key], 'aria-label': label });
    const hex = el('input', { value: draft[key], maxlength: '7', pattern: '#[0-9a-fA-F]{6}', 'aria-label': `${label} (hexadécimal)` });
    picker.addEventListener('input', () => { draft[key] = picker.value; hex.value = picker.value; changed(); });
    hex.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(hex.value)) { draft[key] = hex.value.toLowerCase(); picker.value = draft[key]; changed(); } });
    return field(label, el('div', { class: 'color-row' }, picker, hex), help);
  };
  const imageRow = ([key, label, kind]) => {
    const thumb = el('span', { class: 'thumb' });
    const drawThumb = () => thumb.replaceChildren(draft[key] ? el('img', { src: draft[key], alt: '' }) : el('span', { class: 'hint' }, 'aucun'));
    drawThumb();
    return field(label, el('div', { class: 'img-field' }, thumb,
      btn('⬆ Téléverser', async () => {
        const [file] = await pickFile(kind === 'favicon' ? 'image/png,image/x-icon,.ico' : 'image/png,image/jpeg,image/webp');
        if (!file) return;
        try { const m = await upload(kind, file, key === 'homeImageUrl' ? 'home' : 'logo'); draft[key] = m.url; drawThumb(); changed(); toast('Image téléversée — enregistrez pour l’appliquer'); }
        catch (ex) { toast(ex.message, true); }
      }, 'small'),
      btn('Retirer', () => { draft[key] = ''; drawThumb(); changed(); }, 'small ghost')),
    kind === 'favicon' ? 'PNG ou ICO, 512 Ko max.' : 'PNG, JPEG ou WebP, 2 Mo max. SVG refusé.');
  };
  const radius = el('input', { type: 'range', min: '0', max: '32', value: draft.buttonRadius, oninput: (e) => { draft.buttonRadius = Number(e.target.value); radiusVal.textContent = `${draft.buttonRadius} px`; changed(); } });
  const radiusVal = el('span', { class: 'sub' }, `${draft.buttonRadius} px`);
  const fields = ['logoUrl', 'darkLogoUrl', 'faviconUrl', 'homeImageUrl', ...COLORS.map((c) => c[0]), 'buttonRadius', 'themeMode'];

  page('Paramètres · Apparence',
    el('div', { class: 'appearance' },
      el('div', { class: 'stack' },
        el('div', { class: 'card stack' }, el('h2', {}, 'Logos et images'), el('div', { class: 'grid2' }, ...IMAGES.map(imageRow))),
        el('div', { class: 'card stack' }, el('h2', {}, 'Couleurs et thème'),
          el('div', { class: 'grid2' }, ...COLORS.map(colorRow)),
          el('div', { class: 'grid2' },
            field('Thème', select([['dark', 'Sombre'], ['light', 'Clair'], ['auto', 'Automatique (selon l’appareil)']], draft.themeMode, (v) => { draft.themeMode = v; changed(); })),
            field('Arrondi des boutons', el('div', { class: 'color-row' }, radius, radiusVal))))),
      el('div', { class: 'stack' }, el('h2', {}, 'Aperçu (non enregistré)'), preview)),
    el('div', { class: 'sticky-save' },
      btn('💾 Enregistrer', () => save(fields), 'accent'),
      btn('Annuler les modifications', () => { dirty = false; renderSettings('appearance'); }, 'ghost'),
      btn('Restaurer le thème par défaut', async () => {
        if (!confirm('Restaurer les couleurs, le thème et l’arrondi par défaut ? Le nom, les logos et les textes sont conservés.')) return;
        await api('/api/admin/settings/reset-theme', {});
        dirty = false; toast('Thème par défaut restauré'); renderSettings('appearance');
      }, 'ghost'),
      el('a', { class: 'btn ghost', href: '/', target: '_blank', rel: 'noopener' }, 'Voir la page d’accueil ↗'),
      status));
  drawPreview();
}

// Keep the admin page title in sync with the brand (already rendered server-side).
document.title = `Administration · ${brand().shortName || ''}`;
boot();
