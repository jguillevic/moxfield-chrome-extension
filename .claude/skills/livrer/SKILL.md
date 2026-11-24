---
name: livrer
description: Checklist de fin d'une fonctionnalité ou d'une correction de l'extension, avant de proposer un commit — tests (et vérification qu'ils échouent sans le code), textes fr/en, charte ergonomique, README, ROADMAP, version. À utiliser quand une fonctionnalité est « finie », ou quand l'utilisateur demande de livrer, de préparer le commit ou de vérifier que tout est fait.
---

# Livrer une fonctionnalité

Les règles viennent de `CLAUDE.md` ; ce skill les ordonne en une liste
à dérouler **dans l'ordre**, sans en sauter. Cocher au fur et à mesure,
et dire à la fin ce qui a été fait, vérifié, ou laissé de côté (et
pourquoi).

## 1. Tests

- [ ] Chaque règle nouvelle ou modifiée a un test dans `tests/` (module
      extrait `createXxx` + `module.exports`, ou page jsdom avec faux
      `chrome`, cf. `tests/popup.test.js`, `tests/background.test.js`).
- [ ] Un bug constaté en vrai (capture, cas utilisateur) est reproduit
      par un test, avec un commentaire « Constaté en vrai : … ».
- [ ] `npm test` : 0 échec. Annoncer le nombre de tests.
- [ ] Les nouveaux tests échouent sans le code : skill `/verifier-tests`.

## 2. Textes et écrans

- [ ] Aucun texte affiché en dur : skill `/ajouter-texte` (fr tutoyé et en,
      vocabulaire de `docs/charte-ergonomique.md`, aucune clé inutilisée).
- [ ] Écran nouveau ou modifié : liste « Avant de livrer » de la charte
      (§9) passée point par point ; tests des règles testables
      (désactivation avec raison, focus, rôle, libellé).
- [ ] Mise en page douteuse (largeur, débordement, nouvelle langue) :
      skill `/capture-ecran`.
- [ ] Écran important ou retour de l'utilisateur sur l'ergonomie : skill
      `/revue-ergonomie`.
- [ ] Données qui partent de l'extension (Sentry, Moxfield, Drive) :
      skill `/verifier-confidentialite`.

## 3. Documentation

- [ ] README, section « Utilisation » : la fonctionnalité telle qu'un
      utilisateur la voit (où cliquer, ce qui se passe).
- [ ] README, « Limites connues » : ce qu'elle ne fait pas.
- [ ] README, « Développement » : nouveau fichier de tests ou nouveaux cas
      dans la description de `tests/…` (et ce qui n'est pas couvert).
- [ ] `ROADMAP.md` : la ligne passe dans « Livré » (date, et « rang N de
      l'étude de marché » si elle en vient) ; `docs/etude-de-marche.md`
      marqué « livré en X.Y.Z » si concerné.
- [ ] Nouvelle règle de travail durable : `CLAUDE.md`.
- [ ] Icône tierce : créditée dans le README (« Crédits »).

## 4. Version

- [ ] `version` de `manifest.json` augmentée **une seule fois** pour
      l'ensemble des changements non encore livrés sur `main` (comparer à
      `git show main:manifest.json`) : correctif (0.3.0 → 0.3.1) pour une
      correction, mineur (→ 0.4.0) pour une fonctionnalité.
- [ ] Rappeler à l'utilisateur de **recharger l'extension** dans
      `chrome://extensions` pour essayer : le service worker relit son code
      tout seul, mais le numéro de version n'est relu qu'au rechargement
      (constaté : idées envoyées en 0.10.0 avec le code de la 0.11.0).

## 5. Commit

- Ne pas commiter sans demande. Si demandé : message en anglais, à
  l'impératif, pas de fichier secret, `package-lock.json` sans URL de
  l'Artifactory interne.
- Résumer à l'utilisateur : ce qui a changé pour lui, les tests (nombre,
  vérification de détection), ce qui reste à vérifier en vrai.
