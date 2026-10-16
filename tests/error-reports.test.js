// Tests des rapports d'erreurs envoyés à Sentry (error-reports.js) : npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const { createErrorReports } = require("../error-reports.js");

const DSN = "https://abc123@o42.ingest.de.sentry.io/777";
const HOUR = 60 * 60 * 1000;

function reports({ dsn = DSN, fetch, at = Date.UTC(2026, 9, 14, 10) } = {}) {
  const clock = { t: at };
  const calls = [];
  const r = createErrorReports({
    dsn,
    now: () => clock.t,
    fetch: fetch || (async (url, init) => (calls.push({ url, init }), { ok: true })),
  });
  return { r, clock, calls };
}

const BRAVE_LINUX = {
  brave: { isBrave: async () => true },
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  userAgentData: { platform: "Linux" },
};

test("DSN : adresse d'envoi Sentry, ou rien si absente ou invalide", () => {
  const { r } = reports();
  assert.equal(r.configured, true);
  assert.deepEqual(r.parseDsn(DSN), {
    key: "abc123",
    endpoint: "https://o42.ingest.de.sentry.io/api/777/envelope/?sentry_key=abc123&sentry_version=7",
  });
  assert.equal(r.parseDsn(""), null);
  assert.equal(r.parseDsn("pas une dsn"), null);
  assert.equal(reports({ dsn: "" }).r.configured, false);
});

test("jetons et adresses mail masqués dans les rapports", () => {
  const { r } = reports();
  const text = r.scrub(
    "GET https://api.moxfield.com/v1/collections/download?a=1&access_token=eyJabc.def&b=2 — Bearer eyJ0eXAi.x-y_z — compte jean.dupont@gmail.com"
  );
  assert.ok(!/eyJ|jean\.dupont/.test(text), text);
  assert.match(text, /access_token=\[masqué\]&b=2/);
  assert.match(text, /Bearer \[masqué\]/);
  assert.match(text, /\[mail masqué\]/);
});

test("une même erreur part au plus une fois par heure", () => {
  const { r, clock } = reports();
  const report = { where: "drive-sync", message: "Connexion à Google refusée ou annulée." };
  let { allowed, log } = r.allow(undefined, report);
  assert.equal(allowed, true);
  ({ allowed, log } = r.allow(log, report));
  assert.equal(allowed, false, "répétée tout de suite");
  ({ allowed, log } = r.allow(log, { ...report, where: "popup" }));
  assert.equal(allowed, true, "autre endroit : autre erreur");
  clock.t += HOUR;
  ({ allowed, log } = r.allow(log, report));
  assert.equal(allowed, true, "une heure après");
});

test("20 rapports au plus par jour, compteur remis à zéro le lendemain", () => {
  const { r, clock } = reports();
  let log;
  let allowed;
  for (let i = 0; i < r.MAX_PER_DAY; i++) {
    ({ allowed, log } = r.allow(log, { where: "x", message: `erreur ${i}` }));
    assert.equal(allowed, true);
  }
  ({ allowed, log } = r.allow(log, { where: "x", message: "une de trop" }));
  assert.equal(allowed, false);
  clock.t += 24 * HOUR;
  ({ allowed } = r.allow(log, { where: "x", message: "une de trop" }));
  assert.equal(allowed, true);
});

test("navigateur reconnu, Brave compris (il se présente comme Chrome)", () => {
  const { r } = reports();
  assert.deepEqual(r.describeBrowser(BRAVE_LINUX), { browser: "Brave 141", os: "Linux" });
  assert.deepEqual(r.describeBrowser({ ...BRAVE_LINUX, brave: undefined, userAgentData: undefined }), {
    browser: "Chrome 141",
    os: "Linux",
  });
  assert.deepEqual(r.describeBrowser(null), { browser: "inconnu", os: "inconnu" });
});

test("pile d'appels : cadres du plus ancien au plus récent, sans l'identifiant de l'extension", () => {
  const { r } = reports();
  const frames = r.parseStack(`TypeError: x is undefined
    at handleToggleDeck (chrome-extension://abcdef/background.js:254:7)
    at chrome-extension://abcdef/background.js:901:30
    at https://www.moxfield.com/main.js:1:200`);
  assert.deepEqual(frames, [
    { function: "?", filename: "https://www.moxfield.com/main.js", lineno: 1, colno: 200, in_app: false },
    { function: "?", filename: "background.js", lineno: 901, colno: 30, in_app: true },
    { function: "handleToggleDeck", filename: "background.js", lineno: 254, colno: 7, in_app: true },
  ]);
});

test("événement : erreur, version, navigateur et PC — rien d'autre", () => {
  const { r, clock } = reports();
  const event = r.buildEvent(
    { where: "drive-sync", message: "échec pour moi@exemple.fr", stack: "Error: x\n    at f (chrome-extension://id/background.js:1:2)", type: "TypeError", extra: { cause: "Error: non supporté" } },
    { release: "0.2.0", installId: "pc-1", nav: BRAVE_LINUX }
  );
  assert.match(event.event_id, /^[0-9a-f]{32}$/);
  assert.equal(event.timestamp, clock.t / 1000);
  assert.equal(event.release, "moxfield-stock-manager@0.2.0");
  assert.deepEqual(event.user, { id: "pc-1" });
  assert.deepEqual(event.tags, { where: "drive-sync", browser: "Brave 141", os: "Linux" });
  assert.equal(event.exception.values[0].type, "TypeError");
  assert.equal(event.exception.values[0].value, "échec pour [mail masqué]");
  assert.equal(event.exception.values[0].stacktrace.frames[0].filename, "background.js");
  assert.deepEqual(event.extra, { cause: "Error: non supporté" });
});

test("envoi : enveloppe Sentry postée en text/plain", async () => {
  const { r, calls } = reports();
  const event = r.buildEvent({ where: "popup", message: "boum" }, { release: "0.2.0", installId: "pc-1", nav: null });
  assert.equal(await r.send(event), true);
  const [{ url, init }] = calls;
  assert.equal(url, r.parseDsn(DSN).endpoint);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "text/plain;charset=UTF-8");
  const [header, item, payload] = init.body.split("\n").map((l) => JSON.parse(l));
  assert.equal(header.event_id, event.event_id);
  assert.deepEqual(item, { type: "event" });
  assert.deepEqual(payload, event);
});

test("envoi : sans DSN rien ne part, et un échec réseau ne lève pas", async () => {
  const none = reports({ dsn: "" });
  assert.equal(await none.r.send({ event_id: "x" }), false);
  assert.equal(none.calls.length, 0);
  const offline = reports({ fetch: async () => { throw new Error("hors ligne"); } });
  assert.equal(await offline.r.send({ event_id: "x" }), false);
});
