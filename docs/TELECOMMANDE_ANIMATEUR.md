# Télécommande animateur (`/host/remote`)

Un téléphone (celui de l’animateur) pilote la partie et voit les réponses, pendant que l’écran projeté reste sans indice.

## Association

1. Sur l’écran animateur : **📱 Télécommande** (lobby ou barre de commandes).
2. Un **QR code privé** s’affiche avec un **code à usage unique valable 5 minutes** (8 caractères).
3. Le téléphone scanne le QR code. Il peut aussi ouvrir `/host/remote`, puis saisir le PIN et le code.

Sécurité :
- la clé animateur permanente (`hostKey`) n’est **jamais** mise dans le QR code ;
- le code voyage dans le fragment d’URL (`#code=…`) : il n’est pas envoyé dans les requêtes ni écrit dans les journaux d’accès, et il est retiré de la barre d’adresse dès l’association ;
- le téléphone reçoit un **jeton de télécommande** distinct, stocké haché avec la partie (10 au maximum) et conservé seulement dans l’onglet (`sessionStorage`) ;
- **Révoquer les télécommandes** (sur l’écran animateur uniquement) invalide tous les jetons ;
- un administrateur connecté peut ouvrir la télécommande directement (« Ouvrir avec ma session administrateur ») ; l’action est journalisée ;
- les tentatives d’association sont limitées à 10 par minute et par IP.

## Écran

Nom de la partie, état de connexion, phase, enchaînement, réponses reçues, joueurs connectés, temps restant ; morceau en cours (titre, artiste, année, **bonne réponse**, notes internes) ; morceau suivant ; état de l’audio rapporté par l’écran animateur (lecture, pause, erreur, bloqué par le navigateur) ; réponses « proches » à valider pendant la révélation.

## Commandes

Lancer · Pause / Reprendre (y compris l’enchaînement automatique) · Fermer et révéler · Recommencer l’extrait · Afficher / masquer le classement · Morceau suivant / Résultats finaux · Débloquer · Terminer (avec confirmation) · changer l’enchaînement.

Chaque commande porte la phase pour laquelle elle a été pensée (`expectState`). Un double appui, ou l’écran et la télécommande qui appuient en même temps, ne fait pas sauter d’étape : la commande périmée est refusée, et une commande identique répétée dans les 800 ms est ignorée. Les boutons sont aussi désactivés pendant l’envoi.

**« Précédent » n’est pas proposé** : revenir à un morceau déjà noté obligerait à recalculer les scores et les séries. Seul « Masquer le classement » (retour à la révélation) est possible, car il ne touche pas aux points.

## Confidentialité

Les informations secrètes passent uniquement par le flux de la télécommande (`/remote-events`, jeton requis). L’écran animateur et les téléphones des joueurs ne les reçoivent jamais avant la révélation (vérifié par les tests).
