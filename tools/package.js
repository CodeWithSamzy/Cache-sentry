#!/usr/bin/env node
// Builds the two archives Cache Sentry is distributed as:
//
//   dist/cache-sentry-<version>.zip          manifest.json at the archive root
//                                            (the shape the Chrome Web Store wants)
//   dist/cache-sentry-<version>-unpacked.zip a single cache-sentry/ folder, so
//                                            unzipping leaves one tidy directory
//                                            to point "Load unpacked" at
//
// Only the files Chrome needs are included. The list is derived from
// manifest.json and popup.html, so a new asset cannot be forgotten here.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");

function read(rel) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    throw new Error("manifest references a file that does not exist: " + rel);
  }
  return fs.readFileSync(abs);
}

const manifest = JSON.parse(read("manifest.json").toString("utf8"));

function fileList() {
  const files = new Set(["manifest.json"]);

  if (manifest.background && manifest.background.service_worker) {
    files.add(manifest.background.service_worker);
  }
  for (const icon of Object.values(manifest.icons || {})) files.add(icon);

  const action = manifest.action || {};
  for (const icon of Object.values(action.default_icon || {})) files.add(icon);

  if (action.default_popup) {
    files.add(action.default_popup);
    const html = read(action.default_popup).toString("utf8");
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const ref = match[1];
      if (/^[a-z]+:/i.test(ref) || ref.startsWith("/") || ref.startsWith("#")) continue;
      files.add(path.posix.join(path.posix.dirname(action.default_popup), ref));
    }
  }
  return [...files].sort();
}

// --- minimal deflate zip writer (no dependencies) ---
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosStamp(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, day: day & 0xffff };
}

function buildZip(entries) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length < data.length ? deflated : null;
    const body = stored || data;
    const method = stored ? 8 : 0;
    const stamp = dosStamp(entry.mtime || new Date());
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(stamp.time, 10);
    header.writeUInt16LE(stamp.day, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(stamp.time, 12);
    dir.writeUInt16LE(stamp.day, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += header.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(local), centralBuf, end]);
}

// Reads the archive back and confirms every entry is present and decompresses
// to exactly the bytes that went in. A malformed zip must fail here, not in
// somebody else's Chrome.
function verify(zipBuffer, entries) {
  if (zipBuffer.readUInt32LE(0) !== 0x04034b50) throw new Error("bad local header");

  const names = new Map(entries.map((e) => [e.name, e.data]));
  const seen = new Set();
  let at = 0;

  while (at + 30 <= zipBuffer.length && zipBuffer.readUInt32LE(at) === 0x04034b50) {
    const method = zipBuffer.readUInt16LE(at + 8);
    const crc = zipBuffer.readUInt32LE(at + 14);
    const size = zipBuffer.readUInt32LE(at + 18);
    const raw = zipBuffer.readUInt32LE(at + 22);
    const nameLen = zipBuffer.readUInt16LE(at + 26);
    const extraLen = zipBuffer.readUInt16LE(at + 28);
    const name = zipBuffer.subarray(at + 30, at + 30 + nameLen).toString("utf8");
    const body = zipBuffer.subarray(at + 30 + nameLen + extraLen, at + 30 + nameLen + extraLen + size);

    if (!names.has(name)) throw new Error("unexpected entry in archive: " + name);
    const out = method === 0 ? body : zlib.inflateRawSync(body);
    if (out.length !== raw) throw new Error("size mismatch for " + name);
    if (crc32(out) !== crc) throw new Error("checksum mismatch for " + name);
    if (!out.equals(names.get(name))) throw new Error("content mismatch for " + name);

    seen.add(name);
    at += 30 + nameLen + extraLen + size;
  }

  for (const name of names.keys()) {
    if (!seen.has(name)) throw new Error("missing from archive: " + name);
  }
  if (zipBuffer.readUInt32LE(zipBuffer.length - 22) !== 0x06054b50) {
    throw new Error("missing end-of-central-directory record");
  }
  return seen.size;
}

const source = fileList().map((name) => {
  const abs = path.join(root, name);
  return { name, data: read(name), mtime: fs.statSync(abs).mtime };
});

const outDir = path.join(root, "dist");
fs.mkdirSync(outDir, { recursive: true });

const version = manifest.version;
const targets = [
  {
    file: "cache-sentry-" + version + ".zip",
    label: "Chrome Web Store upload",
    entries: source,
  },
  {
    file: "cache-sentry-" + version + "-unpacked.zip",
    label: "manual install (Load unpacked)",
    entries: source.map((entry) => ({ ...entry, name: "cache-sentry/" + entry.name })),
  },
];

for (const target of targets) {
  const zip = buildZip(target.entries);
  const outPath = path.join(outDir, target.file);
  fs.writeFileSync(outPath, zip);
  const count = verify(zip, target.entries);
  const flat = target.entries.length;
  console.log(
    "dist/" + target.file +
    "\n  " + target.label +
    "\n  " + count + "/" + flat + " entries verified, " + zip.length + " bytes"
  );
}
console.log("\nincluded:");
for (const entry of source) console.log("  " + String(entry.data.length).padStart(7) + "  " + entry.name);