// V1.1 integration tests: artist-title partial points, 8 choices, multipliers,
// manual / semi-auto / automatic flow, pause, restart during automatic flow, double commands.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, client, listen, state, sleep, ADMIN } = require('./helpers');

const AUDIO = '/audio/demo-arpeges.wav';
const EIGHT = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8'];

function blindTest(flowMode, rounds) {
  return { schemaVersion: 2, type: 'music-blind-test', title: `Flow ${flowMode}`,
    settings: { countdownDuration: 0, excerptDuration: 5, revealDuration: 1, scoreboardDuration: 1, flowMode, allowLateJoin: true, scoring: { preset: 'party' } }, rounds };
}

async function setup(srv, input, names = ['Ava', 'Ben']) {
  const admin = client(srv.base);
  await admin('/api/admin/login', { body: ADMIN });
  const created = await admin('/api/admin/blind-tests', { body: { blindTest: input } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const g = (await admin('/api/games', { body: { blindTestId: created.body.id } })).body;
  const anon = client(srv.base);
  const host = listen(`${srv.base}/api/games/${g.pin}/host-events?key=${g.hostKey}`);
  const players = [];
  for (const name of names) {
    const r = (await anon(`/api/games/${g.pin}/join`, { body: { name } })).body;
    players.push({ ...r, sse: listen(`${srv.base}/api/games/${g.pin}/events?token=${r.token}`) });
  }
  const act = (action, extra = {}) => anon(`/api/games/${g.pin}/host-action`, { body: { key: g.hostKey, action, ...extra } });
  const answer = (p, i, a) => anon(`/api/games/${g.pin}/answer`, { body: { token: p.token, questionIndex: i, answer: a } });
  return { ...g, admin, anon, host, players, act, answer, close: () => { host.close(); players.forEach((p) => p.sse.close()); } };
}

test('V1.1 game features', async (t) => {
  let srv = await startServer();
  t.after(() => srv.stop());

  await t.test('artist-title partial points, 8 choices, x2 multiplier (manual flow)', async () => {
    const g = await setup(srv, blindTest('manual', [
      { title: 'Artiste et titre', questionType: 'artist-title', tracks: [{ title: 'Je te donne', artist: 'Goldman', year: 1985, audioUrl: AUDIO,
        answers: { artist: { choices: ['Goldman', 'Balavoine', 'Berger', 'Cabrel'], correctAnswer: 'Goldman' }, title: { choices: ['Je te donne', 'Envole-moi'], correctAnswer: 'Je te donne' } } }] },
      { title: 'Huit choix', questionType: 'custom', pointsMultiplier: 2, tracks: [{ title: 'X', artist: 'Y', audioUrl: AUDIO, choices: EIGHT, correctAnswer: 'A7' }] },
    ]));
    const [ava, ben] = g.players;
    await g.act('start');
    const q = await ava.sse.waitFor(state('QUESTION', 0));
    assert.deepEqual(q.question.parts.map((p) => [p.key, p.mode, p.choices.length]), [['artist', 'mc', 4], ['title', 'mc', 2]]);
    assert.ok(!JSON.stringify(q).includes('"correct"') && !JSON.stringify(q).includes(AUDIO), 'no answer and no audio URL on phones');
    assert.equal((await g.answer(ava, 0, { artist: 0, title: 0 })).status, 200);
    assert.equal((await g.answer(ben, 0, { artist: 0 })).status, 200, 'answering one part only is allowed');
    const [ra, rb] = await Promise.all([ava.sse.waitFor(state('REVEAL', 0)), ben.sse.waitFor(state('REVEAL', 0))]);
    assert.ok(ra.result.isCorrect && ra.result.points > 1000, `both parts: ${ra.result.points}`);
    assert.ok(rb.result.partial && !rb.result.isCorrect, 'partial');
    assert.ok(rb.result.points >= 500 && rb.result.points < 1000, `artist only: ${rb.result.points}`);
    assert.deepEqual(rb.result.parts.map((x) => [x.key, x.correct, x.answered]), [['artist', true, true], ['title', false, false]]);
    const hostReveal = await g.host.waitFor(state('REVEAL', 0));
    assert.deepEqual(hostReveal.reveal.parts.map((p) => p.correctCount), [2, 1]);

    await g.act('next', { expectState: 'REVEAL' });
    // A stale double press (still thinking it is REVEAL) is refused; an immediate repeat is ignored.
    assert.equal((await g.act('next', { expectState: 'REVEAL' })).body.code, 'STALE_STATE');
    await g.host.waitFor(state('SCOREBOARD'));
    await g.act('next', { expectState: 'SCOREBOARD' });
    const q2 = await ava.sse.waitFor(state('QUESTION', 1));
    assert.equal(q2.question.choices.length, 8);
    assert.equal(q2.blind.multiplierLabel, 'QUESTION BONUS · POINTS x2');
    assert.equal((await g.answer(ava, 1, 6)).status, 200);
    assert.equal((await g.answer(ben, 1, 8)).status, 400, 'index outside the 8 choices refused');
    await g.answer(ben, 1, 0);
    const r2 = await ava.sse.waitFor(state('REVEAL', 1));
    assert.equal(r2.result.multiplier, 2);
    assert.ok(r2.result.points >= 1000, `x2 applied: ${r2.result.points}`);
    g.close();
  });

  await t.test('semi-auto: reveal -> scoreboard by itself, then waits for the host', async () => {
    const g = await setup(srv, blindTest('semi-auto', [{ title: 'R', tracks: [
      { title: 'T1', artist: 'A', audioUrl: AUDIO, choices: ['A', 'B'], correctAnswer: 'A' },
      { title: 'T2', artist: 'B', audioUrl: AUDIO, choices: ['A', 'B'], correctAnswer: 'B' }] }]), ['Zoé']);
    await g.act('start');
    await g.players[0].sse.waitFor(state('QUESTION', 0));
    await g.answer(g.players[0], 0, 0);
    const rev = await g.host.waitFor(state('REVEAL', 0));
    assert.equal(rev.flow.mode, 'semi-auto');
    assert.ok(rev.flow.autoAt > rev.serverNow, 'next automatic step is announced');
    await g.host.waitFor(state('SCOREBOARD'), 4000);
    await sleep(1500);
    const last = [...g.host.msgs].reverse().find((m) => m.type === 'STATE');
    assert.equal(last.state, 'SCOREBOARD', 'semi-auto waits for the host after the scoreboard');
    assert.equal(last.flow.autoAt, null);
    g.close();
  });

  let auto;
  await t.test('automatic: whole sequence, pause and resume during the reveal', async () => {
    auto = await setup(srv, blindTest('automatic', [{ title: 'R', tracks: [
      { title: 'T1', artist: 'A', audioUrl: AUDIO, choices: ['A', 'B'], correctAnswer: 'A', revealDuration: 2 },
      { title: 'T2', artist: 'B', audioUrl: AUDIO, choices: ['A', 'B'], correctAnswer: 'B' },
      { title: 'T3', artist: 'C', audioUrl: AUDIO, choices: ['C', 'B'], correctAnswer: 'C' }] }]), ['Léa']);
    await auto.act('start');
    await auto.players[0].sse.waitFor(state('QUESTION', 0));
    await auto.answer(auto.players[0], 0, 0);
    await auto.host.waitFor(state('REVEAL', 0));
    assert.equal((await auto.act('pause')).status, 200, 'automatic flow can be paused during the reveal');
    const paused = await auto.host.waitFor((m) => m.type === 'STATE' && m.state === 'REVEAL' && m.paused);
    assert.ok(paused.paused.remainingMs > 0);
    await sleep(2500);
    const still = [...auto.host.msgs].reverse().find((m) => m.type === 'STATE');
    assert.equal(still.state, 'REVEAL', 'nothing moves while paused');
    await auto.act('resume');
    await auto.host.waitFor(state('SCOREBOARD'), 5000);
    await auto.host.waitFor(state('GET_READY', 1), 5000);
    await auto.host.waitFor(state('QUESTION', 1), 5000);
  });

  await t.test('automatic flow continues after a backend restart', async () => {
    await sleep(400);
    auto.close();
    await srv.stop();
    srv = await startServer({ dataDir: srv.dataDir });
    const host = listen(`${srv.base}/api/games/${auto.pin}/host-events?key=${auto.hostKey}`);
    // Track 2's timer was re-armed from the persisted timestamps: the game reaches track 3 then the podium alone.
    await host.waitFor(state('QUESTION', 2), 15000);
    const end = await host.waitFor(state('ENDED'), 15000);
    assert.ok(Number.isInteger(end.reportId));
    host.close();
  });

  await t.test('host can switch the flow mode during a game', async () => {
    const g = await setup(srv, blindTest('manual', [{ title: 'R', tracks: [{ title: 'T1', artist: 'A', audioUrl: AUDIO, choices: ['A', 'B'], correctAnswer: 'A' }] }]), ['Max']);
    assert.equal((await g.act('set-flow', { mode: 'turbo' })).status, 400);
    await g.act('start');
    await g.players[0].sse.waitFor(state('QUESTION', 0));
    await g.answer(g.players[0], 0, 1);
    const rev = await g.host.waitFor(state('REVEAL', 0));
    assert.equal(rev.flow.autoAt, null, 'manual: no automatic step');
    await g.act('set-flow', { mode: 'automatic' });
    const switched = await g.host.waitFor((m) => m.type === 'STATE' && m.flow?.override === 'automatic');
    assert.ok(switched.flow.autoAt);
    await g.host.waitFor(state('ENDED'), 6000);
    g.close();
  });
});
