# Format « music-blind-test » (schemaVersion 2)

Un blind test est un document JSON. Exemple importable : `public/exemples/blindtest-demo.json`
(format V1, accepté tel quel). Les fichiers V1 restent importables ; voir « Compatibilité » en bas de page.

```json
{
  "schemaVersion": 2,
  "type": "music-blind-test",
  "id": "blindtest-annees-80",
  "title": "Blind Test Années 80",
  "description": "30 morceaux emblématiques",
  "settings": {
    "answerMode": "multiple-choice",
    "countdownDuration": 3,
    "excerptDuration": 20,
    "revealDuration": 8,
    "scoreboardDuration": 8,
    "allowLateJoin": true,
    "allowAnswerChange": false,
    "shuffleChoices": false,
    "flowMode": "manual",
    "scoring": { "preset": "competitive" }
  },
  "rounds": [
    {
      "id": "round-2",
      "title": "Artiste et titre",
      "description": "Deux réponses par morceau",
      "questionType": "artist-title",
      "scoringPreset": "party",
      "trackDuration": 20,
      "countdownDuration": 3,
      "revealDuration": 8,
      "scoreboardDuration": 6,
      "pointsMultiplier": 1,
      "automaticMode": "semi-auto",
      "tracks": [
        {
          "id": "track-001",
          "musicTrackId": "music-1a2b3c4d5e",
          "title": "Je te donne",
          "artist": "Jean-Jacques Goldman",
          "year": 1985,
          "audioUrl": "/media/3f2a…e1.mp3",
          "coverUrl": "",
          "startTime": 42,
          "duration": 20,
          "pointsMultiplier": 2,
          "artistAnswer": { "mode": "free-text", "aliases": ["Goldman", "JJ Goldman"], "typoTolerance": true },
          "titleAnswer": { "mode": "multiple-choice", "choices": ["Je te donne", "Envole-moi", "Encore un matin", "Il suffira d’un signe"], "correctAnswer": "Je te donne" },
          "notes": "Couplet 2"
        }
      ]
    }
  ]
}
```

## Racine

| Champ | Règle |
|---|---|
| `schemaVersion` | 2 (absent ou 1 = ancien format, converti en mémoire) |
| `type` | `music-blind-test` s’il est présent |
| `id` | lettres, chiffres, `-`, `_` ; généré s’il manque ; à l’import, un `id` existant est remplacé (jamais d’écrasement) |
| `title` | **obligatoire**, 100 caractères |
| `description` | 500 caractères |

## `settings` (blind test)

| Champ | Défaut | Règle |
|---|---|---|
| `answerMode` | `multiple-choice` | mode par défaut des morceaux : `multiple-choice` ou `free-text` |
| `countdownDuration` | 3 | 0 à 10 s (minimum effectif 1 s) |
| `excerptDuration` | 20 | 5 à 120 s |
| `revealDuration`, `scoreboardDuration` | 8 | 0 à 60 s ; utilisées par les enchaînements semi-auto et auto (0 = pas d’étape automatique) |
| `allowLateJoin` | true | |
| `allowAnswerChange` | false | la dernière réponse avant la fermeture compte |
| `shuffleChoices` | false | mélange les propositions à chaque partie |
| `flowMode` | `manual` | `manual`, `semi-auto`, `automatic` |
| `scoring` | null (= réglages du jeu) | `{ "preset": "classic" \| "competitive" \| "party" \| "relaxed" \| "custom", ... }`, voir MODES_DE_JEU.md |
| `playAudioOnHostOnly` | true | toujours vrai |

## Manche (`rounds[]`, 1 à 20)

| Champ | Règle |
|---|---|
| `title`, `description` | 80 / 300 caractères |
| `questionType` | `artist` (défaut), `title`, `artist-title`, `year`, `decade`, `custom` |
| `scoringPreset` | nom de preset, ou objet de scoring complet ; vide = celui du blind test |
| `trackDuration`, `countdownDuration`, `revealDuration`, `scoreboardDuration` | vides = valeurs du blind test |
| `pointsMultiplier` | 1 à 5 (ou `normal`, `bonus` = 2, `finale` = 3) |
| `automaticMode` | `manual`, `semi-auto`, `automatic` ; vide = celui du blind test |

## Morceau (`tracks[]`, 200 au total)

| Champ | Règle |
|---|---|
| `musicTrackId` | fiche de bibliothèque ; les champs vides ci-dessous la reprennent |
| `title`, `artist` | **obligatoires** (ou hérités de la fiche) |
| `year` | entier 1800 à 2100 |
| `audioUrl` | **obligatoire** (ou hérité) : `/media/<hex>.(mp3\|m4a\|ogg\|wav)`, `/audio/…` ou `https://` |
| `coverUrl` | `/media/<hex>.(png\|jpg\|webp)`, `/covers/…` ou `https://` ; montrée à la révélation seulement |
| `startTime`, `duration` | vides = fiche, puis manche, puis blind test |
| `questionType` | surcharge celui de la manche |
| `question` | texte affiché personnalisé |
| `pointsMultiplier` | surcharge celui de la manche (x1 à x5) |
| `scoring` | surcharge de scoring (preset ou objet) |
| `countdownDuration`, `revealDuration`, `scoreboardDuration` | surcharges |
| `difficulty` | `easy`, `medium`, `hard` |
| `notes` | jamais envoyées aux joueurs ni à l’écran projeté (visibles sur la télécommande) |
| `lockedChoices` | propositions verrouillées dans l’éditeur |

### Réponse simple (artist, title, year, decade, custom)

| Champ | Règle |
|---|---|
| `answerMode` | `multiple-choice` ou `free-text` |
| `choices` | QCM : **2 à 8** propositions non vides, sans doublon (accents, majuscules et ponctuation ignorés) |
| `correctAnswer` | QCM : l’une des propositions (déduite de l’artiste, du titre, de l’année ou de la décennie si absente et présente dans les choix) ; saisie libre : réponse attendue (déduite pareillement si absente ; obligatoire pour `custom`) |
| `aliases` | saisie libre : variantes acceptées (20 au maximum) |
| `ignoreArticles` (défaut true), `typoTolerance` (défaut false) | réglages de la saisie libre |

### Réponse composée (artist-title)

`artistAnswer` et `titleAnswer` (ou la forme équivalente `answers: { artist, title }`), chacun :
`{ "mode": "multiple-choice" | "free-text", "choices": [...], "correctAnswer": "...", "aliases": [...], "ignoreArticles": true, "typoTolerance": false }`.
Sans `correctAnswer`, c’est l’artiste (ou le titre) du morceau qui est attendu.

## Validation

Côté serveur à chaque enregistrement et import (`POST /api/admin/blind-tests/validate` pour vérifier sans enregistrer). Les erreurs portent leur chemin (`rounds[1].tracks[0].titleAnswer.choices`). Des avertissements sont émis pour un mode inconnu, un multiplicateur ramené dans les bornes ou une URL audio qui semble contenir la réponse.

## Compatibilité avec la V1

- Un document sans `schemaVersion` (V1) est accepté. Valeurs par défaut appliquées : `flowMode: manual`, multiplicateur x1, scoring global, `answerMode: multiple-choice`. Les 4 choix V1 restent valides.
- La conversion se fait **en mémoire** : le document stocké n’est réécrit qu’au prochain enregistrement, et un fichier importé n’est jamais modifié. L’éditeur signale l’ancien format.
- L’export produit toujours le format 2.
- Dans le jeu, chaque morceau devient une question interne `blind` (parties de réponse). Le type `quiz` des parties V1 en cours reste supporté.
