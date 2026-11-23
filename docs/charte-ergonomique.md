# Charte ergonomique

Règles d'ergonomie de l'extension, tirées de deux revues (guide de
démarrage, puis toute l'extension, version 0.9.0). Elles s'appliquent à
toute nouvelle fonctionnalité et à toute modification d'un écran. Les
écarts encore présents sont listés à la fin, avec leur lot dans
`ROADMAP.md`.

## 1. Principes

1. **Le stock d'abord.** L'utilisateur vient savoir ce qu'il peut monter et
   où sont ses cartes. Ce qui sert tous les jours (decks, stock) passe avant
   ce qui se règle une fois (collection, CSV, Drive, rapports).
2. **Prévenir plutôt que refuser.** Une action impossible est désactivée,
   avec la raison visible à côté. On n'apprend pas après un clic, par un
   message, qu'il ne fallait pas cliquer.
3. **Annuler plutôt que confirmer.** Pour une action destructive mais
   courante (démonter un deck), une annulation proposée juste après vaut
   mieux qu'une boîte de dialogue. La confirmation est réservée à ce qui ne
   se rattrape pas (tout effacer, restaurer une sauvegarde, se déconnecter
   de Drive).
4. **Toujours un retour.** Chaque action dit ce qu'elle a fait, ou pourquoi
   elle a échoué. Une réponse du service worker est toujours lue.
5. **Rien seulement au survol.** Une information utile n'est jamais
   uniquement dans un `title` : elle doit être lisible au clavier, au
   toucher et par un lecteur d'écran.
6. **Un mot = une notion.** Le vocabulaire ci-dessous est le même partout :
   popup, page d'un deck, aide, README.

## 2. Vocabulaire

Le français est la langue de référence ; l'anglais suit les mêmes règles.
Les textes s'adressent à l'utilisateur en le tutoyant.

| Notion | Français | Anglais | À éviter |
|---|---|---|---|
| Nom d'une carte, toutes éditions confondues | carte | card | — |
| Copie physique d'une carte | exemplaire | copy | « carte » quand on compte des copies |
| Impression précise (set, numéro) | édition | printing | « version » (réservé à l'extension et aux sauvegardes Drive) |
| Deck dont les cartes sont rangées physiquement | monté | built | — |
| Deck dont toutes les cartes sont dans le stock libre | montable | buildable | confondre avec « monté » |
| Exemplaires possédés hors decks montés | stock libre | free stock | — |
| Collection Moxfield | collection | collection | « stock » pour la collection |
| Carte imprimée pour remplacer une carte manquante | proxy | proxy | — |
| Deck pas encore lu sur Moxfield | pas encore lu | not read yet | « à vérifier » (déjà pris par les terrains de base) |

Règles :

- **On compte des exemplaires** dès qu'il s'agit de quantités (pastille,
  blocages, totaux, historique). On compte des **cartes** quand chaque nom
  compte pour un (« 3 cartes différentes », « stock insuffisant pour
  2 cartes »).
- **Pas de jargon de développeur** : ni « décrémenter », ni
  « réincrémenter », ni « flag ». On dit ce qui arrive aux cartes :
  « ses cartes sortent de ton stock libre », « elles y reviennent ».
- **Un emplacement se décrit sans position absolue** quand elle varie :
  « dans la barre de boutons en bas de la page d'un deck », pas « en bas à
  gauche ».
- **Montable ≠ monté** : jamais la même couleur, jamais le même mot.

## 3. Actions et boutons

- **Un seul bouton principal par fenêtre**, celui que l'utilisateur vient
  faire. Jamais une action destructive : dans la fenêtre d'un deck monté,
  le bouton principal est « Fermer », ou « Mettre à jour le montage » s'il
  y a des changements ; « Démonter » est un bouton secondaire, en rouge.
- **Bouton désactivé = raison affichée** à côté (pas seulement dans un
  `title`, invisible au clavier et sur un bouton désactivé).
- **Le libellé dit le résultat** : « Confirmer le montage avec 2 proxies »,
  « Mettre à jour avec 1 proxy », « Démonter tous les decks et effacer le
  stock ».
- **Même style pour une même nature d'action** : destructive en rouge,
  secondaire en neutre, principale en accent. Démonter n'a pas le style
  d'Imprimer.
- **Écritures sur Moxfield** : bouton explicite, nommé par son effet
  (« Utiliser mes éditions »), progression affichée, résultat vérifié (cf.
  CLAUDE.md).

## 4. Retours et messages

- **Résultat à côté de l'action** dans le popup (zone `*-status` sous la
  section concernée), en toast sur la page d'un deck.
- **Toasts** : `role="status"` (ou `role="alert"` pour une erreur), bouton
  de fermeture, durée calculée sur la longueur du texte, suspendue pendant
  le survol ou le focus.
- **Zones de statut du popup** : `role="status"`, pour être annoncées.
- **Message d'erreur** : ce qui s'est passé, puis ce que l'utilisateur
  peut faire (« connecte-toi sur moxfield.com dans ce navigateur »).
- **Pas de constat faux** : pendant un rendu transitoire de Moxfield, on
  garde le dernier état (cf. CLAUDE.md, scraping).
- **Alertes importantes visibles** sans dérouler le popup (collection qui
  ne couvre plus des cartes, choix Drive en attente, deck modifié).

## 5. Accessibilité

- **Clavier partout** : tout ce qui se clique se fait au clavier (vrais
  `<button>`, ou `role="button"` + `tabindex="0"` + Entrée/Espace). Pas de
  ligne de tableau cliquable sans bouton à l'intérieur.
- **Focus visible** sur nos éléments : contour net (`outline` 2 px), jamais
  `no-outline` ni une simple variation d'opacité.
- **Fenêtres modales** : focus placé dans la fenêtre à l'ouverture, Tab
  retenu dedans, Échap = Annuler, focus rendu au bouton qui l'a ouverte.
- **Contraste AA** : 4,5:1 pour le texte (même en 11 px), dans les deux
  thèmes. Vérifier tout nouveau couple de couleurs.
- **Nom accessible** pour chaque contrôle sans texte (case à cocher,
  icône) : `aria-label`, pas seulement `title`.
- **Champs masqués** : classe `.visually-hidden`, jamais `hidden` sur un
  champ qu'on doit pouvoir atteindre (choix d'un fichier).
- **Animations** : désactivées sous `prefers-reduced-motion`.
- **Icônes décoratives** : `aria-hidden="true"`, le texte suffit.

## 6. Popup

- Ordre visé : en-tête (synchro, aide), alertes, chiffres clés, decks,
  stock, historique ; les réglages ensuite, repliés.
- Chiffres clés : un message plutôt que des zéros tant que rien n'est
  récupéré.
- Sections lourdes (stock, historique, Mes decks) construites seulement
  dépliées ; filtre temporisé (≈ 200 ms) et sans relire tout l'état à
  chaque frappe.
- États d'un deck distincts à l'œil : Monté (accent, ✓), Montable (vert),
  bloqué (rouge, avec le nombre d'exemplaires), pas encore lu (neutre).

## 7. Page d'un deck

- Nos boutons s'intègrent à la barre de Moxfield (ou au bandeau flottant),
  avec les mêmes repères : icône + pastille (cf. `deck-help.js`, légende
  partagée avec le popup).
- Ne jamais masquer Moxfield : toasts au-dessus de sa barre, une seule
  fenêtre à la fois.
- Ne redessiner que ce qui change (sinon l'infobulle ou le focus se
  perdent).
- Fenêtre de montage : d'abord ce qui bloque (stock, puis édition), puis
  les avertissements (terrains de base), puis la liste ; boutons toujours
  visibles.

## 8. Aide

- Liste de premiers pas cochée d'après l'état réel, pas un diaporama.
- La légende utilise les vraies icônes de la page (`deck-help.js`) : un
  seul dessin pour l'aide et pour la page.
- Aide contextuelle là où on agit (bulle sur la page d'un deck, « ? » dans
  la fenêtre de montage), montrée une fois, toujours rouvrable.

## 9. Avant de livrer un écran

- [ ] Vocabulaire conforme au tableau (fr et en).
- [ ] Un seul bouton principal, pas destructif ; action impossible
      désactivée avec sa raison.
- [ ] Retour visible et annoncé pour chaque action, réponse lue.
- [ ] Tout faisable au clavier, focus visible, Échap ferme.
- [ ] Rien d'utile seulement au survol.
- [ ] Contraste vérifié dans les deux thèmes.
- [ ] Test automatisé pour chaque règle ci-dessus qu'on peut tester
      (désactivation, focus, rôle, libellé).

## Écarts connus

- **Lot 2** : annulation après un démontage, zone d'alertes en tête du
  popup, fenêtre de montage réordonnée (boutons collés en bas), détails du
  survol accessibles au clic.
- **Lot 3** : fusion de « Decks montés » et « Mes decks », réglages sortis
  du popup.
- **À trancher** : en anglais, « build / unbuild » pourrait devenir
  « assemble / take apart » ; à décider avec l'avis d'utilisateurs
  anglophones.
