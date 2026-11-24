// error-reports.js — rapports d'erreurs anonymes envoyés à Sentry, pour
// voir les erreurs de tous les utilisateurs et améliorer l'extension.
//
// Chargé par le service worker (importScripts dans background.js) et par les
// tests Node (tests/), d'où la fabrique paramétrée par fetch. La page d'un
// deck et le popup ne l'utilisent pas : ils passent leurs erreurs au service
// worker (message REPORT_ERROR).
//
// Pas de SDK Sentry (aucune dépendance dans l'extension) : on poste
// directement une « enveloppe » sur l'API d'ingestion. La DSN n'est pas un
// secret : elle permet seulement d'envoyer des événements, pas de les lire.
// En text/plain pour éviter la requête préalable CORS, comme le SDK.
//
// Contenu d'un rapport : message et pile de l'erreur, endroit, version de
// l'extension, navigateur et système, identifiant au hasard du PC. Jamais
// le stock, les decks, ni l'adresse mail ; les jetons et adresses mail qui
// traîneraient dans un message sont masqués (scrub).
//
// Même canal pour « Proposer une idée » (popup) : un retour d'utilisateur
// Sentry (« User Feedback »), pour que proposer une idée ne demande aucun
// compte (un formulaire d'issue GitHub en demandait un). Seule adresse mail
// qui part : celle que l'utilisateur tape lui-même pour qu'on lui réponde.

function createErrorReports({ dsn, fetch, now = () => Date.now() }) {
  // Une même erreur (endroit + message) part au plus une fois par heure, et
  // 20 rapports au plus par jour et par PC : une erreur répétée en boucle
  // (alarme, contrôle de la page toutes les 3 s) ne doit pas épuiser le
  // quota gratuit de Sentry.
  const SAME_ERROR_INTERVAL_MS = 60 * 60 * 1000;
  const MAX_PER_DAY = 20;
  const MAX_TEXT = 2000;
  // Sentry refuse un retour de plus de 4096 caractères. 10 idées par jour
  // et par PC : de quoi tout dire, sans laisser un clic répété en boucle
  // remplir le projet.
  const MAX_FEEDBACK_TEXT = 4000;
  const MAX_FEEDBACK_PER_DAY = 10;
  const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  // https://<clé>@o123.ingest.de.sentry.io/<projet> → URL d'envoi.
  function parseDsn(value) {
    const m = /^https:\/\/([0-9a-f]+)@([^/]+)\/(\d+)$/i.exec((value || "").trim());
    if (!m) return null;
    const [, key, host, project] = m;
    return { key, endpoint: `https://${host}/api/${project}/envelope/?sentry_key=${key}&sentry_version=7` };
  }
  const target = parseDsn(dsn);

  function scrub(text) {
    return String(text == null ? "" : text)
      .replace(/(access_token|refresh_token|token)=[^&\s"']+/gi, "$1=[masqué]")
      .replace(/Bearer\s+[\w.~+/=-]+/gi, "Bearer [masqué]")
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[mail masqué]")
      .slice(0, MAX_TEXT);
  }

  function fingerprint(report) {
    return `${report.where}|${String(report.message).split("\n")[0]}`;
  }

  // log : { sent: { [empreinte]: date d'envoi }, day: "AAAA-MM-JJ", dayCount }.
  // Renvoie { allowed, log } : le journal mis à jour à conserver.
  function allow(log, report) {
    const t = now();
    const day = new Date(t).toISOString().slice(0, 10);
    const fresh = log && log.day === day ? log : { sent: {}, day, dayCount: 0 };
    const sent = {};
    for (const [fp, at] of Object.entries(fresh.sent || {})) {
      if (t - at < SAME_ERROR_INTERVAL_MS) sent[fp] = at;
    }
    const fp = fingerprint(report);
    if (sent[fp] || fresh.dayCount >= MAX_PER_DAY) return { allowed: false, log: { ...fresh, sent } };
    sent[fp] = t;
    return { allowed: true, log: { sent, day, dayCount: fresh.dayCount + 1 } };
  }

  // nav : navigator. Brave se présente comme Chrome dans le userAgent ; il
  // n'est reconnaissable qu'à navigator.brave.
  function describeBrowser(nav) {
    if (!nav) return { browser: "inconnu", os: "inconnu" };
    const ua = nav.userAgent || "";
    const version = (/Chrome\/(\d+)/.exec(ua) || [])[1];
    let name = "Chrome";
    if (nav.brave) name = "Brave";
    else if (/Edg\//.test(ua)) name = "Edge";
    else if (/OPR\//.test(ua)) name = "Opera";
    const os = (nav.userAgentData && nav.userAgentData.platform) ||
      (/Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "inconnu");
    return { browser: version ? `${name} ${version}` : name, os };
  }

  // Pile V8 (« at fn (chrome-extension://<id>/background.js:12:5) ») →
  // cadres Sentry, du plus ancien au plus récent. Le chemin est ramené au
  // nom du fichier : l'identifiant de l'extension n'apporte rien.
  function parseStack(stack) {
    const frames = [];
    for (const line of String(stack || "").split("\n")) {
      const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
      if (!m) continue;
      const [, fn, file, lineno, colno] = m;
      frames.push({
        function: fn || "?",
        filename: file.replace(/^chrome-extension:\/\/[^/]+\//, ""),
        lineno: Number(lineno),
        colno: Number(colno),
        in_app: file.startsWith("chrome-extension://"),
      });
    }
    return frames.reverse();
  }

  function newEventId() {
    let id = "";
    for (let i = 0; i < 32; i++) id += Math.floor(Math.random() * 16).toString(16);
    return id;
  }

  // report : { where, message, stack?, type?, extra? } ; context : { release,
  // Utilisateur d'un envoi : l'identifiant au hasard du PC, et ip_address
  // à null. Sans lui, Sentry ajoute l'adresse IP de la connexion et en
  // déduit une ville (constaté en vrai : ville gardée même avec « Prevent
  // Storing of IP Addresses » coché) ; null lui demande de ne pas la
  // déduire (documentation Sentry, « Users' IP Address and Location »). Pas
  // de champ sdk.settings.infer_ip : essayé avant, non documenté, l'envoi
  // n'est jamais arrivé (constaté en vrai).
  function sentryUser(installId) {
    return { id: installId, ip_address: null };
  }

  // installId, nav }.
  function buildEvent(report, context) {
    const { browser, os } = describeBrowser(context.nav);
    const frames = parseStack(report.stack);
    const exception = { type: report.type || "Error", value: scrub(report.message) };
    if (frames.length > 0) exception.stacktrace = { frames };
    const extra = {};
    for (const [k, v] of Object.entries(report.extra || {})) extra[k] = scrub(typeof v === "string" ? v : JSON.stringify(v));
    return {
      event_id: newEventId(),
      timestamp: now() / 1000,
      platform: "javascript",
      level: "error",
      release: `moxfield-stock-manager@${context.release}`,
      user: sentryUser(context.installId),
      tags: { where: report.where, browser, os },
      exception: { values: [exception] },
      extra,
    };
  }

  // Idée tapée dans le popup : { ok: true, message, email } nettoyés, ou
  // { ok: false, reason } ("empty", "tooLong", "badEmail"). Partagée par le
  // popup (bouton désactivé avec sa raison) et le service worker (refus).
  function checkFeedback({ message, email } = {}) {
    const text = String(message == null ? "" : message).trim();
    const mail = String(email == null ? "" : email).trim();
    if (!text) return { ok: false, reason: "empty" };
    if (text.length > MAX_FEEDBACK_TEXT) return { ok: false, reason: "tooLong" };
    if (mail && !EMAIL.test(mail)) return { ok: false, reason: "badEmail" };
    return { ok: true, message: text, email: mail };
  }

  // Idées encore possibles aujourd'hui : annoncé avant le clic (bouton
  // désactivé avec sa raison), pas appris après un refus.
  function feedbackLeft(log) {
    const day = new Date(now()).toISOString().slice(0, 10);
    return MAX_FEEDBACK_PER_DAY - (log && log.day === day ? log.count : 0);
  }

  // log : { day: "AAAA-MM-JJ", count }. Renvoie { allowed, log }.
  function allowFeedback(log) {
    const day = new Date(now()).toISOString().slice(0, 10);
    const count = log && log.day === day ? log.count : 0;
    if (count >= MAX_FEEDBACK_PER_DAY) return { allowed: false, log: { day, count } };
    return { allowed: true, log: { day, count: count + 1 } };
  }

  // feedback : sortie de checkFeedback ; context : { release, installId,
  // nav, lang }. Le texte n'est pas masqué (scrub) : l'utilisateur l'a écrit
  // pour qu'on le lise, adresse comprise.
  function buildFeedback(feedback, context) {
    const { browser, os } = describeBrowser(context.nav);
    const contextFeedback = { message: feedback.message, source: "popup" };
    if (feedback.email) contextFeedback.contact_email = feedback.email;
    const tags = { where: "feedback", browser, os };
    if (context.lang) tags.lang = context.lang;
    return {
      event_id: newEventId(),
      timestamp: now() / 1000,
      platform: "javascript",
      level: "info",
      release: `moxfield-stock-manager@${context.release}`,
      user: sentryUser(context.installId),
      tags,
      contexts: { feedback: contextFeedback },
    };
  }

  // type : "event" (erreur) ou "feedback" (idée).
  function buildEnvelope(event, type = "event") {
    const header = { event_id: event.event_id, sent_at: new Date(now()).toISOString() };
    return `${JSON.stringify(header)}\n${JSON.stringify({ type })}\n${JSON.stringify(event)}`;
  }

  // Ne lève jamais : un rapport qui ne part pas ne doit pas créer une
  // nouvelle erreur.
  async function send(event, type = "event") {
    if (!target) return false;
    try {
      const res = await fetch(target.endpoint, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
        body: buildEnvelope(event, type),
      });
      return res.ok;
    } catch (e) {
      return false;
    }
  }

  return {
    configured: Boolean(target),
    SAME_ERROR_INTERVAL_MS,
    MAX_PER_DAY,
    MAX_FEEDBACK_TEXT,
    MAX_FEEDBACK_PER_DAY,
    parseDsn,
    scrub,
    allow,
    describeBrowser,
    parseStack,
    buildEvent,
    buildEnvelope,
    checkFeedback,
    allowFeedback,
    feedbackLeft,
    buildFeedback,
    send,
  };
}

if (typeof module !== "undefined") module.exports = { createErrorReports };
