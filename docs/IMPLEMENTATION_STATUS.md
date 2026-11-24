# État d'avancement V1.1 → V1.3

Branche : `feature/blind-test-v1.1-v1.3` · départ : `a80fd7c` (V1).

| Lot | État | Fichiers principaux |
|---|---|---|
| V1.1 choix 2–8, types artist/title/artist-title/year/decade/custom | ✅ testé | `lib/blindtest.js`, `questions.js` (type `blind`), `public/play.js`, `public/host.js`, `public/admin-editor.js` |
| V1.1 scoring (presets, custom), multiplicateurs | ✅ testé | `lib/scoring.js` |
| V1.1 enchaînement manuel / semi-auto / auto | ✅ testé (restauration après redémarrage incluse) | `server.js` (`scheduleAuto`, `autoAt`) |
| V1.2 télécommande | à faire | |
| V1.2 bibliothèque musicale | à faire | |
| V1.2 distracteurs, imports, images | à faire | |
| V1.3 équipes | à faire | |
| V1.3 saisie libre (moteur prêt et testé dans `lib/answers.js`) | partiel | |
| V1.3 rapports, tableau de bord, audit | à faire | |

Commandes : `npm test`, `npm run lint`, `npm run build`.
