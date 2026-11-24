// Blind test reports: global statistics, per-track statistics and highlights, computed
// from the saved game (games / players / answers tables). Admin only.

const { toCsv } = require('./library');

const DIFFICULTY = (rate) => (rate === null ? null : rate >= 0.7 ? 'facile' : rate >= 0.35 ? 'moyen' : 'difficile');
const avg = (xs) => (xs.length ? Math.round(xs.reduce((s, x) => s + x, 0) / xs.length) : null);

function blindReport(db, id) {
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(Number(id));
  if (!g) return null;
  const quiz = JSON.parse(g.quiz_json);
  const n = g.questions_played;
  const questions = quiz.questions.slice(0, n);
  const players = db.prepare('SELECT * FROM players WHERE game_id = ? ORDER BY rank').all(g.id);
  const answers = db.prepare('SELECT * FROM answers WHERE game_id = ?').all(g.id);
  const teamsInfo = g.teams_json ? JSON.parse(g.teams_json) : null;
  const byPlayer = new Map(players.map((p) => [p.id, []]));
  for (const a of answers) {
    const value = a.response_json !== null ? JSON.parse(a.response_json) : a.choice;
    const detail = a.detail_json ? JSON.parse(a.detail_json) : null;
    byPlayer.get(a.player_id)[a.question_index] = { value, correct: !!a.correct, points: a.points, ms: a.response_ms, parts: detail?.parts || null };
  }
  const given = (a) => a && a.value !== null && a.value !== undefined;

  // ---- per track
  const tracks = questions.map((q, i) => {
    const list = players.map((p) => byPlayer.get(p.id)[i]);
    const answered = list.filter(given);
    const correct = answered.filter((a) => a.correct).length;
    const partRate = (key) => {
      if (!q.parts || !q.parts.some((x) => x.key === key)) return null;
      const ok = list.filter((a) => a && a.parts && a.parts.some((x) => x.key === key && x.correct)).length;
      return players.length ? ok / players.length : null;
    };
    // Wrong answers: per part, the texts given most often.
    const wrong = {};
    for (const part of q.parts || [{ key: 'main', mode: 'mc', choices: q.choices, correct: q.correct }]) {
      const counts = new Map();
      for (const a of answered) {
        const v = q.parts ? (typeof a.value === 'object' ? a.value[part.key] : a.value) : a.value;
        if (v === undefined || v === null) continue;
        const isRight = a.parts ? a.parts.find((x) => x.key === part.key)?.correct : a.correct;
        if (isRight) continue;
        const text = part.mode === 'mc' && part.choices ? part.choices[v] : String(v);
        counts.set(text, (counts.get(text) || 0) + 1);
      }
      wrong[part.key] = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 5).map(([text, count]) => ({ text, count }));
    }
    const rate = players.length ? correct / players.length : null;
    return {
      index: i, title: q.blind ? q.blind.reveal.title : q.text, artist: q.blind ? q.blind.reveal.artist : '', year: q.blind ? q.blind.reveal.year : null,
      roundTitle: q.blind ? q.blind.roundTitle : '', questionType: q.blind ? q.blind.questionType : q.type, multiplier: q.multiplier || 1,
      recognitionRate: rate, artistRate: partRate('artist'), titleRate: partRate('title'),
      answered: answered.length, noAnswer: players.length - answered.length, avgMs: avg(answered.map((a) => a.ms).filter((x) => x !== null)),
      wrongAnswers: wrong, difficulty: DIFFICULTY(rate),
    };
  });

  // ---- players: streaks, cumulative ranks (progression), regularity
  const cumul = players.map(() => 0);
  const rankHistory = players.map(() => []);
  questions.forEach((_, i) => {
    players.forEach((p, k) => { cumul[k] += byPlayer.get(p.id)[i]?.points || 0; });
    const order = players.map((p, k) => k).sort((a, b) => cumul[b] - cumul[a]);
    order.forEach((k, r) => rankHistory[k].push(r + 1));
  });
  const playerRows = players.map((p, k) => {
    const list = byPlayer.get(p.id);
    let streak = 0; let best = 0;
    for (let i = 0; i < n; i++) { if (list[i]?.correct) { streak++; best = Math.max(best, streak); } else if (!(list[i]?.parts || []).some((x) => x.correct)) streak = 0; }
    const correctN = questions.filter((_, i) => list[i]?.correct).length;
    const times = list.filter(given).map((a) => a.ms).filter((x) => x !== null);
    return { rank: p.rank, name: p.name, team: p.team_name, score: p.score, correct: correctN, answered: list.filter(given).length, bestStreak: best,
      avgMs: avg(times), progression: rankHistory[k].length ? rankHistory[k][0] - p.rank : 0, reconnects: p.reconnects || 0 };
  });

  // ---- highlights
  let fastest = null;
  players.forEach((p) => byPlayer.get(p.id).forEach((a, i) => { if (a && a.correct && a.ms !== null && (!fastest || a.ms < fastest.ms)) fastest = { name: p.name, ms: a.ms, track: tracks[i]?.title }; }));
  const pick = (arr, key, dir = 1) => arr.reduce((b, x) => (b === null || (x[key] - b[key]) * dir > 0 ? x : b), null);
  const scoredTracks = tracks.filter((t) => t.recognitionRate !== null);
  let teams = null;
  if (teamsInfo) {
    const method = teamsInfo.method || 'sum';
    teams = teamsInfo.teams.map((t) => {
      const members = playerRows.filter((p) => p.team === t.name).sort((a, b) => b.score - a.score);
      const scores = members.map((m) => m.score);
      const score = method === 'average' ? (scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : 0)
        : method === 'top-n' ? scores.slice(0, teamsInfo.topN || 3).reduce((s, x) => s + x, 0) : scores.reduce((s, x) => s + x, 0);
      return { name: t.name, color: t.color, icon: t.icon, members: members.length, score, best: members[0] ? { name: members[0].name, score: members[0].score } : null };
    }).sort((a, b) => b.score - a.score);
  }
  const totalAnswers = answers.filter((a) => a.response_json !== null || a.choice !== null).length;
  const totalCorrect = answers.filter((a) => a.correct).length;
  const allTimes = answers.map((a) => a.response_ms).filter((x) => x !== null);
  return {
    id: g.id, title: g.title, pin: g.pin, kind: g.kind, startedAt: g.started_at, endedAt: g.ended_at, completed: !!g.completed,
    summary: {
      participants: players.length, tracks: n, tracksInBlindTest: quiz.questions.length, totalAnswers,
      responseRate: players.length && n ? totalAnswers / (players.length * n) : null,
      correctRate: totalAnswers ? totalCorrect / (players.length * n) : null,
      avgResponseMs: avg(allTimes), durationMs: g.ended_at - g.started_at,
      reconnections: players.reduce((s, p) => s + (p.reconnects || 0), 0),
    },
    tracks,
    players: playerRows,
    teams: teams ? { method: teamsInfo.method, list: teams } : null,
    highlights: {
      podium: playerRows.slice(0, 3).map((p) => ({ rank: p.rank, name: p.name, score: p.score })),
      bestStreak: pick(playerRows, 'bestStreak'),
      fastestCorrect: fastest,
      biggestProgression: pick(playerRows.filter((p) => p.progression > 0), 'progression'),
      mostRegular: playerRows.length ? [...playerRows].sort((a, b) => b.correct - a.correct || (a.avgMs ?? 1e12) - (b.avgMs ?? 1e12))[0] : null,
      winningTeam: teams ? teams[0] : null,
      bestPerTeam: teams ? teams.map((t) => ({ team: t.name, best: t.best })) : null,
      bestTrack: pick(scoredTracks, 'recognitionRate'),
      worstTrack: pick(scoredTracks, 'recognitionRate', -1),
    },
  };
}

const pct = (x) => (x === null || x === undefined ? '' : Math.round(x * 100));

function reportCsv(r) {
  const rows = [
    ['Rapport', r.title], ['Date', new Date(r.endedAt).toISOString()], ['Participants', r.summary.participants], ['Morceaux joués', r.summary.tracks],
    ['Réponses', r.summary.totalAnswers], ['Taux de réponse %', pct(r.summary.responseRate)], ['Bonnes réponses %', pct(r.summary.correctRate)],
    ['Temps moyen (s)', r.summary.avgResponseMs === null ? '' : (r.summary.avgResponseMs / 1000).toFixed(1)], ['Durée (min)', Math.round(r.summary.durationMs / 60000)],
    ['Reconnexions', r.summary.reconnections], [],
    ['Rang', 'Joueur', 'Équipe', 'Score', 'Bonnes réponses', 'Répondu', 'Meilleure série', 'Temps moyen (s)', 'Progression', 'Reconnexions'],
    ...r.players.map((p) => [p.rank, p.name, p.team || '', p.score, p.correct, p.answered, p.bestStreak, p.avgMs === null ? '' : (p.avgMs / 1000).toFixed(1), p.progression, p.reconnects]),
    [],
    ['Morceau', 'Artiste', 'Année', 'Manche', 'Type', 'Multiplicateur', 'Reconnu %', 'Artiste %', 'Titre %', 'Temps moyen (s)', 'Sans réponse', 'Difficulté', 'Mauvaises réponses fréquentes'],
    ...r.tracks.map((t) => [t.title, t.artist, t.year || '', t.roundTitle, t.questionType, t.multiplier, pct(t.recognitionRate), pct(t.artistRate), pct(t.titleRate),
      t.avgMs === null ? '' : (t.avgMs / 1000).toFixed(1), t.noAnswer, t.difficulty || '', Object.values(t.wrongAnswers).flat().map((w) => `${w.text} (${w.count})`).join(' ; ')]),
  ];
  if (r.teams) rows.push([], ['Équipe', 'Membres', `Score (${r.teams.method})`, 'Meilleur joueur'], ...r.teams.list.map((t) => [t.name, t.members, t.score, t.best ? `${t.best.name} (${t.best.score})` : '']));
  return toCsv(rows);
}

module.exports = { blindReport, reportCsv };
