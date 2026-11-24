# Rapports

## Rapport blind test (Administration › Historique, ou Tableau de bord › Rapport)

Adresse : `/admin#/reports/<id>`. API : `GET /api/admin/reports/<id>` (`?format=csv` ou `?format=json`). **Session administrateur obligatoire.**

**Statistiques globales** : participants, morceaux joués, réponses, taux de réponse, taux de bonnes réponses, temps moyen, durée, reconnexions.

**Par morceau** : taux de reconnaissance (tout juste), taux artiste et taux titre (questions artiste + titre), temps moyen, absences de réponse, mauvaises réponses les plus fréquentes, difficulté observée (facile ≥ 70 %, moyen ≥ 35 %, difficile en dessous).

**Faits marquants** :
- podium ;
- meilleure série ;
- réponse juste la plus rapide ;
- plus forte progression (rang après le premier morceau comparé au rang final) ;
- joueur le plus régulier (le plus de bonnes réponses, puis le temps moyen le plus court) ;
- équipe gagnante et meilleur joueur par équipe ;
- morceaux le mieux et le moins reconnus.

**Exports** : CSV (cellules commençant par `=`, `+`, `-`, `@` neutralisées) et JSON. **Impression** : bouton 🖨 ; la feuille de style d’impression masque la navigation.

Le rapport historique « par question » (`/reports?id=…`, commun avec le quiz classique) reste disponible.

## Données enregistrées

À la fin d’une partie : le contenu du blind test joué, les joueurs (score, rang, équipe, nombre de reconnexions), chaque réponse (valeur, juste ou non, points, temps serveur) et, pour les blind tests, le détail par partie (`answers.detail_json` : artiste / titre justes ou non). Les équipes et la méthode de calcul sont dans `games.teams_json`.

## Tableau de bord temps réel

Interrogation toutes les 8 secondes, seulement tant que la page est ouverte :
- parties actives (phase, réponses reçues, joueurs connectés et déconnectés temporairement, équipes) ;
- serveur : durée de fonctionnement, mémoire, version de Node, nombre et taille des médias, espace disque libre du dossier de données (si le système le permet) ;
- dernières erreurs serveur (message seulement, 20 au maximum, en mémoire).
