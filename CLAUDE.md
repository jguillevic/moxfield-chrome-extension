# Règles du projet

Extension Chrome (MV3) qui gère un stock de cartes physiques par-dessus
Moxfield. Pas de build : les fichiers sont chargés tels quels par Chrome
(cf. `manifest.json`).

## Skills du projet

Modes opératoires dans `.claude/skills/` : `/livrer` (checklist de fin
de fonctionnalité, à dérouler avant de proposer un commit),
`/verifier-tests`, `/ajouter-texte`, `/capture-ecran`,
`/revue-ergonomie`, `/verifier-confidentialite`, `/tri-sentry`,
`/etude-de-marche`. Un piège nouveau rencontré en les suivant y est
ajouté.

## Tests automatisés

- Toute nouvelle fonctionnalité (ou correction de bug) est livrée avec des
  tests automatisés qui la couvrent, dans `tests/` (`npm test`).
- Code difficile à tester tel quel : on en extrait la logique dans un module
  testable (cf. `deck-scraper.js`, `deck-checks.js` : fabrique
  `createXxx(...)` + `module.exports` conditionnel, chargé avant
  `content-deck.js` dans le manifest), ou on l'exécute dans une page jsdom
  avec un faux `chrome` (cf. `tests/content-deck.test.js`,
  `tests/background.test.js`).
- Vérifier que les nouveaux tests échouent bien sans le code qu'ils couvrent
  (casser volontairement la règle testée, puis restaurer).
- Un bug constaté en vrai (capture, cas utilisateur) est reproduit par un
  test avant ou avec sa correction.

## Code

- Commentaires en français.
- Textes affichés (libellés, messages d'erreur) : jamais en dur, toujours
  traduits en français **et** en anglais dans `_locales/<langue>/messages.json`,
  lus par `t()` / `tn()` (pluriels) ou `data-i18n` (cf. `i18n.js`). En
  français, les textes s'adressent à l'utilisateur en le tutoyant.
- L'historique et l'état ne stockent que des données, jamais un libellé :
  il est calculé à l'affichage, dans la langue du moment.
- Les commentaires expliquent le *pourquoi* (comportement de Moxfield
  observé, piège déjà rencontré), pas le *quoi*. Préciser quand une
  hypothèse sur le DOM a été « confirmée via inspection réelle ».
- Aucune dépendance dans l'extension elle-même ; `package.json` ne sert
  qu'aux outils de développement (tests).
- Un même calcul affiché à deux endroits (ex. pastille du bouton et fenêtre
  de montage) passe par une seule fonction, pour que les chiffres ne
  puissent pas diverger.
- `innerHTML` uniquement avec des valeurs passées par `escapeHtml`.

## Ergonomie

- Tout écran nouveau ou modifié suit `docs/charte-ergonomique.md`
  (vocabulaire, un seul bouton principal jamais destructif, action
  impossible désactivée avec sa raison, retour annoncé, clavier, contraste
  AA, rien seulement au survol) et passe sa liste « Avant de livrer ».

## Lecture de la page Moxfield (scraping)

- Pas d'API publique : on s'appuie sur des repères stables (`data-icon` des
  icônes Font Awesome, ids `collection_full_/pt_/no_`, `id<N>-legal-<code>`,
  classes sémantiques comme `badge-header`), jamais sur les classes générées
  (type `rueHSSzYMIFGgjgPnfBE`).
- Ne rien conclure d'une liste non fiable : le total détecté doit
  correspondre au total annoncé par Moxfield. Pendant un rendu transitoire,
  garder le dernier état plutôt que d'afficher un constat faux.
- Moxfield est une SPA : tout ce qui dépend de la page est réévalué
  (polling, `MutationObserver`), pas seulement au chargement.
- Une nouvelle structure de page rencontrée = une nouvelle page dans
  `tests/fixtures/`.

## Règles métier

- La collection Moxfield est la seule source de vérité du stock : pas
  d'ajustement de quantités possédées dans l'extension (on corrige la
  collection sur Moxfield). L'extension ne fait que retirer du stock libre
  les cartes des decks montés.
- Le stock est suivi par nom de carte (toutes éditions confondues), stocké
  sous forme normalisée (`normalizeName`).
- Les éditions ne servent qu'à refuser une version déjà prise par un autre
  deck monté (`computeVersionConflicts`). Le code Moxfield d'une version
  (page du deck) et l'édition de la collection (CSV) ne sont reliés que par
  l'API du deck (`GET_DECK_PRINTINGS`, versions `{code, qty, set, cn}`) :
  sans elle, ne jamais supposer quel code correspond à quelle édition
  (repli par recoupement), et dans le doute laisser monter. Finition et
  langue ne sont pas distinguées. Priorité au stock, puis à la version
  différente.
- Terrains de base (Plains, Island, Swamp, Mountain, Forest) : jamais
  bloquants, jamais comptés dans les chiffres de faisabilité, seulement un
  avertissement.
- Priorité au stock : une carte en stock insuffisant n'est jamais aussi
  signalée en « version différente ».
- Les cartes de la zone « Considering » ne font pas partie du deck.
- Les cartes `excludedFromStock` ne sont jamais décomptées ni rendues au
  stock.
- Proxies (`proxyQty` d'une carte d'un deck monté) : ne font pas partie du
  stock (la collection Moxfield reste la seule source de vérité), donc
  jamais décomptés ni rendus, ni comptés « dans des decks ». Toujours
  passer par `stockQtyOf` / `proxyCountOf` (`deck-checks.js`). Un proxy
  ajouté par l'extension (« avec N proxies ») ne remplace qu'un stock
  insuffisant, jamais une version différente ou déjà utilisée. Exception :
  une carte marquée proxy dans le deck sur Moxfield (`declaredProxies`) est
  un proxy d'office, même possédée ou d'une autre édition (choix de
  l'utilisateur) ; les contrôles ne portent que sur la part prise au stock
  (`stockPartOf`). Rien n'est écrit sur Moxfield.
- Seule écriture sur Moxfield : passer, dans un deck, des cartes possédées
  dans une autre édition sur l'édition de la collection
  (`PLAN_OWNED_EDITIONS` puis `APPLY_OWNED_EDITIONS`), en un seul clic sur
  un bouton explicite (« Utiliser mes éditions », dans la barre d'actions,
  sans confirmation : choix de l'utilisateur), seulement sur un deck du
  compte connecté (`deckOwnedBy` ; bouton désactivé sinon), carte par carte (jamais
  d'écritures en parallèle : chacune change la version du deck), deck lu
  une fois puis relu sur un refus avant une seule nouvelle tentative,
  réponse vérifiée ; la page est
  ensuite rechargée. Ne monte jamais le deck. Toute autre écriture sur Moxfield demande
  la même prudence (action explicite, vérification de la réponse).
- Toute nouvelle action qui change le stock ou les decks montés est notée
  dans l'historique (`recordHistory`, cf. `history.js`).

## Extension Chrome

- Chaque écriture de l'état part sur Google Drive : n'écrire que si
  quelque chose change.
- Penser aux grosses collections (référence : 50 000 lignes de CSV, 30 000
  noms, ≈ 3 Mo d'état) : ne pas faire circuler l'état complet quand une
  partie suffit (la page d'un deck passe par `GET_DECK_CONTEXT`, jamais
  `GET_STATE`), et borner tout ce qui s'accumule (historique : 200 entrées,
  200 cartes de détail par entrée).
- Après un rechargement de l'extension, l'ancien content script reste actif
  mais déconnecté (« Extension context invalidated ») : intercepter
  l'erreur. Actions de l'utilisateur via `safeSendMessage` (toast
  explicite) ; contrôles en fond silencieux.
- Ne redessiner un élément de la page que si son contenu change (sinon
  l'infobulle ouverte disparaît).
- Erreur inattendue (bug, réponse anormale) : la rapporter
  (`reportError` dans le service worker, message `REPORT_ERROR` depuis une
  page). Jamais l'état, les decks ni l'adresse mail dans un rapport ; pas
  de rapport pour une situation normale (pas connecté à Moxfield, réseau
  coupé) ni pour un refus expliqué à l'utilisateur. Seule exception pour
  l'adresse mail : celle que l'utilisateur tape lui-même dans « Proposer
  une idée » (retour d'utilisateur Sentry, `SEND_FEEDBACK`).
- Styles injectés : variables CSS posées sur nos seuls éléments racines
  (`.msm-*`), variantes sombres via `prefers-color-scheme`.
- Toute icône tierce est créditée dans le README (section « Crédits »).

## Documentation

- Idées de fonctionnalités et questions ouvertes : `ROADMAP.md`. Une
  fonctionnalité livrée passe dans sa section « Livré ».
- Idées et erreurs reçues dans Sentry : triées selon
  `docs/traitement-des-idees.md` (jamais d'adresse mail ni de texte
  d'utilisateur recopié dans le dépôt, qui est public).
- Chaque fonctionnalité visible est décrite dans le README (section
  « Utilisation »), et ses limites dans « Limites connues ».
- Nouveau fichier de tests : mettre à jour la section « Développement » du
  README (y compris la liste de ce qui n'est pas couvert).

## Git et environnement

- Messages de commit en anglais, à l'impératif (« Add… », « Fix… »).
- Ne pas commiter sans que ce soit demandé.
- Pas de Python sur le poste : scripts en Node ou shell.
- Les tests tournent sur GitHub Actions à chaque push, sur toutes les branches
  (`.github/workflows/tests.yml`).
- Version (`version` du manifest, affichée dans le popup) : augmentée dans
  le même commit que toute modification de l'extension livrée sur `main`
  — correctif (0.3.0 → 0.3.1) pour une correction, mineur (→ 0.4.0) pour
  une fonctionnalité, majeur pour une étape (publication sur le Store).
  Contrôlé sur GitHub Actions à chaque push sur `main`
  (`scripts/check-version.js`).
- `package-lock.json` ne doit référencer que `https://registry.npmjs.org/` :
  le registre npm du poste est un Artifactory interne, inaccessible depuis
  GitHub. npm redirige tout seul vers le registre configuré en local ; après
  un `npm install`, remplacer les URL de l'Artifactory qui auraient été
  écrites dans le lockfile.
