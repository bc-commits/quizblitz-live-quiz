// Single source of truth for points. Always computed on the server from server
// timestamps: the client never sends a score, a response time or a multiplier.
//
// 1. Classic quiz (historical formula, used by the 9 legacy question types):
//      correct = basePoints + speedBonus * (1 - t/T) ; streak bonus +streakStep per
//      consecutive correct answer beyond the first, capped at streakCap.
// 2. Blind test (presets or custom configuration, see PRESETS):
//      single answer  : correctPoints if right, wrongAnswerPoints if wrong
//      artist + title : artistPoints and/or titlePoints (partial points)
//      speed bonus    : speedBonusMax * (1 - t/T) * (share of the answer that is right)
//      streak         : all parts right -> streak + 1 and bonus min((streak-1)*streakStep, streakMax)
//                       partially right -> streak kept but not increased, no bonus
//                       all wrong / no answer -> streak reset to 0
//      no answer      : noAnswerPoints
//      the total is then multiplied by the question multiplier (x1 .. x5).

const DEFAULT_SCORING = Object.freeze({ basePoints: 500, speedBonus: 500, streakStep: 100, streakCap: 500 });

const PRESETS = Object.freeze({
  classic: { correctPoints: 1000, artistPoints: 500, titlePoints: 500, speedBonusMax: 0, streakStep: 0, streakMax: 0, wrongAnswerPoints: 0, noAnswerPoints: 0 },
  competitive: { correctPoints: 500, artistPoints: 250, titlePoints: 250, speedBonusMax: 500, streakStep: 100, streakMax: 500, wrongAnswerPoints: 0, noAnswerPoints: 0 },
  party: { correctPoints: 500, artistPoints: 500, titlePoints: 500, speedBonusMax: 250, streakStep: 50, streakMax: 250, wrongAnswerPoints: 0, noAnswerPoints: 0 },
  relaxed: { correctPoints: 1, artistPoints: 1, titlePoints: 1, speedBonusMax: 0, streakStep: 0, streakMax: 0, wrongAnswerPoints: 0, noAnswerPoints: 0 },
});
const PRESET_NAMES = [...Object.keys(PRESETS), 'custom'];
const MULTIPLIERS = Object.freeze({ normal: 1, bonus: 2, finale: 3 });

const int = (v, def, min, max) => {
  const n = Math.round(Number(v));
  return v !== undefined && v !== null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

// ---------------------------------------------------------------- classic quiz

function normaliseScoring(cfg = {}) {
  return {
    basePoints: int(cfg.basePoints, DEFAULT_SCORING.basePoints, 0, 5000),
    speedBonus: int(cfg.speedBonus, DEFAULT_SCORING.speedBonus, 0, 5000),
    streakStep: int(cfg.streakStep, DEFAULT_SCORING.streakStep, 0, 1000),
    streakCap: int(cfg.streakCap, DEFAULT_SCORING.streakCap, 0, 5000),
  };
}

const ratioOf = (responseMs, timeLimitMs) => {
  const limit = Math.max(1, Number(timeLimitMs) || 1);
  const ms = Number.isFinite(Number(responseMs)) ? Number(responseMs) : limit;
  return Math.min(1, Math.max(0, ms / limit));
};

/** Base + speed points for a correct answer given `responseMs` out of `timeLimitMs`. */
function speedPoints(responseMs, timeLimitMs, cfg = DEFAULT_SCORING) {
  return Math.round(cfg.basePoints + cfg.speedBonus * (1 - ratioOf(responseMs, timeLimitMs)));
}

/** Streak bonus once the player's streak (including this answer) is `streak`. */
function streakBonus(streak, cfg = DEFAULT_SCORING) {
  return Math.min(Math.max(streak - 1, 0) * cfg.streakStep, cfg.streakCap);
}

// ---------------------------------------------------------------- blind test

/**
 * Normalises a blind-test scoring configuration: { preset, ...overrides }.
 * Unknown presets fall back to `fallback` (already normalised) or "competitive".
 */
function resolveScoring(cfg, fallback) {
  const base = fallback || { preset: 'competitive', ...PRESETS.competitive };
  if (!cfg || typeof cfg !== 'object') {
    if (typeof cfg === 'string' && PRESETS[cfg]) return { preset: cfg, ...PRESETS[cfg] };
    return { ...base };
  }
  const preset = PRESET_NAMES.includes(cfg.preset) ? cfg.preset : (fallback ? fallback.preset : 'competitive');
  const start = preset === 'custom' ? base : { ...(PRESETS[preset] || base) };
  return {
    preset,
    correctPoints: int(cfg.correctPoints, start.correctPoints, 0, 10000),
    artistPoints: int(cfg.artistPoints, start.artistPoints, 0, 10000),
    titlePoints: int(cfg.titlePoints, start.titlePoints, 0, 10000),
    speedBonusMax: int(cfg.speedBonusMax, start.speedBonusMax, 0, 10000),
    streakStep: int(cfg.streakStep, start.streakStep, 0, 5000),
    streakMax: int(cfg.streakMax, start.streakMax, 0, 10000),
    wrongAnswerPoints: int(cfg.wrongAnswerPoints, start.wrongAnswerPoints, -10000, 10000),
    noAnswerPoints: int(cfg.noAnswerPoints, start.noAnswerPoints, -10000, 10000),
  };
}

/** Converts the global (classic) settings into a blind-test "custom" configuration. */
function fromClassicSettings(s = DEFAULT_SCORING) {
  const c = normaliseScoring(s);
  return { preset: 'custom', ...PRESETS.competitive, correctPoints: c.basePoints, speedBonusMax: c.speedBonus, streakStep: c.streakStep, streakMax: c.streakCap };
}

/** Validates a multiplier: a preset name or a number between 1 and 5 (one decimal). */
function normaliseMultiplier(v, def = 1) {
  if (typeof v === 'string' && MULTIPLIERS[v]) return MULTIPLIERS[v];
  const n = Number(v);
  if (v === undefined || v === null || v === '' || !Number.isFinite(n)) return def;
  return Math.min(5, Math.max(1, Math.round(n * 10) / 10));
}

/**
 * Points for one blind-test answer.
 * @param {object} p
 * @param {Array<{key:string, correct:boolean}>} p.parts  judged parts (empty if no answer)
 * @param {number} p.totalParts  parts expected (1, or 2 for artist + title)
 * @param {boolean} p.answered
 * @param {number} p.responseMs  measured by the server from the official opening of the answers
 * @param {number} p.timeLimitMs
 * @param {number} p.streak  the player's streak before this question
 * @param {object} p.cfg  resolved scoring configuration
 * @param {number} p.multiplier
 * @returns {{ points:number, streak:number, allCorrect:boolean, partial:boolean, breakdown:object }}
 */
function blindPoints({ parts = [], totalParts = 1, answered, responseMs, timeLimitMs, streak = 0, cfg, multiplier = 1 }) {
  const c = cfg || resolveScoring(null);
  if (!answered) {
    return { points: Math.round(c.noAnswerPoints * multiplier), streak: 0, allCorrect: false, partial: false, breakdown: { base: c.noAnswerPoints, speed: 0, streak: 0, multiplier } };
  }
  const right = parts.filter((x) => x.correct);
  const allCorrect = right.length === totalParts && totalParts > 0;
  const partial = right.length > 0 && !allCorrect;
  let base;
  if (totalParts === 1) base = right.length ? c.correctPoints : c.wrongAnswerPoints;
  else {
    base = right.reduce((s, x) => s + (x.key === 'artist' ? c.artistPoints : x.key === 'title' ? c.titlePoints : c.correctPoints), 0);
    if (!right.length) base = c.wrongAnswerPoints;
  }
  const share = totalParts ? right.length / totalParts : 0;
  const speed = right.length ? c.speedBonusMax * (1 - ratioOf(responseMs, timeLimitMs)) * share : 0;
  let nextStreak = streak;
  let streakPts = 0;
  if (allCorrect) { nextStreak = streak + 1; streakPts = Math.min(Math.max(nextStreak - 1, 0) * c.streakStep, c.streakMax); }
  else if (!partial) nextStreak = 0;
  const points = Math.round((base + speed + streakPts) * multiplier);
  return { points, streak: nextStreak, allCorrect, partial, breakdown: { base, speed: Math.round(speed), streak: streakPts, multiplier } };
}

module.exports = {
  DEFAULT_SCORING, PRESETS, PRESET_NAMES, MULTIPLIERS,
  normaliseScoring, speedPoints, streakBonus,
  resolveScoring, fromClassicSettings, normaliseMultiplier, blindPoints,
};
