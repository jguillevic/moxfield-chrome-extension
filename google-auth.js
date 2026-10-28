// google-auth.js — connexion à Google par la fenêtre de connexion
// (chrome.identity.launchWebAuthFlow), pour les navigateurs autres que
// Google Chrome.
//
// Chargé par le service worker (importScripts dans background.js) et par les
// tests Node (tests/), d'où la fabrique paramétrée par les API du navigateur.
//
// chrome.identity.getAuthToken (connexion par le compte du profil) n'existe
// que dans Google Chrome : Brave, Edge, Opera… la refusent. La fenêtre de
// connexion fonctionne partout. Elle demande un identifiant OAuth de type
// « Application Web » dont l'URI de redirection est
// https://<id de l'extension>.chromiumapp.org/ (fixé par la clé du manifest).
//
// Flux à jeton direct (response_type=token) : pas de jeton de
// renouvellement, qui exigerait un secret impossible à garder dans un dépôt
// public. Le jeton dure 1 h ; on en redemande un sans fenêtre (prompt=none),
// ce qui marche tant que la session Google du navigateur est ouverte.
// Vérifié en vrai sous Chrome (octobre 2026) : renouvellement silencieux en
// moins d'une seconde ; adresse du compte lisible via Drive avec la seule
// autorisation drive.appdata.

// Erreur de connexion, avec un code : "renew" (renouvellement silencieux
// impossible : reconnexion à faire), "cancelled" (fenêtre fermée ou accès
// refusé), "failed" (autre : anormal). expected : situation normale, à ne
// pas rapporter comme une erreur de l'extension.
class GoogleAuthError extends Error {
  constructor(code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = "GoogleAuthError";
    this.code = code;
    this.expected = code !== "failed";
  }
}

// Google Chrome garde sa connexion par le profil (sans fenêtre). Ailleurs,
// y compris Chromium, la fenêtre. Brave se présente comme Chrome dans le
// userAgent, mais pas dans userAgentData.brands.
function chooseAuthMethod(nav) {
  const brands = (nav && nav.userAgentData && nav.userAgentData.brands) || [];
  if (nav && nav.brave) return "web";
  return brands.some((b) => b.brand === "Google Chrome") ? "chrome" : "web";
}

// i18n : textes traduits (cf. i18n.js).
function createGoogleWebAuth({ identity, session, runtime, fetch, clientId, scope, i18n: { t }, isBrave = false, now = () => Date.now(), keepAliveMs = 20 * 1000 }) {
  const TOKEN_KEY = "moxfieldStockManagerGoogleToken";
  // Un jeton qui expire dans moins d'une minute est renouvelé d'avance.
  const EXPIRY_MARGIN_MS = 60 * 1000;
  // Pendant que la fenêtre est ouverte, le service worker n'a pas d'activité
  // et Chrome l'arrête au bout de 30 s : le jeton serait perdu (constaté en
  // vrai). Un appel d'API toutes les 20 s (keepAliveMs) le maintient en vie
  // (Chrome 110+).
  const SILENT_TIMEOUT_MS = 10 * 1000;
  // Fenêtre fermée par l'utilisateur (message de Chrome).
  const USER_CLOSED = /did not approve|cancel/i;

  function authUrl({ interactive, loginHint }) {
    const params = new URLSearchParams({
      client_id: clientId,
      response_type: "token",
      redirect_uri: identity.getRedirectURL(),
      scope,
      // Connexion : toujours proposer le choix du compte, sinon Google
      // reprendrait sans rien demander le compte d'une connexion précédente.
      prompt: interactive ? "select_account" : "none",
    });
    // Plusieurs comptes Google ouverts : sans indication, Google demande
    // lequel au lieu de renouveler en silence.
    if (loginHint) params.set("login_hint", loginHint);
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  }

  // https://<id>.chromiumapp.org/#access_token=…&expires_in=3599 (ou #error=…).
  function parseRedirect(redirect) {
    const hash = String(redirect || "").split("#")[1] || "";
    const p = new URLSearchParams(hash);
    return { token: p.get("access_token"), expiresIn: Number(p.get("expires_in")) || 0, error: p.get("error") };
  }

  async function cached() {
    const data = await session.get(TOKEN_KEY);
    return data[TOKEN_KEY] || null;
  }

  async function readEmail(token) {
    const res = await fetch("https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new GoogleAuthError("failed", t("googleAccountReadError", res.status));
    return (await res.json()).user.emailAddress;
  }

  async function launch(interactive, loginHint) {
    const keepAlive = setInterval(() => runtime.getPlatformInfo(), keepAliveMs);
    try {
      return await identity.launchWebAuthFlow({
        url: authUrl({ interactive, loginHint }),
        interactive,
        abortOnLoadForNonInteractive: false,
        timeoutMsForNonInteractive: SILENT_TIMEOUT_MS,
      });
    } catch (e) {
      if (!interactive) throw renewError(e);
      if (USER_CLOSED.test(e.message || "")) {
        throw new GoogleAuthError("cancelled", t("googleCancelled"), e);
      }
      const message = t("googleWindowFailed") + (isBrave ? ` ${t("googleBraveHint")}` : "");
      throw new GoogleAuthError("failed", message, e);
    } finally {
      clearInterval(keepAlive);
    }
  }

  function renewError(cause) {
    return new GoogleAuthError("renew", t("googleRenew"), cause);
  }

  async function requestToken(interactive, loginHint) {
    const current = await cached();
    if (current && current.expiresAt - EXPIRY_MARGIN_MS > now()) return current;
    // Sans compte connu, un renouvellement silencieux prendrait n'importe
    // quel compte ouvert : seule une connexion (choix explicite) en donne un.
    if (!interactive && !loginHint && !(current && current.email)) throw renewError();
    const result = parseRedirect(await launch(interactive, loginHint || (current && current.email)));
    if (!result.token) {
      if (!interactive) throw renewError(result.error ? new Error(result.error) : undefined);
      throw new GoogleAuthError(result.error === "access_denied" ? "cancelled" : "failed",
        t("googleCancelled"), result.error ? new Error(result.error) : undefined);
    }
    const entry = { token: result.token, expiresAt: now() + result.expiresIn * 1000, email: await readEmail(result.token) };
    await session.set({ [TOKEN_KEY]: entry });
    return entry;
  }

  // Une seule demande à la fois (alarme de synchro et popup en même temps
  // ouvriraient deux fenêtres) : les suivantes attendent la première puis
  // réutilisent son jeton.
  let queue = Promise.resolve();
  // → { token, email } ; interactive : seulement sur un clic de
  // l'utilisateur, jamais depuis une synchro en fond.
  function getToken({ interactive = false, loginHint = null } = {}) {
    const run = queue.then(() => requestToken(interactive, loginHint));
    queue = run.catch(() => {});
    return run;
  }

  // Jeton refusé par Google (401) : le suivant sera redemandé, en silence
  // pour le même compte (adresse gardée).
  async function invalidate() {
    const current = await cached();
    if (current) await session.set({ [TOKEN_KEY]: { email: current.email, expiresAt: 0 } });
  }

  // Déconnexion : jeton révoqué chez Google, pour que la prochaine
  // connexion reparte de zéro (choix du compte, autorisation).
  async function signOut() {
    const current = await cached();
    await session.remove(TOKEN_KEY);
    if (!current || !current.token) return;
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(current.token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      });
    } catch (e) {
      // hors ligne : le jeton expirera de lui-même dans l'heure
    }
  }

  async function currentEmail() {
    const current = await cached();
    return current ? current.email : null;
  }

  return { TOKEN_KEY, authUrl, parseRedirect, getToken, invalidate, signOut, currentEmail };
}

if (typeof module !== "undefined") module.exports = { createGoogleWebAuth, chooseAuthMethod, GoogleAuthError };
