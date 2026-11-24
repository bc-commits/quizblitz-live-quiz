// Rule-based generation of wrong answers ("distractors") from the music library.
// Not artificial intelligence: candidates are ranked by simple rules (same decade,
// same genre) with a deterministic pseudo-random tie-break seeded by the track, so the
// same request always gives the same choices. The admin can regenerate (new seed),
// edit or lock the result, which is then stored in the blind test.

const { canon } = require('./answers');

function seededRandom(seed) {
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  let a = h >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function shuffle(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const decadeOf = (y) => (Number.isInteger(y) ? Math.floor(y / 10) * 10 : null);
const decadeLabel = (d) => `Années ${d}`;

/** Picks `n` unique values from ranked candidates (higher score first, seeded tie-break). */
function pickRanked(candidates, n, rnd, exclude) {
  const seen = new Set(exclude.map(canon));
  const ranked = candidates.map((c) => ({ ...c, r: rnd() })).sort((a, b) => b.score - a.score || a.r - b.r);
  const out = [];
  for (const c of ranked) {
    const k = canon(c.value);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(c.value);
    if (out.length >= n) break;
  }
  return out;
}

/**
 * @param {object} target  { artist, title, year, genre }
 * @param {'artist'|'title'|'year'|'decade'} type
 * @param {Array<{artist,title,year,genre}>} library  candidate tracks (target excluded or not)
 * @param {object} opts  { count: total choices 2..8, seed }
 * @returns {{ choices: string[], correctAnswer: string, warnings: string[] }}
 */
function generateChoices(target, type, library, { count = 4, seed = '' } = {}) {
  const n = Math.min(8, Math.max(2, Math.round(Number(count) || 4)));
  const rnd = seededRandom(`${seed}|${type}|${target.artist}|${target.title}`);
  const warnings = [];
  const d = decadeOf(target.year);
  let correct = '';
  let wrong = [];
  if (type === 'artist') {
    correct = target.artist;
    const byArtist = new Map();
    for (const t of library) {
      if (!t.artist || canon(t.artist) === canon(correct)) continue;
      const score = (d !== null && decadeOf(t.year) === d ? 2 : 0) + (target.genre && t.genre && canon(t.genre) === canon(target.genre) ? 1 : 0);
      const prev = byArtist.get(canon(t.artist));
      if (!prev || prev.score < score) byArtist.set(canon(t.artist), { value: t.artist, score });
    }
    wrong = pickRanked([...byArtist.values()], n - 1, rnd, [correct]);
  } else if (type === 'title') {
    correct = target.title;
    // Titles by the same artist would make the answer ambiguous or obvious: excluded.
    const cands = library.filter((t) => t.title && canon(t.title) !== canon(correct) && canon(t.artist) !== canon(target.artist))
      .map((t) => ({ value: t.title, score: (d !== null && decadeOf(t.year) === d ? 2 : 0) + (target.genre && t.genre && canon(t.genre) === canon(target.genre) ? 1 : 0) }));
    wrong = pickRanked(cands, n - 1, rnd, [correct]);
  } else if (type === 'year') {
    if (!Number.isInteger(target.year)) return { choices: [], correctAnswer: '', warnings: ['Année du morceau inconnue'] };
    correct = String(target.year);
    const maxYear = new Date().getFullYear();
    const offsets = shuffle([-1, 1, -2, 2, -3, 3, -4, 4, -5, 5, -6, 6], rnd).sort((a, b) => Math.abs(a) - Math.abs(b) || 0);
    wrong = offsets.map((o) => target.year + o).filter((y) => y >= 1900 && y <= maxYear).slice(0, n - 1).map(String);
  } else if (type === 'decade') {
    if (d === null) return { choices: [], correctAnswer: '', warnings: ['Année du morceau inconnue'] };
    correct = decadeLabel(d);
    const maxDecade = Math.floor(new Date().getFullYear() / 10) * 10;
    const near = [-10, 10, -20, 20, -30, 30, -40, 40].map((o) => d + o).filter((x) => x >= 1940 && x <= maxDecade);
    wrong = near.slice(0, n - 1).map(decadeLabel);
  } else {
    return { choices: [], correctAnswer: '', warnings: ['Génération non disponible pour ce type de question'] };
  }
  if (wrong.length < n - 1) warnings.push(`Seulement ${wrong.length + 1} proposition(s) possibles : ajoutez des morceaux à la bibliothèque ou complétez à la main.`);
  const choices = type === 'year' || type === 'decade'
    ? [correct, ...wrong].sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10))
    : shuffle([correct, ...wrong], rnd);
  return { choices, correctAnswer: correct, warnings };
}

module.exports = { generateChoices, seededRandom };
