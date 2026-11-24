# Bibliothèque musicale

Une fiche par morceau, réutilisable dans autant de blind tests que voulu, **sans dupliquer le fichier audio**.

## Modèle (`music_tracks`)

| Champ | Description |
|---|---|
| `id` | `music-xxxxxxxxxx` |
| `title`, `artist`, `year` (`decade` calculée), `genre` | métadonnées |
| `audio_url`, `cover_url` | fichier téléversé (`/media/…`), `public/audio`, `public/covers` ou lien https |
| `default_start`, `default_duration` | extrait par défaut |
| `artist_aliases`, `title_aliases` | variantes acceptées en saisie libre |
| `tags` | étiquettes libres (minuscules) |
| `notes` | notes internes |
| `archived` | masqué des listes, toujours utilisable |
| `norm_key` | artiste + titre + année normalisés (détection des doublons) |
| `search` | texte normalisé indexé pour la recherche |

La table `blind_test_tracks` (blind test, morceau, fiche, manche, position) est reconstruite à chaque enregistrement d’un blind test. Elle sert à compter les utilisations et à protéger les suppressions.

## Dans un blind test

Un morceau de blind test peut référencer une fiche (`musicTrackId`). Les champs laissés vides (titre, artiste, année, audio, pochette, début, durée) reprennent la fiche ; les champs remplis la surchargent. Le type de question, les propositions, la bonne réponse et le multiplicateur restent propres au blind test.

- **Ajouter depuis la bibliothèque** (éditeur, par manche) : recherche paginée, filtres décennie / genre / tag, sélection multiple, préécoute, début, durée, type de question et nombre de propositions ; les propositions sont générées automatiquement.
- **Ajout groupé** depuis la liste de la bibliothèque : cocher des morceaux, choisir un blind test et une manche.
- **Lier les morceaux à la bibliothèque** (éditeur d’un blind test V1 ou à morceaux intégrés) : chaque morceau est relié à une fiche existante (même artiste, titre et année) ou à une nouvelle fiche. Les fichiers audio ne sont pas copiés.

## Propositions générées (distracteurs)

Génération **par règles** (ce n’est pas de l’intelligence artificielle) :
- **artiste** : autres artistes de la bibliothèque, en privilégiant la même décennie, puis le même genre ;
- **titre** : titres d’autres artistes (ceux du même artiste sont exclus, car ils rendraient la réponse ambiguë), même décennie ou genre en priorité ;
- **année** : années proches (±1 à ±6), triées ;
- **décennie** : décennies voisines.

La bonne réponse est toujours incluse, sans doublon. Le résultat est déterministe (même morceau, même graine, même résultat) et il est **enregistré dans le blind test** : il ne change pas pendant une partie.
Dans l’éditeur : **🎲 Générer**, **↻ Autres propositions** (nouvelle graine), modification à la main, et **Verrouiller** (une confirmation est demandée avant tout remplacement). Si la bibliothèque est trop petite, un avertissement indique combien de propositions ont pu être produites.

## Administration

Liste paginée (50 par page) avec recherche (titre, artiste, genre, tag, alias), filtres (décennie, genre, tag, pochette, audio, utilisé ou non, archivés) et tris (artiste, titre, année, récents, plus utilisés). Chaque ligne affiche la pochette, le titre, l’artiste, l’année, l’extrait, le nombre de blind tests qui l’utilisent et l’état de l’audio.

Actions : créer, modifier, dupliquer (métadonnées seulement), archiver, supprimer.
**Suppression d’un morceau utilisé** : refusée par défaut, avec la liste des blind tests concernés. L’archivage est recommandé. Après confirmation explicite, la suppression « détache » le morceau : ses informations sont recopiées dans chaque blind test, qui continue de fonctionner. Le fichier audio n’est supprimé que s’il ne sert plus nulle part.

**Médias inutilisés** : fichiers qui ne servent ni aux paramètres, ni aux blind tests, ni à la bibliothèque.

## Import et export

- **Export** JSON (`{ "type": "music-library", "version": 1, "tracks": [...] }`) ou CSV (cellules neutralisées contre l’injection de formules).
- **Import** JSON ou CSV, 2 Mo et 2 000 lignes au maximum, **simulation par défaut** puis import réel. Rapport ligne par ligne : prêt / importé, doublon (même artiste, titre et année, dans la bibliothèque ou dans le fichier : jamais fusionné automatiquement), erreur avec motif.
- En-têtes CSV : `title, artist, year, genre, tags, artistAliases, titleAliases, audioUrl, coverUrl, defaultStartTime, defaultDuration, internalNotes` (`titre`, `artiste`, `annee`, `audio`, `pochette` acceptés). Les listes dans une cellule sont séparées par `|`. Le séparateur `,` ou `;` est détecté automatiquement.
- Les fichiers audio se téléversent séparément (Médias, ou fiche du morceau).

## Performance

Index sur `norm_key`, `(archived, artist)`, `decade`, `genre` et `blind_test_tracks(music_track_id)`. Recherche et pagination côté serveur : le navigateur ne charge jamais tout le catalogue. La génération de propositions lit seulement les colonnes légères (titre, artiste, année, genre).
