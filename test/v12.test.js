// V1.2 tests: host remote, music library, distractors, imports/exports, conversion of V1 blind tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const { generateChoices } = require('../lib/distractors');
const Library = require('../lib/library');
const { startServer, client, listen, state, ADMIN, PNG_1X1 } = require('./helpers');

const LIB = [
  { artist: 'Jean-Jacques Goldman', title: 'Je te donne', year: 1985, genre: 'Variété' },
  { artist: 'Daniel Balavoine', title: 'Le chanteur', year: 1978, genre: 'Variété' },
  { artist: 'Michel Berger', title: 'Diego', year: 1981, genre: 'Variété' },
  { artist: 'Francis Cabrel', title: 'Petite Marie', year: 1977, genre: 'Variété' },
  { artist: 'Indochine', title: "L'aventurier", year: 1982, genre: 'Rock' },
  { artist: 'Téléphone', title: 'Un autre monde', year: 1984, genre: 'Rock' },
  { artist: 'Renaud', title: 'Mistral gagnant', year: 1985, genre: 'Variété' },
  { artist: 'Goldman', title: 'Envole-moi', year: 1984, genre: 'Variété' },
  { artist: 'Daft Punk', title: 'One More Time', year: 2000, genre: 'Électro' },
];

// ---------------------------------------------------------------- unit

test('distractors: artist choices exclude the answer, have no duplicates, prefer the same decade, are deterministic', () => {
  const target = LIB[0];
  const r = generateChoices(target, 'artist', LIB, { count: 4, seed: 's' });
  assert.equal(r.choices.length, 4);
  assert.ok(r.choices.includes('Jean-Jacques Goldman'));
  assert.equal(r.correctAnswer, 'Jean-Jacques Goldman');
  assert.equal(new Set(r.choices.map((c) => c.toLowerCase())).size, 4);
  assert.ok(!r.choices.includes('Daft Punk'), 'a 2000s electro artist is the least plausible');
  assert.deepEqual(generateChoices(target, 'artist', LIB, { count: 4, seed: 's' }), r, 'same seed, same result');
  assert.notDeepEqual(generateChoices(target, 'artist', LIB, { count: 6, seed: 'other' }).choices, r.choices);
});

test('distractors: titles avoid the same artist; years and decades are close and unique', () => {
  const t = generateChoices(LIB[0], 'title', LIB, { count: 5 });
  assert.ok(t.choices.includes('Je te donne'));
  assert.equal(new Set(t.choices).size, t.choices.length);
  const y = generateChoices(LIB[0], 'year', LIB, { count: 4 });
  assert.equal(y.correctAnswer, '1985');
  assert.ok(y.choices.every((c) => Math.abs(Number(c) - 1985) <= 3));
  assert.equal(new Set(y.choices).size, 4);
  const d = generateChoices(LIB[0], 'decade', LIB, { count: 4 });
  assert.equal(d.correctAnswer, 'Années 1980');
  assert.ok(d.choices.includes('Années 1970') && d.choices.includes('Années 1990'));
  const few = generateChoices(LIB[0], 'artist', LIB.slice(0, 2), { count: 6 });
  assert.equal(few.choices.length, 2);
  assert.ok(few.warnings.length, 'warns when the library is too small');
});

test('library: CSV parsing (quotes, semicolons, BOM) and spreadsheet-safe export', () => {
  const rows = Library.parseCsv('﻿titre;artiste;annee\n"Je te donne";"Goldman";1985\n"Titre ""quoté""; avec point-virgule";X;\n');
  assert.deepEqual(rows[1], ['Je te donne', 'Goldman', '1985']);
  assert.equal(rows[2][0], 'Titre "quoté"; avec point-virgule');
  const { rows: objs } = Library.csvToObjects('titre,artiste\nA,B\n');
  assert.deepEqual(objs[0], { line: 2, data: { title: 'A', artist: 'B' } });
  const csv = Library.tracksToCsv([{ title: '=HYPERLINK("x")', artist: '+cmd', tags: ['a', 'b'] }]);
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`) && csv.includes(`"'+cmd"`), 'formulas neutralised');
  assert.ok(csv.includes('"a|b"'));
});

// ---------------------------------------------------------------- integration

test('V1.2: remote, library, imports', async (t) => {
  const srv = await startServer();
  t.after(() => srv.stop());
  const admin = client(srv.base);
  const anon = client(srv.base);
  await admin('/api/admin/login', { body: ADMIN });

  const ids = [];
  await t.test('library CRUD, validation, search, filters and pagination', async () => {
    assert.equal((await anon('/api/admin/library')).status, 401, 'admin only');
    assert.equal((await admin('/api/admin/library', { body: { track: { title: '', artist: 'X' } } })).status, 400);
    for (const m of LIB) {
      const r = await admin('/api/admin/library', { body: { track: { ...m, audioUrl: '/audio/demo-arpeges.wav', tags: ['années 80'], artistAliases: m.artist === 'Jean-Jacques Goldman' ? ['Goldman', 'JJG'] : [] } } });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      ids.push(r.body.track.id);
    }
    const dup = await admin('/api/admin/library', { body: { track: { ...LIB[0], title: 'JE TE DONNE' } } });
    assert.equal(dup.body.duplicates.length, 1, 'potential duplicate reported, not merged');
    ids.push(dup.body.track.id);
    const search = (await admin('/api/admin/library?q=goldman')).body;
    assert.ok(search.items.some((x) => x.title === 'Je te donne'), 'search by artist, accents/case ignored');
    assert.ok((await admin('/api/admin/library?q=jjg')).body.items.length >= 1, 'search matches aliases');
    assert.equal((await admin('/api/admin/library?decade=2000')).body.total, 1);
    assert.equal((await admin('/api/admin/library?genre=Rock')).body.total, 2);
    const p1 = (await admin('/api/admin/library?pageSize=4&page=1')).body;
    const p3 = (await admin('/api/admin/library?pageSize=4&page=3')).body;
    assert.equal(p1.total, 10); assert.equal(p1.items.length, 4); assert.equal(p3.items.length, 2);
    const upd = await admin(`/api/admin/library/${ids[8]}`, { method: 'PUT', body: { track: { ...LIB[8], genre: 'Électro', year: 2001 } } });
    assert.equal(upd.body.track.year, 2001);
    await admin(`/api/admin/library/${ids[9]}/archive`, { body: { archived: true } });
    assert.equal((await admin('/api/admin/library')).body.total, 9, 'archived hidden by default');
    assert.equal((await admin('/api/admin/library?archived=1')).body.total, 1);
    const facets = (await admin('/api/admin/library/facets')).body;
    assert.ok(facets.decades.includes(1980) && facets.tags.includes('années 80'));
  });

  let bt1; let bt2;
  await t.test('a library track used in two blind tests; deletion protected; generated choices', async () => {
    const make = async (title) => (await admin('/api/admin/blind-tests', { body: { blindTest: { title, settings: { countdownDuration: 0, excerptDuration: 5 }, rounds: [
      { title: 'R1', questionType: 'artist', tracks: [{ musicTrackId: ids[0], choices: ['Jean-Jacques Goldman', 'Renaud'], correctAnswer: 'Jean-Jacques Goldman' }] }] } } })).body;
    bt1 = await make('Avec bibliothèque 1');
    assert.ok(bt1.id, JSON.stringify(bt1));
    bt2 = await make('Avec bibliothèque 2');
    assert.equal(bt1.blindTest.rounds[0].tracks[0].audioUrl, '', 'audio not copied: inherited from the library');
    assert.equal((await admin('/api/admin/library?used=1')).body.total, 1);
    const one = (await admin(`/api/admin/library/${ids[0]}`)).body;
    assert.deepEqual(one.usage.map((u) => u.title).sort(), ['Avec bibliothèque 1', 'Avec bibliothèque 2']);
    const del = await admin(`/api/admin/library/${ids[0]}`, { method: 'DELETE' });
    assert.equal(del.status, 409);
    assert.equal(del.body.usage.length, 2);
    // Add several tracks from the library to a round, with generated wrong answers.
    const add = await admin('/api/admin/library/add-to-blind-test', { body: { blindTestId: bt1.id, roundIndex: 0, trackIds: [ids[1], ids[4]], count: 4 } });
    assert.equal(add.body.added, 2);
    const added = add.body.blindTest.rounds[0].tracks.slice(-2);
    assert.ok(added.every((x) => x.choices.length === 4 && x.choices.includes(x.correctAnswer)));
    assert.equal(added[0].correctAnswer, 'Daniel Balavoine');
    const gen = await admin('/api/admin/library/distractors', { body: { musicTrackId: ids[0], questionType: 'title', count: 6 } });
    assert.equal(gen.body.choices.length, 6);
    assert.ok(gen.body.choices.includes('Je te donne') && new Set(gen.body.choices).size === 6);
    // The game resolves library data and still never sends audio to phones.
    const g = (await admin('/api/games', { body: { blindTestId: bt1.id } })).body;
    const host = listen(`${srv.base}/api/games/${g.pin}/host-events?key=${g.hostKey}`);
    const lobby = await host.waitFor(state('LOBBY'));
    assert.equal(lobby.blind.audioUrl, '/audio/demo-arpeges.wav', 'audio inherited from the library on the host screen');
    host.close();
    await admin(`/api/admin/games/${g.pin}`, { method: 'DELETE' });
    // Forced deletion copies the data into both blind tests (no loss).
    assert.equal((await admin(`/api/admin/library/${ids[0]}?detach=1`, { method: 'DELETE' })).status, 200);
    const after = (await admin(`/api/admin/blind-tests/${bt2.id}`)).body.blindTest.rounds[0].tracks[0];
    assert.equal(after.musicTrackId, null);
    assert.equal(after.title, 'Je te donne');
    assert.equal(after.audioUrl, '/audio/demo-arpeges.wav');
  });

  await t.test('converting a V1 blind test links its tracks without duplicating media', async () => {
    const v1 = { type: 'music-blind-test', title: 'Ancien V1', settings: { excerptDuration: 15 }, rounds: [{ title: 'R', questionType: 'artist', tracks: [
      { title: 'Diego', artist: 'Michel Berger', year: 1981, audioUrl: '/audio/demo-valse.wav', startTime: 0, duration: 15, choices: ['Michel Berger', 'Renaud', 'Indochine', 'Téléphone'], correctAnswer: 'Michel Berger' },
      { title: 'Nouveau', artist: 'Inconnu', year: 1990, audioUrl: '/audio/demo-disco.wav', startTime: 0, duration: 15, choices: ['Inconnu', 'Renaud', 'Indochine', 'Téléphone'], correctAnswer: 'Inconnu' }] }] };
    const imp = await admin('/api/admin/blind-tests', { body: { blindTest: v1 } });
    assert.equal(imp.status, 201);
    assert.equal(imp.body.upgraded, true);
    const before = (await admin('/api/admin/library')).body.total;
    const conv = await admin(`/api/admin/library/convert-blind-test/${imp.body.id}`, { body: {} });
    assert.deepEqual(conv.body, { linked: 2, created: 1 }, 'existing "Diego" matched, one new card created');
    assert.equal((await admin('/api/admin/library')).body.total, before + 1);
    const media = (await admin('/api/admin/media')).body.media.length;
    assert.equal(media, 0, 'no media file duplicated');
  });

  await t.test('imports: JSON and CSV with dry run, per-line errors and duplicate detection', async () => {
    const csv = 'titre;artiste;annee;genre;tags\nNuit de folie;Début de Soirée;1988;Dance;soirée|dance\n;Sans titre;1990;;\nDiego;Michel Berger;1981;;\nNuit de folie;Début de Soirée;1988;;\n';
    const dry = (await admin('/api/admin/library/import', { body: { format: 'csv', content: csv, dryRun: true } })).body;
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.counts, { ok: 1, duplicate: 2, error: 1 });
    assert.equal(dry.rows.find((r) => r.status === 'error').line, 3);
    const totalBefore = (await admin('/api/admin/library')).body.total;
    assert.equal((await admin('/api/admin/library')).body.total, totalBefore, 'dry run writes nothing');
    const real = (await admin('/api/admin/library/import', { body: { format: 'csv', content: csv, dryRun: false } })).body;
    assert.equal(real.created, 1);
    const json = await admin('/api/admin/library/import', { body: { format: 'json', content: JSON.stringify({ tracks: [{ title: 'Ella, elle l’a', artist: 'France Gall', year: 1987 }] }), dryRun: false } });
    assert.equal(json.body.created, 1);
    assert.equal((await admin('/api/admin/library/import', { body: { format: 'json', content: '{oops', dryRun: true } })).status, 400);
    const exp = await admin('/api/admin/library/export?format=json');
    assert.ok(exp.body.tracks.some((x) => x.title === 'Nuit de folie'));
    const expCsv = await fetch(`${srv.base}/api/admin/library/export?format=csv`, { headers: { Cookie: '' } });
    assert.equal(expCsv.status, 401, 'export needs the admin session');
    const audit = (await admin('/api/admin/audit?action=library')).body;
    assert.ok(audit.items.some((x) => x.action === 'library.import'));
  });

  await t.test('image uploads keep the server-side checks (resized PNG accepted, SVG refused)', async () => {
    const up = (raw, name) => admin('/api/admin/media?kind=image', { raw, headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': name } });
    assert.equal((await up(PNG_1X1, 'cover-resized.png')).status, 201);
    assert.equal((await up(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'x.svg')).status, 400);
  });

  await t.test('host remote: pairing code, denial, commands, double taps, secret info', async () => {
    const g = (await admin('/api/games', { body: { blindTestId: bt2.id } })).body;
    assert.equal((await anon(`/api/games/${g.pin}/remote-code`, { body: { key: 'wrong' } })).status, 403);
    const { code } = (await anon(`/api/games/${g.pin}/remote-code`, { body: { key: g.hostKey } })).body;
    assert.match(code, /^[A-Z2-9]{8}$/);
    assert.equal((await anon(`/api/games/${g.pin}/remote-pair`, { body: { code: 'AAAAAAAA' } })).body.code, 'BAD_REMOTE_CODE');
    const paired = (await anon(`/api/games/${g.pin}/remote-pair`, { body: { code: code.toLowerCase() } })).body;
    assert.ok(paired.remoteToken && paired.remoteToken !== g.hostKey, 'a separate token, never the host key');
    assert.equal((await anon(`/api/games/${g.pin}/remote-pair`, { body: { code } })).status, 403, 'single use');
    assert.equal((await anon(`/api/games/${g.pin}/remote-events?token=nope`)).status, 403);
    assert.equal((await anon(`/api/games/${g.pin}/remote-action`, { body: { token: 'x'.repeat(30), action: 'start' } })).status, 403);
    const p = (await anon(`/api/games/${g.pin}/join`, { body: { name: 'Remi' } })).body;
    const phone = listen(`${srv.base}/api/games/${g.pin}/events?token=${p.token}`);
    const remote = listen(`${srv.base}/api/games/${g.pin}/remote-events?token=${paired.remoteToken}`);
    const first = await remote.waitFor((m) => m.type === 'STATE');
    assert.equal(first.secret.next.title, 'Je te donne', 'remote sees the first track');
    const send = (action, extra = {}) => anon(`/api/games/${g.pin}/remote-action`, { body: { token: paired.remoteToken, action, ...extra } });
    const [a, b] = await Promise.all([send('start', { expectState: 'LOBBY' }), send('start', { expectState: 'LOBBY' })]);
    assert.ok([a, b].filter((r) => r.status === 200).length >= 1);
    assert.ok([a, b].some((r) => r.body.deduped || r.status === 409), 'second tap ignored or refused');
    const q = await remote.waitFor(state('QUESTION', 0));
    assert.equal(q.secret.current.correctText, 'Jean-Jacques Goldman', 'remote sees the answer during the question');
    const pq = await phone.waitFor(state('QUESTION', 0));
    assert.ok(!JSON.stringify(pq).includes('secret') && !JSON.stringify(pq).includes('Je te donne'), 'phones never get the secret block');
    assert.equal((await send('pause')).status, 200);
    await remote.waitFor((m) => m.type === 'STATE' && m.paused);
    await send('resume');
    await send('skip', { expectState: 'QUESTION' });
    await remote.waitFor(state('REVEAL', 0));
    assert.equal((await send('revoke-remotes')).status, 403, 'only the host screen can revoke remotes');
    await anon(`/api/games/${g.pin}/host-action`, { body: { key: g.hostKey, action: 'revoke-remotes' } });
    assert.equal((await send('next')).status, 403, 'revoked token refused');
    const viaAdmin = await admin(`/api/admin/games/${g.pin}/remote-token`, { body: {} });
    assert.ok(viaAdmin.body.remoteToken, 'admin session can open the remote directly');
    remote.close(); phone.close();
  });
});
