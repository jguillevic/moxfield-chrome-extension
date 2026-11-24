---
name: revue-ergonomie
description: Fait relire un écran de l'extension (popup, fenêtre de montage, page d'un deck, page des proxies) par un agent spécialiste de l'ergonomie, qui rend des constats classés bloquant / important / mineur avec libellés fr/en proposés. À utiliser quand l'utilisateur trouve un écran peu pratique, demande l'avis d'un « expert ergonomie », ou avant de livrer un écran important.
---

# Revue d'ergonomie par un agent

Un regard qui n'est pas ancré sur le mien : l'agent reçoit le **code et
les faits**, pas ma conclusion. Il ne modifie rien ; c'est moi qui
applique ensuite, après accord de l'utilisateur.

## Préparer le brief

L'agent ne connaît que ce que je lui écris. Le brief contient :

- **Le rôle** : spécialiste de l'ergonomie des interfaces et des popups
  d'extensions Chrome (MV3). Lecture seule, rapport en français, concis.
- **Le contexte** : extension qui gère un stock de cartes Magic
  physiques par-dessus Moxfield ; ce que fait l'écran.
- **Les remarques de l'utilisateur, mot pour mot**, et ce qu'il a
  constaté en vrai (décrire sa capture d'écran : l'agent ne la voit pas).
- **Les fichiers à lire**, avec ce qu'il faut y chercher : HTML, JS
  (fonctions concernées), CSS (sélecteurs), `_locales/*/messages.json`
  (préfixe des clés), `docs/charte-ergonomique.md` (à appliquer),
  `ROADMAP.md` (lots d'ergonomie prévus, pour que les propositions s'y
  articulent).
- **Les contraintes** : popup de 400 px de large, padding 12 px ;
  français et anglais ; clavier et lecteur d'écran.
- **Les questions précises** (emplacement, retour après action,
  libellés, accessibilité…), et ce qui n'est pas en question.
- **Le rendu attendu** : constats classés bloquant / important / mineur,
  chacun avec constat → pourquoi (règle de la charte ou principe) →
  recommandation concrète (emplacement, libellé exact fr **et** en,
  comportement), fichiers cités avec numéros de ligne ; puis une
  recommandation globale en quelques lignes, et ce qui relève des lots
  déjà prévus.

Lancer avec l'outil Agent (type `general-purpose`), en fond si j'ai autre
chose à faire. Pour une question de largeur ou de mise en page,
demander une **estimation chiffrée** (largeur de chaque élément, pire
cas fr/en) puis la confirmer par `/capture-ecran`.

## Après le rapport

- Le résumer à l'utilisateur : d'abord les bloquants, puis le reste en
  une ligne chacun ; dire ce que je retiens et pourquoi.
- Appliquer après accord (ou si l'utilisateur m'a laissé choisir), avec
  un test par règle testable et le défaut constaté en vrai reproduit par
  un test.
- Une règle nouvelle et durable (ex. ordre de l'en-tête) va dans la
  charte.
