---
name: etude-de-marche
description: Fait ou met à jour l'étude de marché de l'extension (concurrents, forces et manques, demandes des utilisateurs sur les forums, fonctionnalités classées par attrait × simplicité) dans docs/etude-de-marche.md. À utiliser quand l'utilisateur demande quoi faire ensuite, ce que font les concurrents, ou de revoir le classement des idées.
---

# Étude de marché

Référence : [`docs/etude-de-marche.md`](../../../docs/etude-de-marche.md)
(novembre 2026). La mettre à jour plutôt que d'en refaire une, sauf
demande contraire.

## Recherche

- Recherches web en parallèle (mode « standard », « extended » pour ce
  qui est récent ou difficile à trouver) : fiches du Chrome Web Store et
  de Firefox, sites et guides des outils, applications mobiles, forums de
  suggestions (Moxfield nolt.io, Archidekt, Deckbox, TappedOut, Reddit).
- Pour chaque concurrent : type, ce qu'il fait **sur notre besoin** (stock
  physique, decks montés), limites relevées (avis, forums). Ce qu'ils
  *annoncent* n'est pas ce qu'ils font : le dire (« aucun installé ni
  testé »).
- Feuille de route publique de Moxfield : ce qu'il pourrait livrer
  lui-même est notre premier risque.
- Toujours garder les liens : section « Sources » en fin de document.

## Classement

- **Score = attrait × simplicité** (25 au plus). Attrait 1 (marginal) à
  5 (très demandé), d'après les demandes publiques ; simplicité 1 (gros
  chantier) à 5 (très simple), d'après le code existant (lire les
  fichiers concernés avant de noter).
- Chaque ligne : rang, fonctionnalité, attrait, simplicité, score,
  origine (« ROADMAP n° X » ou « nouveau »), et **pourquoi ces notes**
  en une phrase.
- Fonctionnalité livrée : la laisser à son rang avec « (livré en X.Y.Z) ».
- Idées reçues des utilisateurs (skill `/tri-sentry`) : « demandée N
  fois » augmente l'attrait.
- Le score ignore les dépendances : les signaler dans « Lecture du
  classement ».

## Rendu

- Mettre à jour le document (méthode et limites datées, concurrents,
  position — ce que nous avons, ce qui nous manque, risques —, tableau,
  lecture, sources), puis répercuter dans `ROADMAP.md` (lien et rangs).
- À l'utilisateur : où on en est (livré / à faire, tableau court), et une
  recommandation des 2 ou 3 prochaines fonctionnalités, avec pourquoi.
