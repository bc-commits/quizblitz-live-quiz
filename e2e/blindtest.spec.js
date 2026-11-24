// Full browser scenario: admin renames the app and sets a logo, music library, a
// two-round blind test (artist-title then 6 choices x2), host screen + host remote,
// three phones in two teams, a reconnection, scoreboard, podium and report.
const { test, expect, devices } = require('@playwright/test');

const ADMIN = { email: 'admin@e2e.local', password: 'e2e-password-1234' };
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');
const SIX = ['Orchestre Pixel', 'Duo Modem', 'DJ Cassette', 'Les Synthés Rêveurs', 'Néon Club', 'Radio K7'];

test('admin, library, host, remote, three players in teams, podium and report', async ({ browser }) => {
  // ---------------------------------------------------------------- admin
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  await admin.goto('/admin');
  await admin.getByLabel('E-mail').fill(ADMIN.email);
  await admin.getByLabel('Mot de passe').fill(ADMIN.password);
  await admin.getByRole('button', { name: 'Se connecter' }).click();
  await expect(admin.getByRole('heading', { name: 'Tableau de bord' })).toBeVisible();

  // Rename the application
  await admin.goto('/admin#/settings/general');
  const nameField = admin.getByLabel('Nom public de l’application *');
  await nameField.fill('Le Grand Blind Test E2E');
  await admin.getByRole('button', { name: '💾 Enregistrer' }).click();
  await expect(admin.getByText(/Enregistré ✓/)).toBeVisible();

  // Upload a logo (file chooser) and save
  await admin.goto('/admin#/settings/appearance');
  const chooser = admin.waitForEvent('filechooser');
  await admin.getByRole('button', { name: '⬆ Téléverser' }).first().click();
  await (await chooser).setFiles({ name: 'logo.png', mimeType: 'image/png', buffer: PNG });
  await expect(admin.getByText('Image téléversée — enregistrez pour l’appliquer')).toBeVisible();
  await admin.getByRole('button', { name: '💾 Enregistrer' }).click();
  await expect(admin.getByText(/Enregistré ✓/)).toBeVisible();
  const home = await adminCtx.newPage();
  await home.goto('/');
  await expect(home).toHaveTitle('Le Grand Blind Test E2E');
  await expect(home.locator('img.brand-logo')).toHaveAttribute('src', /^\/media\/[a-f0-9]{32}\.png$/);
  await home.close();

  // Music library: one track through the form, the others through the API
  await admin.goto('/admin#/library/new');
  await admin.getByLabel('Titre *').fill('Valse binaire');
  await admin.getByLabel('Artiste *').fill('Orchestre Pixel');
  await admin.getByLabel('Année').fill('2025');
  await admin.getByRole('textbox', { name: 'Fichier ou URL audio' }).fill('/audio/demo-valse.wav');
  await admin.getByRole('button', { name: '💾 Enregistrer' }).click();
  await expect(admin.getByRole('heading', { name: 'Bibliothèque musicale' })).toBeVisible();
  const api = admin.request;
  const H = { 'X-QuizBlitz': '1' };
  for (const [title, artist] of [['Disco à 8 bits', 'DJ Cassette'], ['Arpèges du dimanche', 'Les Synthés Rêveurs'], ['Modem blues', 'Duo Modem']]) {
    expect((await api.post('/api/admin/library', { headers: H, data: { track: { title, artist, year: 2024, audioUrl: '/audio/demo-arpeges.wav' } } })).status()).toBe(201);
  }
  await admin.reload();
  await expect(admin.getByText('Valse binaire')).toBeVisible();
  const lib = await (await api.get('/api/admin/library?q=valse')).json();
  const valseId = lib.items[0].id;

  // Two-round blind test: artist-title from the library, then 6 choices worth x2
  const created = await (await api.post('/api/admin/blind-tests', { headers: H, data: { blindTest: {
    title: 'Blind test E2E', settings: { countdownDuration: 1, excerptDuration: 12, allowLateJoin: true, scoring: { preset: 'party' } },
    rounds: [
      { title: 'Artiste et titre', questionType: 'artist-title', tracks: [{ musicTrackId: valseId,
        artistAnswer: { mode: 'multiple-choice', choices: ['Orchestre Pixel', 'Duo Modem', 'DJ Cassette', 'Néon Club'] }, titleAnswer: { mode: 'free-text' } }] },
      { title: 'Finale à six', questionType: 'artist', pointsMultiplier: 2, tracks: [{ title: 'Disco à 8 bits', artist: 'DJ Cassette', audioUrl: '/audio/demo-disco.wav', choices: SIX, correctAnswer: 'DJ Cassette' }] },
    ] } } })).json();
  expect(created.id).toBeTruthy();

  // Launch with two automatic teams from the admin UI
  await admin.goto('/admin#/blindtests');
  await admin.locator('.item', { hasText: 'Blind test E2E' }).getByRole('button', { name: '▶ Lancer' }).click();
  await admin.getByLabel('Mode équipes').check();
  await admin.getByRole('dialog').getByRole('button', { name: 'Lancer', exact: true }).click();
  await admin.waitForURL(/\/host\?pin=\d{6}/);
  const host = admin;
  const pin = (await host.locator('#lobby-pin').textContent()).trim();
  expect(pin).toMatch(/^\d{6}$/);

  // ---------------------------------------------------------------- remote
  await host.getByRole('button', { name: '📱 Télécommande' }).first().click();
  const code = (await host.locator('#remote-code').textContent()).trim();
  expect(code).toMatch(/^[A-Z2-9]{8}$/);
  await host.getByRole('button', { name: 'Fermer' }).click();
  const remoteCtx = await browser.newContext({ ...devices['Pixel 7'] });
  const remote = await remoteCtx.newPage();
  await remote.goto(`/host/remote?pin=${pin}#code=${code}`);
  await expect(remote.locator('#r-title')).toHaveText('Blind test E2E');
  await expect(remote).toHaveURL(new RegExp(`/host/remote\\?pin=${pin}$`)); // code removed from the address bar

  // ---------------------------------------------------------------- three players
  const phones = [];
  for (const name of ['Ava', 'Ben', 'Cléo']) {
    const ctx = await browser.newContext({ ...devices['iPhone 13'] });
    const page = await ctx.newPage();
    await page.goto(`/play?pin=${pin}`);
    await page.getByLabel('Pseudo').fill(name);
    await page.getByRole('button', { name: 'C’est parti !' }).click();
    await expect(page.getByText('Vous êtes dans la partie !')).toBeVisible();
    await expect(page.locator('#team-badge')).toContainText('Équipe');
    phones.push({ name, ctx, page });
  }
  await expect(host.locator('#player-count')).toHaveText('3');
  await expect(host.locator('.team-col')).toHaveCount(2);

  // Start from the remote
  await remote.getByRole('button', { name: '▶ Lancer la partie' }).click();
  const [ava, ben, cleo] = phones.map((p) => p.page);

  // Track 1 (artist-title): full, partial, wrong
  await expect(ava.getByRole('heading', { name: 'Artiste' })).toBeVisible();
  await expect(host.locator('#q-audio-bar > div')).not.toHaveAttribute('style', /width: 0%/, { timeout: 10000 }); // the excerpt is playing on the host
  await expect(remote.locator('#r-current')).toContainText('Orchestre Pixel'); // answer only on the remote
  await expect(host.locator('body')).not.toContainText('Valse binaire');
  await ava.getByRole('button', { name: /Orchestre Pixel/ }).click();
  await ava.getByLabel('Titre').fill('valse BINAIRE');
  await ava.getByRole('button', { name: 'Valider ma réponse' }).click();
  await ben.getByRole('button', { name: /Orchestre Pixel/ }).click();
  await ben.getByRole('button', { name: 'Valider ma réponse' }).click();
  await cleo.getByRole('button', { name: /Duo Modem/ }).click();
  await cleo.getByRole('button', { name: 'Valider ma réponse' }).click();
  await expect(ava.locator('#r-title')).toHaveText('Bonne réponse !');
  await expect(ben.locator('#r-title')).toHaveText('En partie juste !');
  await expect(cleo.locator('#r-title')).toHaveText('Mauvaise réponse');
  await expect(host.locator('.track-card')).toContainText('Valse binaire');

  // Ben's phone reloads (sleep / network loss): the result comes back
  await ben.reload();
  await expect(ben.locator('#r-title')).toHaveText('En partie juste !');

  // Scoreboard then next track from the remote
  await remote.getByRole('button', { name: '🏆 Afficher le classement' }).click();
  await expect(host.getByRole('heading', { name: 'Classement', exact: true })).toBeVisible();
  await expect(host.locator('.team-board li')).toHaveCount(2);
  await remote.getByRole('button', { name: '⏭ Morceau suivant' }).click();

  // Track 2: six choices, x2
  await expect(ava.locator('#a-buttons button')).toHaveCount(6);
  await expect(ava.locator('#a-round')).toContainText('POINTS x2');
  await ava.getByRole('button', { name: /DJ Cassette/ }).click();
  await ben.getByRole('button', { name: /DJ Cassette/ }).click();
  await cleo.getByRole('button', { name: /Radio K7/ }).click();
  await expect(ava.locator('#r-points')).toContainText('(x2)');
  await remote.getByRole('button', { name: '🏆 Afficher le classement' }).click();
  await remote.getByRole('button', { name: '🏁 Résultats finaux' }).click();

  // Podium
  await expect(host.locator('#s-end')).toBeVisible();
  await expect(host.locator('.podium .slot')).toHaveCount(3);
  await expect(host.locator('.podium .p1')).toContainText('Ava', { timeout: 15000 });
  await expect(ava.locator('#f-rank')).toHaveText('1er sur 3');
  await expect(ava.locator('#f-team')).toContainText('équipes');

  // Report
  const reports = await (await api.get('/api/reports')).json();
  const reportId = reports.reports[0].id;
  const reportPage = await adminCtx.newPage();
  await reportPage.goto(`/admin#/reports/${reportId}`);
  await expect(reportPage.getByRole('heading', { name: 'Rapport : Blind test E2E' })).toBeVisible();
  await expect(reportPage.getByText('Faits marquants')).toBeVisible();
  await expect(reportPage.locator('.report-table').first()).toContainText(/Rouges|Bleus/);

  for (const c of [adminCtx, remoteCtx, ...phones.map((p) => p.ctx)]) await c.close();
});
