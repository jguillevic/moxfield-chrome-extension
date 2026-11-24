# Traitement des idées et des erreurs reçues

Ce que deviennent les idées envoyées par « Proposer une idée » (popup) et
les rapports d'erreurs : où elles arrivent, qui les trie, quand, et ce
qu'on en fait.

## Où elles arrivent

- **Sentry**, organisation `jguillevic-corp`, projet `javascript` (région
  UE, `https://de.sentry.io`).
- **Idées** : issues de catégorie « feedback », titre « User Feedback : … »,
  étiquette `where: feedback`. Le texte est dans `contexts.feedback.message`,
  l'adresse de contact (facultative) dans `contact_email`.
- **Erreurs** : issues de catégorie « error », étiquette `where` = endroit
  du code (ex. `moxfield-edition-change`, `drive-sync`).
- Chaque idée et chaque erreur porte l'identifiant au hasard du PC
  (`user.id`) : plusieurs envois d'une même installation se reconnaissent.

## Réglages Sentry à garder

- **Adresses IP non stockées** : Sentry déduit l'adresse IP (et une ville)
  de chaque envoi, alors que l'extension ne l'envoie pas et ne l'annonce pas.
  Paramètres du projet → *Security & Privacy* → cocher **Prevent Storing of
  IP Addresses**. Constaté en vrai : l'adresse disparaît, mais Sentry
  garde la ville qu'il en a déduite, même avec `user.ip_address: null`
  dans l'envoi (version 0.11.0, `sentryUser` dans `error-reports.js`,
  gardé car documenté) et avec une règle sur `$user.geo`.
- **Localisation retirée** : trois règles de nettoyage (*Advanced Data
  Scrubbing* : méthode *Remove*, type *Anything*), sources
  **`$user.geo.city`**, **`$user.geo.country_code`** et
  **`$user.geo.region`**. Vérifiées par des envois réels (24/11/2026) :
  `user.geo` vide, `ipAddress` vide.
- Un champ non documenté (`sdk.settings.infer_ip`) a été essayé : l'envoi
  n'est jamais arrivé. Ne pas le remettre.
- **Être prévenu** : vérifier qu'un mail arrive pour une nouvelle idée ;
  sinon, créer une alerte (*Alerts* → nouvelle règle sur les issues de
  catégorie feedback, action : mail).

## Qui, quand, comment

- **Qui** : le mainteneur, avec Claude Code (serveur MCP Sentry, autorisé
  par `/mcp`), qui lit les idées et les erreurs, propose un classement et
  rédige les réponses.
- **Quand** : une séance par semaine (« on trie les idées et les
  erreurs »). Plus tôt seulement pour une erreur qui bloque des
  utilisateurs (beaucoup d'occurrences ou de PC différents).
- **Quoi lire** : dans Sentry, projet `javascript`, les idées reçues
  depuis la dernière séance **quel que soit leur état**
  (`issue.category:feedback firstSeen:-7d`, sans `is:unresolved`) : le
  filtre anti-spam de Sentry archive tout seul les messages qu'il juge
  vides de sens (« Test », constaté en vrai), et une vraie idée courte
  pourrait y passer. Puis les erreurs (`is:unresolved`).
- **Délai** : une idée met quelques minutes à apparaître dans la
  recherche de Sentry (constaté : absente juste après l'envoi, présente
  ensuite).

## Pour chaque idée

| Cas | Action dans le dépôt | Action dans Sentry |
|---|---|---|
| **Bug** décrit par l'utilisateur | Reproduit par un test, corrigé (cf. CLAUDE.md) | Résolue dans la version qui corrige |
| **Idée déjà dans `ROADMAP.md`** | Ajouter ou augmenter « demandée N fois » dans sa colonne « Pourquoi » ; son rang peut monter | Résolue, commentaire « ROADMAP n° X » |
| **Idée nouvelle** | Nouvelle ligne dans `ROADMAP.md`, notée attrait × simplicité (cf. `docs/etude-de-marche.md`) | Résolue, commentaire « ROADMAP n° X » |
| **Contraire aux règles** (ex. modifier la collection : Moxfield reste la seule source de vérité) | Rien, ou une question ouverte si l'idée mérite débat | Archivée pour toujours, commentaire avec la raison |
| **Question d'utilisation** | Si la réponse manque au README, la compléter | Résolue après réponse |
| **Message vide de sens, test** | Rien | Archivée pour toujours |

**Confidentialité** : le dépôt est public. Ni l'adresse mail, ni le texte
d'une idée recopié mot pour mot, ni rien qui identifie la personne n'entre
dans `ROADMAP.md`, les commits ou les tests : on reformule l'idée et on
compte les demandes.

## Pour chaque erreur

- Lire les événements (réponse de Moxfield, `extra`, version, pile).
- Situation normale ou refus expliqué à l'utilisateur : ne devrait pas être
  rapporté (cf. CLAUDE.md) ; corriger le déclenchement du rapport.
- Bug : reproduit par un test, corrigé, puis résolue **dans la version qui
  corrige** (Sentry la rouvre comme régression si elle revient ensuite),
  avec un commentaire qui donne la cause et le commit. Sinon, un commit
  contenant `Fixes JAVASCRIPT-<n>` la résout aussi (intégration GitHub).
- Cause déjà corrigée dans une version publiée : résolue dans cette
  version, même commentaire.

## Répondre

- Seulement si la personne a laissé son adresse (`contact_email`).
- Claude rédige, le mainteneur envoie depuis sa propre messagerie (jamais
  d'envoi automatique). Court, dans la langue de l'idée (étiquette `lang`),
  en tutoyant en français :
  - « Merci pour ton idée ! Elle est notée pour une prochaine version. »
  - Idée écartée : merci, puis la raison en une phrase.
  - Bug : merci, ce qui a été corrigé, et dans quelle version.
- À la livraison d'une idée demandée avec une adresse : prévenir la
  personne. Les autres le voient dans la carte « Nouvelle version » du
  popup.

## À la livraison

- La fonctionnalité passe dans « Livré » de `ROADMAP.md` (avec « demandée
  N fois » si c'est le cas) et est décrite dans le README.
