# Étude de marché — novembre 2026

Où se situe Moxfield Stock Manager face aux outils existants, et quelles
fonctionnalités rapporteraient le plus pour l'effort demandé.

**Méthode et limites.** Étude faite le 21 novembre 2026 à partir de
recherches web : fiches des stores, sites et guides des éditeurs, forums de
suggestions. Aucun concurrent n'a été installé ni testé : leurs
fonctionnalités sont celles qu'ils annoncent. L'attrait pour les
utilisateurs est estimé d'après les demandes publiques (forums de Moxfield,
Archidekt, Deckbox, TappedOut), pas d'après un sondage. Les notes sont des
estimations à réviser avec les premiers retours d'utilisateurs.

## 1. Le besoin

Savoir où sont ses cartes physiques, et ce qu'on peut monter sans
racheter, est une demande ancienne et répétée sur tous les sites de decks :

- **Moxfield** : demande « Collection Availability Tracking Across Decks »
  (« 1 sur 3 disponible, 2 dans d'autres decks ») et une demande plus
  ancienne où des utilisateurs parlent de fonction indispensable
  ([2554](https://moxfield.nolt.io/2554), [331](https://moxfield.nolt.io/331)).
- **Archidekt** : plusieurs fils (« In-Use / Available », « dans quel deck
  est ma carte »)
  ([fil 15420664](https://websockets.archidekt.com/forum/thread/15420664),
  [fil 1053995](https://archidekt.com/forum/thread/1053995)).
- **Deckbox, TappedOut** : mêmes demandes
  ([Deckbox](https://deckbox.org/forum/viewtopic.php?id=331),
  [TappedOut](https://tappedout.net/mtg-forum/tappedout/how-can-i-know-in-which-deck-i-have-a-given-card)).

## 2. Les concurrents

| Outil | Type | Ce qu'il fait sur ce besoin | Limites relevées |
|---|---|---|---|
| [MTG Collection Lens](https://chromewebstore.google.com/detail/nkgmdnkmdkafgjmckimpjafpmlcgfnpl) | Extension Chrome et [Firefox](https://addons.mozilla.org/addon/mtg-collection-lens) | Surligne les cartes possédées sur EDHREC, Scryfall, MTGGoldfish, MTGDecks, MTGTop8 ; importe tous les decks Moxfield en un clic ; motif rayé quand tous les exemplaires sont dans des decks ; decks qui contiennent la carte ; proxies marqués `[[Proxy]]` | Tous les decks comptent comme occupés (pas de notion de deck monté) ; réserve non importée ; un avis signale des imports de decks incomplets (10 à 15 cartes manquantes) ; collection par export CSV manuel |
| [MagiCard](https://chromewebstore.google.com/detail/floonngmgapnmpemcjfegdicglefbdjm) | Extension Chrome | Compare possédé / dans des decks / disponible | Decks importés d'Archidekt et TappedOut ; Moxfield annoncé « bientôt » |
| [ManaBox](https://manabox.app/guides/decks/collection-decks/) | Application mobile | « Build from collection » : indique dans quel classeur ou deck est chaque carte, puis déplace les cartes dans le deck ; option « chercher dans les autres decks » pour les manques ; scanner de cartes | Hors Moxfield : il faut y tenir sa collection et ses decks |
| [Grimoria](https://grimoria.app/help/deckbuilder/building-from-collection) | Application mobile | Transforme une idée de deck en « deck box » ; origine de chaque carte (classeur, autre deck, vrac) ; choix de l'impression exacte ; état, langue, foil, emplacement ; écarts entre l'idée et la boîte | Hors Moxfield |
| ManaForge, Eldwyn, TopDecked, MythicHub | Applications | Emplacements physiques, classeurs, déplacement de cartes entre decks et classeurs | Hors Moxfield |
| [Archidekt](https://archidekt.com/news/6801001) | Site de decks | Collection V2 : onglets montrant les autres decks où se trouve une carte | Concurrent de Moxfield lui-même |
| Moxfield | Site de decks | Rien de natif aujourd'hui | Sa feuille de route publique mentionne « Add Strict Assignment to Collections » ([roadmap](https://moxfield.nolt.io/roadmap)) — statut et contenu non vérifiés |

## 3. Notre position

**Ce que nous avons et que les extensions concurrentes n'annoncent pas :**

- La notion de **deck physiquement monté** : seuls les decks réellement
  montés occupent du stock, pas tous les decks du compte.
- Tout **sur la page du deck Moxfield** : faisabilité en direct, cartes
  bloquantes, deck monté où se trouve chaque carte manquante.
- **Suivi du montage** : deck modifié après le montage détecté et mis à
  jour pour les seules cartes changées.
- **Éditions** : refus d'une version déjà prise par un autre deck monté,
  et passage du deck sur les éditions possédées en un clic.
- **Proxies** : montage malgré un manque, planches à imprimer,
  remplacement proposé quand la carte arrive.
- **Achat** : prix Cardmarket des manques et export de la liste.
- Collection **récupérée automatiquement** (pas d'export CSV à refaire),
  historique, synchronisation Google Drive, français et anglais.

**Ce qui nous manque face à eux :**

- **Distribution** : pas sur le Chrome Web Store ni sur Firefox
  (installation en mode développeur, mise à jour par `git pull`).
- **Vue d'ensemble de tous les decks** : il faut ouvrir chaque deck.
- **Aide au geste physique** : pas de liste à cocher, pas d'emplacement
  des cartes (classeur, boîte), pas de transfert d'un deck à l'autre.
- **Présence hors de Moxfield** : rien sur EDHREC ou Scryfall, pas de
  mobile (une extension Chrome ne tourne que sur ordinateur).
- **Prise en main** : aucun parcours de premier lancement (comblé depuis :
  premiers pas du popup en 0.4.0, bulle sur la page d'un deck en 0.9.0).

**Risques :**

- Moxfield peut livrer la fonction lui-même (cf. sa feuille de route) :
  notre avantage resterait le suivi du montage physique, les proxies et
  l'aide à l'achat.
- L'extension dépend de l'API privée et de la page de Moxfield, qui
  changent sans prévenir (barre d'actions disparue en novembre 2026).

## 4. Fonctionnalités classées

**Score = attrait × simplicité** (25 au plus).
Attrait pour les utilisateurs : 1 (marginal) à 5 (très demandé).
Simplicité : 1 (gros chantier) à 5 (très simple à produire).
« ROADMAP n° » renvoie à la ligne de `ROADMAP.md` ; « nouveau » : idée
issue de cette étude.

| Rang | Fonctionnalité | Attrait | Simplicité | Score | Origine | Pourquoi ces notes |
|---|---|---|---|---|---|---|
| 1 | **Premier lancement guidé** (livré, version 0.4.0 ; revu en 0.9.0 : premiers pas cochés, légende, bulle sur la page d'un deck) : connexion à Moxfield, première récupération, premier deck monté, explication des pastilles | 4 | 4 | **16** | nouveau | Sans lui, un nouvel utilisateur ne comprend ni le bouton ni la pastille (confusion constatée entre « montable » et « monté ») ; surtout de l'affichage |
| 2 | **Publication sur le Chrome Web Store** : installation en un clic, mises à jour automatiques | 5 | 3 | **15** | nouveau | Condition pour avoir des utilisateurs ; préparation déjà faite une fois (commit `fc46bc4`), à reprendre ; relecture de Google et compte Google Cloud à prévoir |
| 3 | **Faisabilité de tous mes decks** (livré en 0.5.0, decks ouverts ou collés) dans le popup : monté, montable, nombre de cartes bloquantes | 5 | 3 | **15** | ROADMAP n°2 | La vue d'ensemble est l'atout principal de Collection Lens ; l'API des decks est déjà lue pour un deck |
| 4 | **Liste de cartes à sortir / ranger** avec cases à cocher, triée, au montage et au démontage | 4 | 3 | **12** | ROADMAP n°4 | Le geste physique que ManaBox et Grimoria accompagnent ; sert à chaque montage |
| 5 | **Transfert entre decks** : prendre une carte manquante dans un deck monté | 4 | 3 | **12** | ROADMAP n°5 | « Chercher dans les autres decks » existe chez ManaBox ; nous savons déjà où est la carte |
| 6 | **Proxies déclarés sur Moxfield** (livré en 0.7.0) (`isProxy`) montés d'office en proxy | 3 | 4 | **12** | ROADMAP n°9 | Collection Lens gère un marqueur proxy ; l'API du deck est déjà lue |
| 7 | **Liste d'achats cumulée** de plusieurs decks, sans doublons, avec le coût total (livré en 0.8.0) | 3 | 4 | **12** | ROADMAP n°8 | Une seule commande ; plus utile une fois le rang 3 livré |
| 8 | **Disponibilité pendant la construction du deck** sur Moxfield : « 1 sur 3 libre, 2 dans des decks montés » dans la recherche de cartes | 5 | 2 | **10** | nouveau | Exactement la demande 2554 de Moxfield ; lecture d'une nouvelle partie de la page, fragile |
| 9 | **Export du stock libre** (CSV ou format d'import Moxfield) | 2 | 5 | **10** | ROADMAP n°14 | Usage occasionnel, mais très simple |
| 10 | **Bouton « Proposer une idée »** (formulaire d'issue GitHub pré-rempli) | 2 | 5 | **10** | nouveau | Canal de retour dès les premiers utilisateurs ; un lien et un formulaire |
| 11 | **Version Firefox** | 3 | 3 | **9** | nouveau | Collection Lens y est ; la connexion Google par fenêtre existe déjà |
| 12 | **Decks montés modifiés détectés sans les ouvrir** | 3 | 3 | **9** | ROADMAP n°6 | Fiabilité du stock ; se combine avec le rang 3 |
| 13 | **Boutons intégrés à la nouvelle page de Moxfield** (à la place du bandeau flottant) | 3 | 3 | **9** | nouveau | Intégration plus propre ; demande une copie de la nouvelle page |
| 14 | **Doublons libres échangeables**, avec export | 2 | 4 | **8** | ROADMAP n°13 | Usage occasionnel |
| 15 | **Cartes les plus partagées** entre decks | 2 | 4 | **8** | ROADMAP n°12 | Aide à décider d'un achat en double |
| 16 | **Emplacement physique** des cartes (classeur, boîte), repris dans la liste à sortir | 3 | 2 | **6** | ROADMAP n°10 | Présent chez ManaBox, Grimoria, ManaForge ; saisie initiale lourde, sauf à lire les classeurs de Moxfield (à vérifier) |
| 17 | **Stock par finition et langue**, quantités libres par édition | 3 | 2 | **6** | ROADMAP n°7 | Grimoria suit état, langue et foil ; refonte des calculs |
| 18 | **Cartes libres surlignées sur EDHREC et Scryfall** | 3 | 2 | **6** | nouveau | Terrain de Collection Lens ; nouveaux sites à lire et à maintenir |
| 19 | **Annuler depuis l'historique** | 2 | 3 | **6** | ROADMAP n°3 | Rattrapage d'erreur, rare |
| 20 | **Valeur du stock** : libre, dans les decks montés | 2 | 3 | **6** | nouveau | Confort ; les prix ne sont lus aujourd'hui que pour les manques |
| 21 | **Proxy pour une carte d'une autre édition** | 2 | 3 | **6** | ROADMAP n°1 | Cas particulier des proxies |
| 22 | **Autres sites de decks** (Archidekt) | 4 | 1 | **4** | nouveau | Élargit le public, mais tout le lecteur de page et l'API sont à refaire |
| 23 | **Différences avant import CSV manuel** | 1 | 4 | **4** | ROADMAP n°11 | L'import manuel n'est plus qu'un secours |
| 24 | **Stock partagé entre plusieurs personnes** | 2 | 1 | **2** | ROADMAP n°15 | Gros chantier pour un besoin incertain |

## 5. Lecture du classement

- **Rangs 1 à 3** : rendre l'extension installable et compréhensible, puis
  combler le seul vrai retard fonctionnel (la vue de tous les decks).
- **Rangs 4 à 7** : creuser ce qui nous distingue, l'accompagnement du
  montage physique et de l'achat.
- **Rang 8** : la fonction la plus demandée sur le forum de Moxfield ; son
  coût tient à la fragilité de la lecture de page. À réévaluer si Moxfield
  livre son « Strict Assignment ».
- Le score ne tient pas compte des dépendances : le rang 7 gagne à suivre
  le rang 3, le rang 16 à suivre le rang 4.

## Sources

- [MTG Collection Lens — Chrome Web Store](https://chromewebstore.google.com/detail/nkgmdnkmdkafgjmckimpjafpmlcgfnpl)
- [MTG Collection Lens — Firefox](https://addons.mozilla.org/addon/mtg-collection-lens)
- [MTG Collection Lens — site](https://fccmtgdev.github.io/collectionlens)
- [MagiCard — Chrome Web Store](https://chromewebstore.google.com/detail/floonngmgapnmpemcjfegdicglefbdjm)
- [ManaBox — decks dans la collection](https://manabox.app/guides/decks/collection-decks/)
- [ManaBox — cartes manquantes](https://manabox.app/guides/decks/missing-cards)
- [Grimoria — construire depuis la collection](https://grimoria.app/help/deckbuilder/building-from-collection)
- [Grimoria — à propos](https://www.grimoria.app/about)
- [ManaForge MTG](https://apps.apple.com/app/id6758670832)
- [MythicHub — classeurs](https://mythichub.com/collection)
- [Archidekt — Collection V2++](https://archidekt.com/news/6801001)
- [Archidekt — In-Use / Available](https://websockets.archidekt.com/forum/thread/15420664)
- [Archidekt — decks où une carte est jouée](https://archidekt.com/forum/thread/1053995)
- [Moxfield — demande 2554](https://moxfield.nolt.io/2554)
- [Moxfield — demande 331](https://moxfield.nolt.io/331)
- [Moxfield — feuille de route](https://moxfield.nolt.io/roadmap)
- [Deckbox — cartes utilisées dans des decks](https://deckbox.org/forum/viewtopic.php?id=331)
- [TappedOut — dans quel deck est ma carte](https://tappedout.net/mtg-forum/tappedout/how-can-i-know-in-which-deck-i-have-a-given-card)
