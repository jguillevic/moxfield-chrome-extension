# Politique de confidentialité — Moxfield Stock Manager

*English version below.*

Dernière mise à jour : 29 octobre 2026.

Moxfield Stock Manager est une extension de navigateur **non officielle**,
sans lien avec Moxfield. Elle gère un stock de cartes physiques à partir de
ta collection Moxfield. Le développeur ne gère aucun serveur : tes données
restent dans ton navigateur et, si tu l'actives, dans ton propre Google
Drive.

## Données utilisées, et pourquoi

| Donnée | Usage | Où elle va |
|---|---|---|
| **Ta collection Moxfield** (noms de cartes et quantités) | Constituer le stock | Téléchargée depuis Moxfield, gardée dans le navigateur (`chrome.storage.local`) |
| **Decks montés, historique des actions** | Fonctionnement de l'extension | Gardés dans le navigateur |
| **Cookie de session Moxfield** (`refresh_token`) | Télécharger ta collection à ta place, comme le fait le site | Lu par l'extension et joint par le navigateur aux seules requêtes vers Moxfield. **Jamais enregistré, jamais envoyé ailleurs.** |
| **Requêtes de ton navigateur vers l'API de collection de Moxfield** (adresse et code de réponse) | Détecter que tu as modifié ta collection, pour la récupérer à nouveau | Rien n'est enregistré ni transmis |
| **Liste de cartes de la page d'un deck Moxfield** | Contrôler le stock avant de monter un deck | Reste dans le navigateur |
| **Presse-papiers** | Coller une liste de cartes dans la fenêtre de montage (clic sur « Coller depuis le presse-papiers », ou à l'ouverture de la fenêtre si la liste n'a pas pu être lue sur la page) | Reste dans le navigateur |
| **Adresse mail de ton compte Google** (seulement si tu actives la synchronisation Google Drive) | Afficher le compte utilisé et détecter un changement de compte | Gardée dans le navigateur |
| **Stock, decks montés et historique** (seulement si tu actives la synchronisation) | Sauvegarde et synchronisation entre tes ordinateurs | Dans un dossier privé de **ton** Google Drive (`appDataFolder`), que seule l'extension peut lire. Le développeur n'y a pas accès. |
| **Rapports d'erreurs** (seulement si tu l'acceptes) | Corriger les bugs | Envoyés à [Sentry](https://sentry.io) (serveurs dans l'Union européenne) : message et pile d'appels de l'erreur, endroit où elle s'est produite, version de l'extension, navigateur, système, et un identifiant tiré au hasard propre à l'ordinateur. **Jamais** ton stock, tes decks ni ton adresse mail ; les jetons de connexion et adresses mail qui apparaîtraient dans un message d'erreur sont masqués. |

## Ce que l'extension ne fait pas

- Elle ne vend, ne loue et ne cède aucune donnée.
- Elle n'affiche aucune publicité et ne fait aucun suivi de navigation.
- Elle n'utilise pas tes données pour autre chose que les fonctions
  décrites ci-dessus.
- Elle ne charge aucun code depuis Internet.

L'utilisation des informations reçues des API Google respecte la
[politique des données utilisateur des services d'API Google](https://developers.google.com/terms/api-services-user-data-policy),
y compris les exigences d'usage limité (*Limited Use*).

## Tes choix

- **Rapports d'erreurs** : demandés au premier lancement ; modifiables à
  tout moment dans le popup, section « Rapports d'erreurs ».
- **Synchronisation Google Drive** : désactivée par défaut ; « Déconnecter »
  l'arrête. Le fichier reste dans ton Drive jusqu'à ce que tu supprimes les
  données de l'application (Google Drive → Paramètres → Gérer les
  applications).
- **Tout effacer** : supprimer l'extension efface les données gardées dans
  le navigateur. « Réinitialiser tout le stock » (popup, zone de danger)
  vide le stock et les decks montés.

## Contact

Questions ou demandes : [issues du dépôt GitHub](https://github.com/jguillevic/moxfield-chrome-extension/issues).

---

# Privacy policy — Moxfield Stock Manager

Last updated: October 29, 2026.

Moxfield Stock Manager is an **unofficial** browser extension, not
affiliated with Moxfield. It manages a stock of physical cards from your
Moxfield collection. The developer runs no server: your data stays in your
browser and, if you turn it on, in your own Google Drive.

## Data used, and why

| Data | Use | Where it goes |
|---|---|---|
| **Your Moxfield collection** (card names and quantities) | Building the stock | Downloaded from Moxfield, kept in the browser (`chrome.storage.local`) |
| **Built decks, action history** | Running the extension | Kept in the browser |
| **Moxfield session cookie** (`refresh_token`) | Downloading your collection on your behalf, as the site does | Read by the extension and attached by the browser only to requests to Moxfield. **Never stored, never sent anywhere else.** |
| **Your browser's requests to Moxfield's collection API** (address and response code) | Detecting that you changed your collection, to fetch it again | Nothing is stored or sent |
| **Card list on a Moxfield deck page** | Checking the stock before building a deck | Stays in the browser |
| **Clipboard** | Pasting a card list into the build window (click on “Paste from clipboard”, or when the window opens if the list could not be read from the page) | Stays in the browser |
| **Your Google account email address** (only if you turn on Google Drive sync) | Showing which account is used and detecting an account change | Kept in the browser |
| **Stock, built decks and history** (only if you turn on sync) | Backup and sync between your computers | In a private folder of **your** Google Drive (`appDataFolder`), readable only by the extension. The developer has no access to it. |
| **Error reports** (only if you agree) | Fixing bugs | Sent to [Sentry](https://sentry.io) (servers in the European Union): error message and stack trace, where it happened, extension version, browser, system, and a random identifier specific to the computer. **Never** your stock, your decks or your email address; sign-in tokens and email addresses that would appear in an error message are masked. |

## What the extension does not do

- It does not sell, rent or transfer any data.
- It shows no ads and does no browsing tracking.
- It does not use your data for anything other than the features above.
- It does not load any code from the Internet.

The use of information received from Google APIs adheres to the
[Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy),
including the Limited Use requirements.

## Your choices

- **Error reports**: asked on first launch; can be changed at any time in
  the popup, “Error reports” section.
- **Google Drive sync**: off by default; “Disconnect” stops it. The file
  stays in your Drive until you delete the app's data (Google Drive →
  Settings → Manage apps).
- **Erase everything**: removing the extension erases the data kept in the
  browser. “Reset the whole stock” (popup, danger zone) empties the stock
  and built decks.

## Contact

Questions or requests: [GitHub repository issues](https://github.com/jguillevic/moxfield-chrome-extension/issues).
