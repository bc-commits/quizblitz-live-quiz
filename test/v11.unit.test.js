// V1.1 unit tests: variable choices, music question types, scoring presets, multipliers, free text.
const test = require('node:test');
const assert = require('node:assert/strict');
const BT = require('../lib/blindtest');
const Scoring = require('../lib/scoring');
const Q = require('../questions');
const { matchFreeText, canon } = require('../lib/answers');

const choices = (n) => Array.from({ length: n }, (_, i) => `Choix ${i + 1}`);
const track = (extra = {}) => ({ title: 'Je te donne', artist: 'Jean-Jacques Goldman', year: 1985, audioUrl: '/audio/demo-arpeges.wav', duration: 20, ...extra });
const bt = (tracks, round = {}, settings = {}) => ({ title: 'T', settings, rounds: [{ title: 'R', questionType: 'artist', ...round, tracks }] });
const errorsOf = (input) => BT.validateBlindTest(input).errors;
const quizOf = (input, opts) => BT.toGameQuiz(BT.assertValid(input).blindTest, opts);

// ---------------------------------------------------------------- choices

for (const n of [2, 4, 8]) {
  test(`choices: a ${n}-choice question is valid and keeps its order`, () => {
    const c = choices(n);
    const q = quizOf(bt([track({ questionType: 'custom', choices: c, correctAnswer: c[n - 1] })])).questions[0];
    assert.deepEqual(q.parts[0].choices, c);
    assert.deepEqual(q.parts[0].correct, [n - 1]);
  });
}
test('choices: 1 or 9 choices are refused', () => {
  for (const n of [1, 9]) {
    const c = choices(n);
    assert.ok(errorsOf(bt([track({ questionType: 'custom', choices: c, correctAnswer: c[0] })])).some((e) => e.path.endsWith('.choices')), String(n));
  }
});
test('choices: duplicates after normalisation, empty choices and a missing answer are refused', () => {
  assert.ok(errorsOf(bt([track({ choices: ['Renaud', 'RENAUD ', 'Cabrel'], correctAnswer: 'Cabrel' })])).some((e) => /double/.test(e.message)));
  assert.ok(errorsOf(bt([track({ choices: ['Éric', 'eric', 'Cabrel'], correctAnswer: 'Cabrel' })])).some((e) => /double/.test(e.message)), 'accents ignored');
  assert.ok(errorsOf(bt([track({ choices: ['A', '', 'C'], correctAnswer: 'A' })])).some((e) => /vide/.test(e.message)));
  assert.ok(errorsOf(bt([track({ choices: ['A', 'B', 'C'], correctAnswer: 'Z' })])).some((e) => e.path.endsWith('correctAnswer')));
});

// ---------------------------------------------------------------- question types

test('types: artist, title, year, decade and custom produce one part with the expected answer', () => {
  const tr = (questionType, c, correctAnswer) => track({ questionType, choices: c, correctAnswer });
  const quiz = quizOf(bt([
    tr('artist', ['Jean-Jacques Goldman', 'Renaud'], undefined),
    tr('title', ['Je te donne', 'Envole-moi'], undefined),
    tr('year', ['1983', '1985', '1987'], undefined),
    tr('decade', ['Années 1970', 'Années 1980', 'Années 1990', 'Années 2000'], undefined),
    tr('custom', ['Oui', 'Non'], 'Oui'),
  ]));
  const correct = quiz.questions.map((q) => q.parts[0].choices[q.parts[0].correct[0]]);
  assert.deepEqual(correct, ['Jean-Jacques Goldman', 'Je te donne', '1985', 'Années 1980', 'Oui']);
  assert.deepEqual(quiz.questions.map((q) => q.parts.length), [1, 1, 1, 1, 1]);
  assert.equal(quiz.questions[3].text, 'De quelle décennie date ce morceau ?');
});

const AT = track({
  questionType: 'artist-title',
  answers: {
    artist: { choices: ['Jean-Jacques Goldman', 'Daniel Balavoine', 'Michel Berger', 'Francis Cabrel'], correctAnswer: 'Jean-Jacques Goldman' },
    title: { choices: ['Je te donne', 'Envole-moi', 'Encore un matin', 'Il suffira d’un signe'], correctAnswer: 'Je te donne' },
  },
});

test('artist-title: the spec form { answers: { artist, title } } gives two independent parts', () => {
  const q = quizOf(bt([AT])).questions[0];
  assert.deepEqual(q.parts.map((p) => p.key), ['artist', 'title']);
  assert.equal(q.choices, undefined, 'no single choice list');
  const pub = Q.publicView(q, 0, 1, true);
  assert.ok(!JSON.stringify(pub).includes('"correct"'));
});

test('artist-title: answers may cover one part only; parts are judged independently', () => {
  const q = quizOf(bt([AT])).questions[0];
  assert.deepEqual(Q.parseAnswer(q, { answer: { title: 0 } }), { title: 0 });
  assert.throws(() => Q.parseAnswer(q, { answer: {} }));
  assert.throws(() => Q.parseAnswer(q, { answer: { artist: 7 } }));
  const both = Q.judge(q, { artist: 0, title: 0 });
  assert.equal(both.correct, true);
  const half = Q.judge(q, { artist: 0, title: 1 });
  assert.equal(half.correct, false);
  assert.deepEqual(half.parts.map((x) => x.correct), [true, false]);
  assert.deepEqual(Q.judge(q, { artist: 2, title: 3 }).parts.map((x) => x.correct), [false, false]);
});

// ---------------------------------------------------------------- scoring

const run = (opts) => Scoring.blindPoints({ timeLimitMs: 20000, responseMs: 0, answered: true, totalParts: 1, streak: 0, ...opts });
const ok = [{ key: 'main', correct: true }];
const ko = [{ key: 'main', correct: false }];

test('scoring presets: classic, competitive, party, relaxed', () => {
  const r = (preset, extra) => run({ parts: ok, cfg: Scoring.resolveScoring({ preset }), ...extra }).points;
  assert.equal(r('classic'), 1000);
  assert.equal(r('classic', { responseMs: 19000 }), 1000, 'no speed bonus');
  assert.equal(r('competitive'), 1000);
  assert.equal(r('competitive', { responseMs: 10000 }), 750);
  assert.equal(r('party'), 750);
  assert.equal(r('relaxed'), 1);
});

test('scoring: custom configuration, wrong and missing answers', () => {
  const cfg = Scoring.resolveScoring({ preset: 'custom', correctPoints: 300, speedBonusMax: 100, wrongAnswerPoints: -50, noAnswerPoints: -10 });
  assert.equal(run({ parts: ok, cfg }).points, 400);
  assert.equal(run({ parts: ko, cfg }).points, -50);
  assert.equal(run({ parts: [], answered: false, cfg }).points, -10);
  assert.equal(Scoring.resolveScoring({ preset: 'custom', correctPoints: 999999 }).correctPoints, 10000, 'clamped');
});

test('scoring artist-title: partial points and the documented streak rule', () => {
  const cfg = Scoring.resolveScoring({ preset: 'party' });
  const at = (parts, streak = 2) => run({ parts, totalParts: 2, cfg, streak, responseMs: 20000 });
  const full = at([{ key: 'artist', correct: true }, { key: 'title', correct: true }]);
  assert.equal(full.points, 1000 + 100, 'artist 500 + title 500 + streak bonus (3rd in a row: 2 x 50)');
  assert.equal(full.streak, 3);
  const artistOnly = at([{ key: 'artist', correct: true }, { key: 'title', correct: false }]);
  assert.equal(artistOnly.points, 500);
  assert.equal(artistOnly.streak, 2, 'partial answer keeps the streak without increasing it');
  assert.ok(artistOnly.partial);
  const titleOnly = at([{ key: 'title', correct: true }]);
  assert.equal(titleOnly.points, 500);
  const none = at([{ key: 'artist', correct: false }, { key: 'title', correct: false }]);
  assert.equal(none.points, 0);
  assert.equal(none.streak, 0, 'all wrong resets the streak');
  const fastHalf = run({ parts: [{ key: 'artist', correct: true }], totalParts: 2, cfg, responseMs: 0 });
  assert.equal(fastHalf.points, 500 + 125, 'speed bonus proportional to the share that is right');
});

test('multipliers: x1, x2, x3 applied after the normal points; values bounded', () => {
  const cfg = Scoring.resolveScoring({ preset: 'classic' });
  assert.deepEqual([1, 2, 3].map((m) => run({ parts: ok, cfg, multiplier: m }).points), [1000, 2000, 3000]);
  assert.equal(Scoring.normaliseMultiplier('bonus'), 2);
  assert.equal(Scoring.normaliseMultiplier('finale'), 3);
  assert.equal(Scoring.normaliseMultiplier(9), 5);
  assert.equal(Scoring.normaliseMultiplier(0.2), 1);
  assert.equal(BT.multiplierLabel(2), 'QUESTION BONUS · POINTS x2');
  assert.equal(BT.multiplierLabel(3), 'FINALE x3');
});

test('settings priority: track > round > blind test > application default', () => {
  const input = bt([track({ choices: ['Jean-Jacques Goldman', 'Renaud'], duration: 12, pointsMultiplier: 3 }), track({ choices: ['Jean-Jacques Goldman', 'Renaud'], duration: null })],
    { trackDuration: 25, pointsMultiplier: 2, scoringPreset: 'classic', countdownDuration: 5 }, { excerptDuration: 30, countdownDuration: 2, scoring: { preset: 'relaxed' } });
  const [a, b] = quizOf(input).questions;
  assert.equal(a.time, 12); assert.equal(b.time, 25);
  assert.equal(a.multiplier, 3); assert.equal(b.multiplier, 2);
  assert.equal(a.scoring.preset, 'classic', 'round preset over blind test preset');
  assert.equal(a.flow.countdown, 5);
  const noRound = quizOf(bt([track({ choices: ['Jean-Jacques Goldman', 'Renaud'], duration: null })], {}, { excerptDuration: 30, scoring: { preset: 'relaxed' } })).questions[0];
  assert.equal(noRound.time, 30);
  assert.equal(noRound.scoring.preset, 'relaxed');
  const app = quizOf(bt([track({ choices: ['Jean-Jacques Goldman', 'Renaud'] })]), { appScoring: Scoring.resolveScoring({ preset: 'classic' }) }).questions[0];
  assert.equal(app.scoring.preset, 'classic', 'application default when nothing else is set');
});

// ---------------------------------------------------------------- compatibility

test('compatibility: a V1 blind test (4 choices, no schemaVersion) is upgraded in memory', () => {
  const v1 = { id: 'old', type: 'music-blind-test', title: 'Ancien', settings: { excerptDuration: 15 }, rounds: [{ id: 'r1', title: 'Artistes', questionType: 'artist',
    tracks: [{ id: 't1', title: 'X', artist: 'A', year: 1990, audioUrl: '/audio/demo-valse.wav', startTime: 2, duration: 15, choices: ['A', 'B', 'C', 'D'], correctAnswer: 'A' }] }] };
  const r = BT.validateBlindTest(v1);
  assert.deepEqual(r.errors, []);
  assert.equal(r.upgraded, true);
  assert.equal(r.blindTest.schemaVersion, 2);
  assert.equal(r.blindTest.settings.flowMode, 'manual');
  assert.equal(r.blindTest.rounds[0].pointsMultiplier, 1);
  assert.equal(v1.schemaVersion, undefined, 'the input object is not modified');
});

// ---------------------------------------------------------------- free text (used by V1.3, judged here)

test('free text: case, accents, apostrophes, dashes, aliases, articles and limited typos', () => {
  const p = { answer: 'Jean-Jacques Goldman', aliases: ['Goldman', 'JJ Goldman'] };
  assert.equal(matchFreeText('jean jacques goldman', p).rule, 'exact');
  assert.equal(matchFreeText('JEAN-JACQUES GÔLDMAN', p).accepted, true);
  assert.equal(matchFreeText('jj goldman', p).rule, 'alias');
  assert.equal(matchFreeText('Les Rita Mitsouko', { answer: 'Rita Mitsouko' }).rule, 'articles');
  assert.equal(matchFreeText('Rita Mitsouko', { answer: 'Les Rita Mitsouko', ignoreArticles: false }).accepted, false);
  assert.equal(matchFreeText("l'aventurier", { answer: 'L’Aventurier' }).accepted, true);
  assert.equal(matchFreeText('Goldmann', p).accepted, false, 'no typo tolerance by default');
  assert.equal(matchFreeText('Goldmann', { ...p, typoTolerance: true }).rule, 'typo');
  assert.equal(matchFreeText('Jean Jaques Goldmann', { ...p, typoTolerance: true }).rule, 'typo', '2 edits on a long answer');
  assert.equal(matchFreeText('Balavoine', { ...p, typoTolerance: true }).accepted, false, 'too different');
  assert.equal(matchFreeText('Golmdan', { ...p, typoTolerance: true }).accepted, false, 'more than allowed');
  assert.equal(matchFreeText('Prince', { answer: 'Prance', typoTolerance: true }).accepted, true, '1 edit at 6 characters');
  assert.equal(matchFreeText('Abba', { answer: 'Abbe', typoTolerance: true }).accepted, false, 'no typo under 6 characters');
  assert.equal(canon('  À   l’Été —  2000 ! '), 'a l ete 2000');
});

test('free text and mixed artist-title: artist typed, title multiple choice', () => {
  const q = quizOf(bt([track({ questionType: 'artist-title', artistAnswer: { mode: 'free-text', aliases: ['Goldman'] }, titleAnswer: { mode: 'multiple-choice', choices: ['Je te donne', 'Envole-moi'] } })])).questions[0];
  assert.deepEqual(q.parts.map((p) => p.mode), ['text', 'mc']);
  assert.equal(q.parts[0].answer, 'Jean-Jacques Goldman', 'expected answer defaults to the track artist');
  const pub = Q.publicView(q, 0, 1, true);
  assert.ok(!JSON.stringify(pub).includes('Goldman'), 'expected text and aliases never sent to phones');
  assert.deepEqual(Q.judge(q, Q.parseAnswer(q, { answer: { artist: 'goldman', title: 0 } })).parts.map((x) => x.correct), [true, true]);
});
