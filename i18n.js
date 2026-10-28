// i18n.js — textes affichés, traduits (français, anglais).
//
// Chargé par le popup (popup.html), la page d'un deck (manifest.json, avant
// content-deck.js), le service worker (importScripts dans background.js) et
// par les tests Node (tests/), d'où la fabrique paramétrée par la lecture
// des messages.
//
// Les textes sont dans _locales/<langue>/messages.json, le système de
// traduction de Chrome : la langue suit celle du navigateur, l'anglais
// (default_locale du manifest) pour toute langue non traduite. Pas de choix
// de langue dans l'extension : chrome.i18n ne sait pas en changer.
//
// Règles des messages (vérifiées par tests/i18n.test.js) :
// - mêmes clés dans toutes les langues ;
// - valeurs insérées en $1…$9 (remplacées par chrome.i18n), jamais deux
//   collées ("$1$2" serait lu par Chrome comme un nom de variable et
//   empêcherait l'extension de se charger) ;
// - pluriels : deux clés <clé>_one et <clé>_other, choisies par tn() selon
//   les règles de la langue (en français, 0 et 1 s'accordent au singulier ;
//   en anglais, seul 1).

// getMessage : (clé, [valeurs]) → texte, "" si la clé n'existe pas (comme
// chrome.i18n.getMessage).
function createI18n(getMessage) {
  function read(key, subs) {
    try {
      return getMessage(key, subs) || "";
    } catch (e) {
      // Content script d'une extension rechargée : chrome.i18n peut lever
      // (« Extension context invalidated »). La clé reste lisible.
      return "";
    }
  }

  // Langue réellement utilisée (celle du navigateur si elle est traduite,
  // sinon la langue par défaut) : c'est elle, et non celle du navigateur,
  // qui doit régler pluriels et dates.
  const locale = read("locale") || "en";
  const pluralRules = new Intl.PluralRules(locale);

  // Une clé manquante s'affiche telle quelle : visible, sans planter.
  function t(key, ...subs) {
    return read(key, subs.map(String)) || key;
  }

  // Pluriel : count est aussi la première valeur ($1).
  function tn(key, count, ...subs) {
    const form = pluralRules.select(count) === "one" ? "one" : "other";
    return t(`${key}_${form}`, count, ...subs);
  }

  // Date et heure courtes (ex. 07/10/2026 15:42, 10/7/26, 3:42 PM).
  function formatDateTime(value) {
    return new Date(value).toLocaleString(locale, { dateStyle: "short", timeStyle: "short" });
  }

  function formatDay(value) {
    return new Date(value).toLocaleDateString(locale);
  }

  // Textes d'une page HTML : data-i18n (contenu), data-i18n-placeholder,
  // data-i18n-title. Les éléments n'ont pas de texte dans le HTML : une seule
  // source, les messages.
  function translateDocument(doc) {
    doc.documentElement.lang = locale;
    for (const el of doc.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const el of doc.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
    for (const el of doc.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  }

  return { locale, t, tn, formatDateTime, formatDay, translateDocument };
}

// Messages de l'extension (popup, page d'un deck, service worker).
function createChromeI18n() {
  return createI18n((key, subs) => chrome.i18n.getMessage(key, subs));
}

if (typeof module !== "undefined") module.exports = { createI18n };
