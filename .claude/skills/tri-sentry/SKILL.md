---
name: tri-sentry
description: Séance de tri des idées (User Feedback) et des erreurs reçues dans Sentry pour l'extension — lecture, classement (bug, ROADMAP, écartée), réponses à rédiger, résolution dans Sentry. À utiliser quand l'utilisateur dit « on trie les idées », « regarde Sentry », « qu'est-ce qu'on a reçu », ou demande de vérifier qu'une idée ou une erreur est arrivée.
---

# Tri des idées et des erreurs Sentry

Le circuit complet est dans [`docs/traitement-des-idees.md`](../../../docs/traitement-des-idees.md) :
le lire d'abord, il fait référence. Ce skill ajoute le mode opératoire
avec les outils MCP Sentry et les pièges rencontrés.

## Accès

- Outils `mcp__sentry__*` (charger les schémas par ToolSearch). Toujours
  `organizationSlug: "jguillevic-corp"`, `regionUrl: "https://de.sentry.io"`,
  projet `javascript`, et `fresh: true` pour ne pas lire un cache.
- Serveur non autorisé : demander à l'utilisateur de lancer `/mcp` dans
  une session interactive (`claude` dans un terminal), choisir `sentry`,
  « Authenticate », puis recharger la fenêtre.

## Déroulé

1. **Idées** : `search_issues`, `query: "issue.category:feedback firstSeen:-7d"`
   (adapter à la date de la dernière séance), `sort: "new"`, **sans**
   `is:unresolved` — le filtre anti-spam de Sentry archive tout seul les
   messages qu'il juge vides (« Test », « efrefs » constatés), et une vraie
   idée courte peut y passer.
2. Pour chacune, `get_issue_details` : texte dans
   `contexts.feedback.message`, adresse dans `contact_email`, langue dans
   le tag `lang`, version dans `release`. Le titre et les étiquettes
   `ai_categorization` sont générés par Sentry (parfois en anglais) : se
   fier au texte.
3. Classer selon le tableau du document (bug / déjà dans la ROADMAP /
   nouvelle / contraire aux règles / question / test) et **proposer** à
   l'utilisateur, idée par idée, l'action dans le dépôt et dans Sentry.
   Ne rien écrire dans `ROADMAP.md` ni résoudre avant son accord.
4. **Erreurs** : `search_issues`, `query: "is:unresolved issue.category:error"`.
   Pour chacune, `search_issue_events` puis les événements un par un
   (`get_sentry_resource` avec l'URL de l'événement) : réponse de Moxfield
   dans `extra.response`, code dans `extra.code`, version, pile. Recouper
   les dates avec `git log` pour savoir si la cause est déjà corrigée.
5. **Clôture** (après accord) : `update_issue` avec `status: "resolved"`,
   `inRelease: "moxfield-stock-manager@<version qui corrige>"` (elle doit
   exister dans Sentry : une version déjà vue sur un envoi) et un `reason`
   qui donne la cause et le commit. Idée hors sujet ou test :
   `status: "ignored"`, `ignoreMode: "forever"`, avec la raison.
6. **Réponses** : pour chaque idée avec `contact_email`, rédiger un mail
   court (modèles dans le document), dans la langue du tag `lang`. Ne
   jamais l'envoyer : c'est l'utilisateur qui l'envoie.

## Pièges constatés

- **Délai** : une idée met de quelques secondes à quelques minutes à
  apparaître dans la recherche. Si elle manque juste après l'envoi,
  attendre (commande `sleep 300` en fond) puis relire, plutôt que de
  conclure à une perte.
- **Numéros en base 36** : après `JAVASCRIPT-9` vient `JAVASCRIPT-A`, pas
  `JAVASCRIPT-10`.
- **Version d'un envoi** : la `release` vient du numéro de version que
  Chrome a lu au dernier rechargement de l'extension, pas forcément du
  code qui tourne (le service worker relit son code seul). Pour un essai,
  faire recharger l'extension dans `chrome://extensions`.
- **`find_dropped_events`** : statistiques en retard de plusieurs minutes ;
  « aucun rejet » juste après un envoi ne prouve rien.
- **Confidentialité** : le dépôt est public — ni adresse mail, ni texte
  recopié mot pour mot, ni identifiant dans `ROADMAP.md`, les commits ou
  les tests. Reformuler et compter les demandes.
