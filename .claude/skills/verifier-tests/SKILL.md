---
name: verifier-tests
description: Vérifie que des tests nouveaux ou modifiés détectent vraiment ce qu'ils couvrent, en cassant volontairement chaque règle du code (une à la fois), en lançant npm test puis en restaurant. À utiliser après avoir écrit des tests, avant de livrer, ou quand l'utilisateur demande si les tests servent à quelque chose.
---

# Vérifier que les tests détectent la casse

Exigé par `CLAUDE.md` (« Vérifier que les nouveaux tests échouent bien
sans le code qu'ils couvrent »). Le script
[`mutate.js`](mutate.js) automatise : une mutation à la fois, `npm test`,
restauration du fichier **même en cas d'erreur**.

## Étapes

1. Lister les règles couvertes par les nouveaux tests (une règle = une
   condition, un calcul, un attribut, un appel).
2. Pour chacune, choisir une **mutation minimale** qui casse la règle sans
   casser la syntaxe : condition forcée (`if (x)` → `if (false)`), ligne
   retirée, valeur changée, attribut retiré du HTML. Le texte `from` doit
   être **unique** dans le fichier.
3. Écrire les mutations dans un fichier JSON du scratchpad (pas dans le
   dépôt) :

   ```json
   [
     { "name": "adresse refusée dès la frappe", "file": "popup.js", "from": "return feedback.emailTouched ? {", "to": "return true ? {" },
     { "name": "texte collé coupé", "file": "popup.html", "from": "rows=\"5\" data-i18n", "to": "rows=\"5\" maxlength=\"4000\" data-i18n" }
   ]
   ```

4. Lancer depuis la racine du dépôt (peut dépasser 2 minutes : timeout
   long ou exécution en fond) :

   ```sh
   node .claude/skills/verifier-tests/mutate.js <chemin/vers/mutations.json>
   ```

5. Lire le résultat : chaque ligne dit `détectée (N échecs)` ou
   `NON DÉTECTÉE`. Une mutation non détectée = un test manquant ou trop
   lâche : l'écrire, puis relancer.
6. Vérifier que tout est restauré : `git diff --stat` identique à avant,
   `npm test` à 0 échec.

## Pièges

- Écrire le JSON avec l'outil Write : les guillemets et apostrophes du
  code français cassent les heredocs du shell (constaté plusieurs fois).
- Une mutation qui casse la syntaxe fait échouer *tous* les fichiers de
  tests : ça ne prouve rien. Préférer une mutation de comportement.
