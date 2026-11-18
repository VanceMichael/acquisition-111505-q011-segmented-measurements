import { createHash } from 'node:crypto';

// Reader for Compound File Binary version 3 envelopes (the container used by
// legacy office-style applications). The reader follows only allocation
// metadata and the directory tree. Stream contents are never executed or
// interpreted: macros, scripts and embedded objects stay opaque bytes.

export const FREE_SECTOR = 0xffffffff;
export const END_OF_CHAIN = 0xfffffffe;
export const FAT_SECTOR = 0xfffffffd;
export const DIFAT_SECTOR = 0xfffffffc;

const HEADER_SIZE = 512;
const DIRECTORY_ENTRY_SIZE = 128;
const CFB_SIGNATURE = 'd0cf11e0a1b11ae1';
const RESERVED = new Set([FREE_SECTOR, END_OF_CHAIN, FAT_SECTOR, DIFAT_SECTOR]);
const MAX_REGULAR_SECTOR = 0xfffffffa;

export class CompoundError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CompoundError';
    this.code = code;
    this.details = details;
  }
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function fail(code, message, details) {
  throw new CompoundError(code, message, details);
}

const sectorOffset = (index, sectorSize) => (index + 1) * sectorSize;

function readHeader(bytes) {
  if (!Buffer.isBuffer(bytes)) fail('invalid-input', '复合文件必须是字节缓冲区');
  if (bytes.length < HEADER_SIZE) fail('truncated-header', '复合文件小于一个文件头');
  const signature = bytes.subarray(0, 8).toString('hex');
  if (signature !== CFB_SIGNATURE) fail('invalid-signature', '不是复合文件头', { signature });
  if (bytes.readUInt16LE(28) !== 0xfffe) fail('invalid-byte-order', '复合文件不是小端序');
  const majorVersion = bytes.readUInt16LE(26);
  if (majorVersion !== 3) fail('unsupported-version', '仅支持复合文件 v3', { majorVersion });
  const sectorSize = 1 << bytes.readUInt16LE(30);
  const miniSectorSize = 1 << bytes.readUInt16LE(32);
  if (sectorSize !== 512 || miniSectorSize !== 64) {
    fail('unsupported-sector-size', '仅支持 512 字节普通扇区与 64 字节微型扇区', { sectorSize, miniSectorSize });
  }
  const header = {
    majorVersion,
    sectorSize,
    miniSectorSize,
    miniCutoff: bytes.readUInt32LE(56),
    directoryStart: bytes.readUInt32LE(48),
    fatCount: bytes.readUInt32LE(44),
    miniFatStart: bytes.readUInt32LE(60),
    miniFatCount: bytes.readUInt32LE(64),
    difatStart: bytes.readUInt32LE(68),
    difatCount: bytes.readUInt32LE(72),
  };
  if (header.miniCutoff !== 4096) fail('unsupported-cutoff', '微型流阈值不是 4096', { miniCutoff: header.miniCutoff });
  if (header.fatCount === 0) fail('missing-fat', '文件头没有列出 FAT 扇区');
  return header;
}

function readDifat(bytes, header) {
  const listed = [];
  for (let index = 0; index < 109; index += 1) {
    const sector = bytes.readUInt32LE(76 + index * 4);
    if (sector !== FREE_SECTOR) listed.push(sector);
  }
  let next = header.difatStart;
  const seen = new Set();
  for (let index = 0; index < header.difatCount && next !== END_OF_CHAIN && next !== FREE_SECTOR; index += 1) {
    if (RESERVED.has(next) || next >= MAX_REGULAR_SECTOR) fail('invalid-difat', 'DIFAT 扇区编号无效', { sector: next });
    if (seen.has(next)) fail('cyclic-difat', 'DIFAT 扇区形成循环', { sector: next });
    seen.add(next);
    const offset = sectorOffset(next, header.sectorSize);
    if (offset + header.sectorSize > bytes.length) fail('truncated-difat', 'DIFAT 扇区超出文件末尾', { sector: next });
    for (let slot = 0; slot < header.sectorSize / 4 - 1; slot += 1) {
      const fat = bytes.readUInt32LE(offset + slot * 4);
      if (fat !== FREE_SECTOR) listed.push(fat);
    }
    next = bytes.readUInt32LE(offset + header.sectorSize - 4);
  }
  if (listed.length < header.fatCount) {
    fail('missing-fat', '头部列出的 FAT 扇区不足', { expected: header.fatCount, listed: listed.length });
  }
  return listed.slice(0, header.fatCount);
}

function readFat(bytes, header, fatSectors) {
  const entriesPerSector = header.sectorSize / 4;
  const seen = new Set();
  const fat = [];
  for (const sector of fatSectors) {
    if (RESERVED.has(sector) || sector >= MAX_REGULAR_SECTOR) fail('invalid-fat-sector', 'FAT 扇区编号无效', { sector });
    if (seen.has(sector)) fail('shared-fat-sector', 'FAT 扇区被重复列出', { sector });
    seen.add(sector);
    const offset = sectorOffset(sector, header.sectorSize);
    if (offset + header.sectorSize > bytes.length) fail('truncated-fat', 'FAT 扇区超出文件末尾', { sector });
    for (let slot = 0; slot < entriesPerSector; slot += 1) fat.push(bytes.readUInt32LE(offset + slot * 4));
  }
  return fat;
}

// Follow a complete allocation chain. Chains must terminate with
// END_OF_CHAIN and may not revisit an entry. The whole chain is validated even
// when the caller only needs its leading sectors, so a loop hidden in the
// surplus is still reported instead of being silently truncated.
function readChain(start, table, kind, evidence = {}) {
  if (start === END_OF_CHAIN) return [];
  if (RESERVED.has(start) || start >= table.length) {
    fail('invalid-chain', `${kind}链起始项无效`, { ...evidence, kind, start });
  }
  const chain = [];
  const seen = new Set();
  let current = start;
  while (current !== END_OF_CHAIN) {
    if (RESERVED.has(current) || current >= table.length) {
      fail('invalid-chain', `${kind}链包含无效项`, { ...evidence, kind, sector: current });
    }
    if (seen.has(current)) fail('cyclic-chain', `${kind}链形成循环`, { ...evidence, kind, sector: current });
    seen.add(current);
    chain.push(current);
    current = table[current];
  }
  return chain;
}

function decodeEntryName(raw, nameLength, index) {
  if (nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0) {
    fail('invalid-directory-entry', '目录项名称长度无效', { index, nameLength });
  }
  if (raw[nameLength - 2] !== 0 || raw[nameLength - 1] !== 0) {
    fail('invalid-directory-entry', '目录项名称缺少终止符', { index });
  }
  return raw.subarray(0, nameLength - 2).toString('utf16le');
}

// Names are compared case-insensitively within one parent storage and are
// never compared across storages.
function normalizeName(name) {
  return String(name).toUpperCase();
}

function readDirectoryEntry(raw, index, offset) {
  const type = raw.readUInt8(66);
  if (type === 0) return { index, offset, type, empty: true };
  if (![1, 2, 5].includes(type)) fail('invalid-directory-entry', '目录项类型未知', { index, type });
  return {
    index,
    offset,
    type,
    empty: false,
    color: raw.readUInt8(67),
    name: decodeEntryName(raw, raw.readUInt16LE(64), index),
    left: raw.readUInt32LE(68),
    right: raw.readUInt32LE(72),
    child: raw.readUInt32LE(76),
    start: raw.readUInt32LE(116),
    size: raw.readBigUInt64LE(120),
  };
}

function readDirectory(bytes, header, fat) {
  const sectors = readChain(header.directoryStart, fat, '目录');

  const entries = [];
  const perSector = header.sectorSize / DIRECTORY_ENTRY_SIZE;
  for (const sector of sectors) {
    const offset = sectorOffset(sector, header.sectorSize);
    if (offset + header.sectorSize > bytes.length) fail('truncated-directory', '目录扇区超出文件末尾', { sector });
    for (let slot = 0; slot < perSector; slot += 1) {
      const entryOffset = offset + slot * DIRECTORY_ENTRY_SIZE;
      entries.push(readDirectoryEntry(bytes.subarray(entryOffset, entryOffset + DIRECTORY_ENTRY_SIZE), entries.length, entryOffset));
    }
  }
  if (!entries[0] || entries[0].type !== 5) fail('missing-root', '目录缺少根对象');
  return { entries, sectors };
}

// Flatten one sibling red-black tree in order. left/right/child are directory
// entry numbers, not byte offsets. Color bits are deliberately ignored: they
// are not needed to order names. On a cycle the entries visited so far are
// attached to the error so the caller can report the affected branch.
function siblingOrder(entries, root) {
  const ordered = [];
  const visited = new Set();
  const stack = [];
  let current = root;
  try {
    while (current !== FREE_SECTOR || stack.length) {
      while (current !== FREE_SECTOR) {
        if (current >= entries.length) fail('invalid-directory-link', '目录项编号越界', { index: current });
        if (visited.has(current)) fail('cyclic-directory', '目录树形成循环', { index: current });
        const entry = entries[current];
        if (entry.empty) fail('invalid-directory-link', '目录树引用了空槽', { index: current });
        if (entry.type === 5) fail('invalid-directory-link', '目录树引用了根对象', { index: current });
        visited.add(current);
        stack.push(current);
        current = entry.left;
      }
      const index = stack.pop();
      ordered.push(index);
      current = entries[index].right;
    }
  } catch (error) {
    if (error instanceof CompoundError) error.details.visited = [...visited];
    throw error;
  }
  return ordered;
}

function resolveDirectory(entries) {
  const issues = [];
  const assigned = new Map([[0, '/']]);
  const broken = new Map();
  const brokenStorages = new Set();
  const childTrees = new Map();
  const queue = [{ index: 0, path: '' }];

  const markBroken = (index, parentPath, code) => {
    if (index === 0) return;
    if (!broken.has(index)) broken.set(index, { parentPath, code });
  };

  while (queue.length) {
    const parent = queue.shift();
    const storage = entries[parent.index];
    if (storage.child === FREE_SECTOR) continue;
    if (storage.child >= entries.length) {
      issues.push({ code: 'invalid-directory-link', message: '子目录项编号越界', entryIndex: parent.index, path: parent.path || '/', evidence: { child: storage.child } });
      brokenStorages.add(parent.index);
      continue;
    }

    let ordered;
    try {
      ordered = siblingOrder(entries, storage.child);
    } catch (error) {
      if (!(error instanceof CompoundError)) throw error;
      issues.push({ code: error.code, message: error.message, entryIndex: parent.index, path: parent.path || '/', evidence: error.details });
      brokenStorages.add(parent.index);
      for (const index of error.details.visited || []) markBroken(index, parent.path || '/', error.code);
      continue;
    }

    const conflicts = ordered.filter(index => assigned.has(index) || childTrees.has(index));
    const names = new Map();
    for (const index of ordered) {
      const entry = entries[index];
      if (entry.type !== 1 && entry.child !== FREE_SECTOR) {
        issues.push({
          code: 'invalid-directory-link',
          message: '流对象不能包含子目录',
          entryIndex: index,
          path: assigned.get(index) || `${parent.path}/${entry.name}`,
          evidence: { child: entry.child },
        });
        markBroken(index, parent.path || '/', 'invalid-directory-link');
      }
      const key = normalizeName(entry.name);
      if (!names.has(key)) names.set(key, []);
      names.get(key).push(index);
    }
    const duplicates = [...names.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([key, list]) => ({ name: entries[list[0]].name, entries: list, paths: list.map(index => `${parent.path}/${entries[index].name}`) }));

    if (conflicts.length || duplicates.length) {
      const code = duplicates.length
        ? 'duplicate-directory-name'
        : (conflicts.includes(parent.index) ? 'cyclic-directory' : 'shared-directory-entry');
      issues.push({
        code,
        message: duplicates.length
          ? '同一存储下出现同名对象'
          : (code === 'cyclic-directory' ? '目录关系形成循环' : '目录项被多个存储引用'),
        entryIndex: parent.index,
        path: parent.path || '/',
        evidence: { child: storage.child, entries: ordered, conflicts, duplicates },
      });
      brokenStorages.add(parent.index);
      for (const index of ordered) {
        // Entries already placed under another storage keep that independent
        // path; only entries with no other parent become unplaced evidence.
        if (!assigned.has(index)) markBroken(index, parent.path || '/', code);
      }
      continue;
    }

    childTrees.set(parent.index, ordered);
    for (const index of ordered) {
      const entry = entries[index];
      const path = `${parent.path}/${entry.name}`;
      assigned.set(index, path);
      if (entry.type === 1) queue.push({ index, path });
    }
  }

  return { assigned, broken, brokenStorages, childTrees, issues };
}

function countChildren(childTrees, entries, index) {
  const ordered = childTrees.get(index);
  if (!ordered) return 0;
  return ordered.filter(item => entries[item].type === 1 || entries[item].type === 2).length;
}

function regularRanges(chain, sectorSize, bytes, kind) {
  return chain.map(sector => {
    const offset = sectorOffset(sector, sectorSize);
    if (offset + sectorSize > bytes.length) fail('truncated-sector', '分配链引用的扇区超出文件末尾', { kind, sector });
    return { sector, offset, length: sectorSize };
  });
}

function miniRanges(chain, rootChain, header, bytes) {
  const perSector = header.sectorSize / header.miniSectorSize;
  return chain.map(miniSector => {
    const regularSector = rootChain[Math.floor(miniSector / perSector)];
    if (regularSector === undefined) fail('invalid-mini-sector', '微型扇区超出根微型流', { miniSector });
    const offset = sectorOffset(regularSector, header.sectorSize) + (miniSector % perSector) * header.miniSectorSize;
    if (offset + header.miniSectorSize > bytes.length) fail('truncated-sector', '微型扇区超出文件末尾', { miniSector });
    return { sector: miniSector, regularSector, offset, length: header.miniSectorSize };
  });
}

// Read one stream according to the size declared by its directory entry.
// Short streams use the root mini stream plus MiniFAT; longer streams use the
// regular FAT. The root's own stream always uses the regular FAT.
function readStream(entry, path, context) {
  const { header, fat, miniFat, miniIssue, rootChain, bytes } = context;
  const object = {
    entryIndex: entry.index,
    directoryEntry: { index: entry.index, offset: entry.offset, name: entry.name },
    path,
    name: entry.name,
    type: entry.type,
    kind: 'stream',
    size: null,
    status: 'confirmed',
    issues: [],
    allocation: null,
    content: null,
  };

  if (entry.size > 0xffffffffn) {
    object.size = null;
    object.status = 'unconfirmed';
    object.issues.push('unsupported-stream-size');
    context.issues.push({ code: 'unsupported-stream-size', message: '流长度超出支持范围', entryIndex: entry.index, path, evidence: { size: entry.size.toString() } });
    return object;
  }
  const size = Number(entry.size);
  object.size = size;

  if (size === 0) {
    object.allocation = { kind: 'none', start: entry.start, sectorSize: null, sectors: [], contentSectors: [], byteRanges: [], contentByteRanges: [] };
    object.content = Buffer.alloc(0);
    object.contentSha256 = sha256(object.content);
    return object;
  }

  const tiny = size < header.miniCutoff;
  object.allocation = {
    kind: tiny ? 'mini' : 'fat',
    start: entry.start,
    sectorSize: tiny ? header.miniSectorSize : header.sectorSize,
    sectors: [],
    contentSectors: [],
    byteRanges: [],
    contentByteRanges: [],
  };

  if (tiny && miniIssue) {
    object.status = 'unconfirmed';
    object.issues.push(miniIssue.code);
    context.issues.push({ code: miniIssue.code, message: miniIssue.message, entryIndex: entry.index, path, evidence: miniIssue.evidence || {} });
    return object;
  }

  try {
    const table = tiny ? miniFat : fat;
    const chain = readChain(entry.start, table, tiny ? '微型流' : '普通流', { entryIndex: entry.index, path });
    const needed = Math.ceil(size / object.allocation.sectorSize);
    if (chain.length < needed) {
      fail('incomplete-chain', '分配链短于声明长度', { needed, available: chain.length });
    }
    const ranges = tiny ? miniRanges(chain, rootChain, header, bytes) : regularRanges(chain, header.sectorSize, bytes, '普通流');
    const contentRanges = tiny ? miniRanges(chain.slice(0, needed), rootChain, header, bytes) : ranges.slice(0, needed);
    object.allocation.sectors = chain;
    object.allocation.contentSectors = chain.slice(0, needed);
    object.allocation.byteRanges = ranges;
    object.allocation.contentByteRanges = contentRanges;
    object.content = Buffer.concat(contentRanges.map(range => bytes.subarray(range.offset, range.offset + range.length))).subarray(0, size);
    object.contentSha256 = sha256(object.content);
  } catch (error) {
    if (!(error instanceof CompoundError)) throw error;
    object.status = 'unconfirmed';
    object.issues.push(error.code);
    object.content = null;
    object.contentSha256 = null;
    context.issues.push({ code: error.code, message: error.message, entryIndex: entry.index, path, evidence: error.details });
  }
  return object;
}

// Sector ownership map. Structural sectors and the root mini stream are
// registered as owners too, so a stream that claims a FAT/directory sector or
// collides with another object's chain is reported rather than guessed.
function claimSectors(objects, context) {
  const { directory, fatSectors, miniFatSectors, rootChain } = context;
  const claims = new Map();
  const conflicts = new Map();

  const claim = (key, owner) => {
    const id = `${owner.index}:${owner.label}`;
    const previous = claims.get(key);
    if (!previous) { claims.set(key, owner); return; }
    if (previous.id === id) return;
    const pair = [previous, owner].sort((a, b) => a.id < b.id ? -1 : 1);
    const conflictId = pair.map(item => item.id).join('|');
    if (!conflicts.has(conflictId)) conflicts.set(conflictId, { owners: pair, keys: [] });
    conflicts.get(conflictId).keys.push(key);
  };

  for (const sector of fatSectors) claim(`fat:${sector}`, { id: `fat:${sector}`, index: -2, label: 'FAT', path: null });
  for (const sector of directory.sectors) claim(`fat:${sector}`, { id: `dir:${sector}`, index: -3, label: '目录', path: null });
  for (const sector of miniFatSectors) claim(`fat:${sector}`, { id: `minifat:${sector}`, index: -4, label: 'MiniFAT', path: null });
  for (const sector of rootChain) claim(`fat:${sector}`, { id: `root:${sector}`, index: 0, label: '根微型流', path: '/' });

  for (const object of objects) {
    if (object.kind !== 'stream' || object.status !== 'confirmed' || !object.allocation) continue;
    for (const range of object.allocation.byteRanges) {
      const key = object.allocation.kind === 'mini' ? `mini:${range.sector}` : `fat:${range.sector}`;
      claim(key, { id: `${object.entryIndex}:${object.path}`, index: object.entryIndex, label: object.path, path: object.path });
    }
  }

  const issues = [];
  for (const conflict of conflicts.values()) {
    const entries = conflict.owners.filter(owner => owner.index >= 0);
    issues.push({
      code: 'shared-allocation',
      message: '多个对象争用同一源扇区',
      entryIndex: entries[0]?.index ?? null,
      path: entries[0]?.path ?? null,
      evidence: {
        owners: conflict.owners.map(owner => ({ entryIndex: owner.index, label: owner.label, path: owner.path })),
        keys: conflict.keys,
        entries: entries.map(owner => owner.index),
        paths: entries.map(owner => owner.path),
        allocation: entries.length ? 'contended' : 'structure',
      },
    });
    for (const object of objects) {
      if (!['stream', 'root'].includes(object.kind) || !entries.some(owner => owner.index === object.entryIndex)) continue;
      if (object.kind === 'root') {
        object.status = 'broken';
      } else {
        object.status = 'unconfirmed';
        object.content = null;
        object.contentSha256 = null;
      }
      if (!object.issues.includes('shared-allocation')) object.issues.push('shared-allocation');
    }
  }
  return issues;
}

export function parseCompound(bytes) {
  const header = readHeader(bytes);
  const fatSectors = readDifat(bytes, header);
  const fat = readFat(bytes, header, fatSectors);
  const directory = readDirectory(bytes, header, fat);
  const { entries } = directory;
  const resolved = resolveDirectory(entries);
  const issues = [...resolved.issues];

  let miniFat = [];
  let miniFatSectors = [];
  let miniIssue = null;
  if (header.miniFatCount === 0) {
    miniIssue = { code: 'missing-minifat', message: '缺少 MiniFAT，微型流无法确认', evidence: {} };
  } else {
    try {
      miniFatSectors = readChain(header.miniFatStart, fat, 'MiniFAT');
      for (const sector of miniFatSectors) {
        const offset = sectorOffset(sector, header.sectorSize);
        if (offset + header.sectorSize > bytes.length) fail('truncated-minifat', 'MiniFAT 扇区超出文件末尾', { sector });
        for (let slot = 0; slot < header.sectorSize / 4; slot += 1) miniFat.push(bytes.readUInt32LE(offset + slot * 4));
      }
    } catch (error) {
      if (!(error instanceof CompoundError)) throw error;
      miniIssue = { code: error.code, message: error.message, evidence: error.details };
      issues.push({ code: error.code, message: error.message, path: '/', evidence: error.details });
    }
  }

  const root = entries[0];
  let rootChain = [];
  let rootIssue = miniIssue;
  if (root.size > 0n) {
    try {
      if (root.size > 0xffffffffn) fail('unsupported-stream-size', '根对象微型流长度超出支持范围', { size: root.size.toString() });
      const chain = readChain(root.start, fat, '根微型流', { entryIndex: 0, path: '/' });
      const needed = Math.ceil(Number(root.size) / header.sectorSize);
      if (chain.length < needed) fail('incomplete-chain', '根微型流分配链短于声明长度', { needed, available: chain.length });
      rootChain = chain.slice(0, needed);
      regularRanges(chain, header.sectorSize, bytes, '根微型流');
    } catch (error) {
      if (!(error instanceof CompoundError)) throw error;
      rootIssue = { code: error.code, message: error.message, evidence: error.details };
      issues.push({ code: error.code, message: error.message, entryIndex: 0, path: '/', evidence: error.details });
      rootChain = [];
    }
  }

  const objects = [];
  const rootObject = {
    entryIndex: 0,
    directoryEntry: { index: 0, offset: root.offset, name: root.name },
    path: '/',
    name: root.name,
    type: 5,
    kind: 'root',
    status: resolved.brokenStorages.has(0) || rootIssue ? 'broken' : 'ok',
    issues: rootIssue ? [rootIssue.code] : [],
    childCount: countChildren(resolved.childTrees, entries, 0),
    miniStream: root.size > 0n ? {
      start: root.start,
      size: Number(root.size),
      sectors: rootChain,
      byteRanges: rootChain.length ? regularRanges(rootChain, header.sectorSize, bytes, '根微型流') : [],
    } : null,
  };
  objects.push(rootObject);

  const assignedIndices = [...resolved.assigned.keys()].filter(index => index !== 0).sort((a, b) => a - b);
  for (const index of assignedIndices) {
    const entry = entries[index];
    const path = resolved.assigned.get(index);
    if (entry.type === 1) {
      objects.push({
        entryIndex: index,
        directoryEntry: { index, offset: entry.offset, name: entry.name },
        path,
        name: entry.name,
        type: 1,
        kind: 'storage',
        status: resolved.brokenStorages.has(index) ? 'broken' : 'ok',
        issues: [],
        childCount: countChildren(resolved.childTrees, entries, index),
      });
    } else if (entry.type === 2) {
      objects.push(readStream(entry, path, { header, fat, miniFat, miniIssue: rootIssue, rootChain, bytes, issues }));
    }
  }

  // Entries that the directory cannot place under a storage are reported as
  // evidence. Their bytes are left unclaimed rather than guessed from the
  // remaining file.
  const unplaced = [];
  for (const entry of entries) {
    if (entry.index === 0 || entry.empty || resolved.assigned.has(entry.index)) continue;
    unplaced.push(entry.index);
    const detail = resolved.broken.get(entry.index);
    const code = detail?.code || 'directory-unresolved';
    const parentPath = detail?.parentPath ?? null;
    const common = {
      entryIndex: entry.index,
      directoryEntry: { index: entry.index, offset: entry.offset, name: entry.name },
      path: null,
      parentPath,
      name: entry.name,
      type: entry.type,
      issues: [code],
    };
    if (entry.type === 2) {
      objects.push({
        ...common,
        kind: 'stream',
        size: entry.size <= 0xffffffffn ? Number(entry.size) : null,
        status: 'unconfirmed',
        allocation: { kind: entry.size < BigInt(header.miniCutoff) ? 'mini' : 'fat', start: entry.start, sectorSize: null, sectors: [], contentSectors: [], byteRanges: [], contentByteRanges: [] },
        content: null,
        contentSha256: null,
      });
    } else {
      objects.push({ ...common, kind: 'storage', status: 'broken', childCount: 0 });
    }
    issues.push({ code, message: '目录关系损坏，未领取该对象内容', entryIndex: entry.index, path: null, parentPath, evidence: { name: entry.name } });
  }

  const structural = { directory, fatSectors, miniFatSectors, rootChain };
  const conflicts = claimSectors(objects, structural);
  issues.push(...conflicts);

  const rank = object => object.path === '/' ? 0 : object.path ? 1 : 2;
  objects.sort((a, b) => rank(a) - rank(b)
    || (a.path && b.path ? a.path.localeCompare(b.path) : 0)
    || a.entryIndex - b.entryIndex);

  const streams = objects.filter(object => object.kind === 'stream');
  const confirmed = objects.filter(object => object.status === 'confirmed' || object.status === 'ok');
  return {
    format: {
      name: 'Compound File Binary',
      version: 3,
      sectorSize: header.sectorSize,
      miniSectorSize: header.miniSectorSize,
      miniCutoff: header.miniCutoff,
    },
    directory: {
      sectors: directory.sectors,
      entryCount: entries.length,
      unplaced,
    },
    objects,
    issues,
    stats: {
      objects: objects.length,
      confirmed: confirmed.length,
      unconfirmed: objects.length - confirmed.length,
      streams: streams.length,
      confirmedStreams: streams.filter(object => object.status === 'confirmed').length,
    },
  };
}

// Return the actual source byte ranges occupied by one directory object, using
// the allocation chain recorded when this exact source version was parsed.
export function sourceRanges(parsed, entryIndex) {
  const index = Number(entryIndex);
  const object = parsed.objects.find(item => item.entryIndex === index);
  if (!object) fail('unknown-object', '目录项不存在', { entryIndex: index });
  if (object.kind !== 'stream') fail('not-a-stream', '目录项不是流对象', { entryIndex: index });
  if (object.status !== 'confirmed' || !object.allocation) fail('unconfirmed-object', '该流内容未被确认', { entryIndex: index });
  return object.allocation.byteRanges.map(range => ({ ...range }));
}

