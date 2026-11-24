---
name: verifier-confidentialite
description: Compare ce que l'extension annonce envoyer (popup, README, fiche du Store) avec ce qui part vraiment du code et ce qui est réellement enregistré chez le service (Sentry, Moxfield, Google Drive), et liste les écarts. À utiliser quand un envoi de données est ajouté ou modifié, avant une publication, ou quand l'utilisateur s'inquiète de ce qui est collecté.
---

# Vérifier la confidentialité : annoncé, envoyé, enregistré

Trois niveaux qui doivent correspondre ; un écart entre eux est un défaut,
même si la donnée paraît anodine (constaté : Sentry déduisait l'adresse
IP et la ville de chaque envoi, absentes de nos textes).

## 1. Ce qui est annoncé

Relever mot pour mot les promesses :
- popup (`_locales/*/messages.json` : clés `feedbackPrivacy`,
  `errorReportsHint`…) ;
- README (« Rapports d'erreurs », « Proposer une idée », « Synchronisation
  Google Drive ») ;
- `CLAUDE.md` (« Jamais l'état, les decks ni l'adresse mail dans un
  rapport ») ;
- fiche du Chrome Web Store si publiée (déclaration des données).

## 2. Ce qui part du code

- Lire les fonctions qui construisent les envois (`buildEvent`,
  `buildFeedback`, `sentryUser` dans `error-reports.js` ; appels
  Moxfield dans `moxfield-collection.js` ; Drive dans `background.js`).
- Vérifier par les tests qui figent le contenu exact (ex. liste des clés
  d'un événement dans `tests/error-reports.test.js` et
  `tests/background.test.js`) ; en ajouter s'il en manque.

## 3. Ce qui est enregistré chez le service

- Sentry : faire un envoi réel (idée de test, avec un texte réaliste pour
  passer le filtre anti-spam), puis le lire avec les outils MCP (skill
  `/tri-sentry`) : `user` (ipAddress, geo, email), `tags`, `contexts`,
  `extra`, `request`. Ce que le service **ajoute** de lui-même (adresse
  IP, localisation, en-têtes) compte autant que ce qu'on envoie.
- Faire **recharger l'extension** avant l'essai et vérifier que la
  `release` enregistrée est la bonne : sinon on teste l'ancien code.

## Corriger un écart

Par ordre de préférence :
1. Ne pas collecter (code, avec test) — méthode documentée par le
   service, vérifiée par un envoi réel (constaté : un champ non documenté
   a fait perdre un envoi sans erreur).
2. Réglage du service (ex. Sentry, « Prevent Storing of IP Addresses »,
   règles de nettoyage) — noté dans `docs/traitement-des-idees.md` pour
   qu'il ne se perde pas.
3. À défaut, l'**annoncer** honnêtement dans tous les textes du niveau 1.

Rendre à l'utilisateur un tableau donnée → annoncée ? → envoyée ? →
enregistrée ? → action.
