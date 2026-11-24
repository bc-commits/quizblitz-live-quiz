// V1.3 tests: teams, free-text answers in a game, manual validation, reports, audit, dashboard.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Teams = require('../lib/teams');
const { startServer, client, listen, state, sleep, ADMIN } = require('./helpers');

const AUDIO = '/audio/demo-arpeges.wav';

// ---------------------------------------------------------------- unit

test('teams: 2 to 8 teams, balanced automatic assignment, sum / average / top-n', () => {
  assert.equal(Teams.normaliseTeamOptions({ enabled: false }), null);
  assert.equal(Teams.normaliseTeamOptions({ enabled: true, count: 1 }).teams.length, 2);
  assert.equal(Teams.normaliseTeamOptions({ enabled: true, count: 12 }).teams.length, 8);
  const auto = Teams.normaliseTeamOptions({ enabled: true, count: 3, assignment: 'auto' });
  assert.equal(auto.options.method, 'sum', 'default with automatic balanced teams');
  assert.equal(Teams.normaliseTeamOptions({ enabled: true, assignment: 'free' }).options.method, 'average', 'default otherwise');
  const g = { teams: auto.teams, teamOptions: auto.options, players: new Map() };
  for (let i = 0; i < 7; i++) {
    const p = { id: `p${i}`, name: `P${i}`, score: [900, 100, 500, 400, 0, 300, 50][i], teamId: null };
    p.teamId = Teams.smallestTeam(g);
    g.players.set(p.id, p);
  }
  const sizes = auto.teams.map((t) => [...g.players.values()].filter((p) => p.teamId === t.id).length);
  assert.deepEqual(sizes, [3, 2, 2], 'balanced');
  const sum = Teams.standings(g);
  assert.equal(sum.reduce((s, t) => s + t.score, 0), 2250);
  g.teamOptions.method = 'average';
  const t1 = Teams.standings(g).find((t) => t.id === 't1');
  assert.equal(t1.score, Math.round((900 + 400 + 50) / 3));
  g.teamOptions.method = 'top-n'; g.teamOptions.topN = 1;
  assert.equal(Teams.standings(g).find((t) => t.id === 't1').score, 900);
  assert.equal(Teams.standings(g)[0].best.name, 'P0');
});

// ---------------------------------------------------------------- integration

test('V1.3: teams, free text, reports, audit', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const admin = client(srv.base);
  const anon = client(srv.base);
  await admin('/api/admin/login', { body: ADMIN });
  const bt = (await admin('/api/admin/blind-tests', { body: { blindTest: {
    title: 'Saisie libre et équipes', settings: { countdownDuration: 0, excerptDuration: 5, allowLateJoin: true, scoring: { preset: 'classic' } },
    rounds: [
      { title: 'Saisie libre', questionType: 'artist', tracks: [{ title: 'Je te donne', artist: 'Jean-Jacques Goldman', audioUrl: AUDIO, answerMode: 'free-text', aliases: ['Goldman', 'JJ Goldman'], typoTolerance: true }] },
      { title: 'Mixte', questionType: 'artist-title', pointsMultiplier: 2, tracks: [{ title: 'L’Aventurier', artist: 'Indochine', audioUrl: AUDIO,
        artistAnswer: { mode: 'multiple-choice', choices: ['Indochine', 'Téléphone', 'Noir Désir'] }, titleAnswer: { mode: 'free-text' } }] },
    ] } } })).body;
  assert.ok(bt.id, JSON.stringify(bt));

  let g; let host; const players = {};
  const act = (action, extra = {}) => anon(`/api/games/${g.pin}/host-action`, { body: { key: g.hostKey, action, ...extra } });
  const answer = (name, i, a) => anon(`/api/games/${g.pin}/answer`, { body: { token: players[name].token, questionIndex: i, answer: a } });
  const join = async (name) => {
    const r = (await anon(`/api/games/${g.pin}/join`, { body: { name } })).body;
    players[name] = { ...r, sse: listen(`${srv.base}/api/games/${g.pin}/events?token=${r.token}`) };
    return r;
  };

  await t.test('team choice in the lobby, host assignment, lock at start, late joiner', async () => {
    g = (await admin('/api/games', { body: { blindTestId: bt.id, options: { teams: { enabled: true, count: 2, assignment: 'free', method: 'sum', names: ['Les Fous', ''] } } } })).body;
    host = listen(`${srv.base}/api/games/${g.pin}/host-events?key=${g.hostKey}`);
    const lobby = await host.waitFor(state('LOBBY'));
    assert.deepEqual(lobby.teams.map((x) => x.name), ['Les Fous', 'Bleus']);
    for (const n of ['Ana', 'Bob', 'Cleo']) await join(n);
    const pl = await players.Ana.sse.waitFor((m) => m.type === 'STATE' && m.canPickTeam);
    assert.equal(pl.teams.length, 2);
    assert.equal((await anon(`/api/games/${g.pin}/team`, { body: { token: players.Ana.token, teamId: 't1' } })).status, 200);
    assert.equal((await anon(`/api/games/${g.pin}/team`, { body: { token: players.Bob.token, teamId: 't9' } })).status, 400);
    await anon(`/api/games/${g.pin}/team`, { body: { token: players.Bob.token, teamId: 't2' } });
    assert.equal((await act('assign-team', { playerId: players.Cleo.playerId, teamId: 't1' })).status, 200, 'host assignment');
    await act('start');
    const ready = await host.waitFor(state('GET_READY', 0));
    assert.deepEqual(ready.players.map((p) => p.teamId).sort(), ['t1', 't1', 't2']);
    assert.equal((await anon(`/api/games/${g.pin}/team`, { body: { token: players.Bob.token, teamId: 't1' } })).body.code, 'TEAMS_LOCKED');
    const late = await join('Dan');
    assert.equal(late.team.id, 't2', 'late joiner placed in the smallest team');
  });

  await t.test('free text: case, accents, aliases, typo tolerance, refusal; points and team score', async () => {
    await players.Ana.sse.waitFor(state('QUESTION', 0));
    const q = (await players.Ana.sse.waitFor(state('QUESTION', 0))).question;
    assert.deepEqual(q.parts.map((p) => p.mode), ['text']);
    assert.ok(!JSON.stringify(q).includes('Goldman'), 'expected answer and aliases never sent');
    await answer('Ana', 0, 'JEAN JACQUES GÔLDMAN');
    await answer('Bob', 0, 'jj goldman');
    await answer('Cleo', 0, 'Goldmann');
    await answer('Dan', 0, 'Balavoine');
    const [ra, rb, rc, rd] = await Promise.all(['Ana', 'Bob', 'Cleo', 'Dan'].map((n) => players[n].sse.waitFor(state('REVEAL', 0))));
    assert.ok(ra.result.isCorrect && rb.result.isCorrect && rc.result.isCorrect, 'case/accents, alias, one typo accepted');
    assert.ok(!rd.result.isCorrect && rd.result.points === 0, 'too different refused');
    assert.equal(ra.result.points, 1000, 'classic preset');
    const rev = await host.waitFor(state('REVEAL', 0));
    assert.equal(rev.reveal.parts[0].correctCount, 3);
    const t1 = rev.teams.find((x) => x.id === 't1');
    assert.equal(t1.score, 2000, 'sum of Ana + Cleo');
  });

  await t.test('mixed artist-title (choice + free text), x2, manual validation of a near miss', async () => {
    await act('next'); await act('next');
    await players.Ana.sse.waitFor(state('QUESTION', 1));
    await answer('Ana', 1, { artist: 0, title: "l'aventurier" });
    await answer('Bob', 1, { artist: 1, title: 'Aventurie' }); // artist wrong, title just outside the tolerance
    await answer('Cleo', 1, { title: 'Aventurier' });
    await answer('Dan', 1, { artist: 0 });
    const [ra, rb] = await Promise.all([players.Ana.sse.waitFor(state('REVEAL', 1)), players.Bob.sse.waitFor(state('REVEAL', 1))]);
    assert.ok(ra.result.isCorrect);
    assert.equal(ra.result.points, 2000, 'artist 500 + title 500, x2');
    assert.equal(rb.result.points, 0);
    const remoteCode = (await anon(`/api/games/${g.pin}/remote-code`, { body: { key: g.hostKey } })).body.code;
    const remoteToken = (await anon(`/api/games/${g.pin}/remote-pair`, { body: { code: remoteCode } })).body.remoteToken;
    const remote = listen(`${srv.base}/api/games/${g.pin}/remote-events?token=${remoteToken}`);
    const snap = await remote.waitFor((m) => m.type === 'STATE' && m.state === 'REVEAL');
    const amb = snap.secret.ambiguous.find((x) => x.name === 'Bob');
    assert.ok(amb, 'near miss offered for manual validation');
    const before = rb.result.totalScore;
    assert.equal((await anon(`/api/games/${g.pin}/remote-action`, { body: { token: remoteToken, action: 'accept-answer', playerId: amb.playerId, part: 'title' } })).status, 200);
    const after = await players.Bob.sse.waitFor((m) => m.type === 'STATE' && m.state === 'REVEAL' && m.result?.manuallyAccepted);
    assert.equal(after.result.totalScore - before, 1000, 'title points x2 added');
    await sleep(900); // beyond the double-press window
    assert.equal((await act('accept-answer', { playerId: amb.playerId, part: 'title' })).status, 400, 'cannot be accepted twice');
    remote.close();
    await act('next'); await act('next');
    const end = await host.waitFor(state('ENDED'));
    assert.ok(end.teams && end.teams.length === 2);
    g.reportId = end.reportId;
    host.close(); Object.values(players).forEach((p) => p.sse.close());
  });

  await t.test('blind test report: global, per track, highlights, CSV and JSON exports', async () => {
    assert.equal((await anon(`/api/admin/reports/${g.reportId}`)).status, 401, 'reports require the admin session');
    const r = (await admin(`/api/admin/reports/${g.reportId}`)).body;
    assert.equal(r.summary.participants, 4);
    assert.equal(r.summary.tracks, 2);
    assert.equal(r.summary.totalAnswers, 8);
    assert.equal(r.tracks[0].recognitionRate, 0.75);
    assert.equal(r.tracks[1].artistRate, 0.5, 'Ana and Dan found the artist');
    assert.equal(r.tracks[1].titleRate, 0.75, 'Ana, Cleo and Bob (accepted manually)');
    assert.equal(r.tracks[1].wrongAnswers.artist[0].text, 'Téléphone');
    assert.equal(r.highlights.podium[0].name, 'Ana');
    assert.equal(r.highlights.bestStreak.name, 'Ana');
    assert.ok(r.highlights.fastestCorrect && r.highlights.fastestCorrect.ms >= 0);
    assert.equal(r.highlights.winningTeam.name, 'Les Fous');
    assert.equal(r.teams.method, 'sum');
    assert.ok(r.players.some((p) => p.team === 'Bleus'));
    const csv = await admin(`/api/admin/reports/${g.reportId}?format=csv`);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.ok(csv.text.includes('"Ana"') && csv.text.includes('Les Fous'));
    const json = await admin(`/api/admin/reports/${g.reportId}?format=json`);
    assert.match(json.headers.get('content-disposition'), /attachment/);
    assert.equal(json.body.id, g.reportId);
  });

  await t.test('CSV exports neutralise formulas', async () => {
    const g2 = (await admin('/api/games', { body: { blindTestId: bt.id } })).body;
    const r = (await anon(`/api/games/${g2.pin}/join`, { body: { name: '=cmd()' } })).body;
    const h = listen(`${srv.base}/api/games/${g2.pin}/host-events?key=${g2.hostKey}`);
    await anon(`/api/games/${g2.pin}/host-action`, { body: { key: g2.hostKey, action: 'start' } });
    await h.waitFor(state('QUESTION', 0));
    await anon(`/api/games/${g2.pin}/answer`, { body: { token: r.token, questionIndex: 0, answer: '+goldman' } });
    await h.waitFor(state('REVEAL', 0));
    await anon(`/api/games/${g2.pin}/host-action`, { body: { key: g2.hostKey, action: 'end' } });
    const end = await h.waitFor(state('ENDED'));
    const csv = (await admin(`/api/admin/reports/${end.reportId}?format=csv`)).text;
    assert.ok(csv.includes(`"'=cmd()"`), 'leading = neutralised');
    assert.ok(!/(^|,)"=/m.test(csv));
    h.close();
  });

  await t.test('audit log records actions without secrets; live dashboard data', async () => {
    await anon('/api/admin/login', { body: { email: ADMIN.email, password: 'wrong-password-123' } });
    const audit = (await admin('/api/admin/audit?pageSize=200')).body;
    const actions = audit.items.map((x) => x.action);
    for (const a of ['admin.login', 'admin.login_failed', 'blindtest.create', 'game.accept_answer']) assert.ok(actions.includes(a), a);
    const failed = audit.items.find((x) => x.action === 'admin.login_failed');
    assert.ok(failed.ip, 'IP kept for failed logins only');
    assert.ok(!audit.items.find((x) => x.action === 'admin.login').ip);
    const dump = JSON.stringify(audit);
    for (const secret of [ADMIN.password, 'wrong-password-123', g.hostKey]) assert.ok(!dump.includes(secret), 'no secret in the audit log');
    const logPath = path.join(srv.dataDir, 'quizblitz.db');
    assert.ok(fs.existsSync(logPath));
    assert.ok(!srv.log().includes(ADMIN.password) && !srv.log().includes(g.hostKey), 'no secret in the server logs');
    assert.equal((await anon('/api/admin/audit')).status, 401);
    const dash = (await admin('/api/admin/dashboard')).body;
    assert.ok(dash.backend.uptime >= 0 && dash.backend.memoryMb > 0);
    assert.ok(Array.isArray(dash.recentErrors));
    assert.ok('libraryTracks' in dash.stats);
  });
});
