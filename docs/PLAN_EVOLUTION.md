# Plan d’évolution

## Réalisé

| Version | Fonction |
|---|---|
| V1 | administration, marque blanche, blind tests QCM, écran animateur avec audio, QR et PIN, téléphones, scoring, podium, rapports, persistance et reprise des parties |
| V1.1 | QCM de 2 à 8 choix ; types artist, title, artist-title, year, decade, custom ; presets de scoring et scoring personnalisé ; multiplicateurs ; réglages par manche ; enchaînement manuel / semi-auto / automatique persistant |
| V1.2 | télécommande animateur ; bibliothèque musicale réutilisable ; distracteurs par règles ; import et export JSON/CSV ; redimensionnement des images ; journal d’audit |
| V1.3 | équipes (sum, average, top-n) ; saisie libre avec alias et tolérance limitée ; artiste + titre mixte ; validation manuelle ; rapports blind test ; tableau de bord temps réel |

## Court terme

1. Rapports par équipe enrichis (évolution du score d’équipe morceau par morceau).
2. Logo pour fond sombre appliqué automatiquement selon le thème.
3. Traduction complète de l’éditeur de quiz classique (`/host`, `/library`, `/reports`) et sélecteur de langue basé sur `defaultLanguage`.
4. Édition des fiches de bibliothèque directement depuis l’éditeur de blind test.
5. Affichage d’une étape « description de la manche » à l’écran au début de chaque manche.

## Moyen terme (jeu)

- **Buzzer** : premier à buzzer, validation par l’animateur, pénalité facultative.
- Questions bonus « à double réponse » (année et artiste), réponses par paliers.
- Réactions et émojis des joueurs.

## Infrastructure (non réalisé, volontairement hors de ce chantier)

- **Multi-instance** : diffusion des messages par **Redis pub/sub** ou **Ably** et verrou par partie. L’instantané persistant existe déjà.
- **Pilotes de stockage objet** (`lib/media.js`) : Cloudflare R2 / S3 (SigV4), Vercel Blob, **Supabase Storage**.
- **Migration PostgreSQL** pour les hébergeurs sans disque persistant.
- **Multi-marques** : paramètres par organisation, sélectionnés par domaine.
- **Architecture 100 % serverless** : état dans Postgres ou Redis, transitions calculées depuis les horodatages (logique déjà utilisée par `armTimers` et `autoAt`), temps réel par Ably ou Supabase Realtime.
