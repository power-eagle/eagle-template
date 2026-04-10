const fs = require('fs');
const path = require('path');
const { processManifest } = require('./process-manifest.cjs');
const {
  ensureFileExists,
  getRepoRoot,
  isPathPrefix,
  matchesAny,
  matchesGlob,
  normalizePath,
  readJson,
  walkFiles,
} = require('./_shared.cjs');

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_HEADER = 0x06054b50;
const UTF8_FLAG = 0x0800;
const STORE_METHOD = 0;

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC_TABLE = buildCrcTable();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function getDosDateTime(dateValue) {
  const date = new Date(dateValue);
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosDate, dosTime };
}

function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const dataBuffer = entry.data;
    const entryCrc = crc32(dataBuffer);
    const { dosDate, dosTime } = getDosDateTime(entry.modifiedAt);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(ZIP_LOCAL_HEADER, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(UTF8_FLAG, 6);
    localHeader.writeUInt16LE(STORE_METHOD, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(entryCrc, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(ZIP_CENTRAL_HEADER, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(UTF8_FLAG, 8);
    centralHeader.writeUInt16LE(STORE_METHOD, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(entryCrc, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    localParts.push(localHeader, nameBuffer, dataBuffer);
    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  }

  const centralDirectorySize = centralParts.reduce((size, part) => size + part.length, 0);
  const endHeader = Buffer.alloc(22);
  endHeader.writeUInt32LE(ZIP_END_HEADER, 0);
  endHeader.writeUInt16LE(0, 4);
  endHeader.writeUInt16LE(0, 6);
  endHeader.writeUInt16LE(entries.length, 8);
  endHeader.writeUInt16LE(entries.length, 10);
  endHeader.writeUInt32LE(centralDirectorySize, 12);
  endHeader.writeUInt32LE(offset, 16);
  endHeader.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, endHeader]);
}

function resolveRulesPath(repoRoot) {
  return path.join(getRepoRoot(repoRoot), '.eagleplus', 'config', 'pkg-rules.json');
}

function shouldIncludeFile(filePath, includePatterns) {
  return includePatterns.some(pattern => {
    if (pattern.includes('*')) {
      return matchesGlob(filePath, pattern);
    }

    return isPathPrefix(filePath, pattern);
  });
}

function resolveIncludedFiles(repoRoot, pkgRules) {
  const includePatterns = Array.isArray(pkgRules.includes) ? pkgRules.includes : [];
  const ignorePatterns = ['.git/**', 'dist/**', 'node_modules/**', ...(pkgRules.ignore || [])];
  const repoFiles = walkFiles(repoRoot);

  return repoFiles
    .filter(filePath => filePath !== 'manifest.json')
    .filter(filePath => !matchesAny(filePath, ignorePatterns))
    .filter(filePath => shouldIncludeFile(filePath, includePatterns));
}

function validateI18nConfig(repoRoot, pkgRules, manifest, includedFiles) {
  if (pkgRules.i18n !== true) {
    return;
  }

  if (typeof manifest.fallbackLanguage !== 'string' || manifest.fallbackLanguage.trim() === '') {
    throw new Error('i18n is enabled in pkg-rules.json, but manifest.json is missing fallbackLanguage');
  }

  if (!Array.isArray(manifest.languages) || manifest.languages.length === 0) {
    throw new Error('i18n is enabled in pkg-rules.json, but manifest.json is missing a non-empty languages array');
  }

  if (!manifest.languages.includes(manifest.fallbackLanguage)) {
    throw new Error('i18n is enabled in pkg-rules.json, but manifest.json languages must include fallbackLanguage');
  }

  const includePatterns = Array.isArray(pkgRules.includes) ? pkgRules.includes : [];
  const hasLocalesInclude = includePatterns.some(pattern => {
    if (pattern.includes('*')) {
      return matchesGlob('_locales/en.json', pattern) || matchesGlob('_locales/example.json', pattern);
    }

    return isPathPrefix('_locales/en.json', pattern) || isPathPrefix('_locales/example.json', pattern);
  });

  if (!hasLocalesInclude) {
    throw new Error('i18n is enabled in pkg-rules.json, but includes does not cover the _locales directory');
  }

  const localesDir = path.join(repoRoot, '_locales');
  if (!fs.existsSync(localesDir) || !fs.statSync(localesDir).isDirectory()) {
    throw new Error('i18n is enabled in pkg-rules.json, but the _locales directory is missing');
  }

  const hasLocaleFiles = includedFiles.some(filePath => filePath.startsWith('_locales/'));
  if (!hasLocaleFiles) {
    throw new Error('i18n is enabled in pkg-rules.json, but no _locales files are being packaged');
  }
}

function buildArchiveEntries(repoRoot, filePaths, manifestContents) {
  const entries = filePaths.map(filePath => {
    const absolutePath = path.join(repoRoot, filePath);
    const stats = fs.statSync(absolutePath);
    return {
      name: filePath,
      data: fs.readFileSync(absolutePath),
      modifiedAt: stats.mtime,
    };
  });

  entries.push({
    name: 'manifest.json',
    data: Buffer.from(`${JSON.stringify(manifestContents, null, 2)}\n`, 'utf8'),
    modifiedAt: new Date(),
  });

  return entries;
}

function packagePlugin(type, options = {}) {
  const repoRoot = getRepoRoot(options.repoRoot);
  const rulesPath = resolveRulesPath(repoRoot);
  ensureFileExists(rulesPath, 'package rules config');

  const pkgRules = readJson(rulesPath);
  const processed = processManifest(type, repoRoot);
  const includedFiles = resolveIncludedFiles(repoRoot, pkgRules);
  validateI18nConfig(repoRoot, pkgRules, processed.manifest, includedFiles);

  if (options.checkOnly) {
    return {
      ...processed,
      includedFiles,
      outputPath: null,
    };
  }

  const outputName = `${processed.manifestName}-v${processed.manifestVersion}-${processed.type}.eagleplugin`;
  const outputPath = path.join(repoRoot, 'dist', outputName);
  const archiveEntries = buildArchiveEntries(repoRoot, includedFiles, processed.manifest);
  const zipBuffer = createZipBuffer(archiveEntries);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, zipBuffer);

  return {
    ...processed,
    includedFiles,
    outputPath,
  };
}

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const mode = args.find(arg => !arg.startsWith('--'));

  if (!checkOnly && !['debug', 'release'].includes(mode)) {
    throw new Error('Usage: node .eagleplus/scripts/package-plugin.cjs <debug|release> or --check');
  }

  const result = packagePlugin(mode || 'release', { checkOnly });
  if (checkOnly) {
    console.log(JSON.stringify({
      manifestName: result.manifestName,
      manifestVersion: result.manifestVersion,
      includedFiles: result.includedFiles,
    }, null, 2));
    return;
  }

  console.log(result.outputPath);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  packagePlugin,
  resolveIncludedFiles,
  validateI18nConfig,
};