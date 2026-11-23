// deck-help.js — icônes des boutons de la page d'un deck, et aide qui les
// explique (légende, bulle de la première visite d'un deck).
//
// Chargé avant content-deck.js (cf. manifest.json), par le popup
// (popup.html) et par les tests Node (tests/). Une seule source pour les
// icônes : la légende du popup montre exactement ce qu'affiche la page.

// i18n : textes traduits (cf. i18n.js).
function createDeckHelp({ t, tn }) {
  // Icônes Font Awesome Free 6.7.2 (CC BY 4.0) — https://fontawesome.com/license/free
  const BAR_ICONS = {
    // box-open
    build: {
      viewBox: "0 0 640 512",
      path: "M58.9 42.1c3-6.1 9.6-9.6 16.3-8.7L320 64 564.8 33.4c6.7-.8 13.3 2.7 16.3 8.7l41.7 83.4c9 17.9-.6 39.6-19.8 45.1L439.6 217.3c-13.9 4-28.8-1.9-36.2-14.3L320 64 236.6 203c-7.4 12.4-22.3 18.3-36.2 14.3L37.1 170.6c-19.3-5.5-28.8-27.2-19.8-45.1L58.9 42.1zM321.1 128l54.9 91.4c14.9 24.8 44.6 36.6 72.5 28.6L576 211.6l0 167c0 22-15 41.2-36.4 46.6l-204.1 51c-10.2 2.6-20.9 2.6-31 0l-204.1-51C79 419.7 64 400.5 64 378.5l0-167L191.6 248c27.8 8 57.6-3.8 72.5-28.6L318.9 128l2.2 0z",
    },
    // Cœur vide / plein (heart regular / solid).
    like: {
      viewBox: "0 0 512 512",
      path: "M225.8 468.2l-2.5-2.3L48.1 303.2C17.4 274.7 0 234.7 0 192.8l0-3.3c0-70.4 50-130.8 119.2-144C158.6 37.9 198.9 47 231 69.6c9 6.4 17.4 13.8 25 22.3c4.2-4.8 8.7-9.2 13.5-13.3c3.7-3.2 7.5-6.2 11.5-9c0 0 0 0 0 0C313.1 47 353.4 37.9 392.8 45.4C462 58.6 512 119.1 512 189.5l0 3.3c0 41.9-17.4 81.9-48.1 110.4L288.7 465.9l-2.5 2.3c-8.2 7.6-19 11.9-30.2 11.9s-22-4.2-30.2-11.9zM239.1 145c-.4-.3-.7-.7-1-1.1l-17.8-20-.1-.1s0 0 0 0c-23.1-25.9-58-37.7-92-31.2C81.6 101.5 48 142.1 48 189.5l0 3.3c0 28.5 11.9 55.8 32.8 75.2L256 430.7 431.2 268c20.9-19.4 32.8-46.7 32.8-75.2l0-3.3c0-47.3-33.6-88-80.1-96.9c-34-6.5-68.9 5.4-92 31.2c0 0 0 0-.1 .1s0 0-.1 .1l-17.8 20c-.3 .4-.7 .7-1 1.1c-4.5 4.5-10.6 7-16.9 7s-12.4-2.5-16.9-7z",
    },
    liked: {
      viewBox: "0 0 512 512",
      path: "M47.6 300.4L228.3 469.1c7.5 7 17.4 10.9 27.7 10.9s20.2-3.9 27.7-10.9L464.4 300.4c30.4-28.3 47.6-68 47.6-109.5l0-5.8c0-69.9-50.5-129.5-119.4-141C347 36.5 300.6 51.4 268 84L256 96 244 84c-32.6-32.6-79-47.5-124.6-39.9C50.5 55.6 0 115.2 0 185.1l0 5.8c0 41.5 17.2 81.2 47.6 109.5z",
    },
    // arrows-rotate
    editions: {
      viewBox: "0 0 512 512",
      path: "M105.1 202.6c7.7-21.8 20.2-42.3 37.8-59.8c62.5-62.5 163.8-62.5 226.3 0L386.3 160 352 160c-17.7 0-32 14.3-32 32s14.3 32 32 32l111.5 0c0 0 0 0 0 0l.4 0c17.7 0 32-14.3 32-32l0-112c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 35.2L414.4 97.6c-87.5-87.5-229.3-87.5-316.8 0C73.2 122 55.6 150.7 44.8 181.4c-5.9 16.7 2.9 34.9 19.5 40.8s34.9-2.9 40.8-19.5zM39 289.3c-5 1.5-9.8 4.2-13.7 8.2c-4 4-6.7 8.8-8.1 14c-.3 1.2-.6 2.5-.8 3.8c-.3 1.7-.4 3.4-.4 5.1L16 432c0 17.7 14.3 32 32 32s32-14.3 32-32l0-35.1 17.6 17.5c0 0 0 0 0 0c87.5 87.4 229.3 87.4 316.7 0c24.4-24.4 42.1-53.1 52.9-83.8c5.9-16.7-2.9-34.9-19.5-40.8s-34.9 2.9-40.8 19.5c-7.7 21.8-20.2 42.3-37.8 59.8c-62.5 62.5-163.8 62.5-226.3 0l-.1-.1L125.6 352l34.4 0c17.7 0 32-14.3 32-32s-14.3-32-32-32L48.4 288c-1.6 0-3.2 .1-4.8 .3s-3.1 .5-4.6 1z",
    },
    // circle-check
    built: {
      viewBox: "0 0 512 512",
      path: "M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM369 209L241 337c-9.4 9.4-24.6 9.4-33.9 0l-64-64c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l47 47L335 175c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9z",
    },
  };

  // Classe svg-inline--fa : même taille et alignement que les icônes natives
  // de la barre de Moxfield (sans effet dans le popup).
  function createBarIcon(doc, kind) {
    const SVG_NS = "http://www.w3.org/2000/svg";
    const { viewBox, path } = BAR_ICONS[kind];
    const svg = doc.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "svg-inline--fa no-pointer-events");
    svg.setAttribute("viewBox", viewBox);
    svg.setAttribute("aria-hidden", "true");
    const p = doc.createElementNS(SVG_NS, "path");
    p.setAttribute("fill", "currentColor");
    p.setAttribute("d", path);
    svg.appendChild(p);
    return svg;
  }

  // Pastille posée sur une icône : mêmes classes que sur la page (cf.
  // renderButton dans content-deck.js).
  function createBadge(doc, text, modifier) {
    const badge = doc.createElement("span");
    badge.className = "msm-avail-badge" + (modifier ? ` ${modifier}` : "");
    badge.textContent = text;
    badge.setAttribute("aria-hidden", "true");
    return badge;
  }

  // Tous les états des boutons, dans l'ordre où on les rencontre : deck pas
  // monté, puis monté, puis les deux autres boutons. state : variante de
  // l'icône (monté en vert, liste modifiée).
  const LEGEND = [
    { icon: "build", key: "legendNotBuilt" },
    { icon: "build", badge: ["OK", "msm-avail-ok"], key: "legendBuildable" },
    { icon: "build", badge: ["3"], key: "legendBlocked" },
    { icon: "built", state: "built", key: "legendBuilt" },
    { icon: "built", state: "outdated", key: "legendOutdated" },
    { icon: "built", state: "built", badge: ["2", "msm-proxy-badge"], key: "legendProxies" },
    { icon: "editions", badge: ["4", "msm-editions-badge"], key: "legendEditions" },
    { icon: "like", key: "legendLike" },
  ];

  // Icône telle qu'affichée dans la barre (blanche sur fond sombre), avec
  // sa pastille.
  function createLegendIcon(doc, item) {
    const chip = doc.createElement("span");
    chip.className = "msm-legend-icon" + (item.state === "built" ? " msm-legend-built" : "") + (item.state === "outdated" ? " msm-legend-built msm-legend-outdated" : "");
    chip.setAttribute("aria-hidden", "true");
    chip.appendChild(createBarIcon(doc, item.icon));
    if (item.badge) chip.appendChild(createBadge(doc, item.badge[0], item.badge[1]));
    return chip;
  }

  // Légende complète : « montable ≠ monté » d'abord (la confusion constatée),
  // puis chaque état. Construite en DOM (textContent) : pas d'innerHTML.
  // withCallout : false quand l'avertissement est déjà affiché juste au-dessus
  // (bulle de la page d'un deck).
  function buildLegend(doc, { withCallout = true } = {}) {
    const root = doc.createElement("div");
    root.className = "msm-legend";
    if (withCallout) {
      const callout = doc.createElement("p");
      callout.className = "msm-legend-callout";
      callout.textContent = t("legendBuildableVsBuilt");
      root.appendChild(callout);
    }
    const list = doc.createElement("ul");
    list.className = "msm-legend-list";
    for (const item of LEGEND) {
      const li = doc.createElement("li");
      li.dataset.legend = item.key;
      const text = doc.createElement("span");
      text.textContent = t(item.key);
      li.append(createLegendIcon(doc, item), text);
      list.appendChild(li);
    }
    root.appendChild(list);
    return root;
  }

  // Bulle de la première visite d'un deck : ce que dit le bouton *pour ce
  // deck*, au moment où l'utilisateur le regarde. availability : faisabilité
  // (cf. computeDeckAvailability), null si pas encore connue.
  function bubbleText({ built, outdated, availability }) {
    if (built) return t(outdated ? "deckHelpBuiltOutdated" : "deckHelpBuilt");
    if (!availability) return t("deckHelpNotBuilt");
    if (availability.blocking === 0) return t("deckHelpBuildable");
    return tn("deckHelpBlocked", availability.blocking);
  }

  return { BAR_ICONS, createBarIcon, createBadge, buildLegend, bubbleText, LEGEND };
}

if (typeof module !== "undefined") module.exports = { createDeckHelp };
