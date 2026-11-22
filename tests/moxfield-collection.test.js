// Tests de la récupération de la collection Moxfield (moxfield-collection.js) : npm test
//
// Les appels à Moxfield sont simulés : la fausse fonction fetch répond comme
// l'API observée (cf. en-tête de moxfield-collection.js) et enregistre les
// requêtes reçues.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { createMoxfieldCollection, computeCollectionDiff, extractDeckPrintings, deckEntries, deckCardList, declaredProxies, readCardEditions, editionChangeBody } = require("../moxfield-collection.js");
const { loadI18n, FIXTURES_DIR } = require("./helpers");

// Réponse de l'API d'un deck : structure observée (novembre 2026), réduite
// aux champs utiles, avec les codes de la page de test text.html.
const DECK = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "api", "deck.json"), "utf8"));
// Éditions d'une carte : structure observée (novembre 2026), valeurs
// construites pour la carte Golgari Thug du deck de test.
const EDITIONS = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, "api", "card-editions.json"), "utf8"));

const CSV = '"Count","Tradelist Count","Name","Edition"\n"2","0","Sol Ring","c21"\n';
const LOGGED_IN = [
  { name: "_ga", value: "GA1.1" },
  { name: "refresh_token", value: "rt-1" },
  { name: "refresh_token_ABC12", value: "rt-1" },
];

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

// overrides : réponse (ou exception) à renvoyer pour une étape donnée
// ("refresh", "download", "csv", "deck").
function fakeMoxfield({ cookies = LOGGED_IN, overrides = {}, now } = {}) {
  const requests = [];
  const fetch = async (url, options = {}) => {
    const step = url.includes("/token/refresh")
      ? "refresh"
      : url.includes("/token/download")
        ? "download"
        : url.includes("/decks/all/")
          ? "deck"
          : url.includes("/cards/editions/")
            ? "editions"
            : url.includes("/v2/decks/")
              ? "edition-change"
              : "csv";
    requests.push({ step, url, options });
    if (step in overrides) {
      const o = overrides[step];
      if (o instanceof Error) throw o;
      return o;
    }
    if (step === "refresh") return jsonResponse(200, { access_token: "session-token", token_type: "Bearer", expires_in_minutes: 15 });
    if (step === "download") return jsonResponse(200, { access_token: "export-token", token_type: "Bearer", expires_in_minutes: 1 });
    if (step === "deck") return jsonResponse(200, DECK);
    if (step === "editions") return jsonResponse(200, EDITIONS);
    // Comme Moxfield : l'entrée modifiée, avec la nouvelle impression.
    if (step === "edition-change") return jsonResponse(200, { card: { id: JSON.parse(options.body).printingData[0].id, uniqueCardId: "u0001" } });
    return jsonResponse(200, CSV);
  };
  const client = createMoxfieldCollection({ fetch, getCookies: async () => cookies, i18n: loadI18n(), now });
  return { client, requests };
}

async function rejectsWith(promise, code, messagePattern) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.code, code);
    if (messagePattern) assert.match(e.message, messagePattern);
    return true;
  });
}

test("récupération : les trois appels du site, dans l'ordre", async () => {
  const { client, requests } = fakeMoxfield();
  assert.equal(await client.downloadCollectionCSV(), CSV);
  assert.deepEqual(requests.map((r) => r.step), ["refresh", "download", "csv"]);

  const [refresh, download, csv] = requests;
  assert.equal(refresh.url, "https://api2.moxfield.com/v1/account/token/refresh");
  assert.equal(refresh.options.method, "POST");
  assert.equal(refresh.options.credentials, "include", "cookie de renouvellement joint");
  assert.deepEqual(JSON.parse(refresh.options.body), { userId: "ABC12", isAppLogin: false });

  assert.equal(download.url, "https://api2.moxfield.com/v1/account/token/download");
  assert.equal(download.options.method, "POST");
  assert.equal(download.options.headers.Authorization, "Bearer session-token");

  assert.match(csv.url, /^https:\/\/api\.moxfield\.com\/v1\/collections\/download\?/);
  assert.match(csv.url, /&access_token=export-token$/);
});

test("userId : déduit du nom du cookie de renouvellement", async () => {
  const { client } = fakeMoxfield();
  assert.equal(await client.findUserId(), "ABC12");
});

test("userId : avec plusieurs comptes, celui du jeton courant", async () => {
  const { client } = fakeMoxfield({
    cookies: [
      { name: "refresh_token_OLD01", value: "rt-old" },
      { name: "refresh_token_NEW02", value: "rt-new" },
      { name: "refresh_token", value: "rt-new" },
    ],
  });
  assert.equal(await client.findUserId(), "NEW02");
});

test("pas de cookie de session : pas connecté, aucun appel", async () => {
  const { client, requests } = fakeMoxfield({ cookies: [{ name: "_ga", value: "x" }] });
  await rejectsWith(client.downloadCollectionCSV(), "not-logged-in", /connecte-toi sur moxfield\.com/);
  assert.equal(requests.length, 0);
});

test("session expirée (401 au renouvellement) : pas connecté", async () => {
  const { client } = fakeMoxfield({ overrides: { refresh: jsonResponse(401, {}) } });
  await rejectsWith(client.downloadCollectionCSV(), "not-logged-in", /reconnecte-toi/);
});

test("refus (403, ex. Cloudflare) : bloqué", async () => {
  const { client } = fakeMoxfield({ overrides: { refresh: jsonResponse(403, "<html>") } });
  await rejectsWith(client.downloadCollectionCSV(), "blocked", /code 403/);
});

test("trop de requêtes (429) : bloqué", async () => {
  const { client } = fakeMoxfield({ overrides: { csv: jsonResponse(429, "") } });
  await rejectsWith(client.downloadCollectionCSV(), "blocked", /code 429/);
});

test("réseau coupé : injoignable", async () => {
  const { client } = fakeMoxfield({ overrides: { refresh: new TypeError("Failed to fetch") } });
  await rejectsWith(client.downloadCollectionCSV(), "network");
});

test("appel déplacé (404) : l'API a changé", async () => {
  const { client } = fakeMoxfield({ overrides: { download: jsonResponse(404, "") } });
  await rejectsWith(client.downloadCollectionCSV(), "api-changed", /étape « download », code 404/);
});

test("réponse sans jeton : l'API a changé", async () => {
  const { client } = fakeMoxfield({ overrides: { refresh: jsonResponse(200, { token: "renamed" }) } });
  await rejectsWith(client.downloadCollectionCSV(), "api-changed", /jeton absent/);
});

test("réponse qui n'est pas du JSON : l'API a changé", async () => {
  const { client } = fakeMoxfield({ overrides: { download: jsonResponse(200, "<html>oops</html>") } });
  await rejectsWith(client.downloadCollectionCSV(), "api-changed", /illisible/);
});

test("fichier qui n'est pas un CSV de collection : l'API a changé", async () => {
  const { client } = fakeMoxfield({ overrides: { csv: jsonResponse(200, "<!doctype html><p>Login</p>") } });
  await rejectsWith(client.downloadCollectionCSV(), "api-changed", /pas un CSV de collection/);
});

test("computeCollectionDiff : ajouts, retraits, changements de quantité", () => {
  const before = {
    "sol ring": { name: "Sol Ring", qty: 2 },
    counterspell: { name: "Counterspell", qty: 1 },
    island: { name: "Island", qty: 10 },
  };
  const after = {
    "sol ring": { name: "Sol Ring", qty: 3 },
    island: { name: "Island", qty: 10 },
    "rhystic study": { name: "Rhystic Study", qty: 1 },
  };
  assert.deepEqual(computeCollectionDiff(before, after), [
    { name: "Counterspell", from: 1, to: 0 },
    { name: "Rhystic Study", from: 0, to: 1 },
    { name: "Sol Ring", from: 2, to: 3 },
  ]);
});

test("computeCollectionDiff : quantité nulle équivaut à une carte absente", () => {
  assert.deepEqual(computeCollectionDiff({ "sol ring": { name: "Sol Ring", qty: 0 } }, {}), []);
});

// --- Éditions des cartes d'un deck (API du deck) ---

// Prix : « eur », ou « eur_foil » pour une impression qui n'existe qu'en
// foil (SWAMP2) ; aucun sans prix (bIrDs).
const EXPECTED_PRINTINGS = {
  ZOwRD: { set: "rav", cn: "87", eur: 0.15 },
  E0aWJ: { set: "pktk", cn: "199p", eur: 0.9 },
  xRXAR: { set: "mh3", cn: "235", eur: 0.1 },
  SWAMP1: { set: "war", cn: "256", eur: 0.11 },
  SWAMP2: { set: "pwar", cn: "war-115", eur: 0.8 },
  bIrDs: { set: "plst", cn: "52★" },
  mAyBe: { set: "c21", cn: "263", eur: 1.25 },
};

test("extractDeckPrintings : édition et numéro de chaque impression, en minuscules", () => {
  // Toutes les zones (« Considering » comprise), impressions multiples d'une
  // même carte (printingData), numéros qui ne sont pas des nombres.
  assert.deepEqual(extractDeckPrintings(DECK), EXPECTED_PRINTINGS);
});

test("extractDeckPrintings : réponse qui n'est pas un deck, entrées incomplètes", () => {
  assert.equal(extractDeckPrintings(null), null);
  assert.equal(extractDeckPrintings({ message: "Not found" }), null);
  const partial = { boards: { mainboard: { cards: { a: { card: { id: "AAAAA" } }, b: { quantity: 1 }, c: null, d: { card: { id: "DDDDD", set: "c21" } } } }, attractions: null } };
  assert.deepEqual(extractDeckPrintings(partial), { DDDDD: { set: "c21", cn: "" } });
});

test("extractDeckPrintings : prix absents, nuls ou illisibles ignorés", () => {
  const card = (id, prices) => ({ card: { id, set: "c21", cn: "1", prices } });
  const deck = {
    boards: {
      mainboard: {
        cards: {
          a: card("ZERO0", { eur: 0, eur_foil: 0 }),
          b: card("TEXT0", { eur: "1.50" }),
          c: card("NULL0", null),
          d: card("FOIL0", { eur: null, eur_foil: 3.2 }),
          e: card("BOTH0", { eur: 0.4, eur_foil: 3.2 }),
        },
      },
    },
  };
  const eurOf = (code) => extractDeckPrintings(deck)[code].eur;
  assert.deepEqual(["ZERO0", "TEXT0", "NULL0"].map(eurOf), [undefined, undefined, undefined]);
  assert.equal(eurOf("FOIL0"), 3.2, "impression qui n'existe qu'en foil");
  assert.equal(eurOf("BOTH0"), 0.4, "prix non foil d'abord");
});

test("éditions d'un deck : renouvellement puis lecture du deck, avec le jeton", async () => {
  const { client, requests } = fakeMoxfield();
  assert.deepEqual(await client.fetchDeckPrintings("abc123"), EXPECTED_PRINTINGS);
  assert.deepEqual(requests.map((r) => r.step), ["refresh", "deck"]);
  const deck = requests[1];
  assert.equal(deck.url, "https://api2.moxfield.com/v3/decks/all/abc123");
  assert.equal(deck.options.method, undefined, "simple lecture");
  assert.equal(deck.options.headers.Authorization, "Bearer session-token");
});

test("éditions d'un deck : le jeton est réutilisé quelques minutes, jamais pour la collection", async () => {
  const clock = { now: 1000 };
  const { client, requests } = fakeMoxfield({ now: () => clock.now });
  const refreshes = () => requests.filter((r) => r.step === "refresh").length;
  await client.fetchDeckPrintings("abc123");
  clock.now += 9 * 60 * 1000;
  await client.fetchDeckPrintings("def456");
  assert.equal(refreshes(), 1, "plusieurs decks d'affilée : un seul renouvellement");
  clock.now += 2 * 60 * 1000;
  await client.fetchDeckPrintings("abc123");
  assert.equal(refreshes(), 2, "jeton trop ancien : redemandé");
  await client.downloadCollectionCSV();
  assert.equal(refreshes(), 3, "la collection redemande toujours un jeton");
  await client.fetchDeckPrintings("abc123");
  assert.equal(refreshes(), 3, "…que la lecture d'un deck peut réutiliser");
});

test("éditions d'un deck : après un échec, le jeton n'est pas réutilisé", async () => {
  const overrides = { deck: jsonResponse(401, {}) };
  const { client, requests } = fakeMoxfield({ overrides });
  await rejectsWith(client.fetchDeckPrintings("abc123"), "deck-unavailable");
  delete overrides.deck;
  await client.fetchDeckPrintings("abc123");
  assert.equal(requests.filter((r) => r.step === "refresh").length, 2);
});

test("éditions d'un deck : erreurs", async () => {
  const failing = (overrides, cookies) => fakeMoxfield({ overrides, cookies }).client.fetchDeckPrintings("abc123");
  await rejectsWith(failing({ deck: jsonResponse(404, {}) }), "deck-unavailable", /introuvable ou privé/);
  await rejectsWith(failing({ deck: jsonResponse(403, "<html>") }), "blocked");
  await rejectsWith(failing({ deck: jsonResponse(500, "") }), "api-changed");
  await rejectsWith(failing({ deck: jsonResponse(200, "<html>oops</html>") }), "api-changed", /illisible/);
  await rejectsWith(failing({ deck: jsonResponse(200, { cards: [] }) }), "api-changed", /pas la description d'un deck/);
  await rejectsWith(failing({ deck: new TypeError("Failed to fetch") }), "network");
  await rejectsWith(failing({}, [{ name: "_ga", value: "x" }]), "not-logged-in");
});

// --- Changement d'édition d'une carte d'un deck ---

test("deckEntries : cartes du deck hors Considering, avec ce qu'il faut pour les modifier", () => {
  const entries = deckEntries(DECK);
  assert.deepEqual(entries.map((e) => `${e.board}:${e.name}`), [
    "mainboard:Golgari Thug",
    "mainboard:Sidisi, Brood Tyrant",
    "mainboard:Revitalizing Repast // Old-Growth Grove",
    "mainboard:Swamp",
    "commanders:Birds of Paradise",
  ]);
  assert.deepEqual(entries[0], {
    board: "mainboard",
    uniqueCardId: "u0001",
    name: "Golgari Thug",
    quantity: 1,
    finish: "nonFoil",
    lang: "en",
    isAlter: false,
    isProxy: false,
    cardId: "ZOwRD",
    set: "rav",
    cn: "87",
    several: false,
  });
  assert.equal(entries[1].set, "pktk", "édition en minuscules");
  assert.equal(entries[3].several, true, "plusieurs impressions dans la même entrée");
  assert.deepEqual(deckEntries(null), []);
  assert.deepEqual(deckEntries({ boards: { mainboard: { cards: { x: { card: { id: "A" } } } } } }), [], "entrée sans nom ignorée");
});

test("readCardEditions : édition, numéro et finitions de chaque impression", () => {
  assert.deepEqual(readCardEditions(EDITIONS), [
    { cardId: "ZOwRD", set: "rav", cn: "87", setName: "Ravnica: City of Guilds", finishes: ["nonFoil", "foil"] },
    { cardId: "GtDds", set: "dds", cn: "50", setName: "Duel Decks: Mind vs. Might", finishes: ["nonFoil"] },
    { cardId: "GtPrm", set: "prm", cn: "24a", setName: "Magic Online Promos", finishes: ["foil"] },
  ]);
  assert.equal(readCardEditions({ data: [] }), null);
  assert.deepEqual(readCardEditions([{ cardId: "A" }, null]), [], "entrées incomplètes ignorées");
});

test("editionChangeBody : quantité, langue et drapeaux gardés, finition gardée si possible", () => {
  const entry = { quantity: 2, finish: "foil", lang: "ja", isAlter: true, isProxy: false };
  assert.deepEqual(editionChangeBody(entry, { cardId: "NEW01", finishes: ["nonFoil", "foil"] }), {
    quantity: 2,
    finish: "foil",
    printingData: [{ id: "NEW01", quantity: 2, finish: "foil", lang: "ja", isAlter: true, isProxy: false }],
  });
  // Édition qui n'existe pas en foil : sa première finition.
  assert.equal(editionChangeBody(entry, { cardId: "NEW01", finishes: ["nonFoil"] }).finish, "nonFoil");
  // Finitions inconnues : celle de l'entrée.
  assert.equal(editionChangeBody(entry, { cardId: "NEW01", finishes: [] }).finish, "foil");
});

test("éditions d'une carte : appel avec le jeton", async () => {
  const { client, requests } = fakeMoxfield();
  assert.equal((await client.fetchCardEditions("u0001")).length, 3);
  const call = requests.find((r) => r.step === "editions");
  assert.equal(call.url, "https://api2.moxfield.com/v3/cards/editions/u0001");
  assert.equal(call.options.headers.Authorization, "Bearer session-token");
  const changed = fakeMoxfield({ overrides: { editions: jsonResponse(200, { cards: [] }) } });
  await rejectsWith(changed.client.fetchCardEditions("u0001"), "api-changed");
});

test("changement d'édition : appel du site, version du deck en en-tête, résultat vérifié", async () => {
  const { client, requests } = fakeMoxfield();
  const deck = await client.fetchDeck("abc123");
  const entry = deckEntries(deck)[0];
  await client.setDeckCardEdition(deck, entry, { cardId: "GtDds", finishes: ["nonFoil"] });
  const call = requests.find((r) => r.step === "edition-change");
  // Impression actuelle de la carte (card.id), pas son uniqueCardId : bug
  // constaté en vrai (refus 400 « not a printing of »), novembre 2026.
  assert.equal(call.url, "https://api2.moxfield.com/v2/decks/0000000/cards/mainboard/ZOwRD");
  assert.equal(call.options.method, "PUT");
  assert.equal(call.options.headers.Authorization, "Bearer session-token");
  assert.equal(call.options.headers["x-deck-version"], "6");
  assert.equal(call.options.headers["x-public-deck-id"], "abc123");
  assert.equal(call.options.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(call.options.body), {
    quantity: 1,
    finish: "nonFoil",
    printingData: [{ id: "GtDds", quantity: 1, finish: "nonFoil", lang: "en", isAlter: false, isProxy: false }],
  });
  // Moxfield répond sans la nouvelle impression : pas enregistré.
  const ignored = fakeMoxfield({ overrides: { "edition-change": jsonResponse(200, { card: { id: "ZOwRD" } }) } });
  await rejectsWith(ignored.client.setDeckCardEdition(deck, entry, { cardId: "GtDds", finishes: [] }), "api-changed", /pas enregistré/);
  // Refus (deck d'un autre compte, version périmée…).
  const refused = fakeMoxfield({ overrides: { "edition-change": jsonResponse(403, {}) } });
  await rejectsWith(refused.client.setDeckCardEdition(deck, entry, { cardId: "GtDds", finishes: [] }), "blocked");
  const conflict = fakeMoxfield({ overrides: { "edition-change": jsonResponse(409, {}) } });
  await rejectsWith(conflict.client.setDeckCardEdition(deck, entry, { cardId: "GtDds", finishes: [] }), "api-changed");
});

// Vue « Mes decks » du popup : cartes d'un deck lues par son API.
test("deckCardList : une entrée par carte, Considering écartée, impressions détaillées (code sans finition, prix)", () => {
  const cards = deckCardList(DECK);
  assert.deepEqual(cards.map((c) => [c.name, c.qty]), [
    ["Golgari Thug", 1],
    ["Sidisi, Brood Tyrant", 1],
    ["Revitalizing Repast // Old-Growth Grove", 1],
    ["Swamp", 3],
    ["Birds of Paradise", 1],
  ]);
  assert.deepEqual(cards.find((c) => c.name === "Swamp").printings, [
    { code: "SWAMP1", set: "war", cn: "256", qty: 2, eur: 0.11 },
    { code: "SWAMP2", set: "pwar", cn: "war-115", qty: 1, eur: 0.8 },
  ]);
  assert.deepEqual(cards[0].printings, [{ code: "ZOwRD", set: "rav", cn: "87", qty: 1, eur: 0.15 }]);
  assert.deepEqual(deckCardList({ cards: [] }), [], "pas un deck");
});

test("deckCardList : même carte dans deux zones, quantités additionnées", () => {
  const entry = (quantity) => ({ quantity, card: { id: "AAA", name: "Sol Ring", set: "c21", cn: "263" } });
  const deck = { boards: { mainboard: { cards: { a: entry(1) } }, sideboard: { cards: { b: entry(2) } } } };
  assert.deepEqual(deckCardList(deck), [{ name: "Sol Ring", qty: 3, printings: [{ code: "AAA", set: "c21", cn: "263", qty: 1 }, { code: "AAA", set: "c21", cn: "263", qty: 2 }] }]);
});

test("declaredProxies : marque proxy de l'entrée ou de chaque impression, Considering écartée", () => {
  const entry = (quantity, extra = {}) => ({ quantity, card: { id: "A", name: extra.name || "Sol Ring", set: "c21", cn: "1" }, ...extra });
  const deck = {
    boards: {
      mainboard: {
        cards: {
          a: entry(2, { isProxy: true }),
          b: entry(3, { name: "Swamp", printingData: [{ quantity: 2, isProxy: false, card: { id: "S1", name: "Swamp", set: "war", cn: "256" } }, { quantity: 1, isProxy: true, card: { id: "S2", name: "Swamp", set: "pwar", cn: "1" } }] }),
          c: entry(1, { name: "Arcane Signet" }),
        },
      },
      maybeboard: { cards: { d: entry(1, { name: "Rhystic Study", isProxy: true }) } },
    },
  };
  assert.deepEqual(declaredProxies(deck), { "Sol Ring": 2, Swamp: 1 });
  assert.deepEqual(deckCardList(deck).map((c) => [c.name, c.proxyQty]), [["Sol Ring", 2], ["Swamp", 1], ["Arcane Signet", undefined]]);
  assert.deepEqual(declaredProxies(DECK), {}, "aucune marque proxy dans la page de test");
});
