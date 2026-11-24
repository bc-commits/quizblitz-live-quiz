// Blind test editor (schemaVersion 2): rounds, tracks, answers with 2 to 8 choices,
// artist + title questions, free text with aliases, multipliers, scoring and flow.
import { api, el } from '/shared.js';

export const QUESTION_TYPES = [['artist', 'Artiste'], ['title', 'Titre'], ['artist-title', 'Artiste + titre'], ['year', 'Année'], ['decade', 'Décennie'], ['custom', 'Question personnalisée']];
const DIFFICULTIES = [['', '—'], ['easy', 'Facile'], ['medium', 'Moyen'], ['hard', 'Difficile']];
const SCORING_PRESETS = [['', 'Par défaut (réglages du jeu)'], ['classic', 'Classique : 1 000 pts, sans bonus'], ['competitive', 'Compétitif : 500 + rapidité 500 + série'], ['party', 'Soirée : artiste 500 + titre 500 + bonus'], ['relaxed', 'Détente : 1 point par bonne réponse'], ['custom', 'Personnalisé…']];
const FLOW_MODES = [['manual', 'Manuel : l’animateur contrôle chaque étape'], ['semi-auto', 'Semi-automatique : révélation puis classement automatiques'], ['automatic', 'Automatique : tout s’enchaîne']];
const MULTIPLIERS = [['', 'Normal (x1)'], ['2', 'Question bonus (x2)'], ['3', 'Finale (x3)'], ['1.5', 'x1,5'], ['4', 'x4'], ['5', 'x5']];
const MIN_CHOICES = 2;
const MAX_CHOICES = 8;
const canon = (s) => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’'`´]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const decadeLabel = (y) => (Number.isInteger(Number(y)) && y !== '' ? `Années ${Math.floor(Number(y) / 10) * 10}` : '');

export const emptyTrack = (duration = 20) => ({ title: '', artist: '', year: '', audioUrl: '', coverUrl: '', startTime: 0, duration, answerMode: 'multiple-choice', choices: ['', '', '', ''], correctAnswer: '', aliases: [], difficulty: '', notes: '', question: '' });
const emptyAnswer = () => ({ mode: 'multiple-choice', choices: ['', '', '', ''], correctAnswer: '', aliases: [] });
export const emptyBlindTest = () => ({
  schemaVersion: 2, type: 'music-blind-test', title: '', description: '',
  settings: { answerMode: 'multiple-choice', countdownDuration: 3, excerptDuration: 20, revealDuration: 8, scoreboardDuration: 8, allowLateJoin: true, allowAnswerChange: false, playAudioOnHostOnly: true, shuffleChoices: false, flowMode: 'manual', scoring: null },
  rounds: [{ title: 'Manche 1', questionType: 'artist', tracks: [emptyTrack()] }],
});

/** Brings any stored blind test (V1 or V2) into the shape the editor works with. */
function prepare(bt) {
  bt.schemaVersion = 2;
  bt.settings = { ...emptyBlindTest().settings, ...(bt.settings || {}) };
  for (const r of bt.rounds) {
    for (const t of r.tracks) {
      if (t.year === null || t.year === undefined) t.year = '';
      if (!Array.isArray(t.choices)) t.choices = [];
      if (!t.answerMode) t.answerMode = 'multiple-choice';
      if (!Array.isArray(t.aliases)) t.aliases = [];
      for (const k of ['artistAnswer', 'titleAnswer']) if (t[k] && !Array.isArray(t[k].aliases)) t[k].aliases = [];
    }
  }
  return bt;
}

/**
 * ctx: { page, field, select, check, btn, toast, upload, pickFile, launchGame, download, fmtDate, previewPlayer, setLeaveGuard, hooks }
 * hooks (optional, added by later features): roundActions(ctx2), trackActions(ctx2), trackFields(ctx2)
 */
export async function renderEditor(id, ctx) {
  const { page, field, select, check, btn, toast, upload, pickFile, launchGame, download, fmtDate, previewPlayer } = ctx;
  const draftKey = `blindtest.draft.${id || 'new'}`;
  let bt;
  let serverUpdatedAt = 0;
  let upgradedNotice = false;
  if (id) {
    const row = await api(`/api/admin/blind-tests/${id}`);
    bt = row.blindTest;
    serverUpdatedAt = row.updatedAt;
    upgradedNotice = row.blindTest.schemaVersion !== 2;
  } else bt = emptyBlindTest();
  let dirty = false;
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey));
    if (saved && saved.savedAt > serverUpdatedAt && saved.blindTest
      && confirm(`Un brouillon non enregistré du ${fmtDate(saved.savedAt)} existe pour ce blind test. Le restaurer ?`)) {
      bt = saved.blindTest; dirty = true;
    } else if (saved) localStorage.removeItem(draftKey);
  } catch { /* ignore */ }
  prepare(bt);

  const openTracks = new Set();
  let issues = { errors: [], warnings: [] };
  const audioStatus = new Map();
  const status = el('span', { class: 'sub' });
  const issuesBox = el('div');
  const roundsBox = el('div', { class: 'stack' });
  const fill = (node, ...kids) => node.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));

  ctx.setLeaveGuard(() => (dirty ? 'Des modifications ne sont pas enregistrées. Quitter quand même ? (un brouillon reste disponible)' : null));

  let validateTimer;
  function changed(rerender = false) {
    dirty = true;
    status.textContent = 'Modifications non enregistrées (brouillon local sauvegardé)';
    try { localStorage.setItem(draftKey, JSON.stringify({ savedAt: Date.now(), blindTest: bt })); } catch { /* ignore */ }
    clearTimeout(validateTimer);
    validateTimer = setTimeout(validate, 700);
    if (rerender) drawRounds();
  }

  const payload = () => ({ ...bt, rounds: bt.rounds.map((r) => ({ ...r, tracks: r.tracks.map((t) => ({ ...t, year: t.year === '' ? null : Number(t.year) })) })) });

  async function validate() {
    try { issues = await api('/api/admin/blind-tests/validate', { blindTest: payload() }); } catch { return; }
    drawIssues();
    document.querySelectorAll('.track[data-path]').forEach((n) => n.classList.toggle('invalid', issues.errors.some((e) => e.path.startsWith(n.dataset.path))));
  }

  function drawIssues() {
    const audioErrors = [...audioStatus].filter(([, s]) => s === 'error').map(([u]) => u);
    fill(issuesBox,
      issues.errors.length ? el('div', { class: 'errors' }, el('b', {}, `${issues.errors.length} point(s) à corriger avant d’enregistrer`), el('ul', {}, ...issues.errors.slice(0, 12).map((e) => el('li', {}, e.message)))) : null,
      issues.warnings.length || audioErrors.length ? el('div', { class: 'warnings', style: 'margin-top:8px' }, el('ul', {},
        ...issues.warnings.map((w) => el('li', {}, w.message)),
        ...audioErrors.map((u) => el('li', {}, `Fichier audio inaccessible : ${u}`)))) : null);
  }

  function checkAudio(url) {
    if (!url || audioStatus.get(url) === 'ok' || audioStatus.get(url) === 'checking') return;
    audioStatus.set(url, 'checking');
    const a = new Audio();
    a.preload = 'metadata';
    const done = (s) => { audioStatus.set(url, s); a.removeAttribute('src'); drawIssues(); document.querySelectorAll(`[data-audio-hint="${CSS.escape(url)}"]`).forEach((n) => setAudioHint(n, url)); };
    a.addEventListener('loadedmetadata', () => done('ok'), { once: true });
    a.addEventListener('error', () => done('error'), { once: true });
    a.src = url;
  }
  function setAudioHint(node, url) {
    const s = audioStatus.get(url);
    node.className = `hint${s === 'error' ? ' bad' : ''}`;
    node.textContent = !url ? 'Aucun fichier audio (ou hérité de la bibliothèque)' : s === 'ok' ? 'Fichier audio accessible ✓' : s === 'error' ? '⚠️ Fichier audio inaccessible ou format non pris en charge' : 'Vérification du fichier…';
  }

  function move(arr, i, d) { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; changed(true); }

  /** Editor for one answer block (multiple choice with 2-8 choices, or free text with aliases). */
  function answerEditor(block, label, onChange, suggest, meta) {
    const box = el('div', { class: 'field answer-block' });
    const draw = () => {
      const mode = select([['multiple-choice', 'QCM (propositions)'], ['free-text', 'Saisie libre']], block.mode, (v) => { block.mode = v; if (v === 'multiple-choice' && block.choices.length < MIN_CHOICES) block.choices = ['', '', '', '']; onChange(); draw(); });
      mode.style.width = 'auto';
      const head = el('div', { class: 'row', style: 'gap:8px' }, el('b', {}, label), mode);
      if (block.mode === 'free-text') {
        const answer = el('input', { value: block.correctAnswer || '', maxlength: '120', placeholder: suggest ? `Réponse attendue (par défaut : ${suggest()})` : 'Réponse attendue', oninput: (e) => { block.correctAnswer = e.target.value; onChange(); } });
        const aliases = el('input', { value: (block.aliases || []).join(', '), maxlength: '1000', placeholder: 'Variantes acceptées, séparées par des virgules (ex. Goldman, JJ Goldman)',
          oninput: (e) => { block.aliases = e.target.value.split(',').map((x) => x.trim()).filter(Boolean); onChange(); } });
        const tester = el('input', { placeholder: 'Tester une réponse de joueur…', maxlength: '120' });
        const result = el('p', { class: 'hint' });
        tester.addEventListener('input', async () => {
          if (!tester.value.trim()) { result.textContent = ''; return; }
          try {
            const r = await api('/api/admin/answers/test', { input: tester.value, answer: block.correctAnswer || (suggest ? suggest() : ''), aliases: block.aliases || [], ignoreArticles: block.ignoreArticles !== false, typoTolerance: !!block.typoTolerance });
            const rules = { exact: 'identique après normalisation', alias: 'variante acceptée', articles: 'articles ignorés', typo: 'faute de frappe tolérée' };
            result.className = `hint${r.accepted ? '' : ' bad'}`;
            result.textContent = `« ${r.normalized} » → ${r.accepted ? `✔ accepté (${rules[r.rule]})` : r.ambiguous ? '✖ refusé (très proche : à valider à la main si besoin)' : '✖ refusé'}`;
          } catch (ex) { result.textContent = ex.message; }
        });
        fill(box, head, answer, aliases,
          el('div', { class: 'row', style: 'gap:16px' },
            check('Ignorer les articles (le, la, les, the…)', block.ignoreArticles !== false, (v) => { block.ignoreArticles = v; onChange(); }),
            check('Tolérer les fautes de frappe (1 à 2 lettres)', !!block.typoTolerance, (v) => { block.typoTolerance = v; onChange(); })),
          el('div', { class: 'url-line' }, tester), result);
        return;
      }
      const radioName = `c-${Math.random().toString(36).slice(2, 8)}`;
      const counts = new Map();
      block.choices.forEach((c) => { const k = canon(c); if (k) counts.set(k, (counts.get(k) || 0) + 1); });
      const lines = block.choices.map((c, ci) => {
        const radio = el('input', { type: 'radio', name: radioName, 'aria-label': `Proposition ${ci + 1} correcte`, onchange: () => { block.correctAnswer = block.choices[ci]; onChange(); } });
        radio.checked = !!c && c === block.correctAnswer;
        const dup = c && counts.get(canon(c)) > 1;
        const text = el('input', { value: c, maxlength: '80', placeholder: `Proposition ${ci + 1}`, class: dup ? 'dup' : '', 'aria-invalid': dup ? 'true' : null,
          oninput: (e) => { const was = radio.checked; block.choices[ci] = e.target.value; if (was) block.correctAnswer = e.target.value; onChange(); },
          onchange: () => draw() });
        return el('div', { class: 'choice-line' }, radio, text,
          btn('↑', () => { if (ci > 0) { [block.choices[ci - 1], block.choices[ci]] = [block.choices[ci], block.choices[ci - 1]]; onChange(); draw(); } }, 'small ghost'),
          btn('✕', () => { if (block.choices.length <= MIN_CHOICES) return; const removed = block.choices.splice(ci, 1)[0]; if (removed === block.correctAnswer) block.correctAnswer = ''; onChange(); draw(); }, 'small ghost'));
      });
      lines.forEach((l, i) => { const [up, del] = l.querySelectorAll('button'); up.setAttribute('aria-label', `Monter la proposition ${i + 1}`); up.disabled = i === 0; del.setAttribute('aria-label', `Supprimer la proposition ${i + 1}`); del.disabled = block.choices.length <= MIN_CHOICES; });
      const dupWarn = [...counts.values()].some((n) => n > 1) ? el('p', { class: 'hint bad' }, 'Propositions en double (accents et majuscules ignorés)') : null;
      const missing = block.correctAnswer && !block.choices.includes(block.correctAnswer) ? el('p', { class: 'hint bad' }, 'La bonne réponse n’est plus dans les propositions') : (!block.correctAnswer ? el('p', { class: 'hint bad' }, 'Cochez la bonne réponse') : null);
      const add = btn('+ Ajouter une proposition', () => { if (block.choices.length < MAX_CHOICES) { block.choices.push(''); onChange(); draw(); } }, 'small ghost');
      add.disabled = block.choices.length >= MAX_CHOICES;
      fill(box, head, el('span', { class: 'hint' }, `${block.choices.length} proposition(s) · de ${MIN_CHOICES} à ${MAX_CHOICES} · cochez la bonne réponse`), ...lines, dupWarn, missing,
        el('div', { class: 'row', style: 'gap:6px' }, add, ...(ctx.hooks?.choiceActions ? ctx.hooks.choiceActions({ block, label, redraw: () => { onChange(); draw(); }, suggest, meta }) : [])));
    };
    draw();
    return box;
  }

  function trackEditor(r, ri, t, ti) {
    const pathId = `rounds[${ri}].tracks[${ti}]`;
    const key = `${ri}:${ti}`;
    const open = openTracks.has(key);
    const qType = t.questionType || r.questionType;
    const lib = t.musicTrackId ? ' 📚' : '';
    const mult = Number(t.pointsMultiplier) > 1 ? ` ⭐x${t.pointsMultiplier}` : '';
    const label = el('span', { class: 'label', role: 'button', tabindex: '0', onclick: () => { if (open) openTracks.delete(key); else openTracks.add(key); drawRounds(); },
      onkeydown: (e) => { if (e.key === 'Enter') e.target.click(); } },
    `${t.title || 'Titre (bibliothèque)'} — ${t.artist || '…'}${t.year ? ` (${t.year})` : ''}${lib}${mult}`);
    const head = el('div', { class: 'track-head' },
      el('span', { class: 'num' }, `${ti + 1}.`), label,
      btn('▶', () => { if (!t.audioUrl) { toast('Fichier audio hérité de la bibliothèque : écoutez-le depuis la bibliothèque', true); return; } previewPlayer.unlock(); previewPlayer.play(t.audioUrl, t.startTime || 0, t.duration || bt.settings.excerptDuration); }, 'small ghost'),
      btn(open ? '▲' : '✏️', () => { if (open) openTracks.delete(key); else openTracks.add(key); drawRounds(); }, 'small ghost'),
      btn('⧉', () => { r.tracks.splice(ti + 1, 0, { ...structuredClone(t), id: undefined }); changed(true); }, 'small ghost'),
      btn('↑', () => move(r.tracks, ti, -1), 'small ghost'),
      btn('↓', () => move(r.tracks, ti, 1), 'small ghost'),
      btn('✕', () => { if (confirm(`Supprimer le morceau « ${t.title || ti + 1} » ?`)) { r.tracks.splice(ti, 1); changed(true); } }, 'small ghost'));
    head.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-label', ['Préécouter', 'Modifier', 'Dupliquer', 'Monter', 'Descendre', 'Supprimer'][i]));
    const node = el('div', { class: `track${issues.errors.some((e) => e.path.startsWith(pathId)) ? ' invalid' : ''}`, 'data-path': pathId }, head);
    if (!open) return node;

    const inp = (k, attrs = {}, onInput) => el('input', { value: t[k] ?? '', ...attrs, oninput: (e) => { t[k] = attrs.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value; if (onInput) onInput(e.target.value); changed(); } });

    const audioHint = el('p', { 'data-audio-hint': t.audioUrl || '' });
    setAudioHint(audioHint, t.audioUrl);
    checkAudio(t.audioUrl);
    const audioInput = inp('audioUrl', { placeholder: t.musicTrackId ? 'Hérité de la bibliothèque' : '/media/… ou https://…', maxlength: '1000' }, (v) => { audioHint.dataset.audioHint = v; setAudioHint(audioHint, v); clearTimeout(audioInput.t); audioInput.t = setTimeout(() => checkAudio(v), 600); });
    const pos = el('span', { class: 'pos' }, '0,0 s');
    const startInput = inp('startTime', { type: 'number', min: '0', step: '0.5' });
    const durInput = inp('duration', { type: 'number', min: '5', max: '120', step: '1', placeholder: String(r.trackDuration || bt.settings.excerptDuration) });
    previewPlayer.onProgress = (_f, elapsed) => { pos.textContent = `${(previewPlayer.excerpt.start + elapsed).toFixed(1).replace('.', ',')} s`; };
    previewPlayer.onError = (msg) => toast(msg, true);
    const playUrl = () => t.audioUrl;
    const preview = el('div', { class: 'preview-bar' },
      btn('▶ Écouter l’extrait', () => { if (!playUrl()) return; previewPlayer.unlock(); previewPlayer.play(playUrl(), Number(t.startTime) || 0, Number(t.duration) || r.trackDuration || bt.settings.excerptDuration); }, 'small accent'),
      btn('⏸ Pause', () => previewPlayer.pause(), 'small'),
      btn('▶ Reprendre', () => previewPlayer.resume(), 'small'),
      btn('↺ Recommencer', () => previewPlayer.restart(), 'small'),
      btn('⏹ Arrêter', () => previewPlayer.stop(), 'small'),
      pos,
      btn('⇤ Début ici', () => { if (!previewPlayer.excerpt) return; t.startTime = Math.round(previewPlayer.audio.currentTime * 10) / 10; startInput.value = t.startTime; changed(); }, 'small ghost'),
      btn('−5 s', () => { t.startTime = Math.max(0, (Number(t.startTime) || 0) - 5); startInput.value = t.startTime; changed(); }, 'small ghost'),
      btn('+5 s', () => { t.startTime = (Number(t.startTime) || 0) + 5; startInput.value = t.startTime; changed(); }, 'small ghost'));

    const uploadBtn = (kind, accept, keyName) => btn('⬆ Téléverser', async () => {
      const [file] = await pickFile(accept);
      if (!file) return;
      try { toast('Téléversement…'); const m = await upload(kind, file, kind === 'image' ? 'cover' : null); t[keyName] = m.url; changed(true); toast('Fichier téléversé ✓'); }
      catch (ex) { toast(ex.message, true); }
    }, 'small');

    const typeSelect = select([['', `Comme la manche (${QUESTION_TYPES.find((q) => q[0] === r.questionType)?.[1]})`], ...QUESTION_TYPES], t.questionType && t.questionType !== r.questionType ? t.questionType : '', (v) => { t.questionType = v || null; changed(true); });
    const suggestFor = (type) => () => (type === 'artist' ? t.artist : type === 'title' ? t.title : type === 'year' ? String(t.year || '') : type === 'decade' ? decadeLabel(t.year) : '');
    let answers;
    if (qType === 'artist-title') {
      t.artistAnswer = t.artistAnswer || emptyAnswer();
      t.titleAnswer = t.titleAnswer || emptyAnswer();
      answers = el('div', { class: 'grid2' }, answerEditor(t.artistAnswer, 'Artiste', () => changed(), suggestFor('artist'), { t, key: 'artist', type: 'artist' }), answerEditor(t.titleAnswer, 'Titre', () => changed(), suggestFor('title'), { t, key: 'title', type: 'title' }));
    } else {
      const block = { mode: t.answerMode || 'multiple-choice', choices: t.choices, correctAnswer: t.correctAnswer, aliases: t.aliases, ignoreArticles: t.ignoreArticles, typoTolerance: t.typoTolerance };
      // Keep the track and the block in sync (the block is the editor's view of the track's answer fields).
      const sync = () => { t.answerMode = block.mode; t.choices = block.choices; t.correctAnswer = block.correctAnswer; t.aliases = block.aliases; t.ignoreArticles = block.ignoreArticles; t.typoTolerance = block.typoTolerance; changed(); };
      answers = answerEditor(block, 'Réponse', sync, suggestFor(qType), { t, key: 'main', type: qType });
    }
    const fillBtn = qType !== 'artist-title' && (t.answerMode || 'multiple-choice') === 'multiple-choice' ? btn('Mettre la bonne réponse depuis la fiche du morceau', () => {
      const value = suggestFor(qType)();
      if (!value) { toast('Renseignez d’abord le champ correspondant (artiste, titre ou année)', true); return; }
      let i = t.choices.findIndex((c) => c === value);
      if (i < 0) i = t.choices.findIndex((c) => !c);
      if (i < 0) { if (t.choices.length >= MAX_CHOICES) { toast('8 propositions au maximum', true); return; } t.choices.push(''); i = t.choices.length - 1; }
      t.choices[i] = value; t.correctAnswer = value; changed(true);
    }, 'small ghost') : null;

    node.append(...[
      t.musicTrackId ? el('p', { class: 'hint' }, `📚 Lié à la bibliothèque (${t.musicTrackId}) : les champs vides reprennent les informations de la bibliothèque.`) : null,
      el('div', { class: 'grid2' },
        field(t.musicTrackId ? 'Titre (vide = bibliothèque)' : 'Titre *', inp('title', { maxlength: '120' })),
        field(t.musicTrackId ? 'Artiste (vide = bibliothèque)' : 'Artiste *', inp('artist', { maxlength: '120' })),
        field('Année', inp('year', { type: 'number', min: '1800', max: '2100' }))),
      field('Fichier ou URL audio *', el('div', { class: 'url-line' }, audioInput, uploadBtn('audio', 'audio/*,.mp3,.m4a,.ogg,.wav', 'audioUrl'))),
      audioHint,
      el('div', { class: 'grid4' },
        field('Début de l’extrait (s)', startInput), field('Durée de l’extrait (s)', durInput),
        field('Type de question', typeSelect),
        field('Multiplicateur de points', select(MULTIPLIERS, t.pointsMultiplier ? String(t.pointsMultiplier) : '', (v) => { t.pointsMultiplier = v ? Number(v) : null; changed(true); })),
        field('Difficulté', select(DIFFICULTIES, t.difficulty || '', (v) => { t.difficulty = v; changed(); }))),
      preview,
      field('Question affichée (facultatif)', inp('question', { maxlength: '160', placeholder: 'Par défaut selon le type : « Qui interprète ce morceau ? »…' })),
      answers,
      fillBtn,
      ...(ctx.hooks?.trackFields ? ctx.hooks.trackFields({ t, r, changed }) : []),
      field('Pochette (facultatif, affichée seulement à la révélation)', el('div', { class: 'url-line' }, inp('coverUrl', { placeholder: '/media/… ou https://…', maxlength: '1000' }), uploadBtn('image', 'image/png,image/jpeg,image/webp', 'coverUrl'))),
      field('Notes internes (jamais montrées aux joueurs, visibles sur la télécommande)', (() => { const ta = el('textarea', { maxlength: '500', oninput: (e) => { t.notes = e.target.value; changed(); } }); ta.value = t.notes || ''; return ta; })())].filter(Boolean));
    return node;
  }

  function roundSettings(r) {
    const num = (k, min, max, ph) => el('input', { type: 'number', min: String(min), max: String(max), value: r[k] ?? '', placeholder: ph, oninput: (e) => { r[k] = e.target.value === '' ? null : Number(e.target.value); changed(); } });
    const desc = el('input', { value: r.description || '', maxlength: '300', placeholder: 'Description (facultatif, affichée au lancement de la manche)', oninput: (e) => { r.description = e.target.value; changed(); } });
    return el('details', { class: 'round-settings' }, el('summary', {}, 'Réglages de la manche (scoring, durées, multiplicateur, enchaînement)'),
      el('div', { class: 'stack', style: 'margin-top:8px' }, desc,
        el('div', { class: 'grid4' },
          field('Scoring de la manche', select(SCORING_PRESETS.filter(([v]) => v !== 'custom'), typeof r.scoringPreset === 'string' ? r.scoringPreset : '', (v) => { r.scoringPreset = v || null; changed(); })),
          field('Durée d’extrait (s)', num('trackDuration', 5, 120, String(bt.settings.excerptDuration))),
          field('Compte à rebours (s)', num('countdownDuration', 0, 10, String(bt.settings.countdownDuration))),
          field('Révélation (s, auto)', num('revealDuration', 0, 60, String(bt.settings.revealDuration))),
          field('Classement (s, auto)', num('scoreboardDuration', 0, 60, String(bt.settings.scoreboardDuration))),
          field('Multiplicateur', select(MULTIPLIERS, r.pointsMultiplier > 1 ? String(r.pointsMultiplier) : '', (v) => { r.pointsMultiplier = v ? Number(v) : 1; changed(true); })),
          field('Enchaînement', select([['', 'Comme le blind test'], ...FLOW_MODES.map(([v, l]) => [v, l.split(' :')[0]])], r.automaticMode || '', (v) => { r.automaticMode = v || null; changed(); }))),
        el('p', { class: 'hint' }, 'Un réglage vide reprend celui du blind test. Un morceau peut à son tour surcharger la durée, le type de question et le multiplicateur.')));
  }

  function drawRounds() {
    roundsBox.replaceChildren(...bt.rounds.map((r, ri) => {
      const title = el('input', { value: r.title || '', maxlength: '80', 'aria-label': `Titre de la manche ${ri + 1}`, oninput: (e) => { r.title = e.target.value; changed(); } });
      const mult = r.pointsMultiplier > 1 ? el('span', { class: 'tag warn' }, `x${r.pointsMultiplier}`) : null;
      return el('section', { class: 'round' },
        el('div', { class: 'round-head' },
          el('b', {}, `Manche ${ri + 1}`), title, mult,
          select(QUESTION_TYPES, r.questionType || 'artist', (v) => { r.tracks.forEach((t) => { if (t.questionType === v) t.questionType = null; }); r.questionType = v; changed(true); }),
          btn('↑', () => move(bt.rounds, ri, -1), 'small ghost'),
          btn('↓', () => move(bt.rounds, ri, 1), 'small ghost'),
          btn('✕ Supprimer la manche', () => { if (confirm(`Supprimer la manche « ${r.title} » et ses ${r.tracks.length} morceau(x) ?`)) { bt.rounds.splice(ri, 1); changed(true); } }, 'small ghost')),
        roundSettings(r),
        ...r.tracks.map((t, ti) => trackEditor(r, ri, t, ti)),
        el('div', { class: 'toolbar', style: 'margin:0' },
          btn('+ Ajouter un morceau', () => { r.tracks.push(emptyTrack(null)); openTracks.add(`${ri}:${r.tracks.length - 1}`); changed(true); }, 'small'),
          btn('+ Ajouter plusieurs fichiers audio…', async () => {
            const files = await pickFile('audio/*,.mp3,.m4a,.ogg,.wav', true);
            for (const f of files) {
              try {
                const m = await upload('audio', f);
                // The file name is only a helper for the editor; the stored URL is random and reveals nothing.
                const guess = f.name.replace(/\.[^.]+$/, '').split(/\s+-\s+/);
                r.tracks.push({ ...emptyTrack(null), audioUrl: m.url, artist: guess.length > 1 ? guess[0] : '', title: guess.length > 1 ? guess.slice(1).join(' - ') : guess[0] });
              } catch (ex) { toast(`${f.name} : ${ex.message}`, true); }
            }
            changed(true);
          }, 'small ghost'),
          ...(ctx.hooks?.roundActions ? ctx.hooks.roundActions({ bt, r, ri, changed, openTracks }) : [])));
    }));
  }

  const s = bt.settings;
  const num = (k, min, max) => el('input', { type: 'number', min: String(min), max: String(max), value: s[k], oninput: (e) => { s[k] = Number(e.target.value); changed(); } });
  const titleInput = el('input', { value: bt.title, maxlength: '100', placeholder: 'Ex. Blind Test Années 80', oninput: (e) => { bt.title = e.target.value; changed(); } });
  const desc = el('textarea', { maxlength: '500', placeholder: 'Ex. 30 morceaux emblématiques', oninput: (e) => { bt.description = e.target.value; changed(); } });
  desc.value = bt.description || '';

  // Scoring of the whole blind test: a preset or a custom configuration.
  const customBox = el('div');
  const drawCustom = () => {
    const sc = s.scoring;
    if (!sc || sc.preset !== 'custom') { customBox.replaceChildren(); return; }
    const f = (k, label) => field(label, el('input', { type: 'number', min: '-10000', max: '10000', value: sc[k] ?? 0, oninput: (e) => { sc[k] = Number(e.target.value); changed(); } }));
    customBox.replaceChildren(el('div', { class: 'grid4' },
      f('correctPoints', 'Bonne réponse'), f('artistPoints', 'Artiste correct'), f('titlePoints', 'Titre correct'), f('speedBonusMax', 'Bonus rapidité max'),
      f('streakStep', 'Bonus par série'), f('streakMax', 'Plafond série'), f('wrongAnswerPoints', 'Mauvaise réponse'), f('noAnswerPoints', 'Sans réponse')));
  };
  const presetSelect = select(SCORING_PRESETS, s.scoring ? s.scoring.preset : '', (v) => {
    s.scoring = v ? (v === 'custom' ? { preset: 'custom', correctPoints: 500, artistPoints: 500, titlePoints: 500, speedBonusMax: 250, streakStep: 100, streakMax: 500, wrongAnswerPoints: 0, noAnswerPoints: 0, ...(s.scoring || {}), preset: 'custom' } : { preset: v }) : null;
    drawCustom(); changed();
  });
  drawCustom();

  async function save() {
    try {
      const body = { blindTest: payload() };
      const r = id ? await api(`/api/admin/blind-tests/${id}`, body, 'PUT') : await api('/api/admin/blind-tests', body);
      dirty = false;
      localStorage.removeItem(draftKey);
      status.textContent = `Enregistré ✓ ${new Date().toLocaleTimeString('fr-FR')}`;
      toast(r.warnings?.length ? `Enregistré avec ${r.warnings.length} avertissement(s)` : 'Blind test enregistré');
      if (!id) { ctx.setLeaveGuard(null); location.hash = `#/blindtests/${r.id}`; return; }
      bt = prepare(r.blindTest);
      drawRounds();
      validate();
    } catch (ex) { toast(ex.message, true); validate(); }
  }

  page(id ? `Modifier : ${bt.title || 'blind test'}` : 'Nouveau blind test',
    upgradedNotice ? el('div', { class: 'warnings' }, 'Ce blind test utilise l’ancien format (V1). Il est converti à l’ouverture ; enregistrez pour le passer au nouveau format (le fichier d’origine importé n’est pas modifié).') : null,
    el('div', { class: 'card stack' },
      el('div', { class: 'grid2' }, field('Titre *', titleInput), field('Description', desc)),
      el('div', { class: 'grid4' },
        field('Compte à rebours (s)', num('countdownDuration', 0, 10)),
        field('Durée d’extrait par défaut (s)', num('excerptDuration', 5, 120)),
        field('Durée de révélation (s)', num('revealDuration', 0, 60)),
        field('Durée du classement (s)', num('scoreboardDuration', 0, 60)),
        field('Mode de réponse par défaut', select([['multiple-choice', 'QCM (2 à 8 propositions)'], ['free-text', 'Saisie libre']], s.answerMode, (v) => { s.answerMode = v; changed(true); }))),
      el('div', { class: 'grid2' },
        field('Scoring', presetSelect),
        field('Enchaînement par défaut', select(FLOW_MODES, s.flowMode || 'manual', (v) => {
          if (v === 'automatic' && !confirm('Enchaînement automatique : les morceaux s’enchaîneront seuls pendant la partie (l’animateur garde pause et reprise). Confirmer ?')) { if (document.activeElement) document.activeElement.value = s.flowMode || 'manual'; return; }
          s.flowMode = v; changed();
        }))),
      customBox,
      el('div', { class: 'grid2' },
        check('Autoriser à rejoindre une partie commencée', s.allowLateJoin, (v) => { s.allowLateJoin = v; changed(); }),
        check('Autoriser le changement de réponse', s.allowAnswerChange, (v) => { s.allowAnswerChange = v; changed(); }),
        check('Mélanger l’ordre des propositions', s.shuffleChoices, (v) => { s.shuffleChoices = v; changed(); })),
      el('p', { class: 'hint' }, '🔊 Le son est toujours joué uniquement sur l’ordinateur de l’animateur, jamais sur les téléphones.')),
    el('h2', { style: 'margin-top:16px' }, 'Manches et morceaux'),
    roundsBox,
    el('div', { class: 'toolbar', style: 'margin-top:12px' }, btn('+ Ajouter une manche', () => { bt.rounds.push({ title: `Manche ${bt.rounds.length + 1}`, questionType: 'artist', pointsMultiplier: 1, tracks: [emptyTrack(null)] }); changed(true); }, 'ghost')),
    issuesBox,
    el('div', { class: 'sticky-save' },
      btn('💾 Enregistrer', save, 'accent'),
      id ? btn('▶ Lancer une partie', () => { if (dirty) { toast('Enregistrez d’abord vos modifications', true); return; } launchGame(id); }, 'ghost') : null,
      id ? btn('⬇ Exporter JSON', () => download(`${id}.json`, payload()), 'ghost') : null,
      ...(ctx.hooks?.editorActions && id ? ctx.hooks.editorActions({ id, isDirty: () => dirty }) : []),
      el('a', { class: 'btn ghost', href: '#/blindtests' }, 'Retour à la liste'),
      status));
  if (dirty) status.textContent = 'Brouillon restauré (non enregistré)';
  drawRounds();
  validate();
}
