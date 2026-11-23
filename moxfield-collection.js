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
//
// Changement d'édition d'une carte d'un deck (observé dans l'onglet
// Network, novembre 2026, en changeant l'édition d'une carte sur le site) :
// - Éditions d'une carte : GET api2…/v3/cards/editions/<uniqueCardId>
//   (Bearer). uniqueCardId est commun à toutes les éditions d'une carte, et
//   c'est la clé de l'entrée dans boards.<zone>.cards. Réponse : tableau de
//   { cardId, uniqueCardId, abbreviation (édition, en minuscules), cn,
//   name (nom de l'édition), hasNonFoil, hasFoil, hasEtched… }. Exemple
//   réduit : tests/fixtures/api/card-editions.json.
// - Changement : PUT api2…/v2/decks/<id interne du deck>/cards/<zone>/<uniqueCardId>
//   (Bearer), en-têtes x-deck-version (champ `version` du deck) et
//   x-public-deck-id, corps { quantity, finish, printingData: [{ id: cardId
//   de la nouvelle édition, quantity, finish, lang, isAlter, isProxy }] }.
//   Réponse : l'entrée modifiée ({ card: { id… }, finish, printingData… }).
//   L'id interne du deck (`id` de la réponse du deck) n'est pas celui de
//   l'adresse de la page (`publicId`).

const MOXFIELD_API2 = "https://api2.moxfield.com/v1/account/token";
const MOXFIELD_DECK_URL = "https://api2.moxfield.com/v3/decks/all";
const MOXFIELD_EDITIONS_URL = "https://api2.moxfield.com/v3/cards/editions";
const MOXFIELD_DECK_WRITE_URL = "https://api2.moxfield.com/v2/decks";
// Lecture demandée par la page d'un deck, qui attend la réponse pour ses
// contrôles : on n'attend pas indéfiniment un Moxfield qui ne répond pas.
const MOXFIELD_DECK_TIMEOUT_MS = 10000;
// Début de la réponse gardé sur une erreur inattendue (cf. request).
const MAX_ERROR_RESPONSE_CHARS = 500;
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
    const error = unexpected(step, t("moxfieldStatusCode", res.status));
    // Début de la réponse (ex. motif d'un refus 400), pour le rapport
    // d'erreur seulement : sans lui, impossible de savoir ce que Moxfield
    // reproche à la requête. Borné, et jamais affiché.
    try {
      error.response = (await res.text()).slice(0, MAX_ERROR_RESPONSE_CHARS);
    } catch (e) {
      // corps illisible : le code HTTP suffira
    }
    throw error;
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

  // Requête avec l'access_token (réutilisé quelques minutes), réponse JSON
  // lue. Un jeton peut-être refusé n'est pas réutilisé au prochain essai.
  async function authorizedJson(step, url, init = {}) {
    const accessToken = await getAccessToken(true);
    const options = { ...init, credentials: "include", headers: { ...(init.headers || {}), Authorization: `Bearer ${accessToken}` } };
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) options.signal = AbortSignal.timeout(MOXFIELD_DECK_TIMEOUT_MS);
    let res;
    try {
      res = await request(step, url, options);
    } catch (e) {
      lastToken = null;
      throw e;
    }
    try {
      return await res.json();
    } catch (e) {
      throw unexpected(step, t("moxfieldUnreadable"));
    }
  }

  // Réponse complète de l'API d'un deck.
  async function fetchDeck(publicId) {
    const body = await authorizedJson("deck", `${MOXFIELD_DECK_URL}/${encodeURIComponent(publicId)}`);
    if (!extractDeckPrintings(body)) throw unexpected("deck", t("moxfieldNotDeck"));
    return body;
  }

  // Édition et numéro de chaque impression du deck : { [code]: { set, cn } }
  // (cf. extractDeckPrintings).
  async function fetchDeckPrintings(publicId) {
    return extractDeckPrintings(await fetchDeck(publicId));
  }

  // Éditions d'une carte (cf. readCardEditions).
  async function fetchCardEditions(uniqueCardId) {
    const body = await authorizedJson("editions", `${MOXFIELD_EDITIONS_URL}/${encodeURIComponent(uniqueCardId)}`);
    const editions = readCardEditions(body);
    if (!editions) throw unexpected("editions", t("moxfieldNotEditions"));
    return editions;
  }

  // Passe une carte du deck sur une autre édition. deck : réponse de
  // fetchDeck (relue juste avant : sa version doit être la dernière) ;
  // entry : cf. deckEntries ; edition : cf. readCardEditions. Vérifie que
  // Moxfield a bien enregistré l'édition demandée. Fin de l'URL : impression
  // actuelle de la carte (card.id), pas son uniqueCardId — avec ce dernier,
  // Moxfield le lit comme l'impression d'une autre carte et refuse (400
  // « Specified printing ID is not a printing of … », constaté en vrai,
  // novembre 2026).
  async function setDeckCardEdition(deck, entry, edition) {
    const url = `${MOXFIELD_DECK_WRITE_URL}/${encodeURIComponent(deck.id)}/cards/${encodeURIComponent(entry.board)}/${encodeURIComponent(entry.cardId)}`;
    const body = await authorizedJson("edition-change", url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-deck-version": String(deck.version), "x-public-deck-id": deck.publicId },
      body: JSON.stringify(editionChangeBody(entry, edition)),
    });
    if (!body || !body.card || body.card.id !== edition.cardId) throw unexpected("edition-change", t("moxfieldEditionNotSaved"));
    return body;
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

  return { findUserId, downloadCollectionCSV, fetchDeck, fetchDeckPrintings, fetchCardEditions, setDeckCardEdition };
}

// Zones d'un deck qui en font partie (même règle que la page : Considering
// n'en fait pas partie, cf. CLAUDE.md).
const IGNORED_BOARDS = new Set(["maybeboard"]);

// Cartes d'un deck (réponse de son API) : [{ board, uniqueCardId, name,
// quantity, finish, lang, isAlter, isProxy, cardId, set, cn, several }].
// several : l'entrée regroupe plusieurs impressions (printingData), à ne
// pas réduire à une seule.
function deckEntries(deck) {
  const entries = [];
  if (!deck || !deck.boards || typeof deck.boards !== "object") return entries;
  for (const [board, content] of Object.entries(deck.boards)) {
    if (IGNORED_BOARDS.has(board) || !content || !content.cards) continue;
    for (const [key, entry] of Object.entries(content.cards)) {
      const card = entry && entry.card;
      if (!card || typeof card.name !== "string" || typeof card.id !== "string") continue;
      entries.push({
        board,
        uniqueCardId: typeof card.uniqueCardId === "string" ? card.uniqueCardId : key,
        name: card.name,
        quantity: Number.isInteger(entry.quantity) ? entry.quantity : 1,
        finish: typeof entry.finish === "string" ? entry.finish : "nonFoil",
        lang: typeof card.lang === "string" ? card.lang : "en",
        isAlter: Boolean(entry.isAlter),
        isProxy: Boolean(entry.isProxy),
        cardId: card.id,
        set: typeof card.set === "string" ? card.set.toLowerCase() : "",
        cn: typeof card.cn === "string" ? card.cn.toLowerCase() : "",
        several: Array.isArray(entry.printingData) && entry.printingData.length > 1,
      });
    }
  }
  return entries;
}

// Exemplaires marqués « proxy » dans un deck sur Moxfield (drapeau isProxy
// de l'entrée, ou de chaque impression quand l'entrée en regroupe
// plusieurs) : { [nom de la carte]: quantité }. Considering écartée. Ce
// choix de l'utilisateur sur Moxfield vaut pour l'extension : ces
// exemplaires sont montés en proxy, jamais pris au stock.
function declaredProxies(deck) {
  const proxies = {};
  if (!deck || !deck.boards || typeof deck.boards !== "object") return proxies;
  for (const [board, content] of Object.entries(deck.boards)) {
    if (IGNORED_BOARDS.has(board) || !content || !content.cards) continue;
    for (const entry of Object.values(content.cards)) {
      const card = entry && entry.card;
      if (!card || typeof card.name !== "string") continue;
      const detailed = Array.isArray(entry.printingData) && entry.printingData.length > 0;
      const qty = detailed
        ? entry.printingData.filter((p) => p && p.isProxy === true).reduce((n, p) => n + (Number.isInteger(p.quantity) ? p.quantity : 1), 0)
        : entry.isProxy === true ? (Number.isInteger(entry.quantity) && entry.quantity > 0 ? entry.quantity : 1) : 0;
      if (qty > 0) proxies[card.name] = (proxies[card.name] || 0) + qty;
    }
  }
  return proxies;
}

// Le deck appartient-il au compte connecté ? true, false, ou null si on ne
// peut pas le savoir. Réponse de l'API d'un deck (confirmée via inspection
// réelle, novembre 2026) : ownerUserId (ex. "XN1JV"), comparé au suffixe du
// cookie refresh_token_<userId> (cf. findUserId). Les co-auteurs
// (authorsCanEdit) ne sont désignés que par leur pseudo, que l'extension ne
// connaît pas : dans ce cas, null (on laisse faire, Moxfield tranchera).
function deckOwnedBy(deck, userId) {
  if (!deck || typeof deck.ownerUserId !== "string" || !deck.ownerUserId || typeof userId !== "string" || !userId) return null;
  if (deck.ownerUserId === userId) return true;
  return deck.authorsCanEdit === true ? null : false;
}

// Cartes d'un deck pour la vue « Mes decks » du popup (réponse de son
// API) : [{ name, qty, proxyQty?, printings: [{ code, set, cn, qty, eur? }] }], une entrée
// par carte (zones additionnées, Considering écartée comme sur la page).
// code : id de l'impression, sans la finition, comme le marqueur de
// collection de la page (cf. ownedVersionOf dans deck-scraper.js), pour que
// les versions venues de l'API et de la page se comparent.
function deckCardList(deck) {
  const byName = new Map();
  if (!deck || !deck.boards || typeof deck.boards !== "object") return [];
  // eur : prix de l'impression (cf. priceOf), pour le coût de la liste
  // d'achats du popup.
  const printing = (p, card, qty) => {
    const result = {
      code: String(card.id || ""),
      set: String(card.set || p.set || "").trim().toLowerCase(),
      cn: String(card.cn || p.cn || "").trim().toLowerCase(),
      qty,
    };
    const eur = priceOf(card.prices);
    if (eur !== undefined) result.eur = eur;
    return result;
  };
  for (const [board, content] of Object.entries(deck.boards)) {
    if (IGNORED_BOARDS.has(board) || !content || !content.cards) continue;
    for (const entry of Object.values(content.cards)) {
      const card = entry && entry.card;
      if (!card || typeof card.name !== "string") continue;
      const qty = Number.isInteger(entry.quantity) && entry.quantity > 0 ? entry.quantity : 1;
      const detailed = Array.isArray(entry.printingData) && entry.printingData.length > 0;
      const printings = detailed
        ? entry.printingData.filter((p) => p && p.card).map((p) => printing(p, p.card, Number.isInteger(p.quantity) ? p.quantity : 1))
        : [printing({}, card, qty)];
      if (!byName.has(card.name)) byName.set(card.name, { name: card.name, qty: 0, printings: [] });
      const item = byName.get(card.name);
      item.qty += qty;
      item.printings.push(...printings.filter((p) => p.set));
    }
  }
  const proxies = declaredProxies(deck);
  return [...byName.values()].map((c) => (proxies[c.name] ? { ...c, proxyQty: proxies[c.name] } : c));
}

// Réponse des éditions d'une carte → [{ cardId, set, cn, setName, finishes }]
// (édition et numéro en minuscules, comme la collection) ; null si ce n'en
// est pas une.
function readCardEditions(body) {
  if (!Array.isArray(body)) return null;
  return body
    .filter((e) => e && typeof e.cardId === "string" && typeof e.abbreviation === "string")
    .map((e) => ({
      cardId: e.cardId,
      set: e.abbreviation.toLowerCase(),
      cn: typeof e.cn === "string" ? e.cn.toLowerCase() : "",
      setName: typeof e.name === "string" ? e.name : e.abbreviation,
      finishes: ["nonFoil", "foil", "etched"].filter((f) => e[`has${f[0].toUpperCase()}${f.slice(1)}`] === true),
    }));
}

// Corps du changement d'édition : quantité, langue et drapeaux de l'entrée
// gardés ; finition demandée (edition.finish : celle que tu possèdes) si
// l'édition l'a, sinon celle de l'entrée si l'édition l'a, sinon la
// première qu'elle propose (une édition qui n'existe qu'en foil).
function editionChangeBody(entry, edition) {
  const available = (f) => f && (edition.finishes.includes(f) || edition.finishes.length === 0);
  const finish = available(edition.finish) ? edition.finish : available(entry.finish) ? entry.finish : edition.finishes[0];
  return {
    quantity: entry.quantity,
    finish,
    printingData: [{ id: edition.cardId, quantity: entry.quantity, finish, lang: entry.lang, isAlter: entry.isAlter, isProxy: entry.isProxy }],
  };
}

// Prix en euros d'une impression (card.prices de l'API d'un deck), ou
// undefined. « eur » est le prix Cardmarket que Moxfield affiche quand
// Cardmarket est choisi comme source de prix ; « eur_foil » seulement pour
// une impression qui n'existe qu'en foil (pas de prix « eur ») : la finition
// n'est pas distinguée (cf. CLAUDE.md, Règles métier).
function priceOf(prices) {
  if (!prices || typeof prices !== "object") return undefined;
  for (const value of [prices.eur, prices.eur_foil]) {
    // Number.isFinite écarte aussi un prix en texte (« 1.50 ») et null.
    if (Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

// Réponse de l'API d'un deck → { [code de l'impression]: { set, cn, eur? } },
// édition et numéro en minuscules comme le détail par édition du stock (cf.
// parseCollectionCSV dans background.js), eur : prix (cf. priceOf). Toutes
// les zones sont lues, « Considering » comprise : ce n'est qu'une table de
// correspondance, et un code désigne la même impression partout. Une entrée
// regroupant plusieurs impressions les détaille dans printingData, chacune
// avec son propre prix (structure confirmée via inspection réelle, novembre
// 2026). null si la réponse n'est pas celle d'un deck.
function extractDeckPrintings(deck) {
  if (!deck || typeof deck.boards !== "object" || deck.boards === null) return null;
  const printings = {};
  const add = (card) => {
    if (!card || typeof card.id !== "string" || typeof card.set !== "string" || !card.set) return;
    const printing = { set: card.set.trim().toLowerCase(), cn: typeof card.cn === "string" ? card.cn.trim().toLowerCase() : "" };
    const eur = priceOf(card.prices);
    if (eur !== undefined) printing.eur = eur;
    printings[card.id] = printing;
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

if (typeof module !== "undefined") {
  module.exports = { createMoxfieldCollection, computeCollectionDiff, extractDeckPrintings, deckEntries, deckCardList, declaredProxies, deckOwnedBy, readCardEditions, editionChangeBody, MoxfieldError };
}
