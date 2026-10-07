# Feuille de route

Idées de fonctionnalités, classées par importance : d'abord ce qui bloque
ou risque de fausser le stock, puis l'usage quotidien, puis le confort.
Une idée livrée passe dans la section « Livré » (et est décrite dans le
README).

## À faire

| Rang | Fonctionnalité | Effort | Pourquoi |
|---|---|---|---|
| 1 | **Accepter une autre version** — monter malgré une édition différente, par carte ou pour toute la liste : la carte est décomptée normalement, l'avertissement devient informatif (comme pour les terrains de base). | Faible | Bloque des decks réels (27 cartes sur un deck testé), alors que le stock est suivi par nom : physiquement, on a bien la carte. |
| 2 | **Faisabilité de tous mes decks** — lister ses decks Moxfield dans le popup avec, pour chacun, monté / montable / nombre de cartes bloquantes, via l'API (session déjà réutilisée pour la collection). Remplace l'idée « faisabilité mémorisée des decks consultés » et la pastille sur les listes de decks. | Moyen | Répond à « que puis-je monter ? » sans ouvrir chaque deck ; réutilise `computeDeckAvailability`. Appels de l'API des decks à capturer d'abord. |
| 3 | **Annuler depuis l'historique** — « Remonter » un deck démonté, « Démonter » un deck monté, « Revenir à la liste précédente » après une mise à jour, « Remonter les decks » après une réinitialisation ; mêmes contrôles de stock qu'au montage, une seule fois, et seulement si le deck est resté dans l'état produit. Les actions sur la collection restent non annulables (Moxfield fait référence). | Moyen | Rattraper une erreur sur les decks montés. Les entrées enregistrent déjà les données nécessaires. Écarté de la première version de l'historique. |
| 4 | **Liste de cartes à sortir / ranger** — cases à cocher triées par couleur, type ou édition, au montage et au démontage. | Moyen | Sert à chaque montage physique. |
| 5 | **Transfert entre decks** — prendre les cartes manquantes dans un deck monté et marquer celui-ci comme incomplet. | Moyen | Évite d'acheter une carte qui dort dans un autre deck ; la fenêtre indique déjà où elle est. |
| 6 | **Détection des decks montés modifiés sans les ouvrir** — via l'API des decks, à chaque récupération. | Moyen | Désormais faisable (la session Moxfield est réutilisable en tâche de fond) ; se combine avec le n°2. |
| 7 | **Stock par édition et finition** (édition, foil, langue). | Élevé | Structurant : modèle de données, migration, synchro Drive. Les données sont déjà dans le CSV récupéré. Rendrait le n°1 inutile. |
| 8 | **Prix des cartes manquantes** — via l'API Scryfall (prix EUR, gratuite, sans clé), avec le total. | Faible | Aide à décider si un deck vaut l'achat ; complète l'export Cardmarket. |
| 9 | **Liste d'achats cumulée** — les manques de plusieurs decks en une seule liste Cardmarket, sans doublons. | Faible | Une seule commande pour plusieurs decks ; plus utile avec le n°2. |
| 10 | **Montage partiel** — monter en attendant des cartes commandées, décomptées à leur arrivée. | Moyen | Cas fréquent en attente de commande. |
| 11 | **Emplacement physique** — classeur, boîte ou page de chaque carte, repris dans la liste à sortir (n°4). | Moyen | Gain de temps réel, mais saisie initiale. |
| 12 | **Proxies** — cartes jouées en proxy, non décomptées du stock. | Faible | Selon la pratique de jeu. |
| 13 | **Différences avant import CSV manuel** — montrer ce qui change avant d'écraser le stock. | Faible | Moins utile depuis la récupération automatique (qui montre déjà les changements et les cartes non couvertes) : l'import manuel n'est plus qu'un secours. |
| 14 | **Tableau de bord du popup** — cartes possédées, libres, dans des decks, decks montés. | Faible | Confort. |
| 15 | **Cartes les plus partagées** — présentes dans plusieurs decks montés ou envisagés. | Faible | Savoir quoi acheter en double ; usage occasionnel. |
| 16 | **Doublons libres échangeables** — avec export pour échange ou vente. | Faible | Usage occasionnel. |
| 17 | **Export du stock libre** — CSV ou format d'import Moxfield. | Faible | Usage occasionnel. |
| 18 | **Formats autres que Commander** — surtout la réserve des decks de 60 cartes. | Moyen | Seulement si d'autres formats sont joués. |
| 19 | **Stock partagé entre plusieurs personnes** — dossier Drive commun, qui a monté quoi. | Élevé | Gros chantier (droits, conflits) pour un besoin incertain. |

Rangs susceptibles de bouger : le n°7 passe en tête si distinguer foil et
éditions dans le stock physique compte ; les n°12 et 18 remontent si l'on
joue des proxies ou d'autres formats.

## Questions ouvertes

- **Pastille de faisabilité** : afficher un pourcentage de cartes
  disponibles (ex. « 34 % ») plutôt que le nombre de cartes bloquantes ?
  Le « − » devant le nombre a été écarté.
- **Suppression d'une carte de la collection** : non vérifiée en réel —
  déclenche-t-elle la récupération 30 s après (comme l'ajout et la
  modification) ? Sinon, capturer l'appel et l'ajouter à la détection.
- **Synchro Drive des grosses collections** : chaque modification renvoie
  encore tout l'état (compressé : quelques centaines de Ko à 50 000 cartes).
  Si ça devient gênant : séparer l'historique dans son propre fichier.
- **Tests manquants** : la synchro Google Drive, le popup (hors section
  « Collection Moxfield »), la fenêtre de montage et l'intégration à la
  barre d'actions Moxfield n'ont pas de tests automatisés.

## Livré

- Faisabilité d'un deck non monté sur le bouton (pastille ✓ / nombre de
  cartes bloquantes), recalculée en direct — octobre 2026.
- Récupération automatique de la collection Moxfield 30 s après chaque
  modification sur le site, et toutes les heures,
  même Moxfield fermé — octobre 2026.
- Ajustements manuels du stock retirés : la collection Moxfield est la
  seule source de vérité — octobre 2026.
- Historique des actions (consultation), synchronisé entre les PC —
  octobre 2026.
- Tenue aux grosses collections (50 000 cartes) : stockage illimité,
  détail de l'historique borné, page de deck limitée au stock de ses
  cartes, fichiers Google Drive compressés — octobre 2026.
