---
name: capture-ecran
description: Fait une vraie capture du popup de l'extension (ou d'une autre page HTML de l'extension) dans Chrome sans interface, avec un faux `chrome` qui fournit les textes fr ou en et des réponses simulées, pour vérifier mise en page, débordements et textes longs. À utiliser après un changement d'écran, pour une question de largeur ou de place, ou quand jsdom (qui ne calcule pas la mise en page) ne suffit pas.
---

# Capture d'écran du popup

jsdom (les tests) ne calcule aucune mise en page : un débordement ne s'y
voit pas. Ce skill ouvre une copie du popup dans le vrai Chrome, sans
interface, et en fait une image que je peux regarder (outil Read).

## Étapes

1. Générer la page de test dans le **scratchpad** (jamais dans le
   dépôt) avec [`render-popup.js`](render-popup.js) :

   ```sh
   node .claude/skills/capture-ecran/render-popup.js <racine du dépôt> <sortie.html> <fr|en> [sélecteur à cliquer] [état de la synchro]
   ```

   - `sélecteur à cliquer` (facultatif) : bouton cliqué après le
     chargement, ex. `#feedback-btn` pour ouvrir le panneau d'idée, `-`
     pour aucun.
   - `état de la synchro` (facultatif) : clé de texte de la pastille, ex.
     `syncPillError` (la plus longue en français, pire cas de l'en-tête).
   - Les réponses simulées du service worker sont dans le script
     (`RESPONSES`) : les compléter pour l'écran voulu (stock, decks
     montés…).

2. Capturer avec Chrome sans interface (chemin habituel sous Windows) :

   ```sh
   "/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --allow-file-access-from-files --hide-scrollbars --window-size=400,620 --virtual-time-budget=2000 --screenshot="<sortie.png>" "file:///<sortie.html>"
   ```

   Largeur 400 = celle du popup. Hauteur à augmenter pour voir plus bas.

3. Regarder l'image (outil Read sur le `.png`), **en français et en
   anglais**, et avec le texte le plus long possible.

4. Pour un zoom (150 %, 200 %) : ajouter `--force-device-scale-factor=1.5`
   et réduire la largeur en proportion (`--window-size=267,…`) pour
   simuler le manque de place.

## Limites

- Les images de l'extension et les feuilles de style sont chargées depuis
  le dépôt (`<base href>`) : il faut `--allow-file-access-from-files`.
- Ce n'est pas le vrai popup : les données sont simulées. Pour un constat
  définitif, demander une capture à l'utilisateur.
- Ne jamais publier ces captures : elles peuvent contenir des données de
  test qui ressemblent à de vraies.
