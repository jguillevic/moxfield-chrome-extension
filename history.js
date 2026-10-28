// history.js — historique des changements du stock et des decks montés.
//
// Chargé par le service worker (importScripts dans background.js) et par les
// tests Node (tests/). Aucun accès au stockage : uniquement des calculs sur
// la liste des entrées (state.history, la plus récente en premier).
//
// Entrées : { id, at, device, type, ...détail } —
//   collection     { source: "fetch" | "csv", changes: [{name, from, to}], changeCount? }
//   deck-built     { deckId, deckName, url, builtAt, cardCount }
//   deck-unbuilt   { deckId, deckName, url, cards }
//   deck-updated   { deckId, deckName, url, changes, changeCount?, previousCards, updatedAt }
// changeCount : nombre total quand le détail est tronqué (cf. compactEntry).
//   reset          { builtDecks }
//   drive-restore  {}
// Les libellés sont calculés à l'affichage (describe), dans la langue du
// moment : les entrées n'enregistrent que des données.
// Pour l'instant, l'historique se consulte seulement. Les entrées gardent
// de quoi annuler plus tard une action sur les decks montés (liste du deck
// démonté, liste avant mise à jour, decks avant réinitialisation, dates de
// montage et de mise à jour) — cf. ROADMAP.md.

// i18n : textes traduits (cf. i18n.js).
function createHistory(normalizeName, { tn, t }) {
  // Six à sept semaines d'usage normal (une trentaine d'actions par semaine).
  const MAX_ENTRIES = 200;

  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  // Détail gardé par entrée : le premier import d'une grosse collection
  // change des dizaines de milliers de cartes (≈ 2 Mo pour 30 000 noms), ce
  // qui finirait par saturer le stockage de Chrome et alourdirait chaque
  // envoi sur Drive. Au-delà, seul le nombre total est conservé.
  const MAX_CHANGES_PER_ENTRY = 200;

  function compactEntry(entry) {
    if (!Array.isArray(entry.changes) || entry.changes.length <= MAX_CHANGES_PER_ENTRY) return entry;
    return {
      ...entry,
      changes: entry.changes.slice(0, MAX_CHANGES_PER_ENTRY),
      changeCount: entry.changeCount || entry.changes.length,
    };
  }

  // Nombre total de cartes modifiées, détail tronqué compris.
  function changeCount(entry) {
    return entry.changeCount || entry.changes.length;
  }

  // Les entrées déjà enregistrées sont compactées au passage (historiques
  // d'avant la limite).
  function addEntry(history, entry) {
    return [entry, ...(history || [])].slice(0, MAX_ENTRIES).map(compactEntry);
  }

  // Union de deux historiques (synchro Drive : rien ne doit se perdre, même
  // quand une version gagne un conflit).
  function mergeHistories(a, b) {
    const byId = new Map();
    for (const e of [...(a || []), ...(b || [])]) {
      if (!byId.has(e.id)) byId.set(e.id, e);
    }
    return [...byId.values()].sort((x, y) => y.at - x.at).slice(0, MAX_ENTRIES).map(compactEntry);
  }

  // Différences de quantités entre deux listes de cartes, par nom (cumulées
  // si un nom apparaît plusieurs fois), triées : [{ name, from, to }].
  function cardsDiff(fromCards, toCards) {
    const tally = (cards) => {
      const map = new Map();
      for (const c of cards) {
        const key = normalizeName(c.name);
        const prev = map.get(key);
        map.set(key, { name: prev ? prev.name : c.name, qty: (prev ? prev.qty : 0) + c.qty });
      }
      return map;
    };
    const before = tally(fromCards);
    const after = tally(toCards);
    const changes = [];
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const from = before.has(key) ? before.get(key).qty : 0;
      const to = after.has(key) ? after.get(key).qty : 0;
      if (from !== to) changes.push({ name: (after.get(key) || before.get(key)).name, from, to });
    }
    return changes.sort((x, y) => x.name.localeCompare(y.name));
  }

  function cardCount(cards) {
    return cards.reduce((n, c) => n + c.qty, 0);
  }

  // Libellé d'une entrée, pour le popup.
  function describe(entry) {
    switch (entry.type) {
      case "collection":
        return tn(entry.source === "csv" ? "historyCsvImport" : "historyCollectionFetched", changeCount(entry));
      case "deck-built":
        return tn("historyDeckBuilt", entry.cardCount, entry.deckName);
      case "deck-unbuilt":
        return tn("historyDeckUnbuilt", cardCount(entry.cards), entry.deckName);
      case "deck-updated":
        return tn("historyDeckUpdated", changeCount(entry), entry.deckName);
      case "reset":
        return tn("historyReset", Object.keys(entry.builtDecks).length);
      case "drive-restore":
        return t("historyDriveRestore");
      default:
        return entry.type;
    }
  }

  return { MAX_ENTRIES, MAX_CHANGES_PER_ENTRY, newId, addEntry, mergeHistories, compactEntry, changeCount, cardsDiff, cardCount, describe };
}

if (typeof module !== "undefined") module.exports = { createHistory };
