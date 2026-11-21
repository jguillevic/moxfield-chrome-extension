# Moxfield Stock Manager (extension Chrome)

Ajoute une gestion de stock de cartes physiques par-dessus Moxfield : flag un
deck comme « monté physiquement » et le stock est décrémenté automatiquement,
carte par carte, selon la decklist. Démonte-le pour réincrémenter.

*English: the extension is available in English and French — it follows
your browser's language. This README is in French.*

## Installation

1. Clone le dépôt (`git clone https://github.com/jguillevic/moxfield-chrome-extension.git`)
   ou décompresse ce dossier quelque part sur ton disque.
2. Ouvre la page des extensions : `chrome://extensions` (Chrome),
   `brave://extensions` (Brave), `edge://extensions` (Edge)…
3. Active le **Mode développeur** (en haut à droite).
4. Clique **Charger l'extension non empaquetée** et sélectionne ce dossier.

### Installer l'extension pour son propre compte

**Compte Moxfield : rien à paramétrer.** L'extension n'a aucun compte
Moxfield codé en dur : elle utilise celui qui est connecté sur
moxfield.com dans le Chrome où elle est installée (son identifiant est lu
dans le cookie de session). Chacun récupère donc sa propre collection, sans
saisir d'identifiant ni de mot de passe.

**Synchronisation Google Drive : crée ta propre application Google
Cloud.** Le dépôt pointe vers l'application Google Cloud de l'auteur
(`oauth2.client_id` dans `manifest.json` pour Google Chrome,
`GOOGLE_WEB_CLIENT_ID` dans `background.js` pour les autres navigateurs),
réservée à son usage : remplace-la par la tienne avant de connecter Drive. Sans synchro, tout le reste fonctionne (les
données restent sur ce PC).

1. Sur [console.cloud.google.com](https://console.cloud.google.com), crée un
   projet et active l'**API Google Drive**.
2. Configure l'**écran de consentement OAuth** (type « Externe »), ajoute le
   champ d'accès `https://www.googleapis.com/auth/drive.appdata`, et ajoute
   ton compte Google comme utilisateur de test (l'application peut rester en
   mode « Test » : elle ne sert qu'à toi).
3. Donne à l'extension sa propre clé, pour que son identifiant soit le même
   sur tous tes PC. Dans un terminal (avec OpenSSL) :
   ```
   openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out cle-extension.pem
   openssl rsa -in cle-extension.pem -pubout -outform DER | openssl base64 -A
   ```
   Remplace la valeur de `"key"` dans `manifest.json` par le texte affiché.
   Garde `cle-extension.pem` pour toi (les fichiers `.pem` sont exclus du
   dépôt par `.gitignore`).
4. Recharge l'extension dans `chrome://extensions` et copie son
   **identifiant** (ID).
5. Dans la console Google Cloud, crée un **identifiant client OAuth** de type
   **« Extension Chrome »**, avec cet identifiant d'extension.
6. Remplace la valeur de `oauth2.client_id` dans `manifest.json` par
   l'identifiant client obtenu, puis recharge l'extension.
7. Pour les navigateurs autres que Google Chrome (Brave, Edge, Opera…),
   crée un second **identifiant client OAuth**, de type **« Application
   Web »**, avec pour **URI de redirection autorisé**
   `https://<identifiant de l'extension>.chromiumapp.org/` (le `/` final
   compte ; `chrome.identity.getRedirectURL()` dans la console du service
   worker l'affiche). Remplace la valeur de `GOOGLE_WEB_CLIENT_ID` dans
   `background.js` par l'identifiant client obtenu (le code secret ne sert
   pas). Google peut mettre quelques minutes à prendre en compte un nouvel
   URI de redirection (erreur `redirect_uri_mismatch` en attendant).

## Utilisation

### 1. Récupérer ta collection (initialiser le stock)

**Automatiquement** : il suffit d'être connecté à Moxfield dans le navigateur.
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
- sans session Moxfield, un lien **« Se connecter à Moxfield »** : une fois
  connecté sur le site, la collection est récupérée aussitôt, sans avoir à
  revenir cliquer sur « Récupérer maintenant » ;
- une alerte si ta collection **ne couvre plus des cartes de decks montés**
  (carte retirée de la collection alors qu'elle est dans un deck monté),
  avec les decks concernés — terrains de base exclus.

L'extension ne connaît ni ne stocke ton mot de passe : elle réutilise la
session Moxfield ouverte dans le navigateur, comme le site lui-même (même jeton de
connexion, renouvelé de la même façon — tu restes connecté). Si tu te
déconnectes de Moxfield, la récupération s'arrête jusqu'à ta prochaine
connexion.

La collection Moxfield est **la seule référence** du stock : chaque
récupération remplace les quantités du stock, et l'extension ne permet pas
de les modifier — pour corriger une quantité, modifie ta collection sur
Moxfield (récupérée 30 secondes plus tard). Les decks déjà marqués comme montés sont réappliqués, sans risque
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
  n'apparaît que sur la page du deck elle-même (pas sur ses sous-pages comme
  `/decks/{id}/history`, ni sur les listes comme `/decks/public`), **quel
  que soit le format** : Commander, mais aussi les formats de 60 cartes
  (Modern, Standard, Pioneer...).
  - Un deck de 60 cartes se monte **avec sa réserve** (sideboard) : ses
    cartes sont dans la liste détectée, comptées dans le total et retirées
    du stock comme celles du deck. Une carte présente à la fois dans le
    deck et dans la réserve apparaît sur une seule ligne, quantités
    additionnées.
- Le bouton est une icône **boîte ouverte** (**cercle coché vert** quand le deck est monté) ajoutée à la
  barre d'actions flottante de Moxfield, en bas à droite, juste après le
  bouton like (cœur). Quand Moxfield n'affiche pas cette barre (elle a
  disparu de la page d'un deck en novembre 2026), les boutons « Monter » et
  « Utiliser mes éditions » sont dans un petit bandeau sombre en bas à
  gauche de la page ; ils retournent dans la barre si elle réapparaît.
- **Faisabilité visible sans ouvrir la fenêtre** : sur un deck pas encore
  monté, une pastille sur le bouton indique si le deck est montable avec le
  stock libre — **« OK » vert** s'il l'est, **rouge avec un nombre** sinon (nombre
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
  ajoutées : stock insuffisant, version différente ou déjà utilisée bloquent
  la mise à jour (le stock disponible compte les exemplaires déjà dans ce
  deck), les terrains de base ne font qu'un avertissement.
  - Une carte dont tu as seulement **changé la version** sur Moxfield compte
    aussi comme une modification (`↻ Steam Vents (version changée)`) : le
    deck n'utilise plus le même exemplaire physique. Le stock ne bouge pas,
    mais la nouvelle version est vérifiée puis enregistrée.
  - Le constat est aussi mémorisé : dans le popup, le deck porte un badge
    orange **« Modifié »** (détail des différences et date du constat au
    survol), et l'en-tête « Decks montés » indique combien le sont. Le badge
    disparaît après « Mettre à jour le montage », au démontage, ou quand la
    page du deck redevient identique au montage. Il reflète la **dernière
    visite** de la page du deck : une modification faite ailleurs (autre
    appareil, onglet fermé tout de suite) n'est connue qu'à la visite
    suivante.
- **Priorité des trois contrôles ci-dessous : le stock d'abord.** Une carte
  dont le stock est insuffisant (même partiellement) n'apparaît que dans
  « Stock insuffisant », jamais dans « Version différente » ni dans
  « Version déjà utilisée » — la version n'est vérifiée qu'une fois le stock
  déjà suffisant pour cette carte.
- **Stock insuffisant** (encadré rouge, bloquant) : liste les cartes dont le
  stock disponible ne suffirait pas si ce deck était monté — y compris une
  carte totalement absente du stock. Dans ce cas, **le montage est bloqué**
  — corrige la liste, mets ta collection Moxfield à jour (ajout des cartes
  achetées), ou retire la/les cartes en trop avant de pouvoir valider.
  - **Acheter les cartes manquantes sur Cardmarket** : le bouton
    **« 🛒 Copier les cartes manquantes pour Cardmarket »** de cet encadré
    copie la liste (`quantité manquante` + nom, une carte par ligne) et ouvre
    la page des Wants de Cardmarket. Crée/ouvre une liste de wants, clique
    sur **« Ajouter une Deck List »**, colle la liste, puis lance le Shopping
    Wizard. Les terrains de base et les cartes en « version différente » ne
    sont pas exportés.
  - **Prix des cartes manquantes** : chaque carte de l'encadré affiche son
    prix (prix unitaire en plus quand il en manque plusieurs), et la ligne
    **« 💶 Coût des cartes manquantes »** en donne le total. C'est le prix
    **Cardmarket** (en euros) de la version utilisée par le deck — la moins
    chère s'il en utilise plusieurs —, tel que Moxfield le donne en ouvrant
    le deck. Une carte sans prix connu est signalée (« au moins … », avec
    le nombre de cartes sans prix) plutôt que comptée pour zéro.
  - **Monter avec des proxies** : quand seul le stock manque, le bouton
    principal de la fenêtre devient **« Confirmer le montage avec N
    proxies »** : il monte quand même le deck, les N exemplaires
    manquants étant joués en **proxy** (carte imprimée). Il redevient
    « Confirmer le montage » dès que plus rien ne manque. Seuls les
    exemplaires qui manquent le sont : avec 1 Sol Ring sur 2, le deck prend
    le vrai et 1 proxy. Un proxy n'est jamais pris à ton stock, ni rendu au
    démontage. Une carte en « version différente » ou « version déjà
    utilisée » bloque toujours (le bouton reste alors « Confirmer le
    montage » et refuse) : un proxy ne règle pas une question d'édition —
    « Utiliser mes éditions » est là pour ça. Même chose pour la mise à
    jour d'un deck monté (**« Mettre à jour avec N proxies »**) ; les
    proxies déjà en place sont gardés.
    Voir « Proxies » ci-dessous pour les imprimer et les remplacer.
- **Version différente de ta collection** (encadré rouge, bloquant) : parmi
  les cartes dont le stock est déjà suffisant, si Moxfield indique que tu la
  possèdes, mais pas dans l'édition/finition précise utilisée par ce deck
  (ex. Sol Ring possédé sous une autre édition), elle est listée ici. Comme
  pour le stock insuffisant, **le montage est bloqué** tant que la ligne
  n'est pas corrigée ou retirée de la liste — pas de décompte de stock pour
  cette carte. Cette détection utilise l'indicateur de collection natif de
  Moxfield ; elle ne fonctionne que via le scraping automatique, pas via un
  collage manuel depuis le presse-papiers.
  - **Utiliser mes éditions** : bouton 🔄 de la barre d'actions de
    Moxfield, juste à gauche du bouton de montage, avec une pastille bleue
    du nombre de cartes que Moxfield indique possédées dans une autre
    édition (masqué s'il n'y en a aucune). Un clic change, dans ton deck
    Moxfield, l'édition de ces cartes pour une édition que tu possèdes — le
    deck reflète alors ce que tu as vraiment. **Le deck n'est pas monté** :
    seules les éditions changent, que le deck soit monté ou non. Pas de
    confirmation : les cartes sont modifiées une à une (comme si tu
    changeais l'édition à la main sur le site ; visible dans l'historique
    du deck sur Moxfield, réversible à la main), puis la page est rechargée
    toute seule, avec le nombre de cartes changées. Pendant ce temps, une
    fenêtre bloque la page et montre l'avancement (recherche des éditions,
    puis cartes changées : « 12 / 66 »). **Decks montés** : une édition
    n'est choisie que s'il t'en reste assez d'exemplaires libres, sans
    ceux que tes autres decks montés tiennent dans cette édition ; sinon
    la carte reste telle quelle (« déjà dans d'autres decks montés »).
    Seuls comptent les decks montés dont l'édition est connue (montés
    depuis la page du deck, avec la session Moxfield) : dans le doute,
    l'extension laisse faire. **Finition** (colonne « Foil » de ta collection) : une carte que
    tu as dans l'édition du deck mais dans une autre finition (ex. foil
    alors que le deck demande la non-foil) garde son édition, et seule sa
    finition change dans le deck. **Foil d'abord** : si tu as un
    exemplaire foil, c'est lui qui est choisi, même si tu as aussi la
    finition du deck ; sinon la finition du deck est gardée si tu l'as,
    sinon celle que tu possèdes. Entre deux éditions dont tu as autant
    d'exemplaires libres, celle que tu as en foil passe devant.
    **Quantité** : une édition n'est choisie que si tu en as assez
    d'exemplaires pour toute la ligne du deck (ex. 11 Plains) — sinon
    Moxfield la signalerait toujours. Les cartes sans autre édition ni
    finition dans ta collection, sans édition qui en couvre la quantité
    (cas courant des terrains de base, répartis sur plusieurs éditions),
    ou sur une ligne du deck qui mélange plusieurs éditions, restent telles
    quelles, et le bouton ne les compte plus sur ce deck jusqu'à la
    fermeture de l'onglet. Si aucune carte n'a pu être changée, la raison
    est affichée, sans recharger.
    Seulement sur tes propres decks (Moxfield refuse sinon), connecté à
    Moxfield dans ce navigateur. C'est la seule modification que
    l'extension fait sur Moxfield.
- **Version déjà utilisée par un autre deck monté** (encadré rouge,
  bloquant) : tu possèdes la carte en plusieurs éditions, il t'en reste un
  exemplaire libre, mais pas dans la version que ce deck demande — celle-là
  est déjà dans un autre deck monté. Exemple : Steam Vents possédée une fois
  en GRN et une fois en RNA ; un deck monté utilise la GRN, un second deck
  demande lui aussi la GRN → refusé, alors que le stock par nom dit qu'il en
  reste une. L'encadré indique le deck qui détient cette version et les
  éditions que tu possèdes (`dans : Niv-Mizzet (1) · tu possèdes : GRN 257
  ×1, RNA 257 ×1`). Pour débloquer : choisis sur Moxfield, pour ce deck, la
  version encore libre, ou démonte l'autre deck. La pastille du bouton
  compte ces cartes parmi les bloquantes.
  - L'extension enregistre pour cela, au montage, la version de chaque
    carte du deck (lue sur la page). Les **decks montés avant cette
    fonctionnalité** n'en ont pas : ouvre une fois la page de chacun, les
    versions sont complétées toutes seules (si la liste n'a pas changé
    depuis le montage). Tant que ce n'est pas fait, leurs cartes ne sont pas
    vues comme « déjà utilisées ».
  - Sur la page d'un deck, l'extension demande aussi à Moxfield l'**édition
    exacte** de chaque version (un appel en fond, avec ta session Moxfield,
    comme pour la collection) : chaque édition est alors comptée à part.
    Steam Vents possédée deux fois en GRN et une fois en RNA, la RNA dans un
    deck monté : un second deck qui demande la RNA est refusé, un deck qui
    demande la GRN passe. Les decks déjà montés reçoivent l'édition de
    leurs versions à la prochaine visite de leur page. Si Moxfield ne
    répond pas (pas connecté, deck privé d'un autre compte), le contrôle
    se fait quand même, par recoupement (cf. « Limites connues »).
  - Le détail de ta collection par édition arrive avec la prochaine
    récupération de la collection (automatique, ou **« Récupérer
    maintenant »** dans le popup).
  - Comme pour la version différente, ce contrôle ne fonctionne qu'avec la
    liste détectée sur la page, pas avec une liste collée.
- **Terrains de base** (Plains, Island, Swamp, Mountain, Forest) : exclus des
  blocages ci-dessus, puisqu'en pratique on en a toujours assez et que
  leur édition n'a jamais d'importance. Un encadré jaune séparé
  **« Terrains de base à vérifier »** les liste à titre indicatif s'il en
  manque ou si l'édition diffère, mais **n'empêche jamais** de valider le
  montage ; le stock est décompté normalement (peut devenir négatif).

#### Proxies

- Un deck monté avec des proxies affiche leur nombre : pastille violette
  sur le bouton du ruban de Moxfield (« Monté physiquement avec 3
  proxies » au survol), badge **« 🃏 3 »**
  dans la liste « Decks montés » du popup (détail au survol), et
  **« Ce deck compte 3 proxies »** dans la fenêtre du deck sur Moxfield.
- **Imprimer** : bouton **« 🖨️ Imprimer »** du popup, ou **« 🖨️ Imprimer
  les proxies »** dans la fenêtre du deck. Une page s'ouvre avec des
  planches A4 de 9 cartes au format réel (63 × 88 mm), traits de coupe
  compris, images de la version du deck (Scryfall). Imprime à **100 %**
  (taille réelle), sans ajustement à la page ; « Enregistrer au format
  PDF » dans la fenêtre d'impression du navigateur donne un PDF. Une carte
  double face occupe deux emplacements (recto et verso, à glisser dos à
  dos dans la même pochette). La mention **« PROXY »** en bas de chaque
  carte est activée par défaut ; la case de la page la retire (choix
  retenu sur ce PC).
- **Remplacer par la vraie carte** : quand tu ajoutes à ta collection
  Moxfield une carte jouée en proxy (achat), le popup propose
  **« Remplacer N proxies »** sur le deck (détail au survol). Rien n'est
  remplacé sans ce clic : la vraie carte est alors prise au stock libre,
  comme au montage, et le proxy disparaît.
- Montage, mise à jour, démontage et remplacement notent les proxies dans
  l'historique.

### 3. Consulter le stock

- Ouvre le popup de l'extension (icône dans la barre d'outils).
- En haut, les chiffres clés : **exemplaires possédés** (libres + dans des
  decks montés), **exemplaires libres**, exemplaires **dans des decks**
  montés et nombre de **cartes différentes** en stock.
- Tu y vois les decks actuellement montés (avec un bouton pour démonter
  chacun) et le stock complet.
- La section **Stock** est repliée par défaut : clique sur son titre pour
  l'afficher (200 premières cartes ; le filtre cherche dans tout le stock)
  et la filtrer par nom. Les quantités ne se modifient pas ici : elles
  viennent de ta collection Moxfield.
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

### 4. Historique

Dans le popup, section **« Historique »** (repliée par défaut) : chaque
action qui a changé le stock ou les decks montés, la plus récente en haut,
avec sa date — et « sur un autre PC » quand elle vient d'un autre PC
synchronisé (Chrome ne donne pas le nom de l'ordinateur) :

- collection Moxfield récupérée ou CSV importé, quand ils changent le stock
  (détail carte par carte : `+1 Lotus Petal (2 → 3)`, limité aux 200
  premières cartes — au-delà, seul le nombre total est indiqué) ;
- deck monté, démonté, montage mis à jour (détail des cartes modifiées) ;
- stock réinitialisé, version de l'historique Google Drive restaurée.

L'historique se consulte seulement : il ne permet pas (encore) d'annuler
une action. Il garde les 200 dernières actions et est synchronisé entre tes PC avec le reste (fusionné
en cas de conflit : rien ne s'y perd).

### 5. Synchronisation Google Drive

- Dans le popup, section **Synchronisation Google Drive** : clique une fois
  sur **« Connecter Google Drive »** sur chaque PC et autorise l'accès. Ensuite
  tout est automatique : chaque modification (récupération de la collection, montage...)
  est envoyée sur Drive quelques secondes plus tard, et les changements faits
  sur un autre PC sont récupérés à l'ouverture du popup, au démarrage du
  navigateur et toutes les 5 minutes.
- Les données vont dans un dossier caché de ton Drive, réservé à l'extension
  (elle n'a accès à aucun autre fichier). Les fichiers y sont compressés
  (gzip) : 4 à 5 fois plus légers pour une grosse collection. Les fichiers
  enregistrés avant la compression restent lisibles, mais **tous tes PC
  doivent avoir une version de l'extension qui la gère** : une ancienne
  version ne sait pas lire un fichier compressé (erreur de synchro, sans
  perte de données — mets-la à jour).
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
- Google Drive momentanément indisponible (erreur 503, trop de requêtes) :
  la requête est réessayée deux fois en quelques secondes, puis la synchro
  suivante reprend. Le popup affiche « momentanément indisponible » ou
  « Google Drive injoignable » (réseau coupé) en attendant.
- Si la connexion Google expire, le popup affiche un avertissement et un
  bouton **« Reconnecter »**. Si le popup se ferme pendant l'autorisation
  Google, rouvre-le.
- **Autres navigateurs que Google Chrome** (Brave, Edge, Opera…) : ils
  n'ont pas de compte Google de profil utilisable par une extension. Une
  fenêtre de connexion Google s'ouvre au clic sur « Connecter Google
  Drive » : choisis ton compte et autorise l'accès. Ensuite, la connexion
  est renouvelée toute seule toutes les heures, sans fenêtre, tant que tu
  restes connecté à Google dans le navigateur ; sinon, le bouton
  « Reconnecter » apparaît. Pour changer de compte : « Déconnecter », puis
  « Connecter Google Drive » avec l'autre compte. **Sous Brave**, si la
  fenêtre ne s'ouvre pas ou échoue, active « Autoriser la connexion Google
  pour les extensions » dans `brave://settings/extensions`.
- **Compte utilisé** (Google Chrome) : celui connecté au profil Chrome, affiché dans le
  popup (« Compte : ... »). Un seul compte par profil Chrome ; pour gérer
  plusieurs stocks, utilise un profil Chrome par personne. Pour changer de
  compte, change celui du profil Chrome : la synchro se met en pause et le
  popup propose d'envoyer le stock de ce PC sur le nouveau compte ou de
  récupérer celui du nouveau compte. Revenir à l'ancien compte fait
  reprendre la synchro normalement.
- Nécessite ta propre application Google Cloud (cf. « Installer
  l'extension pour son propre compte ») : en mode « Test », seuls les comptes
  ajoutés comme utilisateurs de test peuvent se connecter. Sous Google
  Chrome, nécessite un profil connecté à un compte Google.

### 6. Rapports d'erreurs

- Quand l'extension rencontre une erreur inattendue (bug, page Moxfield qui
  a changé, connexion Google impossible…), un **rapport anonyme** est envoyé
  au développeur sur [Sentry](https://sentry.io), pour qu'il voie les
  erreurs de toutes les installations et puisse les corriger.
- Contenu d'un rapport : le message et la pile d'appels de l'erreur,
  l'endroit où elle s'est produite, la version de l'extension, le
  navigateur (Brave reconnu) et le système, et un identifiant tiré au
  hasard propre au PC. **Jamais** ton stock, tes decks ni ton adresse mail ;
  les jetons de connexion et adresses mail qui apparaîtraient dans un
  message sont masqués.
- Ne sont pas envoyées les situations normales (pas connecté à Moxfield,
  réseau coupé, Google Drive momentanément indisponible, service worker de
  l'extension qui redémarre pendant le contrôle d'une page de deck) ni les
  refus expliqués à l'écran (stock insuffisant…).
- Une même erreur part au plus une fois par heure, et 20 rapports au plus
  par jour et par PC.
- Actif par défaut ; pour le couper : popup, section **Rapports d'erreurs**,
  décocher la case.
- Le message d'erreur est dans la langue du navigateur (cf. « Langue »).
- Pour le mainteneur : les rapports arrivent dans le projet Sentry dont la
  DSN est renseignée dans `SENTRY_DSN` (`background.js`). Sans DSN, rien
  n'est envoyé (la case est grisée). La DSN n'est pas un secret : elle ne
  permet que d'envoyer des rapports, pas de les lire.

### 7. Langue

- L'extension s'affiche en **français** ou en **anglais**, selon la langue
  du navigateur (réglages du navigateur → Langues) : popup, bouton et
  fenêtre de montage sur la page d'un deck, messages, historique, nom et
  description dans la liste des extensions. Toute autre langue affiche
  l'anglais.
- Les dates et les prix suivent le format de cette langue (prix toujours en
  euros), et le bouton Cardmarket ouvre la version du site dans cette
  langue.
- L'historique est traduit à l'affichage : une action notée sur un PC en
  français s'affiche en anglais sur un PC en anglais, et inversement.

## Limites connues

- Pas de choix de la langue dans l'extension : elle suit celle du
  navigateur (le système de traduction de Chrome ne permet pas d'en
  changer). Après un changement de langue du navigateur, les messages
  d'erreur déjà affichés (dernière récupération de la collection, synchro
  Google Drive) restent dans l'ancienne langue jusqu'à la prochaine
  tentative.

- Le scraping repose sur des repères structurels de la page, pas sur une
  API officielle — Moxfield n'en fournit pas. La structure lue dépend du
  mode d'affichage (lu dans le sélecteur « View » de Moxfield) : lignes de
  liste en vue Text/Condensed Text, tuiles de carte en Visual Grid, images
  de carte en Visual Stacks. Si Moxfield change sa structure de page, ça
  peut casser ; le compteur comparé au total du site permet de s'en rendre
  compte, et le presse-papiers (bouton Copier de Moxfield) reste la
  solution de secours.
- Le bouton de deck apparaît/disparaît selon l'URL actuelle, réévaluée par
  un polling léger (toutes les 500ms) car Moxfield est une SPA — la
  navigation interne au site ne recharge pas la page.
- Après avoir rechargé l'extension dans `chrome://extensions`, rafraîchis
  (F5) les onglets Moxfield déjà ouverts : sinon l'ancienne version de
  l'extension y reste active mais déconnectée (un message te le rappelle).
- **Decks avec réserve** : la lecture de la réserve n'a pas encore été
  vérifiée sur une vraie page Moxfield (les tests la reconstituent à partir
  d'une page Commander). Si le compteur de la fenêtre de montage passe en
  rouge sur un deck de 60 cartes, la détection est à corriger : une copie
  de la page (cf. « Développement », `tests/fixtures/pages/`) permet de le
  faire.
- Le stock est agrégé par **nom de carte**, toutes éditions/finitions
  confondues : les quantités affichées ne distinguent ni le set ni le foil.
  Seul le contrôle « Version déjà utilisée » regarde les éditions : la page
  d'un deck ne donne que le code Moxfield de la version, la collection une
  édition et un numéro, et c'est un appel à Moxfield (celui que fait le
  site en ouvrant un deck) qui relie les deux. Conséquences :
  - la finition (foil ou non) et la langue ne sont pas distinguées : une
    même édition possédée en foil et en normal compte pour deux exemplaires
    de la même version. C'est voulu pour l'instant : le foil d'une carte
    est rarement tenu à jour dans un deck, le distinguer refuserait des
    montages à tort ;
  - sans réponse de Moxfield (pas connecté, deck privé d'un autre compte,
    appel modifié par Moxfield), ou pour un deck monté dont la page n'a pas
    été rouverte depuis, le contrôle procède par **recoupement** : il
    vérifie seulement que les versions utilisées par les decks montés
    peuvent se répartir sur les éditions possédées. Avec des éditions en
    quantités inégales (une en x2, une en x1), il ne sait pas laquelle est
    demandée : le doute profite au montage, une version possédée en x1
    peut alors être montée deux fois ;
  - même repli si l'édition donnée par Moxfield pour le deck ne se retrouve
    pas à l'identique dans la collection ;
  - cet appel n'a pas pu être essayé hors du navigateur pendant le
    développement (réponse réelle capturée à la main, novembre 2026) ;
  - les quantités libres ne sont pas affichées par édition (cf.
    `ROADMAP.md`).
- **Prix des cartes manquantes** : indicatifs. Ce sont ceux que Moxfield
  affiche pour Cardmarket (sans savoir s'il s'agit du prix de tendance ou
  du prix le plus bas), pour la version du deck, sans tenir compte de la
  finition (prix foil seulement pour une version qui n'existe qu'en foil),
  ni de la langue, ni des frais de port. Une autre édition de la même
  carte peut coûter bien moins cher. Pas de prix sans réponse de Moxfield
  (pas connecté, réseau), ni pour une liste collée depuis le presse-papiers
  (rien n'y indique la version).
- **Utiliser mes éditions** : reproduit les appels que fait le
  site quand on change l'édition d'une carte (observés en novembre 2026,
  pas d'API publique) ; s'ils changent, la modification s'arrête avec un
  message, et les cartes déjà passées sont indiquées. Une ligne du deck
  qui regroupe plusieurs éditions n'est pas touchée. L'édition de ta
  collection est retrouvée chez Moxfield par son code et son numéro : une
  édition notée autrement n'est pas trouvée (carte laissée telle quelle).
  Les cartes sont modifiées une à une (Moxfield exige la version du deck,
  qui change à chaque modification) : compter une demi-seconde par carte
  environ. Comme le bouton de montage, il n'est affiché qu'avec la barre
  d'actions de Moxfield. Il se fie à l'indicateur
  « Partially in collection » de Moxfield, donc pas à une liste collée.
- **Proxies** : suivis dans l'extension seulement, pas sur Moxfield (le
  drapeau proxy de Moxfield n'est ni lu ni écrit). Le remplacement par la
  vraie carte ne vérifie pas son édition (le doute profite au montage). Les
  images viennent de Scryfall : sans réseau, la planche ne porte que les
  noms des cartes ; une version que Scryfall ne connaît pas sous le même
  code est cherchée par son nom (image d'une autre édition). Pour ton usage
  personnel uniquement.
- La récupération automatique de la collection reproduit les appels que
  fait le site Moxfield (pas d'API publique) : s'ils changent, elle échoue
  avec un message dans le popup, et l'import manuel du CSV reste
  disponible. Elle nécessite d'être connecté à Moxfield dans ce profil
  Chrome.
- Grosses collections : l'extension a été vérifiée avec une collection de
  50 000 lignes (30 000 cartes différentes) — import en moins d'une seconde,
  état stocké d'environ 3 Mo (permission `unlimitedStorage` : pas de
  plafond de 10 Mo), détail de l'historique limité à 200 cartes par action,
  et la page d'un deck ne reçoit que le stock de ses propres cartes. Chaque
  modification renvoie en revanche tout l'état sur Google Drive, compressé
  (quelques centaines de Ko avec une telle collection).
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
  Moxfield avec le même deck de 7 cartes (Commander, sans réserve : la
  réserve d'un deck de 60 cartes est reconstituée par les tests, faute de
  page réelle), et les pièges déjà rencontrés
  (cartes double face, foil, quantité > 1, version de chaque carte, tuile en double après une
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
sur toutes les branches (onglet **Actions**, workflow `.github/workflows/tests.yml`) :

- `tests/deck-checks.test.js` : contrôles d'une liste par rapport au stock
  (`deck-checks.js`) — stock insuffisant, version différente, version déjà
  utilisée par un autre deck monté (contrôle exact par édition et repli par
  recoupement), terrains de base, mise à jour d'un deck
  monté, faisabilité affichée sur le bouton, prix des cartes manquantes
  (version la moins chère, total au centime, cartes sans prix), proxies
  (exemplaires pris au stock, proxies ajoutés ou gardés, proxies
  remplaçables, versions tenues par un deck, mise à jour d'un deck qui en a),
  choix de l'édition de la collection pour un deck, lecture d'une liste
  collée.
- `tests/background.test.js` : gestion du stock par le service worker
  (`background.js`, chargé tel quel avec un faux `chrome.storage`) — import
  CSV, montage/démontage, mise à jour d'un deck monté, badge « Modifié »,
  réinitialisation, historique (y compris sa fusion lors de la synchro
  Drive), fichiers Drive compressés (et lecture des anciens), récupération
  de la collection (import, alarme horaire, récupération après une
  modification de la collection sur Moxfield, relance dès la connexion à
  Moxfield, erreurs, cartes non couvertes), stock envoyé à la page d'un deck, collection de 50 000
  cartes, détail de la collection par édition, versions des decks montés
  (complétées, jamais remplacées, édition ajoutée après coup), éditions
  d'un deck lues par l'API (erreurs rapportées ou non), proxies (jamais
  pris au stock ni rendus, valeurs invalides retirées, mise à jour,
  collection récupérée, remplacement par la vraie carte, page
  d'impression), passage d'un deck sur les éditions de la collection
  (proposition sans écriture, application carte par carte avec la version
  du deck relue avant chacune, carte modifiée entre-temps laissée, arrêt à
  la première erreur, refus de Moxfield non rapporté, demandes invalides).
- `tests/history.test.js` : historique (`history.js`) — ajout, limite de
  200 entrées, détail limité à 200 cartes par entrée, fusion, différences
  de listes (changement de version compris), libellés (proxies compris).
- `tests/moxfield-collection.test.js` : dialogue avec Moxfield
  (`moxfield-collection.js`, réponses simulées) — appels et jetons, session
  absente ou expirée, refus, réseau coupé, changement de l'API ; éditions
  et prix des cartes d'un deck (réponse de l'API réduite dans
  `tests/fixtures/api/deck.json`, jeton réutilisé quelques minutes, deck
  introuvable), changement d'édition d'une carte d'un deck (cartes du deck,
  éditions d'une carte réduites dans `tests/fixtures/api/card-editions.json`,
  corps et en-têtes de l'appel, finition, résultat vérifié, refus).
- `tests/popup.test.js` : popup (`popup.html` + `popup.js`, dans une page
  de test avec un faux `chrome`) — sections « Collection Moxfield » et
  « Historique » et « Rapports d'erreurs » (lien de connexion à Moxfield
  compris), chiffres clés (exemplaires possédés, libres, dans des decks),
  affichage du stock (tableau limité, filtre, total possédé d'une carte),
  changement de version d'une carte (badge « Modifié », historique),
  proxies des decks montés (nombre, impression, remplacement proposé ou
  refusé, jamais comptés dans les decks), erreurs rapportées.
- `tests/error-reports.test.js` : rapports d'erreurs (`error-reports.js`)
  — DSN, masquage des jetons et adresses mail, limitation des envois,
  navigateur (Brave), pile d'appels, contenu de l'événement envoyé. Leur
  déclenchement est testé dans `tests/background.test.js` (erreurs
  d'action, de connexion Google, de la collection, Drive indisponible ou
  injoignable non rapporté, case décochée),
  `tests/content-deck.test.js` et `tests/popup.test.js`.
- `tests/google-auth.test.js` : connexion Google hors Google Chrome
  (`google-auth.js`, fenêtre de connexion simulée) — choix de la méthode
  selon le navigateur (Brave compris), choix du compte, renouvellement
  silencieux pour le même compte, jamais de fenêtre en fond, fenêtre
  fermée, réglage Brave, une seule fenêtre pour des demandes simultanées,
  maintien en vie du service worker, jeton refusé, déconnexion. Son
  branchement dans la synchro est testé dans `tests/background.test.js`.
- `tests/content-deck.test.js` : bouton de la page d'un deck
  (`content-deck.js`, exécuté dans une page de test avec un faux `chrome`) —
  faisabilité affichée, recalcul en direct quand la page ou le stock
  change, tolérance à une liste brièvement incohérente, erreurs
  rapportées (contrôle de la page, sauf extension rechargée ou service
  worker injoignable ; erreurs de l'extension mais pas du site), carte
  déjà prise par un autre deck monté jamais reprise au stock (montée en
  proxy), montage refusé pour une version déjà prise alors qu'il en reste
  une d'une autre édition, et accepté quand
  tout est en stock libre, versions enregistrées au montage, complétées sur
  un deck monté qui n'en a pas, deck signalé modifié quand une version
  change, éditions demandées au service worker (montage refusé pour une
  édition possédée en x1 déjà montée, repli sans réponse, pas de demande
  répétée), prix des cartes manquantes (montage, mise à jour, total
  partiel, quantité modifiée à la main, carte absente de la collection ou
  d'une autre édition, sans réponse de Moxfield), montage et mise à jour
  avec N proxies depuis le bouton principal (libellé selon les manques,
  version différente toujours bloquante, proxies du montage gardés),
  proxies d'un deck monté (pastille du bouton) et leur impression,
  « Utiliser mes éditions » (bouton du ruban, jauge, rechargement, cartes
  impossibles à changer, arrêt en cours, erreur), boutons dans un bandeau
  flottant sans la barre d'actions (et passage de l'un à l'autre), état
  « monté » juste en passant d'un deck à l'autre et quand un deck est
  démonté ailleurs, bouton
  et fenêtre de montage en anglais.
- `tests/proxies.test.js` : page d'impression des proxies (`proxies.html`
  + `proxies.js`, Scryfall simulé à partir de vraies réponses réduites
  dans `tests/fixtures/api/scryfall-cards.json`) — recherche par version
  puis par nom (face avant seule), recto et verso des cartes double face,
  paquets de 75 et délai entre deux requêtes, erreurs normales ou
  rapportées, planches de 9 cartes, impression une fois les images
  chargées, mention « PROXY », carte introuvable, deck sans proxy, page en
  anglais.
- `tests/i18n.test.js` : traductions (`i18n.js`, `_locales/`) — mêmes
  clés et mêmes valeurs insérées dans chaque langue, pas de « $ » que Chrome
  refuserait, pluriels complets, nom et description du manifest, toute clé
  utilisée par le code existe et toute clé existante sert, pluriels, dates
  et prix selon la langue, messages illisibles après un rechargement de
  l'extension. Le popup (tous ses textes fixes traduits, popup en anglais)
  et le service worker (erreurs et historique en anglais, historique noté
  dans une langue et affiché dans l'autre) sont testés en anglais dans
  leurs propres fichiers. Les tests attendent les textes français : un
  faux `chrome.i18n` lit les vrais fichiers de langue.

**Ajouter ou modifier un texte affiché** : jamais en dur dans le code. Une
clé dans `_locales/fr/messages.json` **et** `_locales/en/messages.json`,
lue par `t("clé", valeurs…)` (ou `tn("clé", nombre, …)` pour un pluriel :
clés `clé_one` et `clé_other`), ou par un attribut `data-i18n` dans
`popup.html`. Valeurs insérées en `$1`…`$9`, jamais collées l'une à
l'autre. `tests/i18n.test.js` signale une clé oubliée dans une langue.

Non couverts : la synchro Google Drive, le reste du popup, la fenêtre de
montage (hors refus pour stock insuffisant ou version déjà utilisée, prix
des cartes manquantes, proxies, mise à jour après un changement de version
et textes en anglais), l'intégration à la barre d'actions de
Moxfield, le rendu réel de l'impression (taille des cartes sur papier),
et la qualité des traductions elles-mêmes (relecture humaine).

## Crédits

Icônes du bouton de la barre d'actions : [Font Awesome Free](https://fontawesome.com)
6.7.2 (`box-open`, `circle-check`, `arrows-rotate`), sous licence
[CC BY 4.0](https://fontawesome.com/license/free).

Images des cartes de la page d'impression des proxies :
[Scryfall](https://scryfall.com) (API publique, sans clé). Cartes et
illustrations © Wizards of the Coast.
