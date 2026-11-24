# Modes de jeu (V1.1 → V1.3)

## Types de questions

| Type | Question affichée par défaut | Réponse attendue (par défaut) |
|---|---|---|
| `artist` | Qui interprète ce morceau ? | l’artiste du morceau |
| `title` | Quel est le titre de ce morceau ? | le titre |
| `artist-title` | Trouvez l’artiste et le titre ! | deux réponses indépendantes : artiste et titre |
| `year` | En quelle année est sorti ce morceau ? | l’année (ex. « 1985 ») |
| `decade` | De quelle décennie date ce morceau ? | « Années 1980 » |
| `custom` | Quelle est la bonne réponse ? | celle que vous indiquez |

Chaque réponse est soit un **QCM de 2 à 8 propositions** (une seule correcte, sans doublon après normalisation), soit une **saisie libre**.
Pour `artist-title`, l’artiste et le titre ont chacun leur mode : QCM + QCM, QCM + saisie libre, saisie libre + QCM, ou deux saisies libres.
Le joueur peut ne répondre qu’à une des deux parties.

## Saisie libre

Le serveur normalise la réponse : accents, majuscules, apostrophes, tirets, ponctuation simple et espaces multiples sont ignorés.
Selon les réglages de la réponse :
- **variantes acceptées** (alias), ex. « Goldman », « JJ Goldman » ; les alias de la fiche de bibliothèque sont ajoutés automatiquement ;
- **ignorer les articles** (activé par défaut) : le, la, les, l’, un, une, des, du, de, the, a, an en début de réponse ;
- **tolérance aux fautes** (désactivée par défaut) : distance d’édition ≤ 1 à partir de 6 caractères, ≤ 2 à partir de 12 caractères, jamais plus.

Une réponse juste en dehors de la tolérance (une modification de trop, réponse d’au moins 4 caractères) est marquée « proche ».
Pendant la révélation, la **télécommande** liste ces réponses : l’animateur peut les **accepter**. Le joueur reçoit alors les points de base de la partie concernée × multiplicateur, sans bonus de rapidité ; sa série n’est pas modifiée. L’action est inscrite au journal d’audit.

L’éditeur permet de tester une réponse de joueur : texte normalisé, accepté ou refusé, et règle appliquée (`exact`, `alias`, `articles`, `typo`).

## Scoring

Source unique : `lib/scoring.js`. Le client n’envoie jamais de points, de temps ni de multiplicateur.

| Preset | Bonne réponse | Artiste / titre | Rapidité max | Série |
|---|---|---|---|---|
| `classic` | 1 000 | 500 / 500 | 0 | non |
| `competitive` (défaut) | 500 | 250 / 250 | 500 | +100 par réponse, plafond +500 |
| `party` | 500 | 500 / 500 | 250 | +50 par réponse, plafond +250 |
| `relaxed` | 1 | 1 / 1 | 0 | non |
| `custom` | `correctPoints` | `artistPoints` / `titlePoints` | `speedBonusMax` | `streakStep`, `streakMax` |

`custom` accepte aussi `wrongAnswerPoints` et `noAnswerPoints` (négatifs possibles, de −10 000 à 10 000).

- **Rapidité** : `speedBonusMax × (1 − temps/durée) × part juste`. Le temps est mesuré par le serveur depuis l’ouverture officielle des réponses ; les pauses ne comptent pas.
- **Série** : toutes les parties justes → la série augmente et le bonus vaut `min((série − 1) × streakStep, streakMax)`. Réponse **partiellement** juste → la série est conservée mais n’augmente pas, sans bonus. Tout faux ou sans réponse → la série retombe à 0.
- **Multiplicateur** (x1, x2 « QUESTION BONUS », x3 « FINALE », ou personnalisé de x1 à x5) : appliqué en dernier, sur le total.

**Priorité des réglages** : morceau > manche > blind test > réglages du jeu (Administration › Paramètres › Jeu).
Le quiz classique (9 types historiques) garde sa formule d’origine.

## Enchaînement

| Mode | Comportement |
|---|---|
| `manual` | l’animateur déclenche chaque étape |
| `semi-auto` | compte à rebours et fin d’extrait automatiques, puis révélation → classement automatique après `revealDuration` ; l’animateur lance le morceau suivant |
| `automatic` | en plus, classement → morceau suivant (ou podium) après `scoreboardDuration` |

Une durée de 0 désactive l’étape automatique correspondante. Le mode se règle sur le blind test ou la manche, et l’animateur peut le forcer pendant la partie (écran ou télécommande ; une confirmation est demandée pour « automatique »).
La prochaine étape est un horodatage serveur persisté (`autoAt`) : il survit au rafraîchissement de l’écran et au redémarrage du backend, et la pause le fige.

## Équipes

Options au lancement (Administration › Blind tests › ▶ Lancer) :
- **2 à 8 équipes**, noms personnalisables (sinon Rouges, Bleus, Jaunes…) ;
- **affectation** : automatique équilibrée (toujours dans l’équipe la moins nombreuse), choix libre au lobby, ou par l’animateur (menu sur chaque joueur du lobby) ;
- **verrouillage** au lancement (par défaut) ;
- **score d’équipe** :
  - `sum` : somme des scores, recommandée avec l’affectation automatique ;
  - `average` : moyenne des membres, recommandée sinon, car elle limite l’avantage des grandes équipes ;
  - `top-n` : somme des N meilleurs.

Au lancement, les joueurs sans équipe sont placés automatiquement. Un joueur qui arrive en cours de partie rejoint l’équipe la moins nombreuse et part de 0 : en `sum` il ne fait pas baisser son équipe, en `average` il la fait baisser jusqu’à ce qu’il marque.
Le score individuel est toujours conservé. Classements individuel et par équipes à l’écran ; équipe, rang de l’équipe et score sur le téléphone ; meilleur joueur par équipe dans le rapport.

## Non disponible

Le mode **buzzer** n’est pas implémenté (voir `PLAN_EVOLUTION.md`).
