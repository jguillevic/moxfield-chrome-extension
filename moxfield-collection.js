// moxfield-collection.js — récupération de la collection Moxfield (CSV),
// sans passer par le bouton Export du site.
//
// Chargé par le service worker (importScripts dans background.js) et par les
// tests Node (tests/), d'où la fabrique paramétrée par fetch et la lecture
// des cookies.
//
// Moxfield n'a pas d'API publique : on reproduit les appels que fait le site
// (observés dans l'onglet Network, octobre 2026) :
// 1. POST api2…/v1/account/token/refresh {userId, isAppLogin: false} : le
//    jeton de renouvellement voyage dans un cookie HttpOnly
//    (refresh_token_<userId>, SameSite=Strict, 30 jours), que Chrome joint
//    aux requêtes de l'extension (permission d'hôte sur api2). Il est
//    remplacé à chaque appel, dans le même stockage de cookies que le site :
//    l'utilisateur reste connecté. Renvoie un access_token (15 min).
// 2. POST api2…/v1/account/token/download (Bearer) : jeton d'export, 1 min.
// 3. GET api…/v1/collections/download?access_token=… : le CSV, identique à
//    celui du bouton Export.
// Aucun jeton n'est écrit nulle part : tout est redemandé à chaque
// récupération de la collection. Seule la lecture d'un deck (ci-dessous)
// réutilise l'access_token quelques minutes, en mémoire.
//
// Éditions des cartes d'un deck (observé dans l'onglet Network, novembre
// 2026) : GET api2…/v3/decks/all/<publicId> (Bearer, même access_token),
// l'identifiant étant celui de l'adresse de la page (/decks/<publicId>).
// Réponse : boards.<zone>.cards.<clé>.card = { id, set, cn, name… }, où
// `id` est le code de l'impression que la page du deck porte dans ses
// repères (data-hash, collection_full_…_<id> — cf. ownedVersionOf dans
// deck-scraper.js) : même format des deux côtés, suffixe « F0 » pour le foil
// compris (champ `hash` de printingData). `set` et `cn` sont l'édition et le
// numéro de l'export CSV de la collection. Exemple réduit :
// tests/fixtures/api/deck.json.

const MOXFIELD_API2 = "https://api2.moxfield.com/v1/account/token";
const MOXFIELD_DECK_URL = "https://api2.moxfield.com/v3/decks/all";
// Lecture demandée par la page d'un deck, qui attend la réponse pour ses
// contrôles : on n'attend pas indéfiniment un Moxfield qui ne répond pas.
const MOXFIELD_DECK_TIMEOUT_MS = 10000;
// L'access_token vaut 15 min. Chaque renouvellement remplace le cookie de
// session de l'utilisateur : en parcourant plusieurs decks d'affilée, on
// n'en demande pas un par page.
const MOXFIELD_TOKEN_REUSE_MS = 10 * 60 * 1000;
const MOXFIELD_COLLECTION_CSV_URL =
  "https://api.moxfield.com/v1/collections/download?sortColumn=cardName&sortDirection=ascending&pricingProvider=cardmarket";

// Erreur de récupération, avec un code pour l'interface : "not-logged-in"
// (pas de session Moxfield dans le navigateur), "blocked" (refus, ex. protection
// anti-robot), "api-changed" (réponse inattendue : Moxfield a changé ses
// appels), "network" (Moxfield injoignable), "deck-unavailable" (deck
// introuvable ou privé pour ce compte).
class MoxfieldError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// getCookies : renvoie les cookies de moxfield.com ({name, value}) ;
// i18n : textes traduits (cf. i18n.js) ; now : horloge (tests).
function createMoxfieldCollection({ fetch, getCookies, i18n: { t }, now = () => Date.now() }) {
  // Dernier access_token obtenu, en mémoire seulement (perdu quand le
  // service worker s'endort) : { userId, token, at }.
  let lastToken = null;

  // Le userId attendu par le renouvellement est le suffixe du cookie
  // "refresh_token_<userId>". Avec plusieurs comptes déjà utilisés dans ce
  // navigateur, on retient celui dont le jeton est le jeton courant (cookie
  // "refresh_token" sans suffixe).
  async function findUserId() {
    const cookies = await getCookies();
    const current = cookies.find((c) => c.name === "refresh_token");
    const candidates = cookies.filter((c) => /^refresh_token_.+$/.test(c.name));
    const chosen = (current && candidates.find((c) => c.value === current.value)) || candidates[0];
    return chosen ? chosen.name.slice("refresh_token_".length) : null;
  }

  async function request(step, url, options) {
    let res;
    try {
      res = await fetch(url, options);
    } catch (e) {
      throw new MoxfieldError("network", t("moxfieldNetwork"));
    }
    if (res.ok) return res;
    if (step === "refresh" && (res.status === 400 || res.status === 401)) {
      throw new MoxfieldError("not-logged-in", t("moxfieldSessionExpired"));
    }
    if (step === "deck" && (res.status === 401 || res.status === 404)) {
      throw new MoxfieldError("deck-unavailable", t("moxfieldDeckUnavailable"));
    }
    if (res.status === 403 || res.status === 429) {
      throw new MoxfieldError("blocked", t("moxfieldBlocked", res.status));
    }
    throw unexpected(step, t("moxfieldStatusCode", res.status));
  }

  function unexpected(step, detail) {
    return new MoxfieldError("api-changed", t("moxfieldUnexpected", step, detail));
  }

  async function readToken(step, res) {
    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw unexpected(step, t("moxfieldUnreadable"));
    }
    if (!body || typeof body.access_token !== "string" || !body.access_token) throw unexpected(step, t("moxfieldNoToken"));
    return body.access_token;
  }

  // reuse : accepter le dernier jeton s'il est récent (même compte).
  async function getAccessToken(reuse = false) {
    const userId = await findUserId();
    if (!userId) {
      lastToken = null;
      throw new MoxfieldError("not-logged-in", t("moxfieldNoSession"));
    }
    if (reuse && lastToken && lastToken.userId === userId && now() - lastToken.at < MOXFIELD_TOKEN_REUSE_MS) return lastToken.token;
    lastToken = null;
    const refresh = await request("refresh", `${MOXFIELD_API2}/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, isAppLogin: false }),
    });
    const token = await readToken("refresh", refresh);
    lastToken = { userId, token, at: now() };
    return token;
  }

  // Édition et numéro de chaque impression du deck : { [code]: { set, cn } }
  // (cf. extractDeckPrintings).
  async function fetchDeckPrintings(publicId) {
    const accessToken = await getAccessToken(true);
    const options = { credentials: "include", headers: { Authorization: `Bearer ${accessToken}` } };
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) options.signal = AbortSignal.timeout(MOXFIELD_DECK_TIMEOUT_MS);
    let res;
    try {
      res = await request("deck", `${MOXFIELD_DECK_URL}/${encodeURIComponent(publicId)}`, options);
    } catch (e) {
      lastToken = null; // jeton peut-être refusé : le prochain essai en redemande un
      throw e;
    }
    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw unexpected("deck", t("moxfieldUnreadable"));
    }
    const printings = extractDeckPrintings(body);
    if (!printings) throw unexpected("deck", t("moxfieldNotDeck"));
    return printings;
  }

  async function downloadCollectionCSV() {
    const accessToken = await getAccessToken();
    const download = await request("download", `${MOXFIELD_API2}/download`, {
      method: "POST",
      credentials: "include",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const exportToken = await readToken("download", download);
    const csv = await request("csv", `${MOXFIELD_COLLECTION_CSV_URL}&access_token=${encodeURIComponent(exportToken)}`, {});
    const text = await csv.text();
    const header = text.split("\n", 1)[0].toLowerCase();
    if (!/\bcount\b/.test(header) || !/\bname\b/.test(header)) throw unexpected("csv", t("moxfieldNotCollectionCsv"));
    return text;
  }

  return { findUserId, downloadCollectionCSV, fetchDeckPrintings };
}

// Réponse de l'API d'un deck → { [code de l'impression]: { set, cn } }, en
// minuscules comme le détail par édition du stock (cf. parseCollectionCSV
// dans background.js). Toutes les zones sont lues, « Considering » comprise :
// ce n'est qu'une table de correspondance, et un code désigne la même
// impression partout. Une entrée regroupant plusieurs impressions les
// détaille dans printingData. null si la réponse n'est pas celle d'un deck.
function extractDeckPrintings(deck) {
  if (!deck || typeof deck.boards !== "object" || deck.boards === null) return null;
  const printings = {};
  const add = (card) => {
    if (!card || typeof card.id !== "string" || typeof card.set !== "string" || !card.set) return;
    printings[card.id] = { set: card.set.trim().toLowerCase(), cn: typeof card.cn === "string" ? card.cn.trim().toLowerCase() : "" };
  };
  for (const board of Object.values(deck.boards)) {
    for (const entry of Object.values((board && board.cards) || {})) {
      if (!entry) continue;
      add(entry.card);
      for (const printing of Array.isArray(entry.printingData) ? entry.printingData : []) add(printing && printing.card);
    }
  }
  return printings;
}

// Différences de quantités possédées entre deux collections ({ [nom
// normalisé]: { name, qty } }), triées par nom : [{ name, from, to }].
function computeCollectionDiff(before, after) {
  const changes = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key] ? before[key].qty : 0;
    const to = after[key] ? after[key].qty : 0;
    if (from !== to) changes.push({ name: (after[key] || before[key]).name, from, to });
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name));
}

if (typeof module !== "undefined") module.exports = { createMoxfieldCollection, computeCollectionDiff, extractDeckPrintings, MoxfieldError };
