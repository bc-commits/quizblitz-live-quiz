// Migration test: a database created by V1 (schema of commit a80fd7c) is opened by the
// current server; nothing is lost and V1 blind tests still play.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { startServer, client, listen, state, tempDir, ADMIN } = require('./helpers');

// V1 schema (db.js at a80fd7c, including its in-place column additions).
const V1_SCHEMA = `
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, pass_hash TEXT NOT NULL, created_at INTEGER NOT NULL, role TEXT NOT NULL DEFAULT 'host');
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  CREATE TABLE quizzes (id INTEGER PRIMARY KEY AUTOINCREMENT, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, quiz_json TEXT NOT NULL, plays INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE games (id INTEGER PRIMARY KEY AUTOINCREMENT, pin TEXT NOT NULL, title TEXT NOT NULL, quiz_json TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, questions_played INTEGER NOT NULL, completed INTEGER NOT NULL, owner_id INTEGER, kind TEXT NOT NULL DEFAULT 'quiz');
  CREATE TABLE players (id INTEGER PRIMARY KEY AUTOINCREMENT, game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE, name TEXT NOT NULL, avatar_json TEXT NOT NULL, score INTEGER NOT NULL, rank INTEGER NOT NULL);
  CREATE TABLE answers (game_id INTEGER NOT NULL, player_id INTEGER NOT NULL, question_index INTEGER NOT NULL, choice INTEGER, correct INTEGER NOT NULL, points INTEGER NOT NULL, response_ms INTEGER, response_json TEXT, PRIMARY KEY (player_id, question_index));
  CREATE TABLE app_settings (id INTEGER PRIMARY KEY CHECK (id = 1), settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT);
  CREATE TABLE blind_tests (id TEXT PRIMARY KEY, title TEXT NOT NULL, blind_test_json TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, plays INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE media (id TEXT PRIMARY KEY, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, original_name TEXT NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE live_games (pin TEXT PRIMARY KEY, game_json TEXT NOT NULL, updated_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
`;

const V1_BLIND_TEST = { id: 'blindtest-v1', type: 'music-blind-test', title: 'Blind test V1', description: '', settings: { answerMode: 'multiple-choice', countdownDuration: 0, excerptDuration: 5, revealDuration: 8, scoreboardDuration: 8, allowLateJoin: true, allowAnswerChange: false, playAudioOnHostOnly: true, shuffleChoices: false },
  rounds: [{ id: 'round-1', title: 'Artistes', questionType: 'artist', tracks: [{ id: 'track-1', title: 'Valse', artist: 'Pixel', year: 2025, audioUrl: '/audio/demo-valse.wav', coverUrl: '', startTime: 2, duration: 5, questionType: 'artist', question: '', choices: ['Pixel', 'Modem', 'Cassette', 'Rêveurs'], correctAnswer: 'Pixel', difficulty: '', notes: '' }] }] };

test('a V1 database is migrated without loss', async (t) => {
  const dataDir = tempDir();
  const db = new DatabaseSync(path.join(dataDir, 'quizblitz.db'));
  db.exec(V1_SCHEMA);
  const now = Date.now();
  db.prepare("INSERT INTO users (email, name, pass_hash, created_at, role) VALUES ('host@test.local', 'Hôte', 'scrypt$x$y', ?, 'host')").run(now);
  db.prepare("INSERT INTO quizzes (owner_id, title, quiz_json, created_at, updated_at) VALUES (1, 'Quiz V1', ?, ?, ?)").run(JSON.stringify({ title: 'Quiz V1', questions: [{ type: 'quiz', text: 'Q', choices: ['a', 'b'], correct: [0], time: 10, points: 'standard', image: '' }] }), now, now);
  db.prepare('INSERT INTO app_settings (id, settings_json, updated_at, updated_by) VALUES (1, ?, ?, ?)').run(JSON.stringify({ appName: 'Soirée V1', shortName: 'V1', primaryColor: '#123456' }), now, 'admin');
  db.prepare('INSERT INTO blind_tests (id, title, blind_test_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run('blindtest-v1', 'Blind test V1', JSON.stringify(V1_BLIND_TEST), now, now);
  db.prepare("INSERT INTO media (id, kind, mime, size, original_name, created_at) VALUES ('0123456789abcdef0123456789abcdef.png', 'image', 'image/png', 10, 'logo.png', ?)").run(now);
  const gid = db.prepare("INSERT INTO games (pin, title, quiz_json, started_at, ended_at, questions_played, completed, owner_id, kind) VALUES ('111111', 'Partie V1', ?, ?, ?, 1, 1, NULL, 'quiz')")
    .run(JSON.stringify({ title: 'Partie V1', questions: [{ type: 'quiz', text: 'Q', choices: ['a', 'b'], correct: [0], time: 10, points: 'standard' }] }), now - 1000, now).lastInsertRowid;
  db.prepare("INSERT INTO players (game_id, name, avatar_json, score, rank) VALUES (?, 'Ava', '{\"character\":1,\"accessory\":0}', 900, 1)").run(gid);
  db.prepare('INSERT INTO answers (game_id, player_id, question_index, choice, correct, points, response_ms, response_json) VALUES (?, 1, 0, 0, 1, 900, 1200, ?)').run(gid, '0');
  db.close();

  const srv = await startServer({ dataDir });
  t.after(() => srv.stop());
  const admin = client(srv.base);
  await admin('/api/admin/login', { body: ADMIN });

  // Data preserved
  assert.equal((await admin('/api/public/settings')).body.settings.appName, 'Soirée V1');
  const list = (await admin('/api/admin/blind-tests')).body.blindTests;
  assert.equal(list.length, 1);
  const row = (await admin('/api/admin/blind-tests/blindtest-v1')).body;
  assert.equal(row.blindTest.schemaVersion, undefined, 'stored V1 document untouched until it is saved again');
  assert.equal((await admin('/api/admin/media')).body.media.length, 1);
  assert.equal((await admin('/api/admin/reports/1')).body.players[0].name, 'Ava');
  const check = new DatabaseSync(path.join(dataDir, 'quizblitz.db'));
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM quizzes').get().n, 1);
  assert.equal(check.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2, 'V1 host + admin');
  for (const table of ['music_tracks', 'blind_test_tracks', 'audit_log']) assert.ok(check.prepare(`SELECT name FROM sqlite_master WHERE name = ?`).get(table), table);
  const cols = check.prepare('PRAGMA table_info(answers)').all().map((c) => c.name);
  assert.ok(cols.includes('response_json') && cols.includes('detail_json'), 'no column dropped, new ones added');
  check.close();

  // The V1 blind test still plays
  const g = (await admin('/api/games', { body: { blindTestId: 'blindtest-v1' } })).body;
  const anon = client(srv.base);
  const p = (await anon(`/api/games/${g.pin}/join`, { body: { name: 'Zed' } })).body;
  const phone = listen(`${srv.base}/api/games/${g.pin}/events?token=${p.token}`);
  await anon(`/api/games/${g.pin}/host-action`, { body: { key: g.hostKey, action: 'start' } });
  await phone.waitFor(state('QUESTION', 0));
  await anon(`/api/games/${g.pin}/answer`, { body: { token: p.token, questionIndex: 0, answer: 0 } });
  const r = await phone.waitFor(state('REVEAL', 0));
  assert.ok(r.result.isCorrect && r.result.points >= 500);
  phone.close();

  // Re-saving converts it to the new format
  const saved = await admin('/api/admin/blind-tests/blindtest-v1', { method: 'PUT', body: { blindTest: row.blindTest } });
  assert.equal(saved.body.blindTest.schemaVersion, 2);

  // Restarting again is harmless (idempotent migrations)
  await srv.stop();
  const srv2 = await startServer({ dataDir });
  assert.equal((await client(srv2.base)('/api/public/settings')).body.settings.appName, 'Soirée V1');
  await srv2.stop();
});
