import { digest } from './archive.mjs';

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const NOSTREAM = 0xffffffff;
const FREESECT = 0xffffffff;
const ENDOFCHAIN = 0xfffffffe;
const MAXREGSECT = 0xfffffffa;
const ENTRY_TYPES = new Set([0, 1, 2, 5]);

// 只读解析 CFB 复合交付件：还原目录层级、普通链与微型链分配，
// 并按声明长度截取流内容。从不解释或执行流内部的宏、脚本或嵌入对象。
export function parseCompoundFile(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const problems = [];
  const result = { ok: false, header: null, problems, entries: [], streams: [] };
  if (bytes.length < 512 || !bytes.subarray(0, 8).equals(SIGNATURE)) {
    problems.push({ scope: 'file', reason: 'bad-signature', detail: '缺少 CFB 复合文件签名' });
    return result;
  }
  const major = bytes.readUInt16LE(0x1a);
  const byteOrder = bytes.readUInt16LE(0x1c);
  const sectorShift = bytes.readUInt16LE(0x1e);
  const miniSectorShift = bytes.readUInt16LE(0x20);
  if (major !== 3 || byteOrder !== 0xfffe || sectorShift !== 9 || miniSectorShift !== 6) {
    problems.push({ scope: 'file', reason: 'unsupported-header', detail: `主版本 ${major}、字节序 ${byteOrder} 或扇区位移不受支持` });
    return result;
  }
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniSectorShift;
  const numFatSectors = bytes.readUInt32LE(0x2c);
  const firstDirSector = bytes.readUInt32LE(0x30);
  const miniCutoff = bytes.readUInt32LE(0x38);
  const firstMiniFatSector = bytes.readUInt32LE(0x3c);
  const numMiniFatSectors = bytes.readUInt32LE(0x40);
  const firstDifatSector = bytes.readUInt32LE(0x44);
  const numDifatSectors = bytes.readUInt32LE(0x48);
  const sectorCount = Math.floor((bytes.length - 512) / sectorSize);
  result.ok = true;
  result.header = { major, sectorSize, miniSectorSize, miniCutoff, sectorCount };
  const sectorOffset = id => 512 + id * sectorSize;
  const inRange = id => id <= MAXREGSECT && id < sectorCount;

  // DIFAT：头部 109 项，必要时跟随 DIFAT 扇区链（带循环检测）
  const difat = [];
  for (let i = 0; i < 109; i++) {
    const value = bytes.readUInt32LE(0x4c + i * 4);
    if (value !== FREESECT) difat.push(value);
  }
  let difatNext = firstDifatSector;
  const difatSeen = new Set();
  for (let n = 0; n < numDifatSectors; n++) {
    if (!inRange(difatNext)) { problems.push({ scope: 'file', reason: 'difat-out-of-range', sector: difatNext, detail: `DIFAT 扇区 ${difatNext} 越界` }); break; }
    if (difatSeen.has(difatNext)) { problems.push({ scope: 'file', reason: 'difat-cycle', sector: difatNext, detail: `DIFAT 链在扇区 ${difatNext} 处循环` }); break; }
    difatSeen.add(difatNext);
    const base = sectorOffset(difatNext);
    for (let i = 0; i < 127; i++) {
      const value = bytes.readUInt32LE(base + i * 4);
      if (value !== FREESECT) difat.push(value);
    }
    difatNext = bytes.readUInt32LE(base + 127 * 4);
  }

  // FAT：仅取 DIFAT 列出的扇区，结构扇区登记后不允许流再占用
  const fat = [];
  const structural = new Map();
  const fatIds = difat.slice(0, numFatSectors);
  if (fatIds.length < numFatSectors) problems.push({ scope: 'file', reason: 'fat-missing', detail: 'DIFAT 未列出足够的 FAT 扇区' });
  for (const id of fatIds) {
    if (!inRange(id)) { problems.push({ scope: 'file', reason: 'fat-out-of-range', sector: id, detail: `FAT 扇区 ${id} 越界` }); continue; }
    if (structural.has(id)) { problems.push({ scope: 'file', reason: 'fat-shared', sector: id, detail: `FAT 扇区 ${id} 被重复引用` }); continue; }
    structural.set(id, 'fat');
    const base = sectorOffset(id);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(bytes.readUInt32LE(base + i * 4));
  }

  // 在分配表上走完整条链以验证其正常终止；循环、越界、空项、特殊标记都记为问题而非猜测
  const walk = (table, count, start) => {
    const sectors = [];
    const seen = new Set();
    let current = start;
    while (current !== ENDOFCHAIN) {
      if (current === FREESECT) return { sectors, problem: { reason: 'chain-free', sector: current, detail: '链指向未分配项' } };
      if (current > MAXREGSECT) return { sectors, problem: { reason: 'chain-special', sector: current, detail: `链指向特殊标记 ${current}` } };
      if (current >= count) return { sectors, problem: { reason: 'chain-out-of-range', sector: current, detail: `链指向越界项 ${current}` } };
      if (seen.has(current)) return { sectors, problem: { reason: 'chain-cycle', sector: current, detail: `链在 ${current} 处循环` } };
      seen.add(current);
      sectors.push(current);
      current = table[current];
    }
    return { sectors, problem: null };
  };
  const walkFat = start => walk(fat, Math.min(sectorCount, fat.length), start);

  // 目录链：逐扇区解析 128 字节目录项，链问题只影响尚未读到的部分
  const entries = result.entries;
  const dirWalk = walkFat(firstDirSector);
  if (dirWalk.problem) problems.push({ scope: 'directory', ...dirWalk.problem });
  for (const id of dirWalk.sectors) {
    if (structural.has(id)) problems.push({ scope: 'directory', reason: 'sector-shared', sector: id, detail: `目录扇区 ${id} 与${structural.get(id)}冲突` });
    else structural.set(id, 'directory');
  }
  for (const sectorId of dirWalk.sectors) {
    const base = sectorOffset(sectorId);
    for (let slot = 0; slot < sectorSize / 128; slot++) {
      const at = base + slot * 128;
      const id = entries.length;
      const nameLength = bytes.readUInt16LE(at + 64);
      const type = bytes.readUInt8(at + 66);
      const left = bytes.readUInt32LE(at + 68);
      const right = bytes.readUInt32LE(at + 72);
      const child = bytes.readUInt32LE(at + 76);
      const start = bytes.readUInt32LE(at + 116);
      const rawSize = bytes.readBigUInt64LE(at + 120);
      let name = null;
      if (nameLength >= 2 && nameLength <= 64 && nameLength % 2 === 0) name = bytes.subarray(at, at + nameLength - 2).toString('utf16le');
      else if (nameLength !== 0) problems.push({ scope: 'directory', reason: 'name-invalid', entry: id, detail: `目录项 ${id} 名称长度 ${nameLength} 无效` });
      if (!ENTRY_TYPES.has(type)) problems.push({ scope: 'directory', reason: 'type-unknown', entry: id, detail: `目录项 ${id} 类型 ${type} 未知` });
      const sizeValid = rawSize <= 0xffffffffn;
      if (!sizeValid) problems.push({ scope: 'directory', reason: 'size-unsupported', entry: id, detail: `目录项 ${id} 大小高 32 位非零` });
      entries.push({ id, name, type, left, right, child, start, size: sizeValid ? Number(rawSize) : null, sizeValid, reachable: false, path: null });
    }
  }

  // 目录树：从根的孩子沿 left/right/child 归位，名称只在各自存储层级下比较
  const root = entries[0];
  if (!root || root.type !== 5) {
    problems.push({ scope: 'directory', reason: 'root-missing', detail: '目录项 0 不是根存储' });
  } else {
    root.reachable = true;
    root.path = '';
    const visited = new Set([0]);
    const place = (id, parentPath) => {
      if (id === NOSTREAM) return;
      if (id >= entries.length) { problems.push({ scope: 'directory', reason: 'entry-out-of-range', entry: id, detail: `目录引用越界项 ${id}` }); return; }
      if (visited.has(id)) { problems.push({ scope: 'directory', reason: 'directory-cycle', entry: id, detail: `目录关系在项 ${id} 处循环` }); return; }
      const entry = entries[id];
      visited.add(id);
      if (entry.type === 0) { problems.push({ scope: 'directory', reason: 'empty-referenced', entry: id, detail: `目录引用了空项 ${id}` }); return; }
      if (entry.name === null || !ENTRY_TYPES.has(entry.type)) { problems.push({ scope: 'directory', reason: 'entry-unreadable', entry: id, detail: `目录项 ${id} 不可解释` }); return; }
      entry.reachable = true;
      entry.path = parentPath + '/' + entry.name;
      if (entry.type === 1) place(entry.child, entry.path);
      place(entry.left, parentPath);
      place(entry.right, parentPath);
    };
    place(root.child, '');
    for (const entry of entries) {
      if (entry.type !== 0 && !entry.reachable) problems.push({ scope: 'directory', reason: 'entry-unreachable', entry: entry.id, detail: `目录项 ${entry.id}（${entry.name ?? '?'}）不在目录树中` });
    }
  }
  const ambiguous = new Set();
  const pathOwner = new Map();
  for (const entry of entries) {
    if (!entry.reachable || entry.type === 0) continue;
    if (pathOwner.has(entry.path)) {
      problems.push({ scope: 'directory', reason: 'duplicate-path', entry: entry.id, detail: `路径 ${entry.path} 被项 ${pathOwner.get(entry.path)} 与 ${entry.id} 同时使用` });
      ambiguous.add(pathOwner.get(entry.path)).add(entry.id);
    } else pathOwner.set(entry.path, entry.id);
  }

  // MiniFAT 与根微型流：根对象的流始终经普通 FAT 读取
  const miniFat = [];
  let miniFatBroken = false;
  if (numMiniFatSectors > 0) {
    const miniWalk = walkFat(firstMiniFatSector);
    if (miniWalk.problem) { problems.push({ scope: 'minifat', ...miniWalk.problem }); miniFatBroken = true; }
    if (miniWalk.sectors.length < numMiniFatSectors) { problems.push({ scope: 'minifat', reason: 'chain-incomplete', detail: 'MiniFAT 链短于头部声明' }); miniFatBroken = true; }
    const miniFatSectors = miniWalk.sectors.slice(0, numMiniFatSectors);
    for (const id of miniFatSectors) {
      if (structural.has(id)) { problems.push({ scope: 'minifat', reason: 'sector-shared', sector: id, detail: `MiniFAT 扇区 ${id} 与${structural.get(id)}冲突` }); miniFatBroken = true; }
      else structural.set(id, 'minifat');
    }
    if (!miniFatBroken) {
      for (const id of miniFatSectors) {
        const base = sectorOffset(id);
        for (let i = 0; i < sectorSize / 4; i++) miniFat.push(bytes.readUInt32LE(base + i * 4));
      }
    }
  }
  let miniStream = null;
  let miniStreamSectors = [];
  let miniStreamBroken = false;
  if (root && root.type === 5 && root.sizeValid && root.size > 0) {
    const need = Math.ceil(root.size / sectorSize);
    const rootWalk = walkFat(root.start);
    if (rootWalk.problem) { problems.push({ scope: 'ministream', ...rootWalk.problem }); miniStreamBroken = true; }
    if (rootWalk.sectors.length < need) { problems.push({ scope: 'ministream', reason: 'chain-incomplete', detail: '根微型流链短于声明大小' }); miniStreamBroken = true; }
    for (const id of rootWalk.sectors) {
      if (structural.has(id)) { problems.push({ scope: 'ministream', reason: 'sector-shared', sector: id, detail: `根微型流扇区 ${id} 与${structural.get(id)}冲突` }); miniStreamBroken = true; }
      else structural.set(id, 'mini-stream');
    }
    if (!miniStreamBroken) {
      miniStreamSectors = rootWalk.sectors.slice(0, need);
      miniStream = Buffer.concat(miniStreamSectors.map(id => bytes.subarray(sectorOffset(id), sectorOffset(id) + sectorSize)));
    }
  } else if (root && root.type === 5 && !root.sizeValid) {
    miniStreamBroken = true;
  }

  // 流：短流（小于阈值）走 MiniFAT，其余走 FAT；先各自算链，再统一判争用
  const claims = [];
  for (const entry of entries) {
    if (!entry.reachable || entry.type !== 2) continue;
    const item = { entry, chain: null, sectors: [], problem: null };
    claims.push(item);
    if (ambiguous.has(entry.id)) { item.problem = { reason: 'duplicate-path', detail: `路径 ${entry.path} 不唯一` }; continue; }
    if (!entry.sizeValid) { item.problem = { reason: 'size-unsupported', detail: '流大小高 32 位非零' }; continue; }
    if (entry.size === 0) { item.chain = 'empty'; continue; }
    const mini = entry.size < miniCutoff;
    item.chain = mini ? 'mini' : 'regular';
    item.need = Math.ceil(entry.size / (mini ? miniSectorSize : sectorSize));
    let chainWalk;
    if (mini) {
      if (miniFatBroken) { item.problem = { reason: 'minifat-broken', detail: 'MiniFAT 不可用' }; continue; }
      if (miniStreamBroken || !miniStream) { item.problem = { reason: 'mini-stream-broken', detail: '根微型流不可用' }; continue; }
      chainWalk = walk(miniFat, Math.min(miniFat.length, miniStream.length / miniSectorSize), entry.start);
    } else {
      chainWalk = walkFat(entry.start);
    }
    item.sectors = chainWalk.sectors;
    if (chainWalk.problem) { item.problem = chainWalk.problem; continue; }
    if (chainWalk.sectors.length < item.need) { item.problem = { reason: 'chain-incomplete', detail: `链只有 ${chainWalk.sectors.length} 节，需要 ${item.need} 节` }; continue; }
  }
  const allocations = new Map();
  for (const [id, role] of structural) allocations.set(`r:${id}`, [`结构:${role}`]);
  for (const item of claims) {
    if (item.problem || item.chain === 'empty') continue;
    for (const sector of item.sectors) {
      const key = `${item.chain === 'mini' ? 'm' : 'r'}:${sector}`;
      if (!allocations.has(key)) allocations.set(key, []);
      allocations.get(key).push(item);
    }
  }
  for (const [key, holders] of allocations) {
    const items = holders.filter(holder => typeof holder !== 'string');
    if (holders.length > 1 && items.length > 0) {
      for (const item of items) item.problem = { reason: 'sector-shared', sector: Number(key.slice(2)), detail: `分配 ${key} 被多个对象争用` };
    }
  }

  // 只有完全确认的流才输出内容；问题流保留目录项与已走链证据，不按剩余字节猜测
  for (const item of claims) {
    const { entry } = item;
    const stream = {
      entryId: entry.id, path: entry.path, name: entry.name,
      size: entry.sizeValid ? entry.size : null,
      chain: item.chain, sectors: item.sectors, ranges: [],
      status: item.problem ? 'unconfirmed' : 'confirmed',
      problem: item.problem, sha256: null, content: null,
    };
    if (!item.problem) {
      if (item.chain === 'regular') {
        stream.ranges = item.sectors.map(id => ({ offset: sectorOffset(id), length: sectorSize }));
        stream.content = Buffer.concat(item.sectors.slice(0, item.need).map(id => bytes.subarray(sectorOffset(id), sectorOffset(id) + sectorSize))).subarray(0, entry.size);
      } else if (item.chain === 'mini') {
        stream.ranges = item.sectors.map(id => {
          const at = id * miniSectorSize;
          const holder = miniStreamSectors[Math.floor(at / sectorSize)];
          return { offset: sectorOffset(holder) + (at % sectorSize), length: miniSectorSize };
        });
        stream.content = Buffer.concat(item.sectors.slice(0, item.need).map(id => miniStream.subarray(id * miniSectorSize, (id + 1) * miniSectorSize))).subarray(0, entry.size);
      } else {
        stream.content = Buffer.alloc(0);
      }
      stream.sha256 = digest(stream.content);
    }
    result.streams.push(stream);
  }
  return result;
}
