// Tests du contrôle de version (scripts/check-version.js) : npm test
//
// Le contrôle complet tourne sur un petit dépôt git temporaire.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { isValidVersion, compareVersions, isExtensionFile, checkVersionBump } = require("../scripts/check-version.js");

test("version du manifest : au format de Chrome", () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.ok(isValidVersion(version), version);
});

test("format de version : accepté par Chrome ou non", () => {
  for (const v of ["0.3.0", "1", "1.2.3.4", "65535.0.1"]) assert.ok(isValidVersion(v), v);
  for (const v of ["", "1.2.3.4.5", "01.2", "1.2a", "1..2", "65536", "v1.2"]) assert.ok(!isValidVersion(v), v);
});

test("comparaison de versions : nombre par nombre", () => {
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.equal(compareVersions("1.2", "1.2.0"), 0);
  assert.ok(compareVersions("0.3.0", "0.3.1") < 0);
});

test("fichiers de l'extension : ceux que Chrome charge, pas les tests ni la documentation", () => {
  for (const f of ["manifest.json", "popup.js", "popup.html", "content.css", "icons/icon16.png", "_locales/fr/messages.json"]) {
    assert.ok(isExtensionFile(f), f);
  }
  for (const f of ["README.md", "tests/popup.test.js", "scripts/check-version.js", ".github/workflows/tests.yml", "package.json"]) {
    assert.ok(!isExtensionFile(f), f);
  }
});

// Petit dépôt : manifest.json en 0.1.0 et popup.js.
function tempRepo(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "msm-version-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, encoding: "utf8" }).trim();
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    fs.writeFileSync(path.join(cwd, file), content);
  };
  const commit = (files) => {
    for (const [file, content] of Object.entries(files)) write(file, content);
    git("add", "-A");
    git("commit", "-q", "-m", "commit");
    return git("rev-parse", "HEAD");
  };
  git("init", "-q");
  const first = commit({ "manifest.json": JSON.stringify({ version: "0.1.0" }), "popup.js": "1" });
  return { cwd, first, commit };
}

test("livraison : extension modifiée sans changer la version, refusée", (t) => {
  const repo = tempRepo(t);
  repo.commit({ "popup.js": "2" });
  const res = checkVersionBump({ base: repo.first, cwd: repo.cwd });
  assert.equal(res.ok, false);
  assert.match(res.message, /popup\.js.*reste 0\.1\.0/);
});

test("livraison : extension modifiée avec une version plus haute, acceptée ; version qui baisse, refusée", (t) => {
  const repo = tempRepo(t);
  const bumped = repo.commit({ "popup.js": "2", "manifest.json": JSON.stringify({ version: "0.2.0" }) });
  assert.deepEqual(checkVersionBump({ base: repo.first, cwd: repo.cwd }), { ok: true, message: "Version 0.1.0 → 0.2.0." });
  repo.commit({ "popup.js": "3", "manifest.json": JSON.stringify({ version: "0.1.5" }) });
  assert.equal(checkVersionBump({ base: bumped, cwd: repo.cwd }).ok, false);
});

test("livraison : seulement tests ou documentation, version inchangée acceptée", (t) => {
  const repo = tempRepo(t);
  repo.commit({ "README.md": "doc", "tests/a.test.js": "test" });
  assert.equal(checkVersionBump({ base: repo.first, cwd: repo.cwd }).ok, true);
});

test("livraison : premier push d'une branche (pas de commit de départ), version invalide refusée", (t) => {
  const repo = tempRepo(t);
  assert.equal(checkVersionBump({ base: "0000000000000000000000000000000000000000", cwd: repo.cwd }).ok, true);
  repo.commit({ "manifest.json": JSON.stringify({ version: "1.02" }) });
  assert.equal(checkVersionBump({ base: "", cwd: repo.cwd }).ok, false);
});
