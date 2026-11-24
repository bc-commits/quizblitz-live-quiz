// Admin: reusable music library (list, filters, pagination, track form, imports,
// exports, adding to blind tests) and the editor hooks (pick from the library,
// generate wrong answers, link a blind test to the library).
import { api, el } from '/shared.js';

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();
const fmtDur = (s) => (s ? `${s} s` : '—');

/** Registers the blind test editor hooks. ctx: admin helpers (btn, toast, field, select, check, previewPlayer...). */
export function registerEditorHooks(hooks, ctx) {
  const { btn, toast } = ctx;

  hooks.roundActions = ({ bt, r, changed, openTracks }) => [btn('📚 Ajouter depuis la bibliothèque', () => openPicker(ctx, {
    title: `Ajouter à « ${r.title} »`,
    onPick: async (ids, opts) => {
      const type = opts.questionType || r.questionType;
      for (const id of ids) {
        const t = { musicTrackId: id, title: '', artist: '', year: '', audioUrl: '', coverUrl: '', answerMode: 'multiple-choice', choices: [], correctAnswer: '', aliases: [],
          startTime: opts.startTime === '' ? null : Number(opts.startTime), duration: opts.duration ? Number(opts.duration) : null, questionType: type !== r.questionType ? type : null };
        try {
          if (type === 'artist-title') {
            const [a, ti] = await Promise.all(['artist', 'title'].map((k) => api('/api/admin/library/distractors', { musicTrackId: id, questionType: k, count: opts.count })));
            t.artistAnswer = { mode: 'multiple-choice', choices: a.choices, correctAnswer: a.correctAnswer, aliases: [] };
            t.titleAnswer = { mode: 'multiple-choice', choices: ti.choices, correctAnswer: ti.correctAnswer, aliases: [] };
          } else if (type !== 'custom') {
            const g = await api('/api/admin/library/distractors', { musicTrackId: id, questionType: type, count: opts.count });
            t.choices = g.choices; t.correctAnswer = g.correctAnswer;
            if (g.warnings.length) toast(g.warnings[0], true);
          } else t.choices = ['', '', '', ''];
        } catch (ex) { toast(ex.message, true); t.choices = ['', '', '', '']; }
        r.tracks.push(t);
      }
      openTracks.add(`${bt.rounds.indexOf(r)}:${r.tracks.length - 1}`);
      changed(true);
      toast(`${ids.length} morceau(x) ajouté(s) : enregistrez le blind test`);
    },
  }), 'small ghost')];

  hooks.choiceActions = ({ block, label, redraw, meta }) => {
    if (!meta) return [];
    const type = meta.key === 'artist' ? 'artist' : meta.key === 'title' ? 'title' : meta.type;
    if (!['artist', 'title', 'year', 'decade'].includes(type)) return [];
    const t = meta.t;
    const gen = async (fresh) => {
      if (t.lockedChoices && !confirm('Les propositions sont verrouillées. Les remplacer quand même ?')) return;
      try {
        const g = await api('/api/admin/library/distractors', { musicTrackId: t.musicTrackId || undefined, artist: t.artist, title: t.title, year: t.year, questionType: type,
          count: Math.max(2, block.choices.length), seed: fresh ? Math.random().toString(36).slice(2) : '' });
        if (!g.choices.length) { toast(g.warnings[0] || 'Rien à proposer', true); return; }
        block.choices.splice(0, block.choices.length, ...g.choices);
        block.correctAnswer = g.correctAnswer;
        if (g.warnings.length) toast(g.warnings[0], true);
        redraw();
      } catch (ex) { toast(ex.message, true); }
    };
    const lock = el('label', { class: 'field inline', style: 'font-size:13px' }, (() => { const c = el('input', { type: 'checkbox', onchange: (e) => { t.lockedChoices = e.target.checked; redraw(); } }); c.checked = !!t.lockedChoices; return c; })(), 'Verrouiller');
    return [btn('🎲 Générer', () => gen(false), 'small ghost'), btn('↻ Autres propositions', () => gen(true), 'small ghost'), lock];
  };

  hooks.editorActions = ({ id, isDirty }) => [btn('📚 Lier les morceaux à la bibliothèque', async () => {
    if (isDirty()) { toast('Enregistrez d’abord vos modifications', true); return; }
    if (!confirm('Créer (ou retrouver) une fiche de bibliothèque pour chaque morceau de ce blind test et les y relier ? Les fichiers audio ne sont pas dupliqués.')) return;
    try {
      const r = await api(`/api/admin/library/convert-blind-test/${id}`, {});
      toast(`${r.linked} morceau(x) lié(s), ${r.created} fiche(s) créée(s)`);
      location.reload();
    } catch (ex) { toast(ex.message, true); }
  }, 'ghost')];
}

/** Modal to search the library and pick tracks (paginated server-side search). */
function openPicker(ctx, { title, onPick }) {
  const { btn, field, select } = ctx;
  const selected = new Set();
  const f = { q: '', decade: '', genre: '', tag: '', page: 1, pageSize: 20 };
  const opts = { questionType: '', count: 4, startTime: '', duration: '' };
  const list = el('div', { class: 'list', style: 'max-height:50vh;overflow:auto' });
  const pager = el('div', { class: 'row' });
  const count = el('span', { class: 'sub' }, '0 sélectionné(s)');
  const overlay = el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title });
  const close = () => { ctx.previewPlayer.stop(); overlay.remove(); };
  async function load() {
    const r = await api(`/api/admin/library?${qs(f)}`);
    list.replaceChildren(...(r.items.length ? r.items.map((m) => {
      const box = el('input', { type: 'checkbox', 'aria-label': `Sélectionner ${m.title}`, onchange: (e) => { if (e.target.checked) selected.add(m.id); else selected.delete(m.id); count.textContent = `${selected.size} sélectionné(s)`; } });
      box.checked = selected.has(m.id);
      return el('label', { class: 'item', style: 'cursor:pointer' }, box,
        m.coverUrl ? el('img', { src: m.coverUrl, alt: '', style: 'width:40px;height:40px;object-fit:cover;border-radius:6px' }) : null,
        el('div', { class: 'grow' }, el('div', { class: 'title' }, m.title), el('div', { class: 'meta' }, `${m.artist}${m.year ? ` · ${m.year}` : ''}${m.genre ? ` · ${m.genre}` : ''}`)),
        m.audioUrl ? btn('▶', (e) => { e.preventDefault(); ctx.previewPlayer.unlock(); ctx.previewPlayer.play(m.audioUrl, m.defaultStartTime || 0, m.defaultDuration || 15); }, 'small ghost') : el('span', { class: 'tag warn' }, 'sans audio'));
    }) : [el('p', { class: 'muted' }, 'Aucun morceau trouvé.')]));
    const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
    pager.replaceChildren(btn('◀', () => { if (f.page > 1) { f.page--; load(); } }, 'small ghost'), el('span', { class: 'sub' }, `Page ${r.page}/${pages} · ${r.total} morceau(x)`), btn('▶', () => { if (f.page < pages) { f.page++; load(); } }, 'small ghost'));
  }
  let t;
  const search = el('input', { type: 'search', placeholder: 'Rechercher titre, artiste, genre, tag…', 'aria-label': 'Rechercher', oninput: (e) => { f.q = e.target.value; f.page = 1; clearTimeout(t); t = setTimeout(load, 300); } });
  api('/api/admin/library/facets').then((fa) => {
    filters.replaceChildren(
      select([['', 'Toutes décennies'], ...fa.decades.map((d) => [String(d), `Années ${d}`])], '', (v) => { f.decade = v; f.page = 1; load(); }),
      select([['', 'Tous genres'], ...fa.genres.map((g) => [g, g])], '', (v) => { f.genre = v; f.page = 1; load(); }),
      select([['', 'Tous tags'], ...fa.tags.map((g) => [g, g])], '', (v) => { f.tag = v; f.page = 1; load(); }));
  });
  const filters = el('div', { class: 'grid4' });
  overlay.append(el('div', { class: 'card stack modal-card' },
    el('div', { class: 'row', style: 'justify-content:space-between' }, el('h2', { style: 'margin:0' }, title), btn('✕', close, 'small ghost')),
    search, filters, list, pager,
    el('div', { class: 'grid4' },
      field('Type de question', select([['', 'Comme la manche'], ['artist', 'Artiste'], ['title', 'Titre'], ['artist-title', 'Artiste + titre'], ['year', 'Année'], ['decade', 'Décennie'], ['custom', 'Personnalisée']], '', (v) => { opts.questionType = v; })),
      field('Nombre de propositions', select(['2', '3', '4', '5', '6', '7', '8'].map((n) => [n, n]), '4', (v) => { opts.count = Number(v); })),
      field('Début (s, vide = fiche)', el('input', { type: 'number', min: '0', oninput: (e) => { opts.startTime = e.target.value; } })),
      field('Durée (s, vide = fiche)', el('input', { type: 'number', min: '5', max: '120', oninput: (e) => { opts.duration = e.target.value; } }))),
    el('div', { class: 'row' }, count, el('span', { class: 'grow' }), btn('Annuler', close, 'ghost'),
      btn('Ajouter la sélection', async () => { if (!selected.size) return; const ids = [...selected]; close(); await onPick(ids, opts); }, 'accent'))));
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.append(overlay);
  search.focus();
  load();
}

// ---------------------------------------------------------------- library pages

export async function renderLibrary(ctx, sub, id) {
  if (sub === 'new' || sub === 'edit') return renderTrackForm(ctx, id);
  if (sub === 'import') return renderImport(ctx);
  return renderList(ctx);
}

async function renderList(ctx) {
  const { page, btn, select, toast, fmtDate } = ctx;
  const f = { q: '', artist: '', decade: '', genre: '', tag: '', hasCover: '', hasAudio: '', used: '', archived: '', sort: 'artist', page: 1, pageSize: 50 };
  const selected = new Set();
  const list = el('div', { class: 'list' });
  const pager = el('div', { class: 'row' });
  const bulk = el('div', { class: 'toolbar' });
  const facets = await api('/api/admin/library/facets');
  async function load() {
    const r = await api(`/api/admin/library?${qs(f)}`);
    list.replaceChildren(...(r.items.length ? r.items.map((m) => {
      const box = el('input', { type: 'checkbox', 'aria-label': `Sélectionner ${m.title}`, onchange: (e) => { if (e.target.checked) selected.add(m.id); else selected.delete(m.id); drawBulk(); } });
      box.checked = selected.has(m.id);
      return el('div', { class: 'item' }, box,
        el('span', { class: 'thumb-sm' }, m.coverUrl ? el('img', { src: m.coverUrl, alt: '' }) : '🎵'),
        el('div', { class: 'grow' }, el('div', { class: 'title' }, `${m.title}`), el('div', { class: 'meta' }, [m.artist, m.year, m.genre, m.tags.length ? `#${m.tags.join(' #')}` : ''].filter(Boolean).join(' · ')),
          el('div', { class: 'meta' }, `Extrait ${m.defaultStartTime || 0} s · ${fmtDur(m.defaultDuration)} · utilisé dans ${m.uses} blind test(s) · modifié ${fmtDate(m.updatedAt)}`)),
        el('span', { class: `tag ${m.audioUrl ? 'ok' : 'warn'}` }, m.audioUrl ? 'audio ✓' : 'sans audio'),
        m.audioUrl ? btn('▶', () => { ctx.previewPlayer.unlock(); ctx.previewPlayer.play(m.audioUrl, m.defaultStartTime || 0, m.defaultDuration || 15); }, 'small ghost') : null,
        el('a', { class: 'btn ghost small', href: `#/library/edit/${m.id}` }, '✏️ Modifier'),
        btn('⧉', async () => { await api(`/api/admin/library/${m.id}/duplicate`, {}); toast('Fiche dupliquée (même fichier audio)'); load(); }, 'small ghost'),
        btn(m.archived ? '↩ Désarchiver' : '🗄 Archiver', async () => { await api(`/api/admin/library/${m.id}/archive`, { archived: !m.archived }); load(); }, 'small ghost'),
        btn('🗑', () => deleteTrack(ctx, m, load), 'small ghost'));
    }) : [el('p', { class: 'muted' }, 'Aucun morceau. Ajoutez-en un, importez un fichier, ou liez un blind test existant à la bibliothèque depuis son éditeur.')]));
    const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
    pager.replaceChildren(btn('◀', () => { if (f.page > 1) { f.page--; load(); } }, 'small ghost'), el('span', { class: 'sub' }, `Page ${r.page}/${pages} · ${r.total} morceau(x)`), btn('▶', () => { if (f.page < pages) { f.page++; load(); } }, 'small ghost'));
  }
  async function drawBulk() {
    if (!selected.size) { bulk.replaceChildren(); return; }
    const { blindTests } = await api('/api/admin/blind-tests');
    let target = blindTests[0]?.id || '';
    let roundIndex = 0;
    const roundSel = select([['0', 'Manche 1']], '0', (v) => { roundIndex = Number(v); });
    const loadRounds = async () => { if (!target) return; const row = await api(`/api/admin/blind-tests/${target}`); roundSel.replaceChildren(...row.blindTest.rounds.map((r, i) => el('option', { value: String(i) }, `Manche ${i + 1} : ${r.title}`))); roundIndex = 0; };
    loadRounds();
    bulk.replaceChildren(el('b', {}, `${selected.size} sélectionné(s)`),
      select(blindTests.map((b) => [b.id, b.title]), target, (v) => { target = v; loadRounds(); }), roundSel,
      btn('Ajouter au blind test', async () => {
        try {
          const r = await api('/api/admin/library/add-to-blind-test', { blindTestId: target, roundIndex, trackIds: [...selected], count: 4 });
          toast(`${r.added} morceau(x) ajouté(s) avec des propositions générées`); selected.clear(); drawBulk(); load();
        } catch (ex) { toast(ex.message, true); }
      }, 'accent small'),
      btn('Désélectionner', () => { selected.clear(); drawBulk(); load(); }, 'ghost small'));
  }
  let t;
  const filter = (k) => (v) => { f[k] = v; f.page = 1; load(); };
  page('Bibliothèque musicale',
    el('div', { class: 'toolbar' },
      el('a', { class: 'btn accent small', href: '#/library/new' }, '➕ Ajouter un morceau'),
      el('a', { class: 'btn ghost small', href: '#/library/import' }, '📥 Importer'),
      el('a', { class: 'btn ghost small', href: '/api/admin/library/export?format=json' }, '⬇ JSON'),
      el('a', { class: 'btn ghost small', href: '/api/admin/library/export?format=csv' }, '⬇ CSV'),
      el('a', { class: 'btn ghost small', href: '#/media/unused' }, '🧹 Médias inutilisés')),
    el('div', { class: 'card stack' },
      el('input', { type: 'search', placeholder: `Rechercher parmi ${facets.total} morceau(x) : titre, artiste, genre, tag, alias…`, 'aria-label': 'Rechercher', oninput: (e) => { f.q = e.target.value; f.page = 1; clearTimeout(t); t = setTimeout(load, 300); } }),
      el('div', { class: 'grid4' },
        select([['', 'Toutes décennies'], ...facets.decades.map((d) => [String(d), `Années ${d}`])], '', filter('decade')),
        select([['', 'Tous genres'], ...facets.genres.map((g) => [g, g])], '', filter('genre')),
        select([['', 'Tous tags'], ...facets.tags.map((g) => [g, g])], '', filter('tag')),
        select([['', 'Pochette : peu importe'], ['1', 'Avec pochette'], ['0', 'Sans pochette']], '', filter('hasCover')),
        select([['', 'Audio : peu importe'], ['1', 'Avec audio'], ['0', 'Sans audio']], '', filter('hasAudio')),
        select([['', 'Utilisation : tous'], ['1', 'Utilisés'], ['0', 'Inutilisés']], '', filter('used')),
        select([['', 'Actifs'], ['1', 'Archivés']], '', filter('archived')),
        select([['artist', 'Tri : artiste'], ['title', 'Tri : titre'], ['year', 'Tri : année'], ['recent', 'Tri : récents'], ['uses', 'Tri : plus utilisés']], 'artist', filter('sort')))),
    bulk, list, pager);
  load();
}

async function deleteTrack(ctx, m, reload) {
  const { toast } = ctx;
  try {
    const { usage } = await api(`/api/admin/library/${m.id}`);
    if (usage.length) {
      const names = usage.map((u) => `• ${u.title}`).join('\n');
      if (!confirm(`« ${m.title} » est utilisé par :\n${names}\n\nL’archivage est recommandé.\n\nSupprimer quand même ? Les informations du morceau seront recopiées dans ces blind tests, qui continueront de fonctionner.`)) return;
      await api(`/api/admin/library/${m.id}?detach=1`, undefined, 'DELETE');
    } else {
      if (!confirm(`Supprimer définitivement « ${m.title} » de la bibliothèque ? Son fichier audio sera supprimé s’il ne sert nulle part ailleurs.`)) return;
      await api(`/api/admin/library/${m.id}`, undefined, 'DELETE');
    }
    toast('Morceau supprimé');
    reload();
  } catch (ex) { toast(ex.message, true); }
}

async function renderTrackForm(ctx, id) {
  const { page, field, btn, toast, upload, pickFile } = ctx;
  const data = id ? await api(`/api/admin/library/${id}`) : { track: { title: '', artist: '', year: '', genre: '', audioUrl: '', coverUrl: '', defaultStartTime: 0, defaultDuration: '', artistAliases: [], titleAliases: [], tags: [], internalNotes: '' }, usage: [] };
  const t = data.track;
  const inp = (k, attrs = {}) => { const n = el('input', { value: Array.isArray(t[k]) ? t[k].join(', ') : t[k] ?? '', ...attrs, oninput: (e) => { t[k] = attrs['data-list'] ? e.target.value.split(',').map((x) => x.trim()).filter(Boolean) : e.target.value; } }); return n; };
  const up = (kind, accept, key, purpose) => btn('⬆ Téléverser', async () => {
    const [file] = await pickFile(accept); if (!file) return;
    try { const m = await upload(kind, file, purpose); t[key] = m.url; renderAgain(); toast('Fichier téléversé ✓'); } catch (ex) { toast(ex.message, true); }
  }, 'small');
  const renderAgain = () => draw();
  function draw() {
    page(id ? `Morceau : ${t.title}` : 'Ajouter un morceau',
      data.usage.length ? el('div', { class: 'warnings' }, `Utilisé par ${data.usage.length} blind test(s) : ${data.usage.map((u) => u.title).join(', ')}. Les changements s’y appliquent (les champs laissés vides dans le blind test reprennent la fiche).`) : null,
      el('div', { class: 'card stack' },
        el('div', { class: 'grid2' }, field('Titre *', inp('title', { maxlength: '120' })), field('Artiste *', inp('artist', { maxlength: '120' })),
          field('Année', inp('year', { type: 'number', min: '1800', max: '2100' })), field('Genre', inp('genre', { maxlength: '40', placeholder: 'Pop, rock, variété…' }))),
        field('Tags (séparés par des virgules)', inp('tags', { 'data-list': '1', placeholder: 'mariage, slow, années 80' })),
        el('div', { class: 'grid2' }, field('Variantes acceptées pour l’artiste (saisie libre)', inp('artistAliases', { 'data-list': '1', placeholder: 'Goldman, JJ Goldman' })), field('Variantes acceptées pour le titre', inp('titleAliases', { 'data-list': '1' }))),
        field('Fichier ou URL audio', el('div', { class: 'url-line' }, inp('audioUrl', { placeholder: '/media/… ou https://…' }), up('audio', 'audio/*,.mp3,.m4a,.ogg,.wav', 'audioUrl'))),
        t.audioUrl ? el('audio', { controls: '', preload: 'none', src: t.audioUrl }) : null,
        el('div', { class: 'grid2' }, field('Début d’extrait par défaut (s)', inp('defaultStartTime', { type: 'number', min: '0', step: '0.5' })), field('Durée par défaut (s)', inp('defaultDuration', { type: 'number', min: '5', max: '120' }))),
        field('Pochette', el('div', { class: 'url-line' }, inp('coverUrl', { placeholder: '/media/… ou https://…' }), up('image', 'image/png,image/jpeg,image/webp', 'coverUrl', 'cover'))),
        t.coverUrl ? el('img', { src: t.coverUrl, alt: '', style: 'width:120px;height:120px;object-fit:cover;border-radius:10px' }) : null,
        field('Notes internes', (() => { const ta = el('textarea', { maxlength: '500', oninput: (e) => { t.internalNotes = e.target.value; } }); ta.value = t.internalNotes || ''; return ta; })())),
      el('div', { class: 'sticky-save' },
        btn('💾 Enregistrer', async () => {
          try {
            const body = { track: { ...t, year: t.year === '' ? null : t.year } };
            const r = id ? await api(`/api/admin/library/${id}`, body, 'PUT') : await api('/api/admin/library', body);
            if (r.duplicates?.length) toast(`Attention : doublon possible de « ${r.duplicates[0].title} » (${r.duplicates[0].artist})`, true); else toast('Morceau enregistré');
            location.hash = '#/library';
          } catch (ex) { toast(ex.message, true); }
        }, 'accent'),
        el('a', { class: 'btn ghost', href: '#/library' }, 'Retour')));
  }
  draw();
}

function renderImport(ctx) {
  const { page, btn, toast, pickFile } = ctx;
  let content = null; let format = 'json';
  const out = el('div', { class: 'stack' });
  const run = async (dryRun) => {
    if (!content) return;
    try {
      const r = await api('/api/admin/library/import', { format, content, dryRun });
      out.replaceChildren(
        el('p', {}, el('b', {}, dryRun ? 'Simulation : rien n’a été enregistré. ' : 'Import terminé. '), `${r.counts.ok} prêt(s)/importé(s), ${r.counts.duplicate} doublon(s) ignoré(s), ${r.counts.error} erreur(s)${r.truncated ? ' (limité à 2 000 lignes)' : ''}.`),
        dryRun && r.counts.ok ? btn(`Importer ${r.counts.ok} morceau(x)`, () => run(false), 'accent') : null,
        el('table', { class: 'report-table' }, el('thead', {}, el('tr', {}, el('th', {}, 'Ligne'), el('th', {}, 'État'), el('th', {}, 'Morceau'), el('th', {}, 'Détail'))),
          el('tbody', {}, ...r.rows.map((x) => el('tr', { class: `st-${x.status}` }, el('td', {}, x.line), el('td', {}, { ok: '✔', duplicate: '≈ doublon', error: '✖ erreur' }[x.status]), el('td', {}, `${x.artist || ''} — ${x.title || ''}`), el('td', {}, x.message))))));
      if (!dryRun) toast(`${r.created} morceau(x) importé(s)`);
    } catch (ex) { toast(ex.message, true); }
  };
  page('Importer dans la bibliothèque',
    el('div', { class: 'card stack' },
      el('p', { class: 'hint' }, 'JSON (export de la bibliothèque, ou tableau de morceaux) ou CSV avec en-tête : title, artist, year, genre, tags, artistAliases, titleAliases, audioUrl, coverUrl, defaultStartTime, defaultDuration, internalNotes (titre/artiste/annee acceptés). Les listes dans une cellule sont séparées par « | ». 2 Mo et 2 000 lignes maximum. Les doublons (même artiste, titre et année) ne sont jamais fusionnés automatiquement : ils sont signalés et ignorés. Les fichiers audio se téléversent séparément.'),
      el('div', { class: 'toolbar' }, btn('Choisir un fichier…', async () => {
        const [file] = await pickFile('.json,.csv,application/json,text/csv');
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) { toast('Fichier trop volumineux (2 Mo max)', true); return; }
        content = await file.text(); format = /\.csv$/i.test(file.name) ? 'csv' : 'json';
        out.replaceChildren(el('p', {}, `${file.name} chargé (${format.toUpperCase()}).`));
        run(true);
      }, 'accent')), out));
}

/** Resizes an image in the browser before upload (keeps PNG/WebP transparency, EXIF orientation). */
export async function resizeImage(file, maxW, maxH) {
  if (!/^image\/(png|jpeg|webp)$/.test(file.type) || typeof createImageBitmap !== 'function') return file;
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { return file; }
  const ratio = Math.min(1, maxW / bmp.width, maxH / bmp.height);
  if (ratio >= 1) { bmp.close?.(); return file; }
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * ratio);
  canvas.height = Math.round(bmp.height * ratio);
  const g = canvas.getContext('2d');
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, file.type, file.type === 'image/png' ? undefined : 0.88));
  if (!blob || blob.size >= file.size) return file;
  return new File([blob], file.name, { type: file.type });
}
