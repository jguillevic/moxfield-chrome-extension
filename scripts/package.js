// scripts/package.js — paquet à envoyer sur le Chrome Web Store : npm run package
//
// Produit dist/moxfield-stock-manager-<version>.zip avec les seuls fichiers
// de l'extension (manifest, scripts, pages, styles, icônes, traductions),
// sans les tests, l'outillage ni la documentation.
//
// Le champ "key" du manifest est retiré : il fixe l'identifiant de
// l'extension pour une installation en mode développeur, mais le Store le
// refuse et attribue son propre identifiant (cf. docs/chrome-web-store.md
// pour ce que ça change côté connexion Google).
//
// Pas de dépendance (ni la commande zip, absente sous Windows) : l'archive
// est écrite ici, avec la compression de Node (zlib).
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.join(__dirname, "..");

// Fichiers de l'extension : à la racine, les scripts, pages et styles ; plus
// les dossiers des icônes et des traductions. Tout le reste (tests/,
// scripts/, docs/, node_modules/, fichiers de configuration) n'a rien à
// faire dans le paquet.
const ROOT_FILES = /\.(js|html|css)$/;
const FOLDERS = ["icons", "_locales"];

function listFiles(root) {
  const files = ["manifest.json"];
  for (const name of fs.readdirSync(root).sort()) {
    if (ROOT_FILES.test(name) && fs.statSync(path.join(root, name)).isFile()) files.push(name);
  }
  const walk = (dir) => {
    for (const name of fs.readdirSync(path.join(root, dir)).sort()) {
      const rel = `${dir}/${name}`;
      if (fs.statSync(path.join(root, rel)).isDirectory()) walk(rel);
      else if (!/^(\.DS_Store|Thumbs\.db)$/.test(name)) files.push(rel);
    }
  };
  FOLDERS.forEach(walk);
  return files;
}

function storeManifest(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  delete manifest.key;
  return manifest;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Archive zip (méthode « deflate »). Date fixe (1er janvier 1980) : deux
// paquets du même code sont identiques octet pour octet.
function zip(entries) {
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  const UTF8_NAMES = 0x0800;
  const local = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(UTF8_NAMES, 6);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, nameBuf, compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(UTF8_NAMES, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += header.length + nameBuf.length + compressed.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

// → { file, files } : chemin du paquet et fichiers qu'il contient.
function buildPackage({ root = ROOT, outDir = path.join(root, "dist") } = {}) {
  const manifest = storeManifest(root);
  const files = listFiles(root);
  const entries = files.map((name) => ({
    name,
    data: name === "manifest.json"
      ? Buffer.from(JSON.stringify(manifest, null, 2) + "\n")
      : fs.readFileSync(path.join(root, name)),
  }));
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `moxfield-stock-manager-${manifest.version}.zip`);
  fs.writeFileSync(file, zip(entries));
  return { file, files };
}

if (require.main === module) {
  const { file, files } = buildPackage();
  console.log(`${path.relative(process.cwd(), file)} : ${files.length} fichiers`);
}

module.exports = { buildPackage, listFiles, crc32 };
