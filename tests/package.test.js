// Tests du paquet pour le Chrome Web Store (scripts/package.js) : npm test
//
// Le paquet est construit dans un dossier temporaire puis relu comme le
// ferait le Store : fichiers présents, contenu intact, manifest sans "key",
// et rien d'inutile (tests, outillage).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { buildPackage, crc32 } = require("../scripts/package.js");

const ROOT = path.join(__dirname, "..");

// Lecture d'une archive zip : { [nom]: contenu }, sommes de contrôle
// vérifiées.
function readZip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let pos = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(pos), 0x02014b50, "entrée du répertoire central");
    const crc = buf.readUInt32LE(pos + 16);
    const size = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const offset = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf8", pos + 46, pos + 46 + nameLen);
    const localNameLen = buf.readUInt16LE(offset + 26);
    const localExtraLen = buf.readUInt16LE(offset + 28);
    const start = offset + 30 + localNameLen + localExtraLen;
    const data = zlib.inflateRawSync(buf.subarray(start, start + size));
    assert.equal(crc32(data), crc, `somme de contrôle de ${name}`);
    files[name] = data;
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function build() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "msm-package-"));
  const result = buildPackage({ outDir });
  return { ...result, zip: readZip(fs.readFileSync(result.file)), cleanup: () => fs.rmSync(outDir, { recursive: true }) };
}

test("paquet : nommé d'après la version, manifest sans « key »", (t) => {
  const pkg = build();
  t.after(pkg.cleanup);
  const manifest = JSON.parse(pkg.zip["manifest.json"]);
  const source = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.equal(path.basename(pkg.file), `moxfield-stock-manager-${source.version}.zip`);
  assert.ok(source.key, "le manifest du dépôt garde sa clé (installation en mode développeur)");
  assert.equal(manifest.key, undefined);
  delete source.key;
  assert.deepEqual(manifest, source, "rien d'autre ne change");
});

test("paquet : tous les fichiers utilisés par l'extension, intacts", (t) => {
  const pkg = build();
  t.after(pkg.cleanup);
  const manifest = JSON.parse(pkg.zip["manifest.json"]);
  const html = pkg.zip["popup.html"].toString();
  const used = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((c) => [...c.js, ...c.css]),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.web_accessible_resources.flatMap((r) => r.resources),
    ...[...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]).filter((ref) => !/^https?:/.test(ref)),
    ...[...fs.readFileSync(path.join(ROOT, "background.js"), "utf8").match(/importScripts\(([^)]*)\)/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    `_locales/${manifest.default_locale}/messages.json`,
  ];
  for (const file of used) {
    assert.ok(pkg.zip[file], `${file} absent du paquet`);
    assert.deepEqual(pkg.zip[file], fs.readFileSync(path.join(ROOT, file)), `${file} modifié`);
  }
  for (const lang of fs.readdirSync(path.join(ROOT, "_locales"))) assert.ok(pkg.zip[`_locales/${lang}/messages.json`], lang);
});

test("paquet : ni tests, ni outillage, ni documentation", (t) => {
  const pkg = build();
  t.after(pkg.cleanup);
  for (const name of Object.keys(pkg.zip)) {
    assert.doesNotMatch(name, /^(tests|scripts|docs|node_modules|dist|\.github)\//, name);
    assert.doesNotMatch(name, /^(package(-lock)?\.json|README\.md|ROADMAP\.md|CLAUDE\.md|PRIVACY\.md|\.gitignore)$/, name);
  }
});

test("paquet : identique d'une construction à l'autre", (t) => {
  const a = build();
  const b = build();
  t.after(() => (a.cleanup(), b.cleanup()));
  assert.deepEqual(fs.readFileSync(a.file), fs.readFileSync(b.file));
});
