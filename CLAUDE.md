# Règles du projet

Extension Chrome (MV3) qui gère un stock de cartes physiques par-dessus
Moxfield. Pas de build : les fichiers sont chargés tels quels par Chrome
(cf. `manifest.json`).

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

- Tout en français : commentaires, textes affichés, messages d'erreur. Les
  textes s'adressent à l'utilisateur en le tutoyant.
- Les commentaires expliquent le *pourquoi* (comportement de Moxfield
  observé, piège déjà rencontré), pas le *quoi*. Préciser quand une
  hypothèse sur le DOM a été « confirmée via inspection réelle ».
- Aucune dépendance dans l'extension elle-même ; `package.json` ne sert
  qu'aux outils de développement (tests).
- Un même calcul affiché à deux endroits (ex. pastille du bouton et fenêtre
  de montage) passe par une seule fonction, pour que les chiffres ne
  puissent pas diverger.
- `innerHTML` uniquement avec des valeurs passées par `escapeHtml`.

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
- Terrains de base (Plains, Island, Swamp, Mountain, Forest) : jamais
  bloquants, jamais comptés dans les chiffres de faisabilité, seulement un
  avertissement.
- Priorité au stock : une carte en stock insuffisant n'est jamais aussi
  signalée en « version différente ».
- Les cartes de la zone « Considering » ne font pas partie du deck.
- Les cartes `excludedFromStock` ne sont jamais décomptées ni rendues au
  stock.

## Extension Chrome

- Chaque écriture de l'état part sur Google Drive : n'écrire que si
  quelque chose change.
- Après un rechargement de l'extension, l'ancien content script reste actif
  mais déconnecté (« Extension context invalidated ») : intercepter
  l'erreur. Actions de l'utilisateur via `safeSendMessage` (toast
  explicite) ; contrôles en fond silencieux.
- Ne redessiner un élément de la page que si son contenu change (sinon
  l'infobulle ouverte disparaît).
- Styles injectés : variables CSS posées sur nos seuls éléments racines
  (`.msm-*`), variantes sombres via `prefers-color-scheme`.
- Toute icône tierce est créditée dans le README (section « Crédits »).

## Documentation

- Idées de fonctionnalités et questions ouvertes : `ROADMAP.md`. Une
  fonctionnalité livrée passe dans sa section « Livré ».
- Chaque fonctionnalité visible est décrite dans le README (section
  « Utilisation »), et ses limites dans « Limites connues ».
- Nouveau fichier de tests : mettre à jour la section « Développement » du
  README (y compris la liste de ce qui n'est pas couvert).

## Git et environnement

- Messages de commit en anglais, à l'impératif (« Add… », « Fix… »).
- Ne pas commiter sans que ce soit demandé.
- Pas de Python sur le poste : scripts en Node ou shell.
- Les tests tournent sur GitHub Actions à chaque push sur `main`
  (`.github/workflows/tests.yml`).
- `package-lock.json` ne doit référencer que `https://registry.npmjs.org/` :
  le registre npm du poste est un Artifactory interne, inaccessible depuis
  GitHub. npm redirige tout seul vers le registre configuré en local ; après
  un `npm install`, remplacer les URL de l'Artifactory qui auraient été
  écrites dans le lockfile.
