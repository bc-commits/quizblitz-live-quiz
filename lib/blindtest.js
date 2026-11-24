// The "music-blind-test" format (schemaVersion 2): validation, V1 compatibility,
// library references and conversion into game questions.
// See docs/FORMAT_BLIND_TEST.md for the full specification.
//
// A track becomes one "blind" game question made of answer parts:
//   - one part ("main") for artist, title, year, decade and custom questions;
//   - two parts ("artist" and "title") for artist-title questions.
// Each part is multiple choice (2 to 8 choices) or free text (answer + aliases).
// The audio excerpt is only ever sent to the host screen; the answers only at the reveal.

const crypto = require('crypto');
const { canon } = require('./answers');
const Scoring = require('./scoring');

const TYPE = 'music-blind-test';
const SCHEMA_VERSION = 2;
const QUESTION_TYPES = ['artist', 'title', 'artist-title', 'year', 'decade', 'custom'];
const ANSWER_MODES = ['multiple-choice', 'free-text'];
const FLOW_MODES = ['manual', 'semi-auto', 'automatic'];
const DIFFICULTIES = ['', 'easy', 'medium', 'hard'];
const MIN_CHOICES = 2;
const MAX_CHOICES = 8;
const MAX_ROUNDS = 20;
const MAX_TRACKS = 200;

const QUESTION_TEXT = {
  artist: 'Qui interprète ce morceau ?',
  title: 'Quel est le titre de ce morceau ?',
  'artist-title': 'Trouvez l’artiste et le titre !',
  year: 'En quelle année est sorti ce morceau ?',
  decade: 'De quelle décennie date ce morceau ?',
  custom: 'Quelle est la bonne réponse ?',
};
const PART_LABELS = { main: 'Réponse', artist: 'Artiste', title: 'Titre' };

const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const slug = (s) => canon(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const newId = (prefix) => `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
const has = (v) => v !== undefined && v !== null && v !== '';
/** Optional integer in [min, max]; null when absent, NaN when invalid. */
const optInt = (v, min, max) => {
  if (!has(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : NaN;
};
const decadeLabel = (year) => (Number.isInteger(year) ? `Années ${Math.floor(year / 10) * 10}` : '');

// Audio: a file uploaded to this server, a file placed in public/audio, or an https link.
const isAudioUrl = (u) => /^\/media\/[a-f0-9]{32}\.(mp3|m4a|ogg|wav)$/.test(u) || /^\/audio\/[\w.\-/]+\.(mp3|m4a|ogg|wav)$/i.test(u) || /^https:\/\/[^\s"'<>]+$/i.test(u);
const isImageUrl = (u) => u === '' || /^\/media\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(u) || /^\/covers\/[\w.\-/]+\.(png|jpe?g|webp)$/i.test(u) || /^https:\/\/[^\s"'<>]+$/i.test(u);

const cleanList = (arr, max, len = 120) => (Array.isArray(arr) ? arr : typeof arr === 'string' ? arr.split(/[,;\n]/) : [])
  .map((x) => str(x, len)).filter(Boolean).slice(0, max);

/** Normalises an answer block ({ mode, choices, correctAnswer, answer, aliases, ... }). */
function normaliseAnswer(a, fallbackMode = 'multiple-choice') {
  const src = a && typeof a === 'object' ? a : {};
  const mode = ANSWER_MODES.includes(src.mode) ? src.mode : fallbackMode;
  return {
    mode,
    choices: Array.isArray(src.choices) ? src.choices.map((c) => str(c, 80)) : [],
    correctAnswer: str(src.correctAnswer ?? src.answer, 120),
    aliases: cleanList(src.aliases, 20),
    ignoreArticles: src.ignoreArticles !== false,
    typoTolerance: src.typoTolerance === true,
  };
}

/** Checks a multiple-choice block: 2..8 non-empty, unique choices containing the answer. */
function checkChoices(block, label, path, err) {
  const { choices, correctAnswer } = block;
  if (choices.length < MIN_CHOICES || choices.length > MAX_CHOICES) err(`${path}.choices`, `${label} : il faut entre ${MIN_CHOICES} et ${MAX_CHOICES} propositions (actuellement ${choices.length})`);
  if (choices.some((c) => !c)) err(`${path}.choices`, `${label} : une proposition est vide`);
  const filled = choices.filter(Boolean).map(canon);
  if (new Set(filled).size !== filled.length) err(`${path}.choices`, `${label} : propositions en double`);
  if (!correctAnswer) err(`${path}.correctAnswer`, `${label} : indiquez la bonne réponse`);
  else if (!choices.includes(correctAnswer)) err(`${path}.correctAnswer`, `${label} : la bonne réponse doit faire partie des propositions`);
}

/** The expected answer of a single-part question, derived from the track when not given. */
function expectedAnswer(track, type) {
  if (type === 'artist') return track.artist;
  if (type === 'title') return track.title;
  if (type === 'year') return Number.isInteger(track.year) ? String(track.year) : '';
  if (type === 'decade') return decadeLabel(track.year);
  return '';
}

/** Fills a track's empty fields from its music library entry (title, artist, audio...). */
function applyLibrary(t, lib) {
  if (!lib) return t;
  return {
    ...t,
    title: t.title || lib.title,
    artist: t.artist || lib.artist,
    year: t.year ?? lib.year ?? null,
    audioUrl: t.audioUrl || lib.audioUrl || '',
    coverUrl: t.coverUrl || lib.coverUrl || '',
    startTime: t.startTime ?? lib.defaultStartTime ?? 0,
    duration: t.duration ?? lib.defaultDuration ?? null,
    libraryAliases: { artist: lib.artistAliases || [], title: lib.titleAliases || [] },
  };
}

/**
 * Validates a blind test (V1 or V2). Returns { blindTest, errors, warnings }.
 * options.library: (id) => music track | null, to resolve musicTrackId references.
 */
function validateBlindTest(input, options = {}) {
  const errors = [];
  const warnings = [];
  const err = (p, message) => errors.push({ path: p, message });
  const warn = (p, message) => warnings.push({ path: p, message });
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { blindTest: null, errors: [{ path: '', message: 'Le blind test doit être un objet JSON' }], warnings, upgraded: false };
  }
  const upgraded = input.schemaVersion !== SCHEMA_VERSION;
  if (input.type !== undefined && input.type !== TYPE) err('type', `Le type doit être "${TYPE}"`);
  if (has(input.schemaVersion) && !(Number.isInteger(input.schemaVersion) && input.schemaVersion >= 1 && input.schemaVersion <= SCHEMA_VERSION)) {
    err('schemaVersion', `Version de format non prise en charge (${input.schemaVersion})`);
  }

  const title = str(input.title, 100);
  if (!title) err('title', 'Le titre est obligatoire');
  const s = input.settings && typeof input.settings === 'object' ? input.settings : {};
  const settings = {
    answerMode: ANSWER_MODES.includes(s.answerMode) ? s.answerMode : 'multiple-choice',
    countdownDuration: optInt(s.countdownDuration, 0, 10) ?? 3,
    excerptDuration: optInt(s.excerptDuration, 5, 120) ?? 20,
    revealDuration: optInt(s.revealDuration, 0, 60) ?? 8,
    scoreboardDuration: optInt(s.scoreboardDuration, 0, 60) ?? 8,
    allowLateJoin: s.allowLateJoin !== false,
    allowAnswerChange: s.allowAnswerChange === true,
    playAudioOnHostOnly: true, // phones never play audio (avoids devices drifting out of sync)
    shuffleChoices: s.shuffleChoices === true,
    flowMode: FLOW_MODES.includes(s.flowMode) ? s.flowMode : 'manual',
    scoring: s.scoring ? Scoring.resolveScoring(s.scoring) : null,
  };
  if (s.answerMode && !ANSWER_MODES.includes(s.answerMode)) warn('settings.answerMode', `Mode "${s.answerMode}" non disponible : QCM utilisé`);
  for (const k of ['countdownDuration', 'excerptDuration', 'revealDuration', 'scoreboardDuration']) {
    if (Number.isNaN(settings[k])) err(`settings.${k}`, 'Durée invalide');
  }

  const rounds = [];
  const ids = new Set();
  const uniqueId = (raw, prefix) => {
    let v = str(raw, 60).replace(/[^\w-]/g, '');
    if (!v || ids.has(v)) v = newId(prefix);
    ids.add(v);
    return v;
  };
  const roundsIn = Array.isArray(input.rounds) ? input.rounds : [];
  if (!roundsIn.length) err('rounds', 'Ajoutez au moins une manche');
  if (roundsIn.length > MAX_ROUNDS) err('rounds', `Trop de manches (maximum ${MAX_ROUNDS})`);
  let trackCount = 0;

  roundsIn.slice(0, MAX_ROUNDS).forEach((r, ri) => {
    const rp = `rounds[${ri}]`;
    if (!r || typeof r !== 'object') { err(rp, 'Manche invalide'); return; }
    const questionType = QUESTION_TYPES.includes(r.questionType) ? r.questionType : 'artist';
    const round = {
      id: uniqueId(r.id, 'round'),
      title: str(r.title, 80) || `Manche ${ri + 1}`,
      description: str(r.description, 300),
      questionType,
      scoringPreset: r.scoringPreset ? (typeof r.scoringPreset === 'string' ? (Scoring.PRESET_NAMES.includes(r.scoringPreset) && r.scoringPreset !== 'custom' ? r.scoringPreset : null) : Scoring.resolveScoring(r.scoringPreset)) : null,
      trackDuration: optInt(r.trackDuration, 5, 120),
      countdownDuration: optInt(r.countdownDuration, 0, 10),
      revealDuration: optInt(r.revealDuration, 0, 60),
      scoreboardDuration: optInt(r.scoreboardDuration, 0, 60),
      pointsMultiplier: Scoring.normaliseMultiplier(r.pointsMultiplier, 1),
      automaticMode: FLOW_MODES.includes(r.automaticMode) ? r.automaticMode : null,
      tracks: [],
    };
    if (typeof r.scoringPreset === 'string' && r.scoringPreset && !round.scoringPreset) warn(`${rp}.scoringPreset`, `Manche ${ri + 1} : mode de scoring inconnu, valeur globale utilisée`);
    for (const k of ['trackDuration', 'countdownDuration', 'revealDuration', 'scoreboardDuration']) if (Number.isNaN(round[k])) err(`${rp}.${k}`, `Manche ${ri + 1} : durée invalide`);
    const tracksIn = Array.isArray(r.tracks) ? r.tracks : [];
    if (!tracksIn.length) err(`${rp}.tracks`, `La manche « ${round.title} » ne contient aucun morceau`);

    tracksIn.forEach((t, ti) => {
      const tp = `${rp}.tracks[${ti}]`;
      const label = `Manche ${ri + 1}, morceau ${ti + 1}`;
      trackCount++;
      if (!t || typeof t !== 'object') { err(tp, `${label} : morceau invalide`); return; }
      const musicTrackId = str(t.musicTrackId, 60).replace(/[^\w-]/g, '') || null;
      const lib = musicTrackId && options.library ? options.library(musicTrackId) : null;
      if (musicTrackId && options.library && !lib) err(`${tp}.musicTrackId`, `${label} : morceau de bibliothèque introuvable (${musicTrackId})`);
      const ownQType = QUESTION_TYPES.includes(t.questionType) && t.questionType !== questionType ? t.questionType : null;
      const qType = ownQType || questionType;
      // Accept both the spec's { answers: { artist, title } } and { artistAnswer, titleAnswer }.
      const artistIn = t.artistAnswer || t.answers?.artist;
      const titleIn = t.titleAnswer || t.answers?.title;
      let track = {
        id: uniqueId(t.id, 'track'),
        musicTrackId,
        title: str(t.title, 120),
        artist: str(t.artist, 120),
        year: has(t.year) ? Number(t.year) : null,
        audioUrl: str(t.audioUrl, 1000),
        coverUrl: str(t.coverUrl, 1000),
        startTime: has(t.startTime) ? Number(t.startTime) : null,
        duration: optInt(t.duration, 5, 120),
        questionType: ownQType,
        question: str(t.question, 160),
        answerMode: ANSWER_MODES.includes(t.answerMode) ? t.answerMode : settings.answerMode,
        choices: Array.isArray(t.choices) ? t.choices.map((c) => str(c, 80)) : [],
        correctAnswer: str(t.correctAnswer, 120),
        aliases: cleanList(t.aliases, 20),
        ignoreArticles: t.ignoreArticles !== false,
        typoTolerance: t.typoTolerance === true,
        artistAnswer: qType === 'artist-title' || artistIn ? normaliseAnswer(artistIn) : null,
        titleAnswer: qType === 'artist-title' || titleIn ? normaliseAnswer(titleIn) : null,
        pointsMultiplier: has(t.pointsMultiplier) ? Scoring.normaliseMultiplier(t.pointsMultiplier, 1) : null,
        scoring: t.scoring ? (typeof t.scoring === 'string' ? (Scoring.PRESETS[t.scoring] ? t.scoring : null) : Scoring.resolveScoring(t.scoring)) : null,
        countdownDuration: optInt(t.countdownDuration, 0, 10),
        revealDuration: optInt(t.revealDuration, 0, 60),
        scoreboardDuration: optInt(t.scoreboardDuration, 0, 60),
        difficulty: DIFFICULTIES.includes(t.difficulty) ? t.difficulty : '',
        notes: str(t.notes, 500),
        lockedChoices: t.lockedChoices === true,
      };
      const eff = applyLibrary(track, lib); // effective values used for checks (stored track keeps overrides only)
      if (!eff.title) err(`${tp}.title`, `${label} : le titre est obligatoire`);
      if (!eff.artist) err(`${tp}.artist`, `${label} : l'artiste est obligatoire`);
      if (eff.year !== null && !(Number.isInteger(eff.year) && eff.year >= 1800 && eff.year <= 2100)) err(`${tp}.year`, `${label} : année invalide`);
      if (!eff.audioUrl) err(`${tp}.audioUrl`, `${label} : ajoutez un fichier ou une URL audio`);
      else if (!isAudioUrl(eff.audioUrl)) err(`${tp}.audioUrl`, `${label} : URL audio invalide (fichier téléversé ou lien https)`);
      if (!isImageUrl(track.coverUrl)) err(`${tp}.coverUrl`, `${label} : URL de pochette invalide`);
      if (track.startTime !== null && !(Number.isFinite(track.startTime) && track.startTime >= 0 && track.startTime <= 3600)) err(`${tp}.startTime`, `${label} : début d'extrait invalide`);
      else if (track.startTime !== null) track.startTime = Math.round(track.startTime * 10) / 10;
      for (const k of ['duration', 'countdownDuration', 'revealDuration', 'scoreboardDuration']) if (Number.isNaN(track[k])) err(`${tp}.${k}`, `${label} : durée invalide`);
      if (has(t.pointsMultiplier) && !(Number(t.pointsMultiplier) >= 1 && Number(t.pointsMultiplier) <= 5) && !Scoring.MULTIPLIERS[t.pointsMultiplier]) {
        warn(`${tp}.pointsMultiplier`, `${label} : multiplicateur ramené entre x1 et x5`);
      }

      if (qType === 'artist-title') {
        for (const [key, block, fallback] of [['artist', track.artistAnswer, eff.artist], ['title', track.titleAnswer, eff.title]]) {
          const bl = `${label} (${PART_LABELS[key].toLowerCase()})`;
          if (block.mode === 'multiple-choice') {
            if (!block.correctAnswer && fallback && block.choices.includes(fallback)) block.correctAnswer = fallback;
            checkChoices(block, bl, `${tp}.${key}Answer`, err);
          } else {
            if (!block.correctAnswer) block.correctAnswer = fallback || '';
            if (!block.correctAnswer) err(`${tp}.${key}Answer`, `${bl} : réponse attendue manquante`);
          }
        }
      } else if (track.answerMode === 'multiple-choice') {
        if (!track.correctAnswer) {
          const exp = expectedAnswer(eff, qType);
          if (exp && track.choices.includes(exp)) track.correctAnswer = exp;
        }
        checkChoices(track, label, tp, err);
      } else {
        const exp = track.correctAnswer || expectedAnswer(eff, qType);
        if (!exp) err(`${tp}.correctAnswer`, `${label} : réponse attendue manquante pour la saisie libre`);
      }
      if (/^https:\/\//i.test(eff.audioUrl) && [eff.title, eff.artist].some((x) => x && slug(eff.audioUrl).includes(slug(x)) && slug(x).length > 3)) {
        warn(`${tp}.audioUrl`, `${label} : l'URL audio semble contenir la réponse ; elle reste invisible des joueurs mais apparaît dans le navigateur de l'animateur`);
      }
      round.tracks.push(track);
    });
    rounds.push(round);
  });
  if (trackCount > MAX_TRACKS) err('rounds', `Trop de morceaux (maximum ${MAX_TRACKS})`);

  const blindTest = {
    schemaVersion: SCHEMA_VERSION,
    id: str(input.id, 60).replace(/[^\w-]/g, '') || `blindtest-${slug(title) || 'sans-titre'}-${crypto.randomBytes(3).toString('hex')}`,
    type: TYPE,
    title,
    description: str(input.description, 500),
    settings,
    rounds,
  };
  return { blindTest, errors, warnings, upgraded };
}

/** Throws a 400 error listing the problems if the blind test is invalid. */
function assertValid(input, options) {
  const r = validateBlindTest(input, options);
  if (r.errors.length) {
    const e = new Error(r.errors.slice(0, 5).map((x) => x.message).join(' · ') + (r.errors.length > 5 ? ` (+${r.errors.length - 5})` : ''));
    e.status = 400;
    e.details = r.errors;
    throw e;
  }
  return r;
}

const countTracks = (bt) => bt.rounds.reduce((n, r) => n + r.tracks.length, 0);

function multiplierLabel(m) {
  if (m >= 3) return `FINALE x${m}`;
  if (m > 1) return `QUESTION BONUS · POINTS x${m}`;
  return '';
}

/** Builds the answer parts of a question from a (library-resolved) track. */
function buildParts(t, qType) {
  const part = (key, block, defaultAnswer, libAliases = []) => {
    if (block.mode === 'multiple-choice') {
      return { key, label: PART_LABELS[key], mode: 'mc', choices: [...block.choices], correct: [block.choices.indexOf(block.correctAnswer)] };
    }
    return { key, label: PART_LABELS[key], mode: 'text', answer: block.correctAnswer || defaultAnswer,
      aliases: [...new Set([...(block.aliases || []), ...libAliases])], ignoreArticles: block.ignoreArticles !== false, typoTolerance: !!block.typoTolerance, maxLength: 80 };
  };
  if (qType === 'artist-title') {
    return [part('artist', t.artistAnswer, t.artist, t.libraryAliases?.artist), part('title', t.titleAnswer, t.title, t.libraryAliases?.title)];
  }
  const libAliases = qType === 'artist' ? t.libraryAliases?.artist : qType === 'title' ? t.libraryAliases?.title : [];
  return [part('main', { mode: t.answerMode, choices: t.choices, correctAnswer: t.correctAnswer || expectedAnswer(t, qType), aliases: t.aliases,
    ignoreArticles: t.ignoreArticles, typoTolerance: t.typoTolerance }, expectedAnswer(t, qType), libAliases)];
}

/**
 * Converts a validated blind test into the quiz shape the game engine plays.
 * options.library: (id) => music track ; options.appScoring: global fallback scoring.
 */
function toGameQuiz(bt, options = {}) {
  const questions = [];
  const btScoring = Scoring.resolveScoring(bt.settings.scoring, options.appScoring || Scoring.resolveScoring(null));
  bt.rounds.forEach((round, ri) => {
    const roundScoring = Scoring.resolveScoring(round.scoringPreset, btScoring);
    round.tracks.forEach((raw, ti) => {
      const lib = raw.musicTrackId && options.library ? options.library(raw.musicTrackId) : null;
      const t = applyLibrary(raw, lib);
      const qType = t.questionType || round.questionType;
      const duration = t.duration ?? round.trackDuration ?? bt.settings.excerptDuration;
      const multiplier = t.pointsMultiplier ?? round.pointsMultiplier ?? 1;
      const parts = buildParts(t, qType);
      const single = parts.length === 1 && parts[0].mode === 'mc' ? parts[0] : null;
      questions.push({
        type: 'blind',
        text: t.question || QUESTION_TEXT[qType] || QUESTION_TEXT.artist,
        time: duration,
        image: '',
        points: 'standard',
        parts,
        // Kept for the host tiles and reports when the question is a single multiple choice.
        ...(single ? { choices: [...single.choices], correct: [...single.correct] } : {}),
        multiplier,
        scoring: Scoring.resolveScoring(t.scoring, roundScoring),
        flow: {
          mode: round.automaticMode || bt.settings.flowMode || 'manual',
          countdown: t.countdownDuration ?? round.countdownDuration ?? bt.settings.countdownDuration,
          reveal: t.revealDuration ?? round.revealDuration ?? bt.settings.revealDuration,
          scoreboard: t.scoreboardDuration ?? round.scoreboardDuration ?? bt.settings.scoreboardDuration,
        },
        blind: {
          trackId: t.id,
          musicTrackId: t.musicTrackId || null,
          questionType: qType,
          roundIndex: ri,
          roundCount: bt.rounds.length,
          roundTitle: round.title,
          roundDescription: round.description,
          trackInRound: ti,
          tracksInRound: round.tracks.length,
          audioUrl: t.audioUrl,
          startTime: t.startTime ?? 0,
          duration,
          multiplier,
          multiplierLabel: multiplierLabel(multiplier),
          notes: t.notes || '',
          reveal: { title: t.title, artist: t.artist, year: t.year, coverUrl: t.coverUrl },
        },
      });
    });
  });
  return { title: bt.title, kind: TYPE, blindTestId: bt.id, settings: bt.settings, questions };
}

/** Media URLs referenced by a blind test (audio and covers uploaded to this server). */
function referencedMedia(bt) {
  const out = [];
  for (const r of bt.rounds || []) for (const t of r.tracks || []) {
    for (const u of [t.audioUrl, t.coverUrl]) if (typeof u === 'string' && u.startsWith('/media/')) out.push(u);
  }
  return out;
}

/** Music library ids referenced by a blind test. */
const referencedLibrary = (bt) => [...new Set((bt.rounds || []).flatMap((r) => (r.tracks || []).map((t) => t.musicTrackId).filter(Boolean)))];

module.exports = {
  TYPE, SCHEMA_VERSION, QUESTION_TYPES, ANSWER_MODES, FLOW_MODES, QUESTION_TEXT, MIN_CHOICES, MAX_CHOICES,
  validateBlindTest, assertValid, toGameQuiz, countTracks, referencedMedia, referencedLibrary, decadeLabel, expectedAnswer, multiplierLabel,
};
