# Moxfield Stock Manager (extension Chrome)

Ajoute une gestion de stock de cartes physiques par-dessus Moxfield : flag un
deck comme « monté physiquement » et le stock est décrémenté automatiquement,
carte par carte, selon la decklist. Démonte-le pour réincrémenter.

## Installation

1. Décompresse ce dossier quelque part sur ton disque.
2. Ouvre `chrome://extensions`.
3. Active le **Mode développeur** (en haut à droite).
4. Clique **Charger l'extension non empaquetée** et sélectionne ce dossier.

## Utilisation

### 1. Importer ta collection (initialiser le stock)

Ouvre le popup de l'extension (icône dans la barre d'outils Chrome) →
section **« Import de secours (fichier CSV) »**. Sur Moxfield : ouvre ta
collection → bouton Export → CSV → enregistre le fichier → choisis-le via
le bouton **Parcourir** du popup → **Importer ce fichier**.

Réimporter écrase les quantités par la nouvelle collection, mais réapplique
automatiquement les decks déjà marqués comme montés — pas de risque de
doublon, tu peux réimporter aussi souvent que tu veux.

### 1bis. Synchronisation automatique (optionnelle, fiabilité limitée)

Dans le popup de l'extension, section **« Synchronisation automatique »** :
coche la case et choisis un intervalle (15 min / 30 min / 1 h / 2 h).

Une fois activée, la synchro se déclenche toute seule :
- à intervalle régulier, tant qu'un onglet `moxfield.com/collection` est ouvert ;
- à chaque fois que tu charges/rafraîchis cette page.

**Limite importante** : la synchro automatique en tâche de fond ne fonctionne
que si Moxfield expose un vrai lien d'export dans la page (ce qui n'est pas
le cas de la méthode de génération dynamique observée sur ton compte).
Autrement dit, elle risque de ne rien faire en pratique tant qu'elle n'a pas
été retravaillée pour utiliser la même méthode d'interception que le popup —
**l'import via fichier téléchargé (section 1) reste la méthode fiable**
pour l'instant.

### 2. Monter / démonter un deck

- Va sur la page d'un deck (`moxfield.com/decks/...`), y compris en y
  naviguant depuis l'intérieur de Moxfield (le bouton apparaît/disparaît
  dynamiquement selon la page affichée, sans besoin de recharger).
- Clique sur **« 🧰 Marquer comme monté physiquement »** : la liste de
  cartes est détectée automatiquement à partir de la page (scan des images
  de cartes affichées et de leur quantité), quel que soit le mode
  d'affichage du deck (Visual Stacks, Visual Grid, Text...).
- **Vérifie/corrige la liste** avant de valider — c'est un scraping au
  mieux, pas une lecture officielle de Moxfield (qui n'a pas d'API
  publique). Si la liste est vide ou incomplète, clique sur le bouton natif
  **« Copier »** de Moxfield puis sur **« 📋 Coller depuis le
  presse-papiers »** dans la fenêtre, ou colle à la main (Ctrl+V).
- Format attendu, une carte par ligne : `1 Sol Ring`, `2 Island`, etc.
- Valide : le stock est décrémenté. Reclique sur le bouton (devenu vert)
  pour démonter le deck et réincrémenter le stock.
- **Version différente de ta collection** (encadré rouge, bloquant) : si
  Moxfield indique que tu possèdes une carte du deck, mais pas dans
  l'édition/finition précise utilisée par ce deck (ex. Sol Ring possédé sous
  une autre édition), et que tu as quand même du stock pour ce nom de carte,
  elle est listée ici. Comme pour le stock insuffisant, **le montage est
  bloqué** tant que la ligne n'est pas corrigée ou retirée de la liste — pas
  de décompte de stock pour cette carte. Cette détection utilise l'indicateur
  de collection natif de Moxfield ; elle ne fonctionne que via le scraping
  automatique, pas via un collage manuel depuis le presse-papiers.
- **Stock insuffisant** (encadré rouge, bloquant) : liste les cartes dont le
  stock disponible ne suffirait pas si ce deck était monté — y compris une
  carte totalement absente du stock. Dans ce cas, **le montage est bloqué**
  — corrige la liste, ajuste ton stock (import collection à jour, ou
  ajustement manuel dans le popup), ou retire la/les cartes en trop avant de
  pouvoir valider.
- **Terrains de base** (Plains, Island, Swamp, Mountain, Forest) : exclus des
  deux blocages ci-dessus, puisqu'en pratique on en a toujours assez et que
  leur édition n'a jamais d'importance. Un encadré jaune séparé
  **« Terrains de base à vérifier »** les liste à titre indicatif s'il en
  manque ou si l'édition diffère, mais **n'empêche jamais** de valider le
  montage ; le stock est décompté normalement (peut devenir négatif).

### 3. Consulter / ajuster le stock

- Ouvre le popup de l'extension (icône dans la barre d'outils).
- Tu y vois le stock complet (filtrable), les decks actuellement montés, et
  tu peux ajuster une quantité à la main avec les boutons +/-.

## Limites connues

- Le scraping repose sur des repères structurels de la page (classe
  `img-card` sur les images de carte, quantité affichée juste à côté dans
  le DOM), pas sur une API officielle — Moxfield n'en fournit pas. Ça
  fonctionne sur les vues visuelles (Visual Stacks, Visual Grid...) et en
  repli sur les vues texte (Text, Condensed Text). Si Moxfield change sa
  structure de page, ça peut casser ; le presse-papiers (bouton Copier de
  Moxfield) reste alors la solution de secours.
- Le bouton de deck apparaît/disparaît en fonction de l'URL actuelle,
  surveillée par un polling léger (toutes les 500ms) car Moxfield est une
  SPA — la navigation interne au site ne recharge pas la page.
- La synchronisation automatique en tâche de fond (réglage dans le popup)
  ne fonctionne que si Moxfield expose un vrai lien d'export ; ce n'est pas
  garanti sur tous les comptes. L'import via fichier téléchargé reste la
  méthode fiable.
- Le stock est agrégé par **nom de carte**, toutes éditions/finitions
  confondues (pas de distinction par set ou par version foil).
- Les données sont stockées localement dans le navigateur
  (`chrome.storage.local`) : pas de synchronisation entre appareils.
