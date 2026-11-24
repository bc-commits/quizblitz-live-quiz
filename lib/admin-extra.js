// Admin API for the music library, distractors, imports/exports and the audit log.
// Mounted by server.js under /api/admin (the caller has already checked the admin
// session and the CSRF header).

const Library = require('./library');
const { generateChoices } = require('./distractors');
const BT = require('./blindtest');
const { canon } = require('./answers');
const Reports = require('./reports');

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_ROWS = 2000;

function createAdminExtra(ctx) {
  const { db, store, readBody, sendJson, httpError, auditLog, blindOptions } = ctx;

  const searchText = (t) => canon([t.title, t.artist, t.genre, ...(t.tags || []), ...(t.artistAliases || []), ...(t.titleAliases || []), t.year || ''].join(' '));
  const save = (t) => store.saveMusicTrack(db, t, Library.normKey(t.artist, t.title, t.year), searchText(t));

  /** Distractors for a library track or free metadata. */
  function distractorsFor(target, type, count, seed) {
    const lib = store.musicCandidates(db).filter((x) => !(target.id && x.id === target.id));
    return generateChoices(target, type, lib, { count, seed });
  }

  /** Builds a blind-test track referencing a library track, with generated choices. */
  function trackFromLibrary(m, { genType, storedType = null, startTime, duration, count = 4, seed }) {
    const t = { musicTrackId: m.id, title: '', artist: '', year: null, audioUrl: '', coverUrl: '' };
    if (Number.isFinite(Number(startTime)) && startTime !== '' && startTime !== null && startTime !== undefined) t.startTime = Number(startTime);
    if (duration) t.duration = Number(duration);
    if (storedType) t.questionType = storedType;
    const type = genType || 'artist';
    const target = { id: m.id, artist: m.artist, title: m.title, year: m.year, genre: m.genre };
    if (type === 'artist-title') {
      const a = distractorsFor(target, 'artist', count, seed);
      const ti = distractorsFor(target, 'title', count, seed);
      t.artistAnswer = { mode: 'multiple-choice', choices: a.choices, correctAnswer: a.correctAnswer };
      t.titleAnswer = { mode: 'multiple-choice', choices: ti.choices, correctAnswer: ti.correctAnswer };
    } else if (type !== 'custom') {
      const g = distractorsFor(target, type, count, seed);
      t.choices = g.choices;
      t.correctAnswer = g.correctAnswer;
    }
    return t;
  }

  /** Validates and imports rows (objects); dry run reports without writing. */
  function importRows(rows, dryRun, actor) {
    const report = [];
    const seen = new Map();
    let created = 0;
    for (const { line, data } of rows.slice(0, MAX_IMPORT_ROWS)) {
      try {
        const t = Library.validateMusicTrack({ ...data, id: undefined });
        const key = Library.normKey(t.artist, t.title, t.year);
        const existing = store.findMusicByNormKey(db, key);
        const dupInFile = seen.get(key);
        if (existing.length || dupInFile) {
          report.push({ line, status: 'duplicate', title: t.title, artist: t.artist, message: existing.length ? `Doublon possible de « ${existing[0].title} » (${existing[0].id}) déjà dans la bibliothèque : non importé` : `Doublon de la ligne ${dupInFile} : non importé` });
          continue;
        }
        seen.set(key, line);
        if (!dryRun) { save(t); created++; }
        report.push({ line, status: 'ok', title: t.title, artist: t.artist, message: dryRun ? 'Prêt à importer' : 'Importé' });
      } catch (err) {
        report.push({ line, status: 'error', title: String(data?.title || ''), artist: String(data?.artist || ''), message: err.message });
      }
    }
    if (!dryRun && created) auditLog(actor, 'library.import', 'music_track', null, `${created} morceau(x) importé(s)`);
    return { dryRun, created, total: Math.min(rows.length, MAX_IMPORT_ROWS), truncated: rows.length > MAX_IMPORT_ROWS, rows: report,
      counts: { ok: report.filter((r) => r.status === 'ok').length, duplicate: report.filter((r) => r.status === 'duplicate').length, error: report.filter((r) => r.status === 'error').length } };
  }

  /** Links the embedded tracks of a blind test to the library (match duplicates or create); media are never copied. */
  function convertBlindTest(row, actor) {
    const bt = structuredClone(row.blindTest);
    let linked = 0; let createdN = 0;
    for (const r of bt.rounds) {
      for (const t of r.tracks) {
        if (t.musicTrackId || !t.title || !t.artist) continue;
        const key = Library.normKey(t.artist, t.title, Number.isInteger(t.year) ? t.year : null);
        let m = store.findMusicByNormKey(db, key)[0];
        if (!m) {
          const v = Library.validateMusicTrack({ title: t.title, artist: t.artist, year: t.year, audioUrl: t.audioUrl, coverUrl: t.coverUrl, defaultStartTime: t.startTime || 0, defaultDuration: t.duration || null });
          save(v); m = v; createdN++;
        }
        t.musicTrackId = m.id; linked++;
      }
    }
    const { blindTest } = BT.assertValid(bt, blindOptions());
    store.saveBlindTest(db, blindTest);
    store.syncBlindTestTracks(db, blindTest);
    auditLog(actor, 'blindtest.convert', 'blind_test', row.id, `${linked} morceau(x) liés, ${createdN} créé(s) dans la bibliothèque`);
    return { linked, created: createdN };
  }

  /** Before deleting a library track used by blind tests: copy its data into them (no loss). */
  function detachEverywhere(m, actor) {
    for (const u of store.musicUsage(db, m.id)) {
      const row = store.getBlindTest(db, u.id);
      if (!row) continue;
      const bt = structuredClone(row.blindTest);
      for (const r of bt.rounds) for (const t of r.tracks) {
        if (t.musicTrackId !== m.id) continue;
        t.title = t.title || m.title; t.artist = t.artist || m.artist; t.year = t.year ?? m.year;
        t.audioUrl = t.audioUrl || m.audioUrl; t.coverUrl = t.coverUrl || m.coverUrl;
        t.musicTrackId = null;
      }
      const { blindTest } = BT.assertValid(bt, blindOptions());
      store.saveBlindTest(db, blindTest);
      store.syncBlindTestTracks(db, blindTest);
      auditLog(actor, 'blindtest.update', 'blind_test', u.id, `Morceau « ${m.title} » détaché de la bibliothèque avant suppression`);
    }
  }

  async function handle(req, res, url, parts, admin) {
    const actor = admin.email;
    const q = Object.fromEntries(url.searchParams);

    if (parts[2] === 'audit' && req.method === 'GET') return sendJson(res, 200, store.listAudit(db, q)), true;
    if (parts[2] === 'reports' && parts[3] && req.method === 'GET') {
      const r = Reports.blindReport(db, parts[3]);
      if (!r) throw httpError(404, 'Rapport introuvable');
      if (q.format === 'csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="rapport-blind-test-${r.id}.csv"`, 'Cache-Control': 'no-store' });
        return res.end(Reports.reportCsv(r)), true;
      }
      if (q.format === 'json') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="rapport-blind-test-${r.id}.json"`, 'Cache-Control': 'no-store' });
        return res.end(JSON.stringify(r, null, 2)), true;
      }
      return sendJson(res, 200, r), true;
    }

    if (parts[2] !== 'library') return false;
    const sub = parts[3];

    if (!sub) {
      if (req.method === 'GET') return sendJson(res, 200, store.listMusicTracks(db, q)), true;
      if (req.method === 'POST') {
        const t = Library.validateMusicTrack((await readBody(req, 64 * 1024)).track || {});
        if (store.getMusicTrack(db, t.id)) throw httpError(409, 'Un morceau avec cet identifiant existe déjà');
        const dup = store.findMusicByNormKey(db, Library.normKey(t.artist, t.title, t.year));
        save(t);
        auditLog(actor, 'library.create', 'music_track', t.id, `${t.artist} — ${t.title}`);
        return sendJson(res, 201, { track: store.getMusicTrack(db, t.id), duplicates: dup.map((d) => ({ id: d.id, title: d.title, artist: d.artist })) }), true;
      }
    }
    if (sub === 'facets' && req.method === 'GET') return sendJson(res, 200, store.musicFacets(db)), true;
    if (sub === 'export' && req.method === 'GET') {
      const all = [];
      for (let page = 1; ; page++) { const r = store.listMusicTracks(db, { page, pageSize: 200, archived: q.archived === '1' }); all.push(...r.items); if (all.length >= r.total || !r.items.length) break; }
      if (q.format === 'csv') {
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="bibliotheque-musicale.csv"', 'Cache-Control': 'no-store' });
        res.end(Library.tracksToCsv(all));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="bibliotheque-musicale.json"', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ type: 'music-library', version: 1, tracks: all.map(({ uses, archived, createdAt, updatedAt, ...t }) => t) }, null, 2));
      }
      return true;
    }
    if (sub === 'import' && req.method === 'POST') {
      const body = await readBody(req, MAX_IMPORT_BYTES + 4096);
      const dryRun = body.dryRun !== false;
      let rows;
      if (body.format === 'csv') {
        const parsed = Library.csvToObjects(String(body.content || '').slice(0, MAX_IMPORT_BYTES));
        if (parsed.errors.length) return sendJson(res, 200, { dryRun, created: 0, total: 0, rows: parsed.errors.map((e) => ({ ...e, status: 'error' })), counts: { ok: 0, duplicate: 0, error: 1 } }), true;
        rows = parsed.rows;
      } else {
        let data = body.content;
        if (typeof data === 'string') { try { data = JSON.parse(data); } catch { throw httpError(400, 'JSON invalide'); } }
        const tracks = Array.isArray(data) ? data : Array.isArray(data?.tracks) ? data.tracks : null;
        if (!tracks) throw httpError(400, 'Le fichier doit contenir un tableau de morceaux (ou { "tracks": [...] })');
        rows = tracks.map((d, i) => ({ line: i + 1, data: d }));
      }
      return sendJson(res, 200, importRows(rows, dryRun, actor)), true;
    }
    if (sub === 'distractors' && req.method === 'POST') {
      const b = await readBody(req, 16 * 1024);
      let target = { artist: String(b.artist || ''), title: String(b.title || ''), year: Number.isInteger(Number(b.year)) && b.year !== '' && b.year !== null ? Number(b.year) : null, genre: String(b.genre || '') };
      if (b.musicTrackId) {
        const m = store.getMusicTrack(db, b.musicTrackId);
        if (!m) throw httpError(404, 'Morceau introuvable');
        target = { id: m.id, artist: m.artist, title: m.title, year: m.year, genre: m.genre };
      }
      if (!['artist', 'title', 'year', 'decade'].includes(b.questionType)) throw httpError(400, 'Type de question non pris en charge pour la génération');
      return sendJson(res, 200, distractorsFor(target, b.questionType, b.count, b.seed || '')), true;
    }
    if (sub === 'add-to-blind-test' && req.method === 'POST') {
      const b = await readBody(req, 64 * 1024);
      const row = store.getBlindTest(db, String(b.blindTestId || ''));
      if (!row) throw httpError(404, 'Blind test introuvable');
      const ids = Array.isArray(b.trackIds) ? b.trackIds.slice(0, 100).map(String) : [];
      if (!ids.length) throw httpError(400, 'Sélectionnez au moins un morceau');
      const bt = structuredClone(row.blindTest);
      const ri = Number(b.roundIndex) || 0;
      if (!bt.rounds[ri]) throw httpError(400, 'Manche introuvable');
      const round = bt.rounds[ri];
      let added = 0;
      for (const id of ids) {
        const m = store.getMusicTrack(db, id);
        if (!m) continue;
        const genType = b.questionType || round.questionType;
        round.tracks.push(trackFromLibrary(m, { genType, storedType: genType !== round.questionType ? genType : null, startTime: b.startTime, duration: b.duration, count: b.count, seed: `${row.id}:${id}` }));
        added++;
      }
      const { blindTest, warnings } = BT.validateBlindTest(bt, blindOptions());
      store.saveBlindTest(db, blindTest);
      store.syncBlindTestTracks(db, blindTest);
      auditLog(actor, 'blindtest.update', 'blind_test', row.id, `${added} morceau(x) ajouté(s) depuis la bibliothèque`);
      return sendJson(res, 200, { added, warnings, blindTest }), true;
    }
    if (sub === 'convert-blind-test' && parts[4] && req.method === 'POST') {
      const row = store.getBlindTest(db, parts[4]);
      if (!row) throw httpError(404, 'Blind test introuvable');
      return sendJson(res, 200, convertBlindTest(row, actor)), true;
    }

    // --- one track
    const m = store.getMusicTrack(db, sub);
    if (!m) throw httpError(404, 'Morceau introuvable');
    const action = parts[4];
    if (!action) {
      if (req.method === 'GET') return sendJson(res, 200, { track: m, usage: store.musicUsage(db, m.id) }), true;
      if (req.method === 'PUT') {
        const t = Library.validateMusicTrack({ ...((await readBody(req, 64 * 1024)).track || {}) }, { id: m.id });
        save(t);
        auditLog(actor, 'library.update', 'music_track', m.id, `${t.artist} — ${t.title}`);
        return sendJson(res, 200, { track: store.getMusicTrack(db, m.id) }), true;
      }
      if (req.method === 'DELETE') {
        const usage = store.musicUsage(db, m.id);
        if (usage.length && q.detach !== '1') {
          return sendJson(res, 409, { error: `Ce morceau est utilisé par ${usage.length} blind test(s). Archivez-le, ou confirmez le détachement (les données sont recopiées dans les blind tests).`, code: 'IN_USE', usage }), true;
        }
        if (usage.length) detachEverywhere(m, actor);
        store.deleteMusicTrack(db, m.id);
        auditLog(actor, 'library.delete', 'music_track', m.id, `${m.artist} — ${m.title}`);
        await ctx.removeMediaIfUnused([m.audioUrl, m.coverUrl].filter(Boolean));
        return sendJson(res, 200, { ok: true }), true;
      }
    }
    if (action === 'archive' && req.method === 'POST') {
      const archived = (await readBody(req, 1024)).archived !== false;
      store.setMusicArchived(db, m.id, archived);
      auditLog(actor, archived ? 'library.archive' : 'library.unarchive', 'music_track', m.id, `${m.artist} — ${m.title}`);
      return sendJson(res, 200, { ok: true }), true;
    }
    if (action === 'duplicate' && req.method === 'POST') {
      // Metadata only: the copy points to the same audio file (no media duplication).
      const { id, uses, archived, createdAt, updatedAt, ...rest } = m;
      const t = Library.validateMusicTrack({ ...rest, title: `${m.title} (copie)`.slice(0, 120) });
      save(t);
      auditLog(actor, 'library.create', 'music_track', t.id, `Copie de ${m.id}`);
      return sendJson(res, 201, { track: store.getMusicTrack(db, t.id) }), true;
    }
    return false;
  }

  return { handle, trackFromLibrary, distractorsFor };
}

module.exports = { createAdminExtra };
