// Tests de la connexion Google par la fenêtre de connexion (google-auth.js),
// hors Google Chrome : npm test
//
// launchWebAuthFlow, la mémoire de session et Google Drive sont simulés.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createGoogleWebAuth, chooseAuthMethod, GoogleAuthError } = require("../google-auth.js");
const { loadI18n } = require("./helpers");

const REDIRECT = "https://pkifconeiolgllnjbnbenadbohcihopf.chromiumapp.org/";
const HOUR = 60 * 60 * 1000;

// options.launch : (details) => URL de redirection (ou lève) ; par défaut,
// un jeton valable 1 h.
function setup(options = {}) {
  const clock = { t: Date.UTC(2026, 9, 16, 10) };
  const store = {};
  const launches = [];
  const fetches = [];
  let tokenCount = 0;
  const keepAlive = { calls: 0 };
  const auth = createGoogleWebAuth({
    i18n: loadI18n(),
    identity: {
      getRedirectURL: () => REDIRECT,
      launchWebAuthFlow: async (details) => {
        launches.push(details);
        if (options.launch) return options.launch(details);
        tokenCount++;
        return `${REDIRECT}#access_token=jeton-${tokenCount}&token_type=Bearer&expires_in=3599`;
      },
    },
    session: {
      get: async (key) => (key in store ? { [key]: JSON.parse(JSON.stringify(store[key])) } : {}),
      set: async (items) => Object.assign(store, JSON.parse(JSON.stringify(items))),
      remove: async (key) => delete store[key],
    },
    runtime: { getPlatformInfo: () => keepAlive.calls++ },
    fetch: async (url, init) => {
      fetches.push({ url, init });
      if (url.includes("/about")) return { ok: true, json: async () => ({ user: { emailAddress: options.email || "moi@gmail.com" } }) };
      return { ok: true };
    },
    clientId: "client-web",
    scope: "https://www.googleapis.com/auth/drive.appdata",
    isBrave: Boolean(options.isBrave),
    now: () => clock.t,
    keepAliveMs: options.keepAliveMs,
  });
  const params = (details) => Object.fromEntries(new URL(details.url).searchParams);
  return { auth, clock, store, launches, fetches, keepAlive, params };
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const brands = (...names) => ({ userAgent: UA, userAgentData: { brands: names.map((brand) => ({ brand, version: "141" })) } });

test("méthode : Google Chrome garde son compte de profil, les autres la fenêtre", () => {
  assert.equal(chooseAuthMethod(brands("Chromium", "Google Chrome", "Not=A?Brand")), "chrome");
  assert.equal(chooseAuthMethod(brands("Chromium", "Microsoft Edge")), "web");
  assert.equal(chooseAuthMethod(brands("Chromium", "Opera")), "web");
  assert.equal(chooseAuthMethod(brands("Chromium")), "web");
  // Brave peut se présenter comme Chrome : reconnu à navigator.brave.
  assert.equal(chooseAuthMethod({ ...brands("Chromium", "Google Chrome"), brave: {} }), "web");
  assert.equal(chooseAuthMethod({ userAgent: UA }), "web");
  assert.equal(chooseAuthMethod(null), "web");
});

test("connexion : fenêtre Google avec choix du compte, jeton et adresse du compte", async () => {
  const { auth, launches, params, clock, store } = setup();
  const result = await auth.getToken({ interactive: true });
  assert.deepEqual(result, { token: "jeton-1", expiresAt: clock.t + 3599 * 1000, email: "moi@gmail.com" });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].interactive, true);
  assert.deepEqual(params(launches[0]), {
    client_id: "client-web",
    response_type: "token",
    redirect_uri: REDIRECT,
    scope: "https://www.googleapis.com/auth/drive.appdata",
    prompt: "select_account",
  });
  assert.equal(store[auth.TOKEN_KEY].token, "jeton-1", "jeton gardé en mémoire de session");
  assert.equal(await auth.currentEmail(), "moi@gmail.com");
});

test("jeton encore valable : réutilisé sans fenêtre", async () => {
  const { auth, launches, clock } = setup();
  await auth.getToken({ interactive: true });
  clock.t += 30 * 60 * 1000;
  assert.equal((await auth.getToken()).token, "jeton-1");
  assert.equal((await auth.getToken({ interactive: true })).token, "jeton-1", "pas de seconde fenêtre");
  assert.equal(launches.length, 1);
});

test("jeton expiré : renouvelé en silence pour le même compte", async () => {
  const { auth, launches, params, clock } = setup();
  await auth.getToken({ interactive: true });
  clock.t += HOUR - 30 * 1000; // dans la marge d'une minute avant l'expiration
  assert.equal((await auth.getToken()).token, "jeton-2");
  const silent = launches[1];
  assert.equal(silent.interactive, false);
  assert.equal(silent.abortOnLoadForNonInteractive, false);
  assert.equal(params(silent).prompt, "none");
  assert.equal(params(silent).login_hint, "moi@gmail.com");
});

test("renouvellement en fond après redémarrage du navigateur : compte indiqué par la synchro", async () => {
  const { auth, launches, params } = setup();
  assert.equal((await auth.getToken({ loginHint: "moi@gmail.com" })).token, "jeton-1");
  assert.equal(params(launches[0]).login_hint, "moi@gmail.com");
});

test("renouvellement en fond sans compte connu : jamais de fenêtre, reconnexion demandée", async () => {
  const { auth, launches } = setup();
  await assert.rejects(auth.getToken(), (e) => e.code === "renew" && e.expected);
  assert.equal(launches.length, 0);
});

test("renouvellement silencieux refusé par Google : reconnexion demandée, pas une erreur à rapporter", async () => {
  const refused = setup({ launch: () => `${REDIRECT}#error=interaction_required` });
  await assert.rejects(refused.auth.getToken({ loginHint: "moi@gmail.com" }), (e) => {
    assert.equal(e.code, "renew");
    assert.equal(e.expected, true);
    assert.match(e.message, /Reconnecter/);
    return true;
  });
  const timeout = setup({ launch: () => { throw new Error("User interaction required."); } });
  await assert.rejects(timeout.auth.getToken({ loginHint: "moi@gmail.com" }), (e) => e.code === "renew");
});

test("fenêtre fermée par l'utilisateur : refus, pas une erreur à rapporter", async () => {
  const { auth } = setup({ launch: () => { throw new Error("The user did not approve access."); } });
  await assert.rejects(auth.getToken({ interactive: true }), (e) => {
    assert.equal(e.code, "cancelled");
    assert.equal(e.expected, true);
    assert.equal(e.message, "Connexion à Google refusée ou annulée.");
    return true;
  });
});

test("échec de la fenêtre : erreur rapportée, avec le réglage à activer sous Brave", async () => {
  const fail = () => { throw new Error("Authorization page could not be loaded."); };
  const brave = setup({ launch: fail, isBrave: true });
  await assert.rejects(brave.auth.getToken({ interactive: true }), (e) => {
    assert.equal(e.code, "failed");
    assert.equal(e.expected, false);
    assert.match(e.message, /brave:\/\/settings\/extensions/);
    assert.equal(e.cause.message, "Authorization page could not be loaded.");
    return true;
  });
  const edge = setup({ launch: fail });
  await assert.rejects(edge.auth.getToken({ interactive: true }), (e) => e.code === "failed" && !/Brave/.test(e.message));
});

test("demandes simultanées (alarme et popup) : une seule fenêtre", async () => {
  const { auth, launches } = setup();
  const results = await Promise.all([auth.getToken({ interactive: true }), auth.getToken({ interactive: true }), auth.getToken()]);
  assert.equal(launches.length, 1);
  assert.deepEqual(results.map((r) => r.token), ["jeton-1", "jeton-1", "jeton-1"]);
});

test("fenêtre ouverte longtemps : le service worker est maintenu en vie, puis plus", async () => {
  const slow = (details) =>
    new Promise((resolve) => setTimeout(() => resolve(`${REDIRECT}#access_token=lent&expires_in=3599`), 120));
  const { auth, keepAlive } = setup({ launch: slow, keepAliveMs: 20 });
  await auth.getToken({ interactive: true });
  assert.ok(keepAlive.calls >= 3, `${keepAlive.calls} appels`);
  const after = keepAlive.calls;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(keepAlive.calls, after, "maintien arrêté après la connexion");
});

test("jeton refusé par Google (401) : oublié, le suivant redemandé en silence pour le même compte", async () => {
  const { auth, launches, params } = setup();
  await auth.getToken({ interactive: true });
  await auth.invalidate();
  assert.equal(await auth.currentEmail(), "moi@gmail.com", "compte toujours connu");
  assert.equal((await auth.getToken()).token, "jeton-2");
  assert.equal(launches[1].interactive, false);
  assert.equal(params(launches[1]).login_hint, "moi@gmail.com");
});

test("déconnexion : jeton révoqué chez Google et oublié", async () => {
  const { auth, fetches, store } = setup();
  await auth.getToken({ interactive: true });
  await auth.signOut();
  const revoke = fetches.find((f) => f.url.startsWith("https://oauth2.googleapis.com/revoke"));
  assert.ok(revoke, "révocation demandée");
  assert.match(revoke.url, /token=jeton-1/);
  assert.equal(revoke.init.method, "POST");
  assert.equal(store[auth.TOKEN_KEY], undefined);
});

test("GoogleAuthError : seules les erreurs anormales sont à rapporter", () => {
  assert.equal(new GoogleAuthError("failed", "x").expected, false);
  assert.equal(new GoogleAuthError("renew", "x").expected, true);
  assert.equal(new GoogleAuthError("cancelled", "x").expected, true);
});
