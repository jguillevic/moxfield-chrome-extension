// proxies.js — page d'impression des proxies d'un deck monté (proxies.html).
//
// Images des cartes : API publique de Scryfall, sans clé ni permission
// (en-têtes CORS ouverts, vérifiés en novembre 2026). Une seule requête
// groupée par paquet de 75 cartes (POST /cards/collection, limite de
// l'API), espacées comme Scryfall le demande. Les images elles-mêmes sont
// servies par cards.scryfall.io, sans limite de débit.
//
// Chargé par proxies.html, et par les tests Node (tests/), d'où la fabrique
// paramétrée par fetch et l'attente entre deux requêtes.

const SCRYFALL_COLLECTION_URL = "https://api.scryfall.com/cards/collection";
// Limite de l'API : 75 identifiants par requête.
const SCRYFALL_BATCH_SIZE = 75;
// Scryfall demande 50 à 100 ms entre deux requêtes.
const SCRYFALL_DELAY_MS = 100;
// Cartes par page A4 : 3 × 3 au format réel (63 × 88 mm).
const CARDS_PER_SHEET = 9;

// Erreur de Scryfall à signaler à l'utilisateur ; expected : situation
// normale (réseau coupé, Scryfall surchargé), pas de rapport d'erreur.
class ScryfallError extends Error {
  constructor(message, expected) {
    super(message);
    this.name = "ScryfallError";
    this.expected = expected;
  }
}

function createProxySheet({ fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");
  // Scryfall ne trouve pas une carte double face ou scindée par son nom
  // complet (« A // B ») dans une recherche groupée, seulement par sa face
  // avant — confirmé via l'API réelle (novembre 2026).
  const frontFace = (name) => norm(name.split(" // ")[0]);

  // Identifiant Scryfall d'une carte : sa version (édition + numéro, donnés
  // par l'API du deck Moxfield) si connue, sinon son nom.
  function identifierOf(card, byName = false) {
    if (!byName && card.set && card.cn) return { set: card.set, collector_number: card.cn };
    return { name: card.name.split(" // ")[0].trim() };
  }

  function matches(identifier, found) {
    if (identifier.set) {
      return norm(found.set) === norm(identifier.set) && norm(found.collector_number) === norm(identifier.collector_number);
    }
    return frontFace(found.name) === frontFace(identifier.name);
  }

  // Images d'une carte trouvée : une par face imprimable (carte double face :
  // recto et verso, à glisser dos à dos dans la même pochette).
  function imagesOf(found) {
    const pick = (uris) => uris && (uris.png || uris.large || uris.normal);
    if (found.image_uris) return [pick(found.image_uris)].filter(Boolean);
    return (found.card_faces || []).map((f) => pick(f.image_uris)).filter(Boolean);
  }

  async function fetchBatch(identifiers) {
    let res;
    try {
      res = await fetch(SCRYFALL_COLLECTION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ identifiers }),
      });
    } catch (e) {
      throw new ScryfallError(`network: ${e.message || e}`, true);
    }
    // Trop de requêtes, panne passagère : normal, réessayer plus tard.
    if (res.status === 429 || res.status >= 500) throw new ScryfallError(`status ${res.status}`, true);
    if (!res.ok) throw new ScryfallError(`status ${res.status}`, false);
    const body = await res.json();
    if (!body || !Array.isArray(body.data)) throw new ScryfallError("unexpected response", false);
    return body.data;
  }

  // Cherche les identifiants par paquets ; → Map identifiant (JSON) → carte.
  async function lookup(identifiers) {
    const found = new Map();
    for (let i = 0; i < identifiers.length; i += SCRYFALL_BATCH_SIZE) {
      if (i > 0) await wait(SCRYFALL_DELAY_MS);
      const batch = identifiers.slice(i, i + SCRYFALL_BATCH_SIZE);
      const data = await fetchBatch(batch);
      // Réponses dans l'ordre demandé, mais sans celles introuvables : on
      // rapproche chacune de sa demande plutôt que par position.
      for (const id of batch) {
        const match = data.find((d) => matches(id, d));
        if (match) found.set(JSON.stringify(id), match);
      }
    }
    return found;
  }

  // Cartes ({ name, qty, set?, cn? }) → emplacements à imprimer
  // [{ name, image | null }], une face par emplacement, qty fois chacune.
  // Version introuvable (code d'édition différent chez Scryfall) : nouvel
  // essai par le nom. Introuvable : emplacement sans image (nom seul).
  async function buildSlots(cards) {
    const unique = (ids) => [...new Map(ids.map((id) => [JSON.stringify(id), id])).values()];
    const first = await lookup(unique(cards.map((c) => identifierOf(c))));
    const retry = cards.filter((c) => !first.has(JSON.stringify(identifierOf(c))) && c.set && c.cn);
    if (retry.length > 0) await wait(SCRYFALL_DELAY_MS);
    const second = retry.length > 0 ? await lookup(unique(retry.map((c) => identifierOf(c, true)))) : new Map();
    const slots = [];
    for (const card of cards) {
      const found = first.get(JSON.stringify(identifierOf(card))) || second.get(JSON.stringify(identifierOf(card, true)));
      const images = found ? imagesOf(found) : [];
      for (let copy = 0; copy < card.qty; copy++) {
        if (images.length === 0) slots.push({ name: card.name, image: null });
        else for (const image of images) slots.push({ name: card.name, image });
      }
    }
    return slots;
  }

  // Emplacements → pages de CARDS_PER_SHEET.
  function toSheets(slots) {
    const sheets = [];
    for (let i = 0; i < slots.length; i += CARDS_PER_SHEET) sheets.push(slots.slice(i, i + CARDS_PER_SHEET));
    return sheets;
  }

  return { identifierOf, imagesOf, buildSlots, toSheets };
}

// --- Page (proxies.html) ---

function startProxiesPage() {
  const i18n = createChromeI18n();
  const { t, tn } = i18n;
  i18n.translateDocument(document);
  const sheetEl = document.getElementById("sheets");
  const statusEl = document.getElementById("status");
  const printBtn = document.getElementById("print");
  const markBox = document.getElementById("proxy-mark");
  const send = (type, payload) => chrome.runtime.sendMessage({ type, payload });
  const reportError = (e) => {
    const error = { message: (e && e.message) || String(e), stack: e && e.stack, type: (e && e.name) || "Error" };
    send("REPORT_ERROR", { where: "proxies-page", error }).catch(() => {});
  };

  // Mention « PROXY » sur chaque carte : activée par défaut, choix gardé
  // sur ce PC (simple confort d'affichage).
  const MARK_KEY = "msmProxyMark";
  try {
    markBox.checked = localStorage.getItem(MARK_KEY) !== "off";
  } catch (e) {
    markBox.checked = true;
  }
  const applyMark = () => document.body.classList.toggle("no-mark", !markBox.checked);
  applyMark();
  markBox.addEventListener("change", () => {
    applyMark();
    try {
      localStorage.setItem(MARK_KEY, markBox.checked ? "on" : "off");
    } catch (e) {
      // stockage indisponible : le choix vaut pour cette page seulement
    }
  });
  printBtn.addEventListener("click", () => window.print());

  function renderSheets(sheets) {
    sheetEl.replaceChildren();
    let pending = 0;
    const done = () => {
      pending--;
      if (pending === 0) printBtn.disabled = false;
    };
    for (const sheet of sheets) {
      const page = document.createElement("section");
      page.className = "sheet";
      for (const slot of sheet) {
        const cell = document.createElement("div");
        cell.className = "slot";
        if (slot.image) {
          const img = document.createElement("img");
          img.alt = slot.name;
          pending++;
          img.addEventListener("load", done);
          img.addEventListener("error", () => {
            cell.classList.add("slot-missing");
            cell.textContent = slot.name;
            done();
          });
          img.src = slot.image;
          cell.appendChild(img);
        } else {
          cell.classList.add("slot-missing");
          cell.textContent = slot.name;
        }
        const mark = document.createElement("span");
        mark.className = "proxy-mark";
        mark.textContent = t("proxiesMarkText");
        cell.appendChild(mark);
        page.appendChild(cell);
      }
      sheetEl.appendChild(page);
    }
    printBtn.disabled = pending > 0;
  }

  (async () => {
    const deckId = new URLSearchParams(location.search).get("deck");
    const res = deckId ? await send("GET_DECK_PROXIES", { deckId }) : null;
    const deck = res && res.ok ? res.deck : null;
    if (!deck || deck.cards.length === 0) {
      statusEl.textContent = t("proxiesNone");
      printBtn.disabled = true;
      return;
    }
    document.getElementById("deck-name").textContent = deck.name;
    document.title = t("proxiesPageTitleDeck", deck.name);
    const count = deck.cards.reduce((n, c) => n + c.qty, 0);
    statusEl.textContent = t("proxiesLoading");
    const sheet = createProxySheet({ fetch: (...args) => fetch(...args) });
    let slots;
    try {
      slots = await sheet.buildSlots(deck.cards);
      const missing = slots.filter((s) => !s.image).length;
      const summary = tn("proxiesSummary", count, tn("proxiesSheets", Math.ceil(slots.length / CARDS_PER_SHEET)));
      statusEl.textContent = missing > 0 ? t("proxiesSomeMissing", summary, missing) : summary;
    } catch (e) {
      if (!e.expected) reportError(e);
      statusEl.textContent = t("proxiesScryfallError");
      // Planche quand même, avec le seul nom des cartes.
      slots = deck.cards.flatMap((c) => Array.from({ length: c.qty }, () => ({ name: c.name, image: null })));
    }
    renderSheets(sheet.toSheets(slots));
  })().catch((e) => {
    reportError(e);
    statusEl.textContent = t("errorPrefix", e.message || String(e));
  });
}

if (typeof module !== "undefined") module.exports = { createProxySheet, ScryfallError, CARDS_PER_SHEET, SCRYFALL_BATCH_SIZE };
else if (typeof document !== "undefined" && document.getElementById("sheets")) startProxiesPage();
