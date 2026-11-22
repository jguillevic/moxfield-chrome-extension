# Feuille de route

Idées de fonctionnalités, classées par importance : d'abord ce qui bloque
ou risque de fausser le stock, puis l'usage quotidien, puis le confort.
Une idée livrée passe dans la section « Livré » (et est décrite dans le
README).

Étude de marché (concurrents, forces et manques, fonctionnalités notées
par attrait × simplicité, dont des idées absentes de cette liste) :
[`docs/etude-de-marche.md`](docs/etude-de-marche.md), novembre 2026.

## À faire

| Rang | Fonctionnalité | Effort | Pourquoi |
|---|---|---|---|
| 1 | **Proxy pour une carte d'une autre édition** — la proposer en proxy quand « Utiliser mes éditions » ne peut rien (exemplaires déjà dans d'autres decks montés, pas assez dans une même édition) ; son remplacement ne doit alors être proposé que quand la bonne édition arrive dans la collection, pas avec l'exemplaire de l'autre édition déjà en stock. | Moyen | Reste de la demande « Monter avec N proxies » (bouton principal livré). Cas devenu rare depuis « Utiliser mes éditions ». |
| 2 | **Liste de tous ses decks Moxfield dans « Mes decks »** — capturer l'appel de l'API qui liste les decks d'un compte (onglet Network, page « Your decks »), pour proposer ses decks sans passer par le cœur. | Faible | « Mes decks » est livré sans cet appel : un deck n'y entre que par le cœur ou une adresse collée. |
| 3 | **Annuler depuis l'historique** — « Remonter » un deck démonté, « Démonter » un deck monté, « Revenir à la liste précédente » après une mise à jour, « Remonter les decks » après une réinitialisation ; mêmes contrôles de stock qu'au montage, une seule fois, et seulement si le deck est resté dans l'état produit. Les actions sur la collection restent non annulables (Moxfield fait référence). | Moyen | Rattraper une erreur sur les decks montés. Les entrées enregistrent déjà les données nécessaires. Écarté de la première version de l'historique. |
| 4 | **Liste de cartes à sortir / ranger** — cases à cocher triées par couleur, type ou édition, au montage et au démontage. | Moyen | Sert à chaque montage physique. |
| 5 | **Transfert entre decks** — prendre les cartes manquantes dans un deck monté et marquer celui-ci comme incomplet. | Moyen | Évite d'acheter une carte qui dort dans un autre deck ; la fenêtre indique déjà où elle est. |
| 6 | **Détection des decks montés modifiés sans les ouvrir** — via l'API des decks, à chaque récupération. | Moyen | Désormais faisable (la session Moxfield est réutilisable en tâche de fond) ; se combine avec le n°2. |
| 7 | **Stock par finition et langue, quantités libres par édition dans le popup.** | Moyen | Le contrôle « version déjà utilisée » compte maintenant chaque édition à part (API du deck). Restent la finition (l'API du deck la donne, mais le foil d'un deck est rarement tenu à jour : risque de refus à tort), la langue (absente de l'API du deck) et l'affichage par édition. Rendrait le n°1 inutile. |
| 8 | **Liste d'achats cumulée** — les manques de plusieurs decks en une seule liste Cardmarket, sans doublons, avec le coût total. | Faible | Une seule commande pour plusieurs decks ; plus utile avec le n°2. |
| 10 | **Emplacement physique** — classeur, boîte ou page de chaque carte, repris dans la liste à sortir (n°4). | Moyen | Gain de temps réel, mais saisie initiale. |
| 11 | **Différences avant import CSV manuel** — montrer ce qui change avant d'écraser le stock. | Faible | Moins utile depuis la récupération automatique (qui montre déjà les changements et les cartes non couvertes) : l'import manuel n'est plus qu'un secours. |
| 12 | **Cartes les plus partagées** — présentes dans plusieurs decks montés ou envisagés. | Faible | Savoir quoi acheter en double ; usage occasionnel. |
| 13 | **Doublons libres échangeables** — avec export pour échange ou vente. | Faible | Usage occasionnel. |
| 14 | **Export du stock libre** — CSV ou format d'import Moxfield. | Faible | Usage occasionnel. |
| 15 | **Stock partagé entre plusieurs personnes** — dossier Drive commun, qui a monté quoi. | Élevé | Gros chantier (droits, conflits) pour un besoin incertain. |

Rang susceptible de bouger : le n°7 passe en tête si distinguer foil et
éditions dans le stock physique compte.

## Questions ouvertes

- **Réserve des decks de 60 cartes** : lecture non vérifiée sur une vraie
  page (marqueur `collection_…_sideboard_…`, même `data-hash` qu'une
  entrée du deck pour une même version : supposés par analogie avec
  Considering). Enregistrer une page réelle dans `tests/fixtures/`.
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
  « Collection Moxfield ») et la fenêtre de montage n'ont pas de tests
  automatisés. La barre d'actions Moxfield des tests est reconstituée à
  partir de ses repères (icônes), pas enregistrée depuis une vraie page.

## Livré

- Proxies déclarés sur Moxfield : une carte marquée proxy dans le deck est
  montée d'office en proxy, même possédée ou d'une autre édition, et ne
  bloque ni la pastille ni « Mes decks » — rang 6 de l'étude de marché —
  novembre 2026.
- Cœur sur la page d'un deck pour le garder dans « Mes decks » (à monter
  plus tard), à la place de l'ajout automatique de chaque deck ouvert —
  novembre 2026.
- « Mes decks » dans le popup : faisabilité de tous les decks ouverts (ou
  collés) et montés, sans les ouvrir, avec le même calcul que la pastille du
  bouton ; liste synchronisée — rang 3 de l'étude de marché — novembre
  2026.
- Guide de démarrage dans le popup (4 étapes, état réel de l'utilisateur,
  rejouable) — rang 1 de l'étude de marché — novembre 2026.
- Notification d'une nouvelle version sur GitHub : pastille sur l'icône et
  carte dans le popup, avec les modifications — novembre 2026.
- Numéro de version géré (0.3.0) et affiché en bas du popup avec le commit
  du clone ; contrôlé à chaque livraison sur `main` — novembre 2026.
- Édition de chaque carte dans le stock (et donc dans la sauvegarde), même
  possédée dans une seule édition — novembre 2026.
- Sauvegarde Google Drive retrouvable : lien vers les paramètres de Drive
  (le dossier de l'extension y est invisible) et téléchargement en JSON de
  la sauvegarde et de chaque version de l'historique — novembre 2026.
- Montage avec des proxies depuis le bouton principal : « Confirmer le
  montage avec N proxies » (et « Mettre à jour avec N proxies ») quand
  seul le stock manque, à la place d'un bouton à part dans l'encadré des
  manques ; nombre de proxies affiché sur le bouton du ruban d'un deck
  monté — novembre 2026.

- Passer un deck sur les éditions de la collection : les cartes possédées
  dans une autre édition sont changées dans le deck Moxfield en un clic
  (bouton « Utiliser mes éditions » de la barre d'actions, à gauche du
  bouton de montage ; page rechargée toute seule, deck pas monté), pour que le deck reflète ce que tu as
  vraiment ; première écriture de l'extension sur Moxfield — novembre 2026.
- Proxies : monter (ou mettre à jour) un deck malgré un stock insuffisant,
  les exemplaires manquants joués en proxy, jamais pris au stock ; planches
  A4 à imprimer (images Scryfall, mention « PROXY » désactivable) ;
  remplacement par la vraie carte proposé dès qu'elle est en stock libre.
  Remplace aussi l'idée « montage partiel » — novembre 2026.
- Prix des cartes manquantes : prix Cardmarket (en euros) de la version du
  deck, donné par l'API de Moxfield déjà appelée pour les éditions, à côté
  de chaque carte manquante, avec le total — novembre 2026.
- Tous les formats : le bouton n'est plus réservé aux decks Commander ; un
  deck de 60 cartes se monte avec sa réserve, une même version pouvant être
  dans le deck et dans la réserve — novembre 2026.
- Version déjà utilisée, contrôle exact par édition : l'édition et le numéro
  de chaque version d'un deck sont lus par l'API de Moxfield
  (`/v3/decks/all/<id>`) et rapprochés de la collection ; le recoupement
  ne sert plus que de repli — novembre 2026.
- Version déjà utilisée par un autre deck monté : montage refusé quand la
  version demandée n'est plus libre, même s'il reste un exemplaire d'une
  autre édition ; versions des decks montés et détail de la collection par
  édition enregistrés ; changement de version d'un deck monté signalé —
  novembre 2026.
- Traduction : extension en français et en anglais, selon la langue du
  navigateur — octobre 2026.
- Tableau de bord du popup : exemplaires possédés, libres, dans des decks,
  cartes différentes et decks montés — octobre 2026.
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
- Rapports d'erreurs anonymes de toutes les installations, envoyés sur
  Sentry (désactivables) — octobre 2026.
- Synchro Google Drive dans tous les navigateurs Chromium (Brave, Edge,
  Opera…), par la fenêtre de connexion Google — octobre 2026.
- Lien « Se connecter à Moxfield » sans session, et récupération de la
  collection dès la connexion — octobre 2026.
