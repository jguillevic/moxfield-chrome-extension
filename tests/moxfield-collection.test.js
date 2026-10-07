// Tests de la récupération de la collection Moxfield (moxfield-collection.js) : npm test
//
// Les appels à Moxfield sont simulés : la fausse fonction fetch répond comme
// l'API observée (cf. en-tête de moxfield-collection.js) et enregistre les
// requêtes reçues.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMoxfieldCollection, computeCollectionDiff } = require("../moxfield-collection.js");

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
// ("refresh", "download", "csv").
function fakeMoxfield({ cookies = LOGGED_IN, overrides = {} } = {}) {
  const requests = [];
  const fetch = async (url, options = {}) => {
    const step = url.includes("/token/refresh") ? "refresh" : url.includes("/token/download") ? "download" : "csv";
    requests.push({ step, url, options });
    if (step in overrides) {
      const o = overrides[step];
      if (o instanceof Error) throw o;
      return o;
    }
    if (step === "refresh") return jsonResponse(200, { access_token: "session-token", token_type: "Bearer", expires_in_minutes: 15 });
    if (step === "download") return jsonResponse(200, { access_token: "export-token", token_type: "Bearer", expires_in_minutes: 1 });
    return jsonResponse(200, CSV);
  };
  const client = createMoxfieldCollection({ fetch, getCookies: async () => cookies });
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
