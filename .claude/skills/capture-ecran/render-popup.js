// Construit une copie de popup.html avec un faux `chrome` (textes fr ou en,
// réponses simulées du service worker) pour une capture dans Chrome sans
// interface (cf. SKILL.md).
// Usage : node render-popup.js <racine du dépôt> <sortie.html> <fr|en> [sélecteur|-] [clé de pastille]
const fs = require("fs");
const path = require("path");

const [repo, out, lang = "fr", clickSelector = "-", syncPillKey] = process.argv.slice(2);
if (!repo || !out) {
  console.error("Usage : node render-popup.js <racine du dépôt> <sortie.html> <fr|en> [sélecteur|-] [clé de pastille]");
  process.exit(2);
}

// Réponses simulées du service worker, par type de message : à compléter
// selon l'écran à vérifier.
const RESPONSES = {
  GET_STATE: { ok: true, state: { stock: {}, builtDecks: {} } },
  GET_SYNC_STATUS: { ok: true, meta: { enabled: false } },
  GET_FEEDBACK_STATUS: { ok: true, configured: true, left: 10, max: 10 },
  GET_ONBOARDING: { ok: true, done: true },
  GET_VERSION_INFO: { ok: true, version: "0.0.0" },
  GET_COLLECTION_STATUS: { ok: true, meta: { enabled: true }, uncovered: [] },
  GET_ERROR_REPORTS: { ok: true, enabled: true, configured: true },
};

const messages = JSON.parse(fs.readFileSync(path.join(repo, `_locales/${lang}/messages.json`), "utf8"));
const base = "file:///" + path.resolve(repo).replace(/\\/g, "/") + "/";
let html = fs.readFileSync(path.join(repo, "popup.html"), "utf8");

const stub = `<script>
const MESSAGES = ${JSON.stringify(messages)};
const RESPONSES = ${JSON.stringify(RESPONSES)};
window.chrome = {
  i18n: {
    getMessage: (key, subs) => {
      const m = MESSAGES[key];
      if (!m) return "";
      let s = m.message;
      [].concat(subs || []).forEach((v, i) => { s = s.split("$" + (i + 1)).join(v); });
      return s;
    },
  },
  runtime: {
    getManifest: () => ({ version: "0.0.0" }),
    sendMessage: async (msg) => RESPONSES[msg.type] || { ok: true },
  },
  storage: { onChanged: { addListener: () => {} } },
};
</script>`;

const after = `<script>
setTimeout(() => {
  ${syncPillKey ? `const pill = document.getElementById("sync-pill"); pill.className = "pill error"; pill.textContent = chrome.i18n.getMessage(${JSON.stringify(syncPillKey)}) || pill.textContent;` : ""}
  ${clickSelector !== "-" ? `const el = document.querySelector(${JSON.stringify(clickSelector)}); if (el) el.click();` : ""}
}, 200);
</script>`;

html = html
  .replace("<head>", `<head><base href="${base}">`)
  .replace(/<script src="i18n\.js"><\/script>/, `${stub}<script src="i18n.js"></script>`)
  .replace("</body>", `${after}</body>`);
fs.writeFileSync(out, html);
console.log(`Page de capture écrite : ${out}`);
