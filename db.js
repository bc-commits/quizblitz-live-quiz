// Persistent data in SQLite via Node's built-in `node:sqlite` (Node 22.13+),
// so the app still has zero npm dependencies:
//   users, sessions   host and admin accounts (scrypt-hashed passwords, hashed session tokens)
//   quizzes           each host's quiz library
//   games, players, answers   game history shown on /reports
//   app_settings      global identity and theme (one row)
//   blind_tests       blind tests managed in /admin
//   media             uploaded files (the bytes live in the media storage driver)
//   live_games        snapshot of every running game, restored after a restart

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const Q = require('./questions');

const DIFFICULT_BELOW = 0.35; // questions answered correctly by < 35% of players
const NEEDS_HELP_BELOW = 0.35; // players with < 35% correct answers
const SESSION_DAYS = 30;

function open(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      pass_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quizzes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      quiz_json TEXT NOT NULL,
      plays INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS quizzes_owner ON quizzes(owner_id, updated_at);
    CREATE TABLE IF NOT EXISTS games (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pin TEXT NOT NULL,
      title TEXT NOT NULL,
      quiz_json TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      questions_played INTEGER NOT NULL,
      completed INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      avatar_json TEXT NOT NULL,
      score INTEGER NOT NULL,
      rank INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS answers (
      game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      player_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      question_index INTEGER NOT NULL,
      choice INTEGER,
      correct INTEGER NOT NULL,
      points INTEGER NOT NULL,
      response_ms INTEGER,
      PRIMARY KEY (player_id, question_index)
    );
    CREATE INDEX IF NOT EXISTS answers_game ON answers(game_id);
  `);
  // Columns added after the first release (databases created earlier are upgraded in place).
  addColumn(db, 'games', 'owner_id', 'INTEGER REFERENCES users(id) ON DELETE CASCADE');
  addColumn(db, 'answers', 'response_json', 'TEXT');
  addColumn(db, 'users', 'role', "TEXT NOT NULL DEFAULT 'host'");
  addColumn(db, 'games', 'kind', "TEXT NOT NULL DEFAULT 'quiz'");
  db.exec('CREATE INDEX IF NOT EXISTS games_owner ON games(owner_id, ended_at)');
  // Blind test version: global settings, blind tests, media and live game snapshots.
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      settings_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_by TEXT
    );
    CREATE TABLE IF NOT EXISTS blind_tests (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      blind_test_json TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      plays INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,          -- storage key, e.g. 3f2a...e1.png
      kind TEXT NOT NULL,           -- image | favicon | audio
      mime TEXT NOT NULL,
      size INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS live_games (
      pin TEXT PRIMARY KEY,
      game_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  // V1.1 -> V1.3 (idempotent; nothing is dropped): music library, blind test <-> library
  // usage, audit log, structured answers, teams and reconnections in reports.
  db.exec(`
    CREATE TABLE IF NOT EXISTS music_tracks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      year INTEGER,
      decade INTEGER,
      genre TEXT NOT NULL DEFAULT '',
      audio_url TEXT NOT NULL DEFAULT '',
      cover_url TEXT NOT NULL DEFAULT '',
      default_start REAL NOT NULL DEFAULT 0,
      default_duration INTEGER,
      artist_aliases TEXT NOT NULL DEFAULT '[]',
      title_aliases TEXT NOT NULL DEFAULT '[]',
      tags TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      archived INTEGER NOT NULL DEFAULT 0,
      norm_key TEXT NOT NULL,
      search TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS music_norm ON music_tracks(norm_key);
    CREATE INDEX IF NOT EXISTS music_artist ON music_tracks(archived, artist);
    CREATE INDEX IF NOT EXISTS music_decade ON music_tracks(decade);
    CREATE INDEX IF NOT EXISTS music_genre ON music_tracks(genre);
    CREATE TABLE IF NOT EXISTS blind_test_tracks (
      blind_test_id TEXT NOT NULL REFERENCES blind_tests(id) ON DELETE CASCADE,
      track_id TEXT NOT NULL,
      music_track_id TEXT NOT NULL,
      round_index INTEGER NOT NULL,
      position INTEGER NOT NULL,
      PRIMARY KEY (blind_test_id, track_id)
    );
    CREATE INDEX IF NOT EXISTS btt_music ON blind_test_tracks(music_track_id);
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      actor TEXT,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      summary TEXT NOT NULL DEFAULT '',
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at);
  `);
  addColumn(db, 'answers', 'detail_json', 'TEXT');
  addColumn(db, 'players', 'team_name', 'TEXT');
  addColumn(db, 'players', 'reconnects', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'games', 'teams_json', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS players_game ON players(game_id)');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  return db;
}

function addColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

// ---------------------------------------------------------------- accounts

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), 32);
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'base64'));
}

const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));
const tokenHash = (t) => crypto.createHash('sha256').update(t).digest('hex');

function createUser(db, { email, name, password }) {
  const e = String(email || '').trim().toLowerCase();
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) throw Object.assign(new Error('Enter a valid email address'), { status: 400 });
  if (!n) throw Object.assign(new Error('Enter your name'), { status: 400 });
  if (String(password || '').length < 8) throw Object.assign(new Error('Use a password of at least 8 characters'), { status: 400 });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(e)) {
    throw Object.assign(new Error('An account with this email already exists. Sign in instead.'), { status: 409 });
  }
  const { lastInsertRowid } = db.prepare('INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(e, n, hashPassword(String(password)), Date.now());
  return { id: Number(lastInsertRowid), email: e, name: n };
}

function checkLogin(db, email, password) {
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim().toLowerCase());
  // Run scrypt even for unknown emails so response time does not reveal which emails exist.
  const ok = verifyPassword(String(password || ''), u ? u.pass_hash : DUMMY_HASH);
  return u && ok ? { id: u.id, email: u.email, name: u.name, role: u.role } : null;
}

function createSession(db, userId, maxAgeSeconds = SESSION_DAYS * 86400) {
  const token = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(tokenHash(token), userId, Date.now() + maxAgeSeconds * 1000);
  return { token, maxAge: maxAgeSeconds };
}

function sessionUser(db, token) {
  if (!token) return null;
  const row = db.prepare(`SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash(token), Date.now());
  return row ? { id: row.id, email: row.email, name: row.name, role: row.role } : null;
}

/**
 * Makes sure an administrator account exists for `email` with `password`
 * (from ADMIN_EMAIL / ADMIN_PASSWORD). Changing ADMIN_PASSWORD and restarting
 * resets the password. Returns the admin user.
 */
function ensureAdmin(db, email, password) {
  const e = String(email).trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(e);
  if (!u) {
    const { lastInsertRowid } = db.prepare("INSERT INTO users (email, name, pass_hash, created_at, role) VALUES (?, ?, ?, ?, 'admin')")
      .run(e, 'Administrateur', hashPassword(String(password)), Date.now());
    return { id: Number(lastInsertRowid), email: e, name: 'Administrateur', role: 'admin', created: true };
  }
  const passwordChanged = !verifyPassword(String(password), u.pass_hash);
  if (passwordChanged || u.role !== 'admin') {
    db.prepare("UPDATE users SET pass_hash = ?, role = 'admin' WHERE id = ?").run(passwordChanged ? hashPassword(String(password)) : u.pass_hash, u.id);
    if (passwordChanged) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id); // log out old sessions
  }
  return { id: u.id, email: u.email, name: u.name, role: 'admin', created: false };
}

const adminCount = (db) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;

// ---------------------------------------------------------------- global settings

function getSettings(db, defaults) {
  const row = db.prepare('SELECT * FROM app_settings WHERE id = 1').get();
  if (!row) return { ...defaults };
  return { ...defaults, ...JSON.parse(row.settings_json), updatedAt: row.updated_at, updatedBy: row.updated_by };
}

function saveSettings(db, settings, updatedBy) {
  const { updatedAt, updatedBy: _ignored, ...rest } = settings;
  const now = Date.now();
  db.prepare(`INSERT INTO app_settings (id, settings_json, updated_at, updated_by) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(JSON.stringify(rest), now, updatedBy || null);
  return { ...rest, updatedAt: now, updatedBy: updatedBy || null };
}

// ---------------------------------------------------------------- blind tests

const blindRow = (r, full) => {
  const bt = JSON.parse(r.blind_test_json);
  const base = { id: r.id, title: r.title, description: bt.description || '', archived: !!r.archived, plays: r.plays,
    rounds: bt.rounds.length, tracks: bt.rounds.reduce((n, x) => n + x.tracks.length, 0), createdAt: r.created_at, updatedAt: r.updated_at };
  return full ? { ...base, blindTest: bt } : base;
};

function listBlindTests(db, { includeArchived = true } = {}) {
  return db.prepare(`SELECT * FROM blind_tests ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY updated_at DESC`).all().map((r) => blindRow(r, false));
}

function getBlindTest(db, id) {
  const r = db.prepare('SELECT * FROM blind_tests WHERE id = ?').get(String(id));
  return r ? blindRow(r, true) : null;
}

/** Inserts or replaces a validated blind test. */
function saveBlindTest(db, bt) {
  const now = Date.now();
  const exists = db.prepare('SELECT 1 FROM blind_tests WHERE id = ?').get(bt.id);
  if (exists) {
    db.prepare('UPDATE blind_tests SET title = ?, blind_test_json = ?, updated_at = ? WHERE id = ?').run(bt.title, JSON.stringify(bt), now, bt.id);
  } else {
    if (db.prepare('SELECT COUNT(*) AS n FROM blind_tests').get().n >= 1000) throw Object.assign(new Error('Trop de blind tests (maximum 1000)'), { status: 409 });
    db.prepare('INSERT INTO blind_tests (id, title, blind_test_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(bt.id, bt.title, JSON.stringify(bt), now, now);
  }
  return bt.id;
}

const setBlindTestArchived = (db, id, archived) => db.prepare('UPDATE blind_tests SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, Date.now(), id).changes > 0;
const deleteBlindTest = (db, id) => db.prepare('DELETE FROM blind_tests WHERE id = ?').run(id).changes > 0;
const countBlindTestPlay = (db, id) => db.prepare('UPDATE blind_tests SET plays = plays + 1 WHERE id = ?').run(id);
const allBlindTestJson = (db) => db.prepare('SELECT blind_test_json FROM blind_tests').all().map((r) => JSON.parse(r.blind_test_json));

// ---------------------------------------------------------------- media

function addMedia(db, m) {
  db.prepare('INSERT INTO media (id, kind, mime, size, original_name, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(m.id, m.kind, m.mime, m.size, m.originalName, Date.now());
}
const mediaRow = (r) => ({ id: r.id, url: `/media/${r.id}`, kind: r.kind, mime: r.mime, size: r.size, originalName: r.original_name, createdAt: r.created_at });
const listMedia = (db, kind) => (kind
  ? db.prepare('SELECT * FROM media WHERE kind = ? ORDER BY created_at DESC').all(kind)
  : db.prepare('SELECT * FROM media ORDER BY created_at DESC').all()).map(mediaRow);
const getMedia = (db, id) => { const r = db.prepare('SELECT * FROM media WHERE id = ?').get(String(id)); return r ? mediaRow(r) : null; };
const deleteMedia = (db, id) => db.prepare('DELETE FROM media WHERE id = ?').run(id).changes > 0;

// ---------------------------------------------------------------- live game snapshots

function saveLiveGame(db, pin, json, expiresAt) {
  db.prepare(`INSERT INTO live_games (pin, game_json, updated_at, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(pin) DO UPDATE SET game_json = excluded.game_json, updated_at = excluded.updated_at, expires_at = excluded.expires_at`)
    .run(pin, json, Date.now(), expiresAt);
}
const deleteLiveGame = (db, pin) => db.prepare('DELETE FROM live_games WHERE pin = ?').run(pin);
function loadLiveGames(db) {
  db.prepare('DELETE FROM live_games WHERE expires_at < ?').run(Date.now());
  return db.prepare('SELECT game_json FROM live_games').all().map((r) => r.game_json);
}

// ---------------------------------------------------------------- music library

const musicRow = (r) => r && ({
  id: r.id, title: r.title, artist: r.artist, year: r.year, decade: r.decade, genre: r.genre, audioUrl: r.audio_url, coverUrl: r.cover_url,
  defaultStartTime: r.default_start, defaultDuration: r.default_duration, artistAliases: JSON.parse(r.artist_aliases), titleAliases: JSON.parse(r.title_aliases),
  tags: JSON.parse(r.tags), internalNotes: r.notes, archived: !!r.archived, createdAt: r.created_at, updatedAt: r.updated_at,
  ...(r.uses !== undefined ? { uses: r.uses } : {}),
});

const getMusicTrack = (db, id) => musicRow(db.prepare('SELECT * FROM music_tracks WHERE id = ?').get(String(id)));

/** Inserts or updates a validated music track (see lib/library.js). */
function saveMusicTrack(db, t, normKey, search) {
  const now = Date.now();
  const vals = [t.title, t.artist, t.year, t.decade, t.genre, t.audioUrl, t.coverUrl, t.defaultStartTime, t.defaultDuration,
    JSON.stringify(t.artistAliases), JSON.stringify(t.titleAliases), JSON.stringify(t.tags), t.internalNotes, normKey, search];
  if (db.prepare('SELECT 1 FROM music_tracks WHERE id = ?').get(t.id)) {
    db.prepare(`UPDATE music_tracks SET title=?, artist=?, year=?, decade=?, genre=?, audio_url=?, cover_url=?, default_start=?, default_duration=?,
      artist_aliases=?, title_aliases=?, tags=?, notes=?, norm_key=?, search=?, updated_at=? WHERE id=?`).run(...vals, now, t.id);
  } else {
    if (db.prepare('SELECT COUNT(*) AS n FROM music_tracks').get().n >= 20000) throw Object.assign(new Error('Bibliothèque pleine (20 000 morceaux)'), { status: 409 });
    db.prepare(`INSERT INTO music_tracks (title, artist, year, decade, genre, audio_url, cover_url, default_start, default_duration,
      artist_aliases, title_aliases, tags, notes, norm_key, search, created_at, updated_at, id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...vals, now, now, t.id);
  }
  return t.id;
}

const SORTS = { artist: 'artist COLLATE NOCASE, title COLLATE NOCASE', title: 'title COLLATE NOCASE', year: 'year, artist COLLATE NOCASE', recent: 'updated_at DESC', uses: 'uses DESC, artist COLLATE NOCASE' };

/** Paginated, filtered search. `search` is matched against a normalised text column. */
function listMusicTracks(db, f = {}) {
  const where = [];
  const args = [];
  where.push(f.archived ? 'm.archived = 1' : 'm.archived = 0');
  if (f.q) for (const w of String(f.q).split(' ').filter(Boolean).slice(0, 6)) { where.push('m.search LIKE ?'); args.push(`%${w}%`); }
  if (f.artist) { where.push('m.artist = ? COLLATE NOCASE'); args.push(f.artist); }
  if (f.year) { where.push('m.year = ?'); args.push(Number(f.year)); }
  if (f.decade) { where.push('m.decade = ?'); args.push(Number(f.decade)); }
  if (f.genre) { where.push('m.genre = ? COLLATE NOCASE'); args.push(f.genre); }
  if (f.tag) { where.push('m.tags LIKE ?'); args.push(`%"${String(f.tag).toLowerCase().replace(/"/g, '')}"%`); }
  if (f.hasCover === '1') where.push("m.cover_url != ''"); else if (f.hasCover === '0') where.push("m.cover_url = ''");
  if (f.hasAudio === '1') where.push("m.audio_url != ''"); else if (f.hasAudio === '0') where.push("m.audio_url = ''");
  const uses = '(SELECT COUNT(DISTINCT b.blind_test_id) FROM blind_test_tracks b WHERE b.music_track_id = m.id)';
  if (f.used === '1') where.push(`${uses} > 0`); else if (f.used === '0') where.push(`${uses} = 0`);
  const pageSize = Math.min(200, Math.max(1, Number(f.pageSize) || 50));
  const page = Math.max(1, Number(f.page) || 1);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS n FROM music_tracks m ${clause}`).get(...args).n;
  const rows = db.prepare(`SELECT m.*, ${uses} AS uses FROM music_tracks m ${clause} ORDER BY ${SORTS[f.sort] || SORTS.artist} LIMIT ? OFFSET ?`)
    .all(...args, pageSize, (page - 1) * pageSize);
  return { items: rows.map(musicRow), total, page, pageSize };
}

function musicFacets(db) {
  const col = (sql) => db.prepare(sql).all().map((r) => r.v).filter((v) => v !== null && v !== '');
  const tags = new Map();
  for (const r of db.prepare('SELECT tags FROM music_tracks WHERE archived = 0').all()) for (const t of JSON.parse(r.tags)) tags.set(t, (tags.get(t) || 0) + 1);
  return {
    genres: col('SELECT DISTINCT genre AS v FROM music_tracks WHERE archived = 0 ORDER BY genre COLLATE NOCASE'),
    decades: col('SELECT DISTINCT decade AS v FROM music_tracks WHERE archived = 0 ORDER BY decade'),
    tags: [...tags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100).map(([t]) => t),
    total: db.prepare('SELECT COUNT(*) AS n FROM music_tracks WHERE archived = 0').get().n,
  };
}

/** Light columns of the whole library, used to generate distractors. */
const musicCandidates = (db) => db.prepare('SELECT id, title, artist, year, genre FROM music_tracks WHERE archived = 0').all();
const findMusicByNormKey = (db, key) => db.prepare('SELECT * FROM music_tracks WHERE norm_key = ?').all(key).map(musicRow);
const setMusicArchived = (db, id, archived) => db.prepare('UPDATE music_tracks SET archived = ?, updated_at = ? WHERE id = ?').run(archived ? 1 : 0, Date.now(), id).changes > 0;
const deleteMusicTrack = (db, id) => db.prepare('DELETE FROM music_tracks WHERE id = ?').run(id).changes > 0;
const musicUsage = (db, id) => db.prepare(`SELECT DISTINCT b.blind_test_id AS id, t.title FROM blind_test_tracks b JOIN blind_tests t ON t.id = b.blind_test_id
  WHERE b.music_track_id = ? ORDER BY t.title`).all(String(id));
const allMusicMedia = (db) => db.prepare("SELECT audio_url AS a, cover_url AS c FROM music_tracks").all().flatMap((r) => [r.a, r.c]).filter((u) => u && u.startsWith('/media/'));

/** Rebuilds the blind test <-> library usage rows for one blind test. */
function syncBlindTestTracks(db, bt) {
  db.prepare('DELETE FROM blind_test_tracks WHERE blind_test_id = ?').run(bt.id);
  const ins = db.prepare('INSERT OR IGNORE INTO blind_test_tracks (blind_test_id, track_id, music_track_id, round_index, position) VALUES (?, ?, ?, ?, ?)');
  bt.rounds.forEach((r, ri) => r.tracks.forEach((t, ti) => { if (t.musicTrackId) ins.run(bt.id, t.id, t.musicTrackId, ri, ti); }));
}

// ---------------------------------------------------------------- audit log

function audit(db, { actor = null, action, resourceType = null, resourceId = null, summary = '', ip = null }) {
  db.prepare('INSERT INTO audit_log (at, actor, action, resource_type, resource_id, summary, ip) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(Date.now(), actor, action, resourceType, resourceId === null ? null : String(resourceId).slice(0, 120), String(summary).slice(0, 300), ip);
}

function listAudit(db, { page = 1, pageSize = 50, action = '' } = {}) {
  const size = Math.min(200, Math.max(1, Number(pageSize) || 50));
  const p = Math.max(1, Number(page) || 1);
  const clause = action ? 'WHERE action LIKE ?' : '';
  const args = action ? [`${action}%`] : [];
  const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...args).n;
  const items = db.prepare(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, size, (p - 1) * size)
    .map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, resourceType: r.resource_type, resourceId: r.resource_id, summary: r.summary, ip: r.ip }));
  return { items, total, page: p, pageSize: size };
}

const purgeAudit = (db, days) => db.prepare('DELETE FROM audit_log WHERE at < ?').run(Date.now() - days * 86400000).changes;

function mediaTotals(db) {
  const r = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM media').get();
  return { count: r.n, bytes: r.bytes };
}

function stats(db) {
  const one = (sql) => db.prepare(sql).get().n;
  const tracks = allBlindTestJson(db).reduce((n, bt) => n + bt.rounds.reduce((m, r) => m + r.tracks.length, 0), 0);
  return {
    blindTests: one('SELECT COUNT(*) AS n FROM blind_tests WHERE archived = 0'),
    archivedBlindTests: one('SELECT COUNT(*) AS n FROM blind_tests WHERE archived = 1'),
    tracks,
    media: one('SELECT COUNT(*) AS n FROM media'),
    libraryTracks: one('SELECT COUNT(*) AS n FROM music_tracks WHERE archived = 0'),
    gamesPlayed: one('SELECT COUNT(*) AS n FROM games'),
  };
}

function recentGames(db, limit = 8) {
  return db.prepare(`SELECT g.id, g.title, g.pin, g.ended_at, g.completed, g.kind, (SELECT COUNT(*) FROM players p WHERE p.game_id = g.id) AS players
    FROM games g ORDER BY g.ended_at DESC LIMIT ?`).all(limit)
    .map((r) => ({ id: r.id, title: r.title, pin: r.pin, endedAt: r.ended_at, completed: !!r.completed, kind: r.kind, players: r.players }));
}

function deleteSession(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

// ---------------------------------------------------------------- quiz library

const quizRow = (r) => {
  const quiz = JSON.parse(r.quiz_json);
  return { id: r.id, title: r.title, questions: quiz.questions.length, types: [...new Set(quiz.questions.map((q) => q.type))],
    plays: r.plays, createdAt: r.created_at, updatedAt: r.updated_at };
};

function listQuizzes(db, ownerId) {
  return db.prepare('SELECT * FROM quizzes WHERE owner_id = ? ORDER BY updated_at DESC').all(ownerId).map(quizRow);
}

function getQuiz(db, ownerId, id) {
  const r = db.prepare('SELECT * FROM quizzes WHERE id = ? AND owner_id = ?').get(id, ownerId);
  return r ? { ...quizRow(r), quiz: JSON.parse(r.quiz_json) } : null;
}

function saveQuiz(db, ownerId, quiz, id = null) {
  const now = Date.now();
  if (id) {
    const res = db.prepare('UPDATE quizzes SET title = ?, quiz_json = ?, updated_at = ? WHERE id = ? AND owner_id = ?')
      .run(quiz.title, JSON.stringify(quiz), now, id, ownerId);
    return res.changes ? id : null;
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM quizzes WHERE owner_id = ?').get(ownerId).n;
  if (count >= 500) throw Object.assign(new Error('Your library is full (500 quizzes). Delete some first.'), { status: 409 });
  return Number(db.prepare('INSERT INTO quizzes (owner_id, title, quiz_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(ownerId, quiz.title, JSON.stringify(quiz), now, now).lastInsertRowid);
}

function deleteQuiz(db, ownerId, id) {
  return db.prepare('DELETE FROM quizzes WHERE id = ? AND owner_id = ?').run(id, ownerId).changes > 0;
}

function countPlay(db, ownerId, id) {
  db.prepare('UPDATE quizzes SET plays = plays + 1 WHERE id = ? AND owner_id = ?').run(id, ownerId);
}

// ---------------------------------------------------------------- game history

/** Saves a finished game. `history[q]` maps playerId -> {answer, correct, points, responseMs}. */
function saveGame(db, g, rankedPlayers, completed) {
  const played = g.history.length;
  if (!played || !rankedPlayers.length) return null;
  db.exec('BEGIN');
  try {
    const { lastInsertRowid: gameId } = db.prepare(
      'INSERT INTO games (pin, title, quiz_json, started_at, ended_at, questions_played, completed, owner_id, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(g.pin, g.quiz.title, JSON.stringify(g.quiz), g.startedAt, Date.now(), played, completed ? 1 : 0, g.ownerId ?? null, g.quiz.kind || 'quiz');
    if (g.teams && g.teams.length) db.prepare('UPDATE games SET teams_json = ? WHERE id = ?').run(JSON.stringify({ teams: g.teams, method: g.teamOptions?.method || 'sum', topN: g.teamOptions?.topN || null }), gameId);
    const teamName = (p) => (g.teams || []).find((t) => t.id === p.teamId)?.name || null;
    const insPlayer = db.prepare('INSERT INTO players (game_id, name, avatar_json, score, rank, team_name, reconnects) VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insAnswer = db.prepare(`INSERT INTO answers (game_id, player_id, question_index, choice, correct, points, response_ms, response_json, detail_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    rankedPlayers.forEach((p, i) => {
      const { lastInsertRowid: pid } = insPlayer.run(gameId, p.name, JSON.stringify(p.avatar), p.score, i + 1, teamName(p), p.reconnects || 0);
      g.history.forEach((byPlayer, q) => {
        const a = byPlayer[p.id];
        if (!a) return;
        insAnswer.run(gameId, pid, q, Number.isInteger(a.answer) ? a.answer : null, a.correct ? 1 : 0, a.points, a.responseMs,
          a.answer === null || a.answer === undefined ? null : JSON.stringify(a.answer), a.parts ? JSON.stringify({ parts: a.parts }) : null);
      });
    });
    db.exec('COMMIT');
    return Number(gameId);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Hosts see their own games; without an account, only games hosted without one.
const ownerClause = (ownerId) => (ownerId ? 'g.owner_id = ?' : 'g.owner_id IS NULL');
const ownerArgs = (ownerId) => (ownerId ? [ownerId] : []);

function listReports(db, ownerId) {
  return db.prepare(`
    SELECT g.id, g.title, g.pin, g.started_at, g.ended_at, g.questions_played, g.completed, g.quiz_json,
           (SELECT COUNT(*) FROM players p WHERE p.game_id = g.id) AS players
    FROM games g WHERE ${ownerClause(ownerId)} ORDER BY g.ended_at DESC LIMIT 500`).all(...ownerArgs(ownerId)).map((r) => {
    const report = getReport(db, r.id, ownerId);
    return {
      id: r.id, title: r.title, pin: r.pin, startedAt: r.started_at, endedAt: r.ended_at,
      questionsPlayed: r.questions_played, completed: !!r.completed, players: r.players, accuracy: report.summary.accuracy,
    };
  });
}

function getReport(db, id, ownerId) {
  const g = db.prepare(`SELECT * FROM games g WHERE g.id = ? AND ${ownerClause(ownerId)}`).get(id, ...ownerArgs(ownerId));
  if (!g) return null;
  const quiz = JSON.parse(g.quiz_json);
  const n = g.questions_played;
  const questions = quiz.questions.slice(0, n).map((q) => ({ type: 'quiz', points: 'standard', ...q })); // older reports had no type
  const scoredIdx = questions.map((q, i) => (Q.isScored(q) ? i : -1)).filter((i) => i >= 0);
  const players = db.prepare('SELECT * FROM players WHERE game_id = ? ORDER BY rank').all(id);
  const answers = db.prepare('SELECT * FROM answers WHERE game_id = ?').all(id);
  const byPlayer = new Map(players.map((p) => [p.id, []]));
  for (const a of answers) {
    const value = a.response_json !== null ? JSON.parse(a.response_json) : a.choice;
    byPlayer.get(a.player_id)[a.question_index] = { ...a, value };
  }

  const qStats = questions.map((q, i) => {
    const given = [];
    let correct = 0; let totalMs = 0;
    for (const p of players) {
      const a = byPlayer.get(p.id)[i];
      if (!a || a.value === null || a.value === undefined) continue;
      given.push(a.value); totalMs += a.response_ms; correct += a.correct;
    }
    const scored = Q.isScored(q);
    const pct = scored && players.length ? correct / players.length : null;
    return { index: i, type: q.type, text: q.text, time: q.time, points: q.points, scored,
      correctText: Q.describeCorrect(q), choices: q.choices || null, correctChoices: q.correct || [],
      summary: Q.revealSummary(q, given), answered: given.length, unanswered: players.length - given.length,
      correct, correctPct: pct, avgMs: given.length ? Math.round(totalMs / given.length) : null,
      difficult: scored && pct < DIFFICULT_BELOW };
  });

  const playerRows = players.map((p) => {
    const list = byPlayer.get(p.id);
    const correct = scoredIdx.filter((i) => list[i]?.correct).length;
    const answered = questions.filter((_, i) => list[i] && list[i].value !== null && list[i].value !== undefined).length;
    const acc = scoredIdx.length ? correct / scoredIdx.length : null;
    return { rank: p.rank, name: p.name, avatar: JSON.parse(p.avatar_json), score: p.score, correct, answered,
      unanswered: n - answered, accuracy: acc, needsHelp: acc !== null && acc < NEEDS_HELP_BELOW, didNotFinish: answered < n,
      answers: questions.map((q, i) => {
        const a = list[i];
        if (!a || a.value === null || a.value === undefined) return null;
        return { text: Q.describeAnswer(q, a.value), choice: Number.isInteger(a.value) ? a.value : null,
          correct: !!a.correct, scored: Q.isScored(q), points: a.points, ms: a.response_ms };
      }) };
  });

  const totalCorrect = playerRows.reduce((s, p) => s + p.correct, 0);
  return {
    id: g.id, title: g.title, pin: g.pin, startedAt: g.started_at, endedAt: g.ended_at, completed: !!g.completed,
    summary: { players: players.length, questions: n, scoredQuestions: scoredIdx.length, questionsInQuiz: quiz.questions.length,
      accuracy: players.length && scoredIdx.length ? totalCorrect / (players.length * scoredIdx.length) : null,
      averageScore: players.length ? Math.round(playerRows.reduce((s, p) => s + p.score, 0) / players.length) : 0,
      difficult: qStats.filter((q) => q.difficult).length, needHelp: playerRows.filter((p) => p.needsHelp).length,
      didNotFinish: playerRows.filter((p) => p.didNotFinish).length },
    thresholds: { difficultBelow: DIFFICULT_BELOW, needsHelpBelow: NEEDS_HELP_BELOW },
    questions: qStats, players: playerRows,
  };
}

function deleteReport(db, id, ownerId) {
  return db.prepare(`DELETE FROM games WHERE id = ? AND ${ownerClause(ownerId).replace(/g\./g, '')}`).run(id, ...ownerArgs(ownerId)).changes > 0;
}

// Spreadsheet-safe CSV: quotes everything and neutralises formula injection (=, +, -, @).
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function reportCsv(r) {
  const head = ['Rank', 'Player', 'Total score', 'Correct', 'Accuracy %', 'Unanswered'];
  r.questions.forEach((q, i) => head.push(`Q${i + 1} answer`, `Q${i + 1} correct`, `Q${i + 1} points`, `Q${i + 1} time (s)`));
  const rows = r.players.map((p) => {
    const row = [p.rank, p.name, p.score, p.correct, p.accuracy === null ? '' : Math.round(p.accuracy * 100), p.unanswered];
    p.answers.forEach((a, i) => {
      if (!a) row.push('(no answer)', r.questions[i].scored ? 'no' : '', 0, '');
      else row.push(a.text, a.scored ? (a.correct ? 'yes' : 'no') : '', a.points, (a.ms / 1000).toFixed(1));
    });
    return row;
  });
  const qSection = [[], ['Question', 'Type', 'Correct answer', 'Correct %', 'Answered', 'Average time (s)', 'Difficult'],
    ...r.questions.map((q, i) => [`Q${i + 1}: ${q.text}`, q.type, q.correctText, q.correctPct === null ? '' : Math.round(q.correctPct * 100),
      q.answered, q.avgMs === null ? '' : (q.avgMs / 1000).toFixed(1), q.difficult ? 'yes' : 'no'])];
  return '﻿' + [head, ...rows, ...qSection].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = {
  open, createUser, checkLogin, createSession, sessionUser, deleteSession, ensureAdmin, adminCount,
  getSettings, saveSettings,
  listBlindTests, getBlindTest, saveBlindTest, setBlindTestArchived, deleteBlindTest, countBlindTestPlay, allBlindTestJson,
  addMedia, listMedia, getMedia, deleteMedia,
  saveLiveGame, deleteLiveGame, loadLiveGames, stats, recentGames,
  getMusicTrack, saveMusicTrack, listMusicTracks, musicFacets, musicCandidates, findMusicByNormKey, setMusicArchived, deleteMusicTrack,
  musicUsage, allMusicMedia, syncBlindTestTracks, audit, listAudit, purgeAudit, mediaTotals,
  listQuizzes, getQuiz, saveQuiz, deleteQuiz, countPlay,
  saveGame, listReports, getReport, deleteReport, reportCsv,
};
