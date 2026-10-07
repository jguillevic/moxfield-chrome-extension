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
// Aucun jeton n'est conservé : tout est redemandé à chaque récupération.

const MOXFIELD_API2 = "https://api2.moxfield.com/v1/account/token";
const MOXFIELD_COLLECTION_CSV_URL =
  "https://api.moxfield.com/v1/collections/download?sortColumn=cardName&sortDirection=ascending&pricingProvider=cardmarket";

// Erreur de récupération, avec un code pour l'interface : "not-logged-in"
// (pas de session Moxfield dans Chrome), "blocked" (refus, ex. protection
// anti-robot), "api-changed" (réponse inattendue : Moxfield a changé ses
// appels), "network" (Moxfield injoignable).
class MoxfieldError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// getCookies : renvoie les cookies de moxfield.com ({name, value}).
function createMoxfieldCollection({ fetch, getCookies }) {
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
      throw new MoxfieldError("network", "Moxfield est injoignable (réseau).");
    }
    if (res.ok) return res;
    if (step === "refresh" && (res.status === 400 || res.status === 401)) {
      throw new MoxfieldError("not-logged-in", "Session Moxfield expirée : reconnecte-toi sur moxfield.com dans Chrome.");
    }
    if (res.status === 403 || res.status === 429) {
      throw new MoxfieldError("blocked", `Moxfield a refusé la récupération (code ${res.status}). Réessaie plus tard, ou utilise l'import CSV.`);
    }
    throw unexpected(step, `code ${res.status}`);
  }

  function unexpected(step, detail) {
    return new MoxfieldError(
      "api-changed",
      `Réponse inattendue de Moxfield (étape « ${step} », ${detail}) : son fonctionnement a peut-être changé. Utilise l'import CSV en attendant.`
    );
  }

  async function readToken(step, res) {
    let body;
    try {
      body = await res.json();
    } catch (e) {
      throw unexpected(step, "réponse illisible");
    }
    if (!body || typeof body.access_token !== "string" || !body.access_token) throw unexpected(step, "jeton absent");
    return body.access_token;
  }

  async function downloadCollectionCSV() {
    const userId = await findUserId();
    if (!userId) {
      throw new MoxfieldError("not-logged-in", "Pas de session Moxfield : connecte-toi sur moxfield.com dans Chrome.");
    }
    const refresh = await request("refresh", `${MOXFIELD_API2}/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, isAppLogin: false }),
    });
    const accessToken = await readToken("refresh", refresh);
    const download = await request("download", `${MOXFIELD_API2}/download`, {
      method: "POST",
      credentials: "include",
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const exportToken = await readToken("download", download);
    const csv = await request("csv", `${MOXFIELD_COLLECTION_CSV_URL}&access_token=${encodeURIComponent(exportToken)}`, {});
    const text = await csv.text();
    const header = text.split("\n", 1)[0].toLowerCase();
    if (!/\bcount\b/.test(header) || !/\bname\b/.test(header)) throw unexpected("csv", "pas un CSV de collection");
    return text;
  }

  return { findUserId, downloadCollectionCSV };
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

if (typeof module !== "undefined") module.exports = { createMoxfieldCollection, computeCollectionDiff, MoxfieldError };
