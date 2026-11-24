// Team mode. Individual scores are kept; a team score is derived from its members:
//   sum      total of the members' scores (fair when teams are balanced: default with automatic assignment)
//   average  mean of the members' scores (limits the advantage of big teams: default otherwise)
//   top-n    total of the N best members of each team
// A late joiner starts at 0: with "sum" they cannot lower their team's score; with
// "average" they do lower it until they score (documented in docs/MODES_DE_JEU.md).

const PALETTE = [
  ['Rouges', '#e5484d', '🔥'], ['Bleus', '#3e63dd', '🌊'], ['Jaunes', '#f5a524', '⭐'], ['Verts', '#30a46c', '🍀'],
  ['Violets', '#8e4ec6', '🔮'], ['Turquoise', '#0d9488', '🐬'], ['Roses', '#d6409f', '🌸'], ['Orange', '#c2410c', '🦊'],
];
const ASSIGNMENTS = ['free', 'auto', 'host'];
const METHODS = ['sum', 'average', 'top-n'];

const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Validates team options from the game creation request; returns null when teams are off. */
function normaliseTeamOptions(o) {
  if (!o || !o.enabled) return null;
  const count = Math.min(8, Math.max(2, Math.round(Number(o.count) || 2)));
  const assignment = ASSIGNMENTS.includes(o.assignment) ? o.assignment : 'auto';
  const method = METHODS.includes(o.method) ? o.method : (assignment === 'auto' ? 'sum' : 'average');
  const names = Array.isArray(o.names) ? o.names.map((n) => str(n, 24)) : [];
  const teams = Array.from({ length: count }, (_, i) => ({ id: `t${i + 1}`, name: names[i] || PALETTE[i][0], color: PALETTE[i][1], icon: PALETTE[i][2] }));
  return { teams, options: { assignment, method, topN: Math.min(10, Math.max(1, Math.round(Number(o.topN) || 3))), lockOnStart: o.lockOnStart !== false } };
}

/** The team with the fewest members (lowest index on ties): balanced automatic assignment. */
function smallestTeam(g) {
  const counts = new Map(g.teams.map((t) => [t.id, 0]));
  for (const p of g.players.values()) if (p.teamId && counts.has(p.teamId)) counts.set(p.teamId, counts.get(p.teamId) + 1);
  return [...counts.entries()].sort((a, b) => a[1] - b[1])[0][0];
}

/** Assigns a team to every player who has none (at start, and for late joiners). */
function fillUnassigned(g) {
  if (!g.teams) return;
  for (const p of g.players.values()) if (!p.teamId) p.teamId = smallestTeam(g);
}

function canChangeTeam(g, started) {
  if (!g.teams) return false;
  return !(started && g.teamOptions.lockOnStart);
}

/** Team standings, best first: { id, name, color, icon, score, members, best: {name, score} }. */
function standings(g) {
  if (!g.teams) return null;
  const { method, topN } = g.teamOptions;
  return g.teams.map((t) => {
    const members = [...g.players.values()].filter((p) => p.teamId === t.id).sort((a, b) => b.score - a.score);
    const scores = members.map((p) => p.score);
    let score = 0;
    if (method === 'average') score = scores.length ? Math.round(scores.reduce((s, x) => s + x, 0) / scores.length) : 0;
    else if (method === 'top-n') score = scores.slice(0, topN).reduce((s, x) => s + x, 0);
    else score = scores.reduce((s, x) => s + x, 0);
    return { id: t.id, name: t.name, color: t.color, icon: t.icon, score, members: members.length, best: members[0] ? { name: members[0].name, score: members[0].score } : null };
  }).sort((a, b) => b.score - a.score || b.members - a.members).map((t, i) => ({ ...t, rank: i + 1 }));
}

const teamOf = (g, p) => (g.teams && p.teamId ? g.teams.find((t) => t.id === p.teamId) || null : null);

module.exports = { PALETTE, ASSIGNMENTS, METHODS, normaliseTeamOptions, smallestTeam, fillUnassigned, canChangeTeam, standings, teamOf };
