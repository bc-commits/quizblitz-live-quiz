// Reusable music library: validation of music tracks, duplicate keys and
// JSON / CSV import-export helpers. Storage lives in db.js (music_tracks).

const crypto = require('crypto');
const { canon } = require('./answers');

const str = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const list = (v, max, len = 60) => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,;|]/) : [])
  .map((x) => str(x, len)).filter(Boolean).filter((x, i, a) => a.findIndex((y) => canon(y) === canon(x)) === i).slice(0, max);
const isAudioUrl = (u) => u === '' || /^\/media\/[a-f0-9]{32}\.(mp3|m4a|ogg|wav)$/.test(u) || /^\/audio\/[\w.\-/]+\.(mp3|m4a|ogg|wav)$/i.test(u) || /^https:\/\/[^\s"'<>]+$/i.test(u);
const isImageUrl = (u) => u === '' || /^\/media\/[a-f0-9]{32}\.(png|jpg|webp)$/.test(u) || /^\/covers\/[\w.\-/]+\.(png|jpe?g|webp)$/i.test(u) || /^https:\/\/[^\s"'<>]+$/i.test(u);

/** Normalised key used to spot potential duplicates (never merged automatically). */
const normKey = (artist, title, year) => `${canon(artist)}|${canon(title)}|${Number.isInteger(year) ? year : ''}`;

function fail(message, details) { throw Object.assign(new Error(message), { status: 400, details }); }

/** Validates a music track; returns the normalised record or throws a 400 error. */
function validateMusicTrack(input, { id } = {}) {
  if (!input || typeof input !== 'object') fail('Morceau invalide');
  const errors = [];
  const title = str(input.title, 120);
  const artist = str(input.artist, 120);
  const yearRaw = input.year;
  const year = yearRaw === undefined || yearRaw === null || yearRaw === '' ? null : Number(yearRaw);
  if (!title) errors.push('le titre est obligatoire');
  if (!artist) errors.push("l'artiste est obligatoire");
  if (year !== null && !(Number.isInteger(year) && year >= 1800 && year <= 2100)) errors.push('année invalide');
  const audioUrl = str(input.audioUrl, 1000);
  const coverUrl = str(input.coverUrl, 1000);
  if (!isAudioUrl(audioUrl)) errors.push('URL audio invalide');
  if (!isImageUrl(coverUrl)) errors.push('URL de pochette invalide');
  const start = input.defaultStartTime === undefined || input.defaultStartTime === '' || input.defaultStartTime === null ? 0 : Number(input.defaultStartTime);
  if (!(Number.isFinite(start) && start >= 0 && start <= 3600)) errors.push("début d'extrait invalide");
  const dur = input.defaultDuration === undefined || input.defaultDuration === '' || input.defaultDuration === null ? null : Math.round(Number(input.defaultDuration));
  if (dur !== null && !(dur >= 5 && dur <= 120)) errors.push("durée d'extrait invalide (5 à 120 s)");
  if (errors.length) fail(`Morceau « ${title || '?'} » : ${errors.join(', ')}`, errors);
  return {
    id: id || str(input.id, 60).replace(/[^\w-]/g, '') || `music-${crypto.randomBytes(5).toString('hex')}`,
    title, artist, year,
    decade: year !== null ? Math.floor(year / 10) * 10 : null,
    genre: str(input.genre, 40),
    audioUrl, coverUrl,
    defaultStartTime: Math.round(start * 10) / 10,
    defaultDuration: dur,
    artistAliases: list(input.artistAliases, 10, 120),
    titleAliases: list(input.titleAliases, 10, 120),
    tags: list(input.tags, 20, 40).map((x) => x.toLowerCase()),
    internalNotes: str(input.internalNotes ?? input.notes, 500),
  };
}

// ---------------------------------------------------------------- CSV

/** RFC 4180 parser (quotes, doubled quotes, commas/semicolons, CRLF). Returns rows of strings. */
function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = []; let cell = ''; let q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim() !== ''));
}

// Spreadsheet-safe CSV cell: quoted, and formula injection neutralised (=, +, -, @, tab, CR).
function csvCell(v) {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
const toCsv = (rows) => `﻿${rows.map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;

const CSV_COLUMNS = ['title', 'artist', 'year', 'genre', 'tags', 'artistAliases', 'titleAliases', 'audioUrl', 'coverUrl', 'defaultStartTime', 'defaultDuration', 'internalNotes'];
const CSV_ALIASES = { titre: 'title', artiste: 'artist', annee: 'year', année: 'year', genre: 'genre', tags: 'tags', notes: 'internalNotes', audio: 'audioUrl', pochette: 'coverUrl', debut: 'defaultStartTime', duree: 'defaultDuration' };

/** Converts CSV text into { rows: [{ line, data }], errors } using the header line. */
function csvToObjects(text) {
  const rows = parseCsv(text);
  if (!rows.length) return { rows: [], errors: [{ line: 1, message: 'Fichier vide' }] };
  const header = rows[0].map((h) => { const k = canon(h).replace(/\s+/g, ''); return CSV_COLUMNS.find((c) => c.toLowerCase() === k) || CSV_ALIASES[k] || null; });
  if (!header.includes('title') || !header.includes('artist')) return { rows: [], errors: [{ line: 1, message: 'En-tête requis : au moins les colonnes title et artist (ou titre et artiste)' }] };
  return {
    rows: rows.slice(1).map((r, i) => ({ line: i + 2, data: Object.fromEntries(header.map((h, j) => [h, r[j] ?? '']).filter(([h]) => h)) })),
    errors: [],
  };
}

function tracksToCsv(tracks) {
  return toCsv([CSV_COLUMNS, ...tracks.map((t) => CSV_COLUMNS.map((c) => (Array.isArray(t[c]) ? t[c].join('|') : t[c] ?? '')))]);
}

module.exports = { validateMusicTrack, normKey, parseCsv, csvToObjects, tracksToCsv, toCsv, csvCell, CSV_COLUMNS };
