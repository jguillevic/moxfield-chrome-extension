---
name: ajouter-texte
description: Ajoute ou modifie un texte affiché par l'extension (libellé, message, aide, erreur) en français et en anglais dans _locales, avec le vocabulaire de la charte et le tutoiement, puis vérifie qu'aucune clé n'est oubliée ni inutilisée. À utiliser dès qu'un écran ou un message change.
---

# Ajouter un texte affiché

Règle de `CLAUDE.md` : jamais de texte en dur ; toujours dans
`_locales/fr/messages.json` **et** `_locales/en/messages.json`, lu par
`t()` / `tn()` (pluriels `_one` / `_other`) ou par les attributs
`data-i18n`, `data-i18n-placeholder`, `data-i18n-title`,
`data-i18n-aria-label` (cf. `translateDocument` dans `i18n.js`).

## Écrire le texte

- **Vocabulaire** : tableau §2 de `docs/charte-ergonomique.md` (carte /
  exemplaire, édition et non « version », monté ≠ montable, stock libre,
  collection…). Pas de jargon de développeur.
- **Français** : tutoiement (« Récupère ta collection »), apostrophe
  droite `'` comme le reste du fichier, guillemets « » avec espaces.
- **Anglais** : même sens, même registre ; termes de la charte (copy,
  printing, built, buildable, free stock).
- **Bouton** : le libellé dit le résultat (« Confirmer le montage avec
  2 proxies »). **Bouton désactivé** : un texte de raison visible à côté.
- **Message d'erreur** : ce qui s'est passé, puis ce que l'utilisateur
  peut faire. S'il est affiché derrière `errorPrefix` (« Erreur : $1 »),
  il commence par une minuscule ; affiché seul, par une majuscule.
- **Variables** : `$1`, `$2` dans le message ; nombres formatés par
  `toLocaleString(i18n.locale)` avant d'être passés.
- L'historique et l'état ne stockent jamais un libellé : seulement des
  données, traduites à l'affichage.

## Ajouter les clés

Ajouter les deux langues d'un coup par un petit script Node (écrit avec
l'outil Write dans le scratchpad, pas en heredoc : les apostrophes
cassent le shell), qui relit le JSON, ajoute les clés, et réécrit avec
`JSON.stringify(json, null, 2) + "\n"` pour garder le format.

## Vérifier

- `npm test` : `tests/i18n.test.js` contrôle les mêmes clés dans toutes
  les langues et aucun texte vide.
- Clés inutilisées (à adapter au préfixe) :

  ```sh
  node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync("_locales/fr/messages.json","utf8"));const src=["popup.html","popup.js","background.js","content-deck.js","deck-help.js","deck-checks.js","proxies.html","proxies.js","history.js","moxfield-collection.js","update-check.js","google-auth.js","manifest.json"].map(f=>{try{return fs.readFileSync(f,"utf8")}catch(e){return ""}}).join("\n");console.log(Object.keys(j).filter(k=>k.startsWith("PREFIXE")&&!src.includes(k.replace(/_(one|other)$/,""))))'
  ```

- Un test d'écran vérifie au moins un texte en français **et** en anglais
  (cf. tests « textes en anglais » de `tests/popup.test.js`).
