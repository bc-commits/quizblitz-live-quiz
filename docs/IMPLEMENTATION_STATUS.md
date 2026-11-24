# État d'avancement V1.1 → V1.3

Branche : `feature/blind-test-v1.1-v1.3` · départ : `a80fd7c` (V1).

| Lot | État | Fichiers principaux |
|---|---|---|
| V1.1 choix 2–8, types artist / title / artist-title / year / decade / custom | ✅ testé | `lib/blindtest.js`, `questions.js` (type `blind`), `public/play.js`, `public/host.js`, `public/admin-editor.js` |
| V1.1 scoring (presets, custom), multiplicateurs, réglages par manche | ✅ testé | `lib/scoring.js`, `lib/blindtest.js` |
| V1.1 enchaînement manuel / semi-auto / auto | ✅ testé (y compris reprise après redémarrage) | `server.js` (`scheduleAuto`, `autoAt`) |
| V1.2 télécommande `/host/remote` | ✅ testé | `views/remote.html`, `public/remote.js`, `server.js` |
| V1.2 bibliothèque musicale | ✅ testé | `lib/library.js`, `lib/admin-extra.js`, `db.js`, `public/admin-library.js` |
| V1.2 distracteurs, imports / exports, redimensionnement des images | ✅ testé (Canvas : navigateur seulement) | `lib/distractors.js`, `public/admin-library.js` |
| V1.3 équipes | ✅ testé | `lib/teams.js`, `server.js`, `public/host.js`, `public/play.js` |
| V1.3 saisie libre, artiste + titre mixte, validation manuelle | ✅ testé | `lib/answers.js`, `questions.js`, `server.js` (`accept-answer`) |
| V1.3 rapports blind test, tableau de bord temps réel | ✅ testé | `lib/reports.js`, `public/admin.js` |
| V1.3 journal d'audit | ✅ testé | `db.js` (`audit_log`), `server.js` |
| Migration d'une base V1 | ✅ testé | `test/migration.test.js` |
| Test navigateur Playwright | voir le rapport final | `e2e/blindtest.spec.js`, `playwright.config.js` |
| Documentation | ✅ | `docs/*.md`, `README.md` |

Non réalisé (hors périmètre, voir `PLAN_EVOLUTION.md`) : buzzer, « précédent » (évité pour ne pas corrompre les scores), multi-instance, multi-marques, pilotes de stockage objet, PostgreSQL, 100 % serverless.

Commandes : `npm test`, `npm run test:e2e`, `npm run lint`, `npm run build`.
