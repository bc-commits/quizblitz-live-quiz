# Migration V1 → V1.3

## Ce qui se passe au démarrage

Les migrations sont **automatiques et idempotentes** (`db.js`, au démarrage du serveur). Aucune table ni colonne n’est supprimée.

| Ajout | Rôle |
|---|---|
| table `music_tracks` + 4 index | bibliothèque musicale |
| table `blind_test_tracks` + index | utilisation des fiches par les blind tests |
| table `audit_log` + index | journal d’audit |
| `answers.detail_json` | détail artiste / titre de chaque réponse |
| `players.team_name`, `players.reconnects` | équipes et reconnexions dans les rapports |
| `games.teams_json` | équipes et méthode de calcul |
| index `players(game_id)` | rapports |

Comptes, sessions, paramètres, médias, quiz classiques, blind tests, historique et parties en cours sont conservés (vérifié par `test/migration.test.js` sur une base au schéma V1).

## Blind tests V1

- Ils sont lus tels quels : les champs absents reçoivent leurs valeurs par défaut (`schemaVersion` 2, enchaînement manuel, multiplicateur x1, scoring global, QCM).
- Le document stocké **n’est pas réécrit** tant qu’il n’est pas enregistré à nouveau. L’éditeur affiche alors « ancien format » et propose de l’enregistrer au nouveau format.
- Un fichier JSON V1 reste importable. Le fichier d’origine n’est jamais modifié ; l’export produit le nouveau format.
- Pour profiter de la bibliothèque : éditeur › **Lier les morceaux à la bibliothèque** (aucun média dupliqué).

## Parties en cours pendant la mise à jour

Les instantanés de parties V1 (questions de type `quiz`) restent compatibles : le type `quiz` est toujours supporté. Il est tout de même conseillé de **ne pas déployer pendant un événement**.

## Procédure (Railway, Fly, Render)

1. **Sauvegarder** `DATA_DIR` (base `quizblitz.db` + dossier `media`), ou faire un instantané du volume.
2. Déployer la nouvelle version (fusion de la branche dans la branche de production, ou nouvelle image).
3. Vérifier les logs : pas d’erreur au démarrage ; `GET /api/health` renvoie `ok`.
4. Ouvrir `/admin` : tableau de bord, blind tests, bibliothèque (vide au départ), journal d’audit.
5. Optionnel : définir `AUDIT_RETENTION_DAYS` (180 par défaut).
6. Vercel : rien à changer (même `BACKEND_URL`) ; redéployer pour publier les nouveaux fichiers statiques (`remote.js`, `admin-*.js`).

## Retour arrière (rollback)

- Les migrations n’ont fait qu’**ajouter** des tables et des colonnes : le code V1 fonctionne sur une base migrée (il ignore ce qu’il ne connaît pas).
- Les blind tests réenregistrés au format V2 restent lisibles par la V1 tant qu’ils n’utilisent que des QCM à 4 choix sans référence de bibliothèque. Les morceaux liés à la bibliothèque (`musicTrackId` sans titre ni audio intégrés), les QCM de 2 ou de 5 à 8 choix, artiste + titre et la saisie libre **ne sont pas jouables en V1**. Avant un retour arrière, utilisez la sauvegarde de l’étape 1 si ces fonctions ont servi.
- Procédure : redéployer le commit V1 (`a80fd7c`), ou restaurer l’instantané du volume si nécessaire.
