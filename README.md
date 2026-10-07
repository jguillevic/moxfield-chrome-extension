# Moxfield Stock Manager (extension Chrome)

Ajoute une gestion de stock de cartes physiques par-dessus Moxfield : flag un
deck comme « monté physiquement » et le stock est décrémenté automatiquement,
carte par carte, selon la decklist. Démonte-le pour réincrémenter.

## Installation

1. Clone le dépôt (`git clone https://github.com/jguillevic/moxfield-chrome-extension.git`)
   ou décompresse ce dossier quelque part sur ton disque.
2. Ouvre `chrome://extensions`.
3. Active le **Mode développeur** (en haut à droite).
4. Clique **Charger l'extension non empaquetée** et sélectionne ce dossier.

## Utilisation

### 1. Récupérer ta collection (initialiser le stock)

**Automatiquement** : il suffit d'être connecté à Moxfield dans Chrome.
L'extension récupère ta collection depuis ton compte, puis l'importe :

- **30 secondes après une modification de ta collection sur Moxfield**
  (ajout, changement de quantité, suppression — depuis la page
  [collection](https://moxfield.com/collection) ou ailleurs sur le site).
  Chaque nouvelle modification repousse ce délai : tu peux saisir plusieurs
  cartes d'affilée, la récupération a lieu après une pause ;
- **toutes les heures** et au démarrage du navigateur, **même sans onglet
  Moxfield ouvert** — pour les modifications faites ailleurs (autre PC,
  application mobile).

Dans le popup, section **« Collection Moxfield »** :

- **« Récupérer maintenant »** pour ne pas attendre (ex. juste après avoir
  ajouté des cartes à ta collection sur Moxfield) ;
- la case **« Récupérer automatiquement »** pour désactiver/réactiver ces
  récupérations automatiques ;
- la date de la dernière récupération, les **derniers changements**
  (`+1 Rhystic Study, −2 Sol Ring`) et, en rouge, la raison d'un échec
  (session Moxfield expirée, Moxfield injoignable ou ayant changé son
  fonctionnement...) ;
- une alerte si ta collection **ne couvre plus des cartes de decks montés**
  (carte retirée de la collection alors qu'elle est dans un deck monté),
  avec les decks concernés — terrains de base exclus.

L'extension ne connaît ni ne stocke ton mot de passe : elle réutilise la
session Moxfield ouverte dans Chrome, comme le site lui-même (même jeton de
connexion, renouvelé de la même façon — tu restes connecté). Si tu te
déconnectes de Moxfield, la récupération s'arrête jusqu'à ta prochaine
connexion.

La collection Moxfield **fait référence** : chaque récupération remplace
les quantités du stock (un ajustement manuel fait dans le popup est donc
écrasé à la récupération suivante — ajuste plutôt ta collection sur
Moxfield). Les decks déjà marqués comme montés sont réappliqués, sans risque
de doublon. Si rien n'a changé, le stock n'est pas réécrit.

**Import manuel (solution de secours)** : section **« Import manuel
(fichier CSV) »** du popup. Sur Moxfield : ouvre ta collection → bouton
Export → CSV → enregistre le fichier → choisis-le via le bouton **Choisir un
fichier CSV** du popup → **Importer**. Tu peux aussi coller directement le
contenu du CSV. Même effet qu'une récupération automatique.

### 2. Monter / démonter un deck

- Va sur la page d'un deck (`moxfield.com/decks/{id}`), y compris en y
  naviguant depuis l'intérieur de Moxfield (le bouton apparaît/disparaît
  dynamiquement selon la page affichée, sans besoin de recharger). Le bouton
  n'apparaît que :
  - sur la page du deck elle-même (pas sur ses sous-pages comme
    `/decks/{id}/history`, ni sur les listes comme `/decks/public`) ;
  - pour un deck au format **Commander** (badge « Commander » dans l'en-tête
    du deck).
- Le bouton est une icône **boîte ouverte** (**cercle coché** quand le deck est monté) ajoutée à la
  barre d'actions flottante de Moxfield, en bas à droite, juste après le
  bouton like (cœur). Si cette barre est introuvable, un bouton flottant
  « 🧰 Marquer comme monté physiquement » prend le relais.
- **Faisabilité visible sans ouvrir la fenêtre** : sur un deck pas encore
  monté, une pastille sur le bouton indique si le deck est montable avec le
  stock libre — **✓ verte** s'il l'est, **rouge avec un nombre** sinon (nombre
  d'exemplaires qui bloqueraient le montage : stock insuffisant ou version
  différente, mêmes règles que ci-dessous). Le détail apparaît au survol
  (« 3 cartes bloquent le montage : 2 manquantes en stock, 1 dans une autre
  version (59/62 cartes disponibles en stock libre, hors terrains de base)
  — manque Sol Ring (1)... »), et la fenêtre de montage affiche le même
  total au-dessus de la liste.
  Les terrains de base ne comptent ni dans la pastille ni dans ce total :
  s'ils manquent, c'est seulement signalé au survol, sans jamais rendre le
  deck « non montable ». La pastille n'apparaît que quand le total
  détecté correspond à celui annoncé par Moxfield, et se met à jour en
  direct : dès que le deck change sur la page (version d'une carte changée,
  carte ajoutée...) et dès que le stock change (autre onglet, synchro
  Drive, popup). Pendant que Moxfield redessine la liste, elle garde son
  dernier état ; elle ne disparaît que si la liste reste incohérente plus de
  3 secondes.
- Clique sur ce bouton (« Marquer comme monté physiquement ») : la liste de
  cartes est détectée automatiquement à partir de la page, quel que soit le
  mode d'affichage du deck (Text, Condensed Text, Visual Grid, Visual
  Stacks...).
- **Contrôle du total** : au-dessus de la liste, un compteur affiche le
  nombre total de cartes détectées. S'il ne correspond pas au total annoncé
  par Moxfield (« N main deck » + « N sideboard »), il passe en rouge — signe
  d'une erreur de détection à corriger dans la liste.
- Les cartes de la zone **« Considering »** (cartes envisagées) ne sont
  jamais comptées, même quand Moxfield les affiche sous le deck : elles ne
  font pas partie du deck physique.
- **Vérifie/corrige la liste** avant de valider — c'est un scraping au
  mieux, pas une lecture officielle de Moxfield (qui n'a pas d'API
  publique). Si la liste est vide ou incomplète, clique sur le bouton natif
  **« Copier »** de Moxfield puis sur **« 📋 Coller depuis le
  presse-papiers »** dans la fenêtre, ou colle à la main (Ctrl+V).
- Format attendu, une carte par ligne : `1 Sol Ring`, `2 Island`, etc.
- Valide : le stock est décrémenté. Reclique sur le bouton (devenu cercle coché)
  pour démonter le deck et réincrémenter le stock.
- **Deck modifié après son montage** : tant que tu es sur la page d'un deck
  monté, l'extension compare la liste affichée à celle enregistrée au
  montage (seulement quand le total détecté correspond à celui annoncé par
  Moxfield, pour éviter les fausses alertes). Si elle a changé, une
  **pastille orange** apparaît sur le bouton. Clique dessus : la fenêtre
  liste les différences (`+1 Counterspell (0 → 1)`, `−1 Rhystic Study (1 → 0)`)
  et propose **« Mettre à jour le montage »**, qui n'ajuste le stock que pour
  les cartes modifiées. Mêmes contrôles qu'au montage, sur les seules cartes
  ajoutées : stock insuffisant ou version différente bloquent la mise à
  jour (le stock disponible compte les exemplaires déjà dans ce deck), les
  terrains de base ne font qu'un avertissement.
  - Le constat est aussi mémorisé : dans le popup, le deck porte un badge
    orange **« Modifié »** (détail des différences et date du constat au
    survol), et l'en-tête « Decks montés » indique combien le sont. Le badge
    disparaît après « Mettre à jour le montage », au démontage, ou quand la
    page du deck redevient identique au montage. Il reflète la **dernière
    visite** de la page du deck : une modification faite ailleurs (autre
    appareil, onglet fermé tout de suite) n'est connue qu'à la visite
    suivante.
- **Priorité des deux contrôles ci-dessous : le stock d'abord.** Une carte
  dont le stock est insuffisant (même partiellement) n'apparaît que dans
  « Stock insuffisant », jamais dans « Version différente » — la version
  n'est vérifiée qu'une fois le stock déjà suffisant pour cette carte.
- **Stock insuffisant** (encadré rouge, bloquant) : liste les cartes dont le
  stock disponible ne suffirait pas si ce deck était monté — y compris une
  carte totalement absente du stock. Dans ce cas, **le montage est bloqué**
  — corrige la liste, ajuste ton stock (import collection à jour, ou
  ajustement manuel dans le popup), ou retire la/les cartes en trop avant de
  pouvoir valider.
  - **Acheter les cartes manquantes sur Cardmarket** : le bouton
    **« 🛒 Copier les cartes manquantes pour Cardmarket »** de cet encadré
    copie la liste (`quantité manquante` + nom, une carte par ligne) et ouvre
    la page des Wants de Cardmarket. Crée/ouvre une liste de wants, clique
    sur **« Ajouter une Deck List »**, colle la liste, puis lance le Shopping
    Wizard. Les terrains de base et les cartes en « version différente » ne
    sont pas exportés.
- **Version différente de ta collection** (encadré rouge, bloquant) : parmi
  les cartes dont le stock est déjà suffisant, si Moxfield indique que tu la
  possèdes, mais pas dans l'édition/finition précise utilisée par ce deck
  (ex. Sol Ring possédé sous une autre édition), elle est listée ici. Comme
  pour le stock insuffisant, **le montage est bloqué** tant que la ligne
  n'est pas corrigée ou retirée de la liste — pas de décompte de stock pour
  cette carte. Cette détection utilise l'indicateur de collection natif de
  Moxfield ; elle ne fonctionne que via le scraping automatique, pas via un
  collage manuel depuis le presse-papiers.
- **Terrains de base** (Plains, Island, Swamp, Mountain, Forest) : exclus des
  deux blocages ci-dessus, puisqu'en pratique on en a toujours assez et que
  leur édition n'a jamais d'importance. Un encadré jaune séparé
  **« Terrains de base à vérifier »** les liste à titre indicatif s'il en
  manque ou si l'édition diffère, mais **n'empêche jamais** de valider le
  montage ; le stock est décompté normalement (peut devenir négatif).

### 3. Consulter / ajuster le stock

- Ouvre le popup de l'extension (icône dans la barre d'outils).
- Tu y vois les decks actuellement montés (avec un bouton pour démonter
  chacun) et le stock complet.
- La section **Stock** est repliée par défaut : clique sur son titre pour
  l'afficher (200 premières cartes ; le filtre cherche dans tout le stock),
  la filtrer par nom, et ajuster une quantité à la main avec les
  boutons +/- (écrasé à la récupération suivante de ta collection Moxfield,
  si elle est active).
- **Savoir où est une carte** : la colonne **Libre** est la quantité
  disponible hors decks montés, la colonne **Decks** le nombre
  d'exemplaires dans des decks montés. Clique sur une carte présente dans
  des decks pour voir lesquels (avec un lien vers chacun) et le total
  possédé. La case **« Seulement les cartes dans des decks montés »** filtre
  la liste sur ces cartes.
- Dans la modale de montage, une carte en stock insuffisant indique aussi
  **dans quels decks montés** se trouvent ses exemplaires — pratique pour
  savoir quel deck démonter plutôt que d'acheter.
- **Zone de danger** : le bouton **« Réinitialiser tout le stock »** vide
  entièrement le stock **et** démonte tous les decks marqués comme montés
  (une confirmation est demandée).

### 4. Synchronisation Google Drive

- Dans le popup, section **Synchronisation Google Drive** : clique une fois
  sur **« Connecter Google Drive »** sur chaque PC et autorise l'accès. Ensuite
  tout est automatique : chaque modification (import, montage, ajustement...)
  est envoyée sur Drive quelques secondes plus tard, et les changements faits
  sur un autre PC sont récupérés à l'ouverture du popup, au démarrage du
  navigateur et toutes les 5 minutes.
- Les données vont dans un dossier caché de ton Drive, réservé à l'extension
  (elle n'a accès à aucun autre fichier).
- **Premier PC connecté** : son stock est envoyé sur Drive. **PC suivants** :
  si ce PC n'a pas encore de stock, celui de Drive est récupéré ; s'il en a
  déjà un, le popup te demande lequel garder.
- **Conflit** (modifications sur deux PC avant qu'ils aient pu se
  synchroniser) : la version modifiée le plus récemment gagne ; l'autre est
  conservée dans l'historique.
- **Historique des versions** : un instantané par jour (et par PC) plus les
  versions écartées lors d'un conflit, les 10 plus récents conservés. Chacun
  peut être restauré ; la version restaurée est aussi appliquée aux autres PC.
- Le bouton **Réinitialiser** de la zone de danger vide aussi le stock des
  autres PC quand la synchro est active.
- Si la connexion Google expire, le popup affiche un avertissement et un
  bouton **« Reconnecter »**. Si le popup se ferme pendant l'autorisation
  Google, rouvre-le.
- **Compte utilisé** : celui connecté au profil Chrome, affiché dans le
  popup (« Compte : ... »). Un seul compte par profil Chrome ; pour gérer
  plusieurs stocks, utilise un profil Chrome par personne. Pour changer de
  compte, change celui du profil Chrome : la synchro se met en pause et le
  popup propose d'envoyer le stock de ce PC sur le nouveau compte ou de
  récupérer celui du nouveau compte. Revenir à l'ancien compte fait
  reprendre la synchro normalement.
- Tant que l'application Google Cloud est en mode « Test », seuls les comptes
  ajoutés comme utilisateurs de test peuvent se connecter. Nécessite Google
  Chrome connecté à un compte Google.

## Limites connues

- Le scraping repose sur des repères structurels de la page, pas sur une
  API officielle — Moxfield n'en fournit pas. La structure lue dépend du
  mode d'affichage (lu dans le sélecteur « View » de Moxfield) : lignes de
  liste en vue Text/Condensed Text, tuiles de carte en Visual Grid, images
  de carte en Visual Stacks. Si Moxfield change sa structure de page, ça
  peut casser ; le compteur comparé au total du site permet de s'en rendre
  compte, et le presse-papiers (bouton Copier de Moxfield) reste la
  solution de secours.
- Le bouton de deck apparaît/disparaît selon l'URL actuelle et la présence
  du badge « Commander », réévalués par un polling léger (toutes les 500ms)
  car Moxfield est une SPA — la navigation interne au site ne recharge pas
  la page, et le badge est affiché après le chargement.
- Après avoir rechargé l'extension dans `chrome://extensions`, rafraîchis
  (F5) les onglets Moxfield déjà ouverts : sinon l'ancienne version de
  l'extension y reste active mais déconnectée (un message te le rappelle).
- Le stock est agrégé par **nom de carte**, toutes éditions/finitions
  confondues (pas de distinction par set ou par version foil).
- La récupération automatique de la collection reproduit les appels que
  fait le site Moxfield (pas d'API publique) : s'ils changent, elle échoue
  avec un message dans le popup, et l'import manuel du CSV reste
  disponible. Elle nécessite d'être connecté à Moxfield dans ce profil
  Chrome.
- Les données sont stockées localement dans le navigateur
  (`chrome.storage.local`) ; sans la synchro Google Drive, rien ne se
  partage entre appareils.

## Développement

### Tests de la lecture des decks

La lecture de la liste d'un deck sur la page (`deck-scraper.js`) est la
partie la plus fragile : elle dépend de la structure HTML de Moxfield, qui
diffère selon la vue et peut changer sans prévenir. Elle est couverte par
des tests automatisés (Node 18+) :

```
npm install
npm test
```

- `tests/fixtures/*.html` : une page par vue (Text, Condensed Text, Visual Grid, Visual Spoiler, Visual
  Stacks, Visual Stacks (Split)), reproduisant la structure réelle de
  Moxfield avec le même deck de 7 cartes, et les pièges déjà rencontrés
  (cartes double face, foil, quantité > 1, tuile en double après une
  modification, restes cachés d'une autre vue, images de l'aperçu latéral).
- **Ajouter une vraie page** (recommandé quand Moxfield change quelque
  chose) : sur la page du deck, DevTools → Elements → clic droit sur
  `<html>` → Copy → Copy outerHTML, colle dans
  `tests/fixtures/pages/<nom>.html`, et crée à côté `<nom>.json` :
  `{ "viewMode": "stacks", "total": 100 }` (valeur du sélecteur « View » :
  `table`, `condensedTable`, `visual`, `stacks`, `splitStacks`, `spoiler`).
  Ajoute si possible `"cards": ["1 Sol Ring", ...]` — la liste du bouton
  « Copier » de Moxfield — pour vérifier aussi le détail.

### Autres tests

Lancés par le même `npm test`, et automatiquement sur GitHub à chaque push
sur `main` (onglet **Actions**, workflow `.github/workflows/tests.yml`) :

- `tests/deck-checks.test.js` : contrôles d'une liste par rapport au stock
  (`deck-checks.js`) — stock insuffisant, version différente, terrains de
  base, mise à jour d'un deck monté, faisabilité affichée sur le bouton,
  lecture d'une liste collée.
- `tests/background.test.js` : gestion du stock par le service worker
  (`background.js`, chargé tel quel avec un faux `chrome.storage`) — import
  CSV, montage/démontage, mise à jour d'un deck monté, badge « Modifié »,
  ajustement manuel, réinitialisation, récupération de la collection
  (import, alarme horaire, récupération après une modification de la
  collection sur Moxfield, erreurs, cartes non couvertes).
- `tests/moxfield-collection.test.js` : dialogue avec Moxfield
  (`moxfield-collection.js`, réponses simulées) — appels et jetons, session
  absente ou expirée, refus, réseau coupé, changement de l'API.
- `tests/popup.test.js` : popup (`popup.html` + `popup.js`, dans une page
  de test avec un faux `chrome`) — section « Collection Moxfield »,
  affichage du stock (tableau limité, filtre).
- `tests/content-deck.test.js` : bouton de la page d'un deck
  (`content-deck.js`, exécuté dans une page de test avec un faux `chrome`) —
  faisabilité affichée, recalcul en direct quand la page ou le stock
  change, tolérance à une liste brièvement incohérente.

Non couverts : la synchro Google Drive, le reste du popup, la fenêtre de
montage et l'intégration à la barre d'actions de Moxfield.

## Crédits

Icônes du bouton de la barre d'actions : [Font Awesome Free](https://fontawesome.com)
6.7.2 (`box-open`, `circle-check`), sous licence
[CC BY 4.0](https://fontawesome.com/license/free).
