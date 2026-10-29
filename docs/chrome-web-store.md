# Publier sur le Chrome Web Store

Marche à suivre, et textes prêts à coller dans le tableau de bord du
développeur. Les règles, prix et délais évoluent : vérifie-les dans le
[Developer Dashboard](https://chrome.google.com/webstore/devconsole) au
moment de publier.

## 1. Compte développeur (une fois)

1. Ouvre le [Developer Dashboard](https://chrome.google.com/webstore/devconsole)
   avec le compte Google qui publiera, et paie les frais d'inscription
   (5 $, une fois).
2. Active la validation en deux étapes sur ce compte (exigée).
3. Déclare-toi « non commerçant » (extension gratuite, sans activité
   commerciale) : sinon une adresse et un contact sont publiés.

## 2. Identifiant de l'extension et connexion Google

Le Store refuse le champ `"key"` du manifest et donne son propre
identifiant à l'extension. Or la synchronisation Google Drive dépend de cet
identifiant (`oauth2.client_id` du manifest, `GOOGLE_WEB_CLIENT_ID` dans
`background.js`, cf. README « Installer l'extension pour son propre
compte »). Pour n'avoir qu'un identifiant partout :

1. `npm run package`, puis dans le Dashboard : **Nouvel élément** → envoie
   `dist/moxfield-stock-manager-<version>.zip`. Ne soumets pas encore : le
   brouillon suffit.
2. Onglet **Paquet** du brouillon : copie la **clé publique** et
   l'**identifiant** de l'élément.
3. Remplace la valeur de `"key"` dans `manifest.json` par cette clé
   publique : tes installations en mode développeur auront le même
   identifiant que la version du Store. Recharge l'extension et vérifie
   l'identifiant dans `chrome://extensions`.
4. Dans [Google Cloud](https://console.cloud.google.com), pour cet
   identifiant : un identifiant client OAuth **« Extension Chrome »**
   (→ `oauth2.client_id`) et un **« Application Web »** avec l'URI de
   redirection `https://<identifiant>.chromiumapp.org/`
   (→ `GOOGLE_WEB_CLIENT_ID`).
5. **Écran de consentement OAuth** → passe l'application **en production**.
   En mode « Test », seuls les utilisateurs de test déclarés peuvent se
   connecter, et leur connexion expire au bout de 7 jours. Renseigne le nom,
   le logo, l'adresse de la politique de confidentialité (ci-dessous) et le
   champ d'accès `drive.appdata`. Google peut demander une vérification de
   la marque (quelques jours).
6. Incrémente `version` dans `manifest.json`, `npm run package`, et envoie
   le nouveau paquet sur le brouillon.

## 3. Fiche

- **Catégorie** : Productivité (ou Outils).
- **Langues** : français et anglais (nom et description viennent de
  `_locales`).
- **Visuels** : icône 128×128 (`icons/icon128.png`), au moins une capture
  d'écran 1280×800 (ou 640×400), petite image promotionnelle 440×280.

### Description détaillée — français

> Extension **non officielle**, sans lien avec Moxfield.
>
> Tu gères tes decks sur Moxfield, mais tes cartes physiques, elles, sont
> dans des boîtes de decks montés ? Moxfield Stock Manager tient ton stock
> physique : ta collection Moxfield, moins les cartes des decks que tu as
> réellement montés.
>
> • Sur la page d'un deck Moxfield, un bouton indique s'il est montable avec
> ton stock libre, et quelles cartes bloquent.
> • Marque un deck comme monté : ses cartes sortent du stock. Démonte-le :
> elles reviennent.
> • Pour une carte manquante, l'extension te dit dans quel deck monté elle
> se trouve, ou copie la liste des manques pour Cardmarket.
> • Deck modifié sur Moxfield après le montage : la différence est détectée
> et le montage se met à jour pour les seules cartes changées.
> • Collection récupérée automatiquement depuis ton compte Moxfield (ou par
> import CSV), historique des actions, synchronisation facultative entre
> tes ordinateurs via ton Google Drive.
>
> Le stock est suivi par nom de carte, toutes éditions confondues. Decks
> Commander uniquement pour l'instant.
>
> Tes données restent dans ton navigateur (et ton Drive si tu actives la
> synchronisation). Aucune publicité, aucune revente de données.

### Description détaillée — anglais

> **Unofficial** extension, not affiliated with Moxfield.
>
> You manage your decks on Moxfield, but your physical cards sit in the
> boxes of built decks? Moxfield Stock Manager keeps track of your physical
> stock: your Moxfield collection, minus the cards of the decks you have
> actually built.
>
> • On a Moxfield deck page, a button shows whether it can be built with
> your free stock, and which cards block it.
> • Mark a deck as built: its cards leave the stock. Unbuild it: they come
> back.
> • For a missing card, the extension tells you which built deck holds it,
> or copies the missing cards for Cardmarket.
> • Deck changed on Moxfield after it was built: the difference is detected
> and the build is updated for the changed cards only.
> • Collection fetched automatically from your Moxfield account (or by CSV
> import), action history, optional sync between your computers through
> your Google Drive.
>
> Stock is tracked by card name, across all printings. Commander decks only
> for now.
>
> Your data stays in your browser (and your Drive if you turn on sync). No
> ads, no data selling.

## 4. Onglet « Confidentialité »

**Objectif unique** :

> Tenir le stock de cartes physiques d'un joueur de Magic à partir de sa
> collection Moxfield, en retirant du stock les cartes des decks qu'il a
> montés physiquement.

**Justification des permissions** :

| Permission | Justification (à coller) |
|---|---|
| `storage`, `unlimitedStorage` | Keeps the stock, built decks and history locally. Large collections (30,000+ card names) exceed the default 10 MB quota. |
| `alarms` | Fetches the Moxfield collection again every hour, and shortly after the user changes it on Moxfield; schedules the Google Drive sync. |
| `cookies` | Reads the user's own Moxfield session cookie (refresh_token) to download their collection CSV from Moxfield on their behalf, exactly like the site's Export button. The cookie is never stored and never sent anywhere but Moxfield. Also detects when the user signs in to Moxfield to retry a failed fetch. |
| `webRequest` | Observes (read-only) the completion of the user's requests to Moxfield's collection API (api2.moxfield.com/*/collections*) to know the collection changed and fetch it again. No request is blocked or modified. |
| `clipboardRead` | Pastes a card list copied from Moxfield into the build window, when the user clicks "Paste from clipboard" or when the list could not be read from the page. |
| `identity`, `identity.email` | Optional Google Drive sync: signs in to Google with the drive.appdata scope, and shows which Google account is used (and detects an account change). |
| Hôtes `moxfield.com`, `www.moxfield.com` | Content script on deck pages: reads the deck list and shows the build button. |
| Hôtes `api.moxfield.com`, `api2.moxfield.com` | Downloads the user's collection (token refresh, export token, CSV), as the Moxfield site does. |
| Hôte `*.sentry.io` | Sends anonymous error reports, only if the user agreed. |

**Code distant** : Non, aucun code distant.

**Utilisation des données** — cocher :

- *Informations d'identification personnelle* : l'adresse mail du compte
  Google (synchro facultative, gardée localement).
- *Informations d'authentification* : le cookie de session Moxfield et le
  jeton Google (jamais enregistrés ailleurs que localement pour le jeton
  Google, jamais transmis à un tiers).
- *Contenu des sites Web* : la liste de cartes de la page d'un deck
  Moxfield.

Et certifier les trois engagements (pas de vente, pas d'usage sans rapport
avec l'objectif unique, pas d'usage pour la solvabilité).

**Politique de confidentialité** :
`https://github.com/jguillevic/moxfield-chrome-extension/blob/main/PRIVACY.md`

## 5. Soumission

- Visibilité conseillée pour un premier essai : **Non répertoriée**
  (accessible seulement par lien), puis **Publique** une fois validée.
- Relecture : de quelques jours à quelques semaines ; `cookies`,
  `webRequest` et plusieurs domaines allongent souvent le délai. Chaque
  mise à jour repasse en relecture.
- Mise à jour : incrémenter `version` dans `manifest.json`,
  `npm run package`, envoyer le zip, soumettre.

## Points à trancher avant de soumettre

- **Nom** : « Moxfield Stock Manager » reprend la marque Moxfield. D'autres
  extensions du Store le font (« Moxfield Highlighter »…), mais un refus
  reste possible ; la description précise « non officielle ». Alternative :
  « Stock Manager for Moxfield ». Demander l'accord de Moxfield réduit le
  risque d'un retrait plus tard.
- **API de Moxfield** : la récupération de la collection imite les appels
  du site (pas d'API publique) ; elle peut cesser de marcher s'ils changent.
