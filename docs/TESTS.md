# Tests

```bash
npm test                 # 75 tests node:test (unitaires + serveur réel), ≈ 2 min
npm run test:unit        # unitaires seuls (< 1 s)
npm run test:integration # serveur réel + anciens tests API
npm run test:e2e         # scénario navigateur Playwright (Chromium)
npm run lint             # syntaxe de tous les fichiers JS + absence de marque codée en dur
npm run build            # lint + génération de .vercel/output (avec BACKEND_URL)
```

Les tests d’intégration démarrent `server.js` sur un port libre avec un dossier de données temporaire ; ils ne touchent pas `data/`.
Le scénario Playwright démarre son propre serveur (port 3456) ; il nécessite `npm install` puis `npx playwright install chromium` (dépendance de développement uniquement : la production reste sans dépendance).

## Fichiers

| Fichier | Couverture |
|---|---|
| `test/unit.test.js` | scoring historique, format, paramètres et thème, signatures de fichiers, Range, instantanés de partie |
| `test/v11.unit.test.js` | QCM à 2, 4 et 8 choix ; refus de 1 et 9 ; doublons (accents compris) ; bonne réponse absente ; types artist, title, year, decade, custom ; artist-title (forme `answers`, réponses partielles, jugement par partie) ; presets classic, competitive, party, relaxed ; scoring personnalisé (points négatifs, bornes) ; règle de série partielle ; multiplicateurs x1, x2, x3 et bornes ; priorité morceau > manche > blind test > application ; conversion V1 sans modifier l’entrée ; saisie libre (casse, accents, alias, articles, apostrophes, fautes limitées, refus) ; artiste + titre mixte sans fuite vers les téléphones |
| `test/integration.test.js` | non-régression V1 : admin, marque dynamique, logo, blind tests, partie, QR, PIN, SSE, pause, reconnexion, rafraîchissement de l’animateur, redémarrage du backend, deux parties simultanées, expiration |
| `test/legacy.test.js` | anciens scripts `e2e.js` et `features.js` : 9 types de quiz historiques, comptes, bibliothèque de quiz, rapports, CSV |
| `test/v11.integration.test.js` | partie avec artist-title (points partiels), 8 choix, x2 ; commande périmée refusée (double appui) ; semi-auto ; automatique avec pause et reprise ; **reprise de l’enchaînement automatique après redémarrage** ; changement de mode en cours de partie |
| `test/v12.test.js` | distracteurs (exclusion de la bonne réponse, sans doublon, déterministes, même décennie privilégiée, années et décennies) ; CSV (guillemets, `;`, BOM, neutralisation des formules) ; bibliothèque (CRUD, validation, recherche avec alias, filtres, pagination, archivage) ; un morceau dans deux blind tests ; suppression refusée puis détachement sans perte ; ajout groupé avec propositions générées ; audio hérité sur l’écran animateur ; conversion d’un blind test V1 sans dupliquer de média ; imports JSON et CSV (simulation, erreurs par ligne, doublons) ; contrôles serveur des images conservés ; télécommande (code unique, refus, jeton distinct, double appui, infos secrètes absentes des téléphones, révocation, ouverture admin) |
| `test/v13.test.js` | équipes 2 à 8, affectation équilibrée, sum, average, top-n ; choix au lobby, affectation par l’animateur, verrouillage, arrivée tardive ; saisie libre en partie (casse, accents, alias, faute tolérée, refus) ; artiste QCM + titre libre x2 ; validation manuelle d’une réponse proche (et pas deux fois) ; rapport global, par morceau, faits marquants, équipes ; exports CSV et JSON ; CSV neutralisé ; journal d’audit (IP seulement pour les échecs, aucun secret) ; aucun secret dans les logs ; données du tableau de bord |
| `test/migration.test.js` | base au schéma V1 avec données → démarrage → rien de perdu, nouvelles tables présentes, colonnes conservées, blind test V1 jouable, réenregistrement en format 2, redémarrage idempotent |
| `e2e/blindtest.spec.js` | navigateur : admin renomme l’application et téléverse un logo, fiche de bibliothèque créée via le formulaire, blind test en 2 manches (artiste + titre depuis la bibliothèque, puis 6 propositions x2), lancement en équipes depuis l’admin, écran animateur avec l’extrait en lecture (Chromium, son coupé), télécommande associée par code, 3 téléphones, réponses juste / partielle / fausse, rechargement d’un téléphone, classement des équipes, podium, rapport |

## Non couvert automatiquement

- Lecture audio réelle sur iPhone / Android (le son n’est jamais joué sur les téléphones), et rendu sur un vrai vidéoprojecteur.
- Redimensionnement des images par Canvas : il s’exécute dans le navigateur ; seuls les contrôles serveur sont testés automatiquement.
- Déploiement réel sur Railway et Vercel.
