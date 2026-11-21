// scripts/check-version.js — une livraison qui modifie l'extension doit
// augmenter sa version : node scripts/check-version.js <commit de départ>
//
// Lancé par GitHub Actions à chaque push sur main (cf.
// .github/workflows/tests.yml), avec le commit d'avant le push. Le numéro
// (champ version du manifest) est affiché dans le popup, comparé par la
// notification de nouvelle version, et le Chrome Web Store refuse un paquet
// dont la version n'augmente pas.
//
// Numérotation majeur.mineur.correctif : correctif pour une correction de
// bug, mineur pour une fonctionnalité, majeur pour une étape (ex. la
// publication sur le Store).
const { execFileSync } = require("child_process");

// Format accepté par Chrome : 1 à 4 nombres de 0 à 65535 séparés par des
// points, sans zéro en tête.
function isValidVersion(version) {
  const parts = String(version).split(".");
  return parts.length >= 1 && parts.length <= 4 && parts.every((p) => /^(0|[1-9]\d{0,4})$/.test(p) && Number(p) <= 65535);
}

// < 0 si a est plus ancienne que b, 0 si égales, > 0 sinon (« 1.2 » = « 1.2.0 »).
function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// Fichiers chargés par Chrome (mêmes règles que le paquet du Store) : un
// changement de tests, de scripts ou de documentation n'est pas une
// nouvelle version de l'extension.
function isExtensionFile(path) {
  return path === "manifest.json" || /^[^/]+\.(js|html|css)$/.test(path) || /^(icons|_locales)\//.test(path);
}

// → { ok, message }.
function checkVersionBump({ base, head = "HEAD", cwd = process.cwd() }) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const version = (ref) => JSON.parse(git("show", `${ref}:manifest.json`)).version;
  const current = version(head);
  if (!isValidVersion(current)) return { ok: false, message: `Version « ${current} » invalide pour Chrome (ex. 1.4.2).` };
  // Premier push d'une branche : pas de commit de départ.
  if (!base || /^0+$/.test(base)) return { ok: true, message: `Version ${current}.` };
  const changed = git("diff", "--name-only", base, head).split("\n").filter(isExtensionFile);
  if (changed.length === 0) return { ok: true, message: `Extension inchangée (version ${current}).` };
  const previous = version(base);
  if (compareVersions(current, previous) > 0) return { ok: true, message: `Version ${previous} → ${current}.` };
  return {
    ok: false,
    message:
      `L'extension a changé (${changed.slice(0, 5).join(", ")}${changed.length > 5 ? "…" : ""}) ` +
      `mais sa version reste ${current} : augmente "version" dans manifest.json.`,
  };
}

if (require.main === module) {
  const result = checkVersionBump({ base: process.argv[2] });
  console.log(result.message);
  process.exit(result.ok ? 0 : 1);
}

module.exports = { isValidVersion, compareVersions, isExtensionFile, checkVersionBump };
