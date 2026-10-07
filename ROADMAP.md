# Feuille de route

Idées de fonctionnalités, classées par importance : d'abord ce qui bloque
ou risque de fausser le stock, puis l'usage quotidien, puis le confort.
Une idée livrée passe dans la section « Livré » (et est décrite dans le
README).

## À faire

| Rang | Fonctionnalité | Effort | Pourquoi |
|---|---|---|---|
| 1 | **Accepter une autre version** — monter malgré une édition différente, par carte ou pour toute la liste : la carte est décomptée normalement, l'avertissement devient informatif (comme pour les terrains de base). | Faible | Bloque des decks réels (27 cartes sur un deck testé), alors que le stock est suivi par nom : physiquement, on a bien la carte. |
| 2 | **Différences avant réimport du CSV** — montrer les cartes ajoutées/retirées avant d'écraser le stock, et alerter si la nouvelle collection ne couvre plus un deck monté. | Faible | Une réimportation peut aujourd'hui rendre le stock négatif sans prévenir. |
| 3 | **Journal des mouvements et annulation** — historique (« +1 Sol Ring (ajustement) », « Deck X monté : −99 cartes ») et bouton pour annuler la dernière action. | Moyen | Une erreur ne se rattrape que via l'historique Drive, quotidien. |
| 4 | **Faisabilité mémorisée des decks consultés** — enregistrer l'état de chaque deck visité (« montable », « 12 bloquantes ») et lister ces decks dans le popup. | Moyen | Répond à « que puis-je monter ? » sans ouvrir chaque deck ; réutilise `computeDeckAvailability`. |
| 5 | **Liste de cartes à sortir / ranger** — cases à cocher triées par couleur, type ou édition, au montage et au démontage. | Moyen | Sert à chaque montage physique. |
| 6 | **Transfert entre decks** — prendre les cartes manquantes dans un deck monté et marquer celui-ci comme incomplet. | Moyen | Évite d'acheter une carte qui dort dans un autre deck ; la fenêtre indique déjà où elle est. |
| 7 | **Stock par édition et finition** (édition, foil, langue). | Élevé | Structurant : modèle de données, migration, synchro Drive. Plus il arrive tard, plus il coûte. Rendrait le n°1 inutile. |
| 8 | **Prix des cartes manquantes** — via l'API Scryfall (prix EUR, gratuite, sans clé), avec le total. | Faible | Aide à décider si un deck vaut l'achat ; complète l'export Cardmarket. |
| 9 | **Liste d'achats cumulée** — les manques de plusieurs decks en une seule liste Cardmarket, sans doublons. | Faible | Une seule commande pour plusieurs decks. |
| 10 | **Montage partiel** — monter en attendant des cartes commandées, décomptées à leur arrivée. | Moyen | Cas fréquent en attente de commande. |
| 11 | **Emplacement physique** — classeur, boîte ou page de chaque carte, repris dans la liste à sortir (n°5). | Moyen | Gain de temps réel, mais saisie initiale. |
| 12 | **Proxies** — cartes jouées en proxy, non décomptées du stock. | Faible | Selon la pratique de jeu. |
| 13 | **Tableau de bord du popup** — cartes possédées, libres, dans des decks, decks montés. | Faible | Confort. |
| 14 | **Cartes les plus partagées** — présentes dans plusieurs decks montés ou envisagés. | Faible | Savoir quoi acheter en double ; usage occasionnel. |
| 15 | **Pastille sur les listes de decks Moxfield** (profil, dossiers) — monté / faisabilité connue. | Moyen | Pratique, mais dépend du n°4 et ajoute du scraping. |
| 16 | **Doublons libres échangeables** — avec export pour échange ou vente. | Faible | Usage occasionnel. |
| 17 | **Export du stock libre** — CSV ou format d'import Moxfield. | Faible | Usage occasionnel. |
| 18 | **Formats autres que Commander** — surtout la réserve des decks de 60 cartes. | Moyen | Seulement si d'autres formats sont joués. |
| 19 | **Détection des decks modifiés sans les ouvrir** — via l'API interne de Moxfield. | Moyen | Non officielle : fragile, peut-être contraire aux conditions d'utilisation. |
| 20 | **Stock partagé entre plusieurs personnes** — dossier Drive commun, qui a monté quoi. | Élevé | Gros chantier (droits, conflits) pour un besoin incertain. |

Rangs susceptibles de bouger : le n°7 passe en tête si distinguer foil et
éditions dans le stock physique compte ; les n°12 et 18 remontent si l'on
joue des proxies ou d'autres formats.

## Questions ouvertes

- **Pastille de faisabilité** : afficher un pourcentage de cartes
  disponibles (ex. « 34 % ») plutôt que le nombre de cartes bloquantes ?
  Le « − » devant le nombre a été écarté.
- **Tests manquants** : la synchro Google Drive, le popup, la fenêtre de
  montage et l'intégration à la barre d'actions Moxfield n'ont pas de tests
  automatisés.

## Livré

- Faisabilité d'un deck non monté sur le bouton (pastille ✓ / nombre de
  cartes bloquantes), recalculée en direct — octobre 2026.
