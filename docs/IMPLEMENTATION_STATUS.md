# État d'avancement V1.1 → V1.3

Branche : `feature/blind-test-v1.1-v1.3` · départ : `a80fd7c` (V1).

| Lot | État | Fichiers principaux |
|---|---|---|
| V1.1 choix 2–8, types artist/title/artist-title/year/decade/custom | ✅ testé | `lib/blindtest.js`, `questions.js` (type `blind`), `public/play.js`, `public/host.js`, `public/admin-editor.js` |
| V1.1 scoring (presets, custom), multiplicateurs | ✅ testé | `lib/scoring.js` |
| V1.1 enchaînement manuel / semi-auto / auto | ✅ testé (restauration après redémarrage incluse) | `server.js` (`scheduleAuto`, `autoAt`) |
| V1.2 télécommande `/host/remote` | ✅ testé | `views/remote.html`, `public/remote.js`, `server.js` (remote-code / remote-pair / remote-events / remote-action) |
| V1.2 bibliothèque musicale | ✅ testé | `lib/library.js`, `lib/admin-extra.js`, `db.js` (`music_tracks`, `blind_test_tracks`), `public/admin-library.js` |
| V1.2 distracteurs, imports JSON/CSV, export, redimensionnement des images | ✅ testé (redimensionnement : côté navigateur, contrôles serveur testés) | `lib/distractors.js`, `public/admin-library.js` |
| V1.3 journal d'audit | ✅ testé (écriture) | `db.js` (`audit_log`), `server.js` (`auditLog`) |
| V1.3 équipes | à faire | |
| V1.3 saisie libre (moteur et éditeur prêts) | partiel : validation manuelle à brancher | |
| V1.3 rapports blind test, tableau de bord temps réel | à faire | |

Commandes : `npm test`, `npm run lint`, `npm run build`.
