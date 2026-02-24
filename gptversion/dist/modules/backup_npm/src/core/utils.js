export function nowStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

export function safeName(name) {
  return String(name ?? 'export')
    .replace(/[\s]+/g, '_')
    .replace(/[^a-zA-Z0-9_\-\.а-яА-ЯіїєІЇЄ]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'export';
}

export function ensureArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Flattens nested records using optional `_level` marker.
 * @param {Array<{id?:string,cells:Record<string,any>,subrows?:Array<any>}>} records
 * @param {number} level
 * @returns {Array<{level:number, record:any}>}
 */
export function flattenRecords(records, level = 0) {
  const out = [];
  for (const r of ensureArray(records)) {
    out.push({ level, record: r });
    const subs = ensureArray(r.subrows).map(s => ({
      id: s.id,
      cells: s.cells ?? {},
      subrows: s.subrows
    }));
    if (subs.length) out.push(...flattenRecords(subs, level + 1));
  }
  return out;
}

/**
 * Builds nested subrows from a flat list with `level` values.
 * Level 0 entries become top rows; larger levels become subrows of nearest previous row with lower level.
 * @param {Array<{level:number, cells:Record<string,any>}>} flat
 * @returns {Array<any>}
 */
export function nestFromLevels(flat) {
  const root = [];
  const stack = []; // {level, node}
  for (const item of ensureArray(flat)) {
    const node = { cells: item.cells ?? {}, subrows: [] };
    while (stack.length && stack[stack.length - 1].level >= item.level) stack.pop();
    if (!stack.length) root.push(node);
    else stack[stack.length - 1].node.subrows.push(node);
    stack.push({ level: item.level, node });
  }
  // prune empty subrows arrays to keep dataset compact
  const prune = (arr) => {
    for (const n of arr) {
      if (n.subrows && n.subrows.length) prune(n.subrows);
      else delete n.subrows;
    }
  };
  prune(root);
  return root;
}

/**
 * Aligns cells array to expected column count.
 * - If source has more values → trims.
 * - If source has fewer values → pads with "".
 *
 * @param {any[]} cellsArr
 * @param {number} expectedCount
 * @returns {{cells:any[], trimmed:boolean, padded:boolean}}
 */
export function alignCellsToCount(cellsArr, expectedCount){
  const arr = ensureArray(cellsArr);
  const n = Math.max(0, Number(expectedCount||0));
  const out = new Array(n);
  for(let i=0;i<n;i++) out[i] = arr[i] ?? '';
  return { cells: out, trimmed: arr.length > n, padded: arr.length < n };
}

/**
 * Creates a simple id generator for imported rows.
 * @param {string} prefix
 * @returns {() => string}
 */
export function makeIdGenerator(prefix = 'imp'){
  let i = 0;
  const base = nowStamp();
  return ()=> `${prefix}_${base}_${++i}`;
}

export function collectIdsFromRecords(records, outSet){
  const set = outSet || new Set();
  const walk=(arr)=>{
    if(!Array.isArray(arr)) return;
    for(const r of arr){
      if(r && typeof r === 'object' && r.id) set.add(String(r.id));
      walk(r?.subrows);
    }
  };
  walk(records);
  return set;
}

/**
 * Applies rowId conflict policy to imported records tree.
 * Policies:
 * - 'overwrite' : keep ids as-is (engine decides)
 * - 'keep'      : skip imported records with conflicting ids
 * - 'generate'  : for conflicting ids, generate new ids
 *
 * @param {any[]} records
 * @param {Set<string>} existingIds
 * @param {'overwrite'|'keep'|'generate'} policy
 * @param {() => string} genId
 * @param {string[]} warnings
 * @returns {any[]} new records array
 */
export function applyRowIdPolicy(records, existingIds, policy, genId, warnings){
  const pol = policy || 'generate';
  const set = existingIds || new Set();
  const out = [];
  const walk = (arr)=>{
    const res = [];
    for(const r0 of ensureArray(arr)){
      const r = (r0 && typeof r0 === 'object') ? { ...r0 } : {};
      const id = r.id ? String(r.id) : null;
      if(id && set.has(id)){
        if(pol === 'keep'){
          warnings?.push?.(`RowId conflict: skipped imported record id="${id}".`);
          continue;
        }
        if(pol === 'generate'){
          const newId = genId();
          warnings?.push?.(`RowId conflict: id="${id}" → generated new id="${newId}".`);
          r.id = newId;
        }
        // overwrite: keep id
      }
      if(r.id) set.add(String(r.id));
      if(r.subrows) r.subrows = walk(r.subrows);
      res.push(r);
    }
    return res;
  };
  return walk(records);
}

/**
 * Validates tree size/depth to avoid runaway imports.
 * @param {any[]} records
 * @param {{maxRows?:number, maxDepth?:number}} limits
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
export function validateRecordsTree(records, limits = {}){
  const errors = [];
  const warnings = [];
  const maxRows = Number.isFinite(limits.maxRows) ? Number(limits.maxRows) : 50000;
  const maxDepth = Number.isFinite(limits.maxDepth) ? Number(limits.maxDepth) : 20;

  let rows = 0;
  let hitDepth = 0;

  const walk = (arr, depth)=>{
    if(!Array.isArray(arr)) return;
    hitDepth = Math.max(hitDepth, depth);
    if(depth > maxDepth){
      errors.push(`Max subrows depth exceeded: depth=${depth} > maxDepth=${maxDepth}`);
      return;
    }
    for(const r of arr){
      rows++;
      if(rows > maxRows){
        errors.push(`Max rows exceeded: rows>${maxRows}`);
        return;
      }
      walk(r?.subrows, depth+1);
      if(errors.length) return;
    }
  };
  walk(records, 0);

  if(hitDepth === maxDepth) warnings.push(`Depth reached maxDepth=${maxDepth}. Consider increasing limits if needed.`);
  if(rows === maxRows) warnings.push(`Rows reached maxRows=${maxRows}. Consider increasing limits if needed.`);

  return { ok: errors.length === 0, errors, warnings };
}
