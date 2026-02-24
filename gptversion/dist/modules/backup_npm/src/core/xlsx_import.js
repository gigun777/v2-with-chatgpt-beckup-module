import { unzipEntries } from './zip_store.js';
import { ensureArray, nestFromLevels, validateRecordsTree } from './utils.js';

/** Converts column letters from cell ref like 'C12' -> 3 */
function colLettersToIndex(ref) {
  const m = String(ref||'').match(/^([A-Z]+)\d+$/i);
  if (!m) return 0;
  const letters = m[1].toUpperCase();
  let n = 0;
  for (let i=0;i<letters.length;i++){
    n = n*26 + (letters.charCodeAt(i)-64);
  }
  return n;
}

function parseSharedStringsXml(xml) {
  try{
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return Array.from(doc.getElementsByTagName('si')).map(si => {
      const t = si.getElementsByTagName('t')[0];
      return t ? t.textContent : '';
    });
  }catch{
    return [];
  }
}

function getCellTextFromXml(cellEl, sharedStrings){
  if(!cellEl) return '';
  const t = cellEl.getAttribute('t') || '';
  const vEl = cellEl.getElementsByTagName('v')[0];
  const isEl = cellEl.getElementsByTagName('is')[0];
  if(isEl){
    const tt = isEl.getElementsByTagName('t')[0];
    return tt ? tt.textContent : '';
  }
  const v = vEl ? vEl.textContent : '';
  if(t==='s'){
    const idx = Number(v);
    return sharedStrings[idx] ?? '';
  }
  return v ?? '';
}

/**
 * Reads first worksheet rows from XLSX (Office Open XML) without external libs.
 * Returns a 2D array of strings, each inner array is a row of cell values by column index.
 * Empty trailing cells may be missing.
 *
 * @param {ArrayBuffer} buf
 * @returns {Promise<string[][]>}
 */
export async function readXlsxSheet1(buf){
  if (typeof DOMParser === 'undefined') {
    throw new Error('XLSX requires DOMParser (browser environment).');
  }

  const entries = await unzipEntries(buf);
  const findEntry=(name)=>entries.find(e=>e.name===name);
  const sheetEntry = findEntry('xl/worksheets/sheet1.xml') || entries.find(e=>e.name.startsWith('xl/worksheets/') && e.name.endsWith('.xml'));
  if(!sheetEntry) throw new Error('XLSX: sheet1.xml not found');
  const ssEntry = findEntry('xl/sharedStrings.xml');
  const sharedStrings = ssEntry ? parseSharedStringsXml(new TextDecoder().decode(ssEntry.data)) : [];

  const sheetXml = new TextDecoder().decode(sheetEntry.data);
  const doc = new DOMParser().parseFromString(sheetXml, 'application/xml');
  const rows = Array.from(doc.getElementsByTagName('row'));

  const out = [];
  for(const rEl of rows){
    const cells = Array.from(rEl.getElementsByTagName('c'));
    if(!cells.length) continue;
    const byIndex = new Map();
    for(const cEl of cells){
      const ref=cEl.getAttribute('r')||'';
      const idx=colLettersToIndex(ref);
      if(!idx) continue;
      byIndex.set(idx, cEl);
    }
    const maxIdx = Math.max(0, ...Array.from(byIndex.keys()));
    const rowArr = [];
    for(let i=1;i<=maxIdx;i++){
      rowArr.push(String(getCellTextFromXml(byIndex.get(i), sharedStrings) ?? '').trim());
    }
    // skip fully empty row
    if(rowArr.every(v=>v==='')) continue;
    out.push(rowArr);
  }
  return out;
}

function norm(s){ return String(s??'').trim().toLowerCase(); }

function detectHeaderRow({ firstRow, columns, minMatches = 1 }){
  const f = ensureArray(firstRow).map(v=>String(v??'').trim());
  if(!f.length) return { hasHeader:false, hasLevel:false, levelColIndex:-1 };

  if(f[0]==='_level') return { hasHeader:true, hasLevel:true, levelColIndex:0 };

  const colNames = ensureArray(columns).map(c=>norm(c.name));
  const fNorm = f.map(norm);
  let matches = 0;
  for(const v of fNorm){
    if(!v) continue;
    if(colNames.includes(v)) matches++;
  }
  return { hasHeader: matches >= minMatches, hasLevel:false, levelColIndex:-1 };
}

/**
 * Analyze XLSX grid for future "import constructor" UI.
 * This function does NOT apply anything, only describes the file.
 *
 * @param {object} args
 * @param {string[][]} args.grid
 * @param {number} [args.previewRows=20]
 * @returns {{maxCols:number, rows:number, header:string[]|null, preview:string[][]}}
 */
export function analyzeXlsxGrid({ grid, previewRows = 20, dataRowStart = null, dataRowEnd = null }){
  const g0 = ensureArray(grid);
  // Optional: when caller already knows the data rows range (future import constructor).
  // Accept 1-based inclusive indices.
  let g = g0;
  if (Number.isFinite(dataRowStart) || Number.isFinite(dataRowEnd)) {
    const s = Math.max(1, Number(dataRowStart ?? 1));
    const e = Math.max(s, Number(dataRowEnd ?? g0.length));
    g = g0.slice(s - 1, e);
  }
  const maxCols = Math.max(0, ...g.map(r => ensureArray(r).length));
  const header = g.length ? ensureArray(g[0]).map(v=>String(v??'')) : null;
  const preview = g.slice(0, Math.max(1, previewRows)).map(r => ensureArray(r).map(v=>String(v??'')));
  return { maxCols, rows: g.length, header, preview, dataRowStart, dataRowEnd };
}

/**
 * Converts a 2D array from XLSX into v2 records.
 *
 * Flexibility rules (важливо):
 * - Можна імпортувати **будь-який** XLSX: навіть якщо назви колонок не співпадають.
 * - Default mapping: by index to the destination schema.
 * - If header row matches (weak match) → header is skipped.
 * - If first cell is `_level` → `_level` is used to restore subrows tree.
 *
 * @param {object} args
 * @param {string[][]} args.grid
 * @param {Array<{colId:string,name:string,type?:string}>} args.columns
 * @param {boolean} [args.allowHeader=true]
 * @param {number} [args.headerMinMatches=1] - weak header detection (future UI will override)
 * @returns {{records:any[], warnings:string[], analysis: ReturnType<typeof analyzeXlsxGrid>}}
 */
export function gridToRecordsV2({
  grid,
  columns,
  allowHeader = true,
  headerMinMatches = 1,
  // Optional explicit range of data rows (1-based inclusive), for future import constructor.
  // If provided, it overrides header detection.
  dataRowStart = null,
  dataRowEnd = null,
  limits = null
}){
  const warnings=[];
  const colDefs = ensureArray(columns);
  const analysis = analyzeXlsxGrid({ grid, dataRowStart, dataRowEnd });
  if(!grid || !grid.length) return { records: [], warnings, analysis };

  // detect header row
  let startRow = 0;
  let hasLevel = false;
  let levelColIndex = -1;

  // If caller provides explicit data row range, use it.
  let endRowExclusive = grid.length;
  if (Number.isFinite(dataRowStart) || Number.isFinite(dataRowEnd)) {
    const s = Math.max(1, Number(dataRowStart ?? 1));
    const e = Math.max(s, Number(dataRowEnd ?? grid.length));
    startRow = s - 1;
    endRowExclusive = Math.min(grid.length, e);

    // _level detection still can work if present in first column.
    const maybe = ensureArray(grid[startRow] || []).map(s=>String(s??'').trim());
    if (maybe[0] === '_level') {
      hasLevel = true;
      levelColIndex = 0;
      startRow += 1; // skip header-like row with _level marker
    }
  }

  if (!(Number.isFinite(dataRowStart) || Number.isFinite(dataRowEnd))) {
    const first = ensureArray(grid[0]).map(s=>String(s??'').trim());
    const headerInfo = allowHeader ? detectHeaderRow({ firstRow: first, columns: colDefs, minMatches: headerMinMatches }) : {hasHeader:false, hasLevel:false, levelColIndex:-1};

    if(headerInfo.hasLevel){
      hasLevel=true; levelColIndex=headerInfo.levelColIndex; startRow=1;
    } else if(headerInfo.hasHeader){
      startRow = 1;
    }
  }

  const rows = [];
  const lim = limits || {};
  const maxFlatRows = Number.isFinite(lim.maxRows) ? Number(lim.maxRows) : 50000;
  for(let r=startRow; r<endRowExclusive; r++){
    if (rows.length >= maxFlatRows) {
      warnings.push(`XLSX import truncated: exceeded maxRows=${maxFlatRows}.`);
      break;
    }
    const row = ensureArray(grid[r]);
    let level = 0;
    let offset = 0;
    if(hasLevel){
      const lv = Number(String(row[levelColIndex]??'0').trim());
      level = Number.isFinite(lv) ? lv : 0;
      offset = 1;
    }
    const cells = {};
    // mapping by index to destination schema
    for(let ci=0; ci<colDefs.length; ci++){
      const v = row[ci+offset];
      cells[colDefs[ci].colId] = String(v ?? '');
    }
    rows.push({ level, cells });
  }

  const nested = hasLevel ? nestFromLevels(rows) : rows.map(r=>({ cells:r.cells }));

  // column mismatch warnings
  const maxRowCols = Math.max(0, ...grid.map(r=>ensureArray(r).length));
  const expected = colDefs.length + (hasLevel ? 1 : 0);
  if(maxRowCols !== expected){
    warnings.push(`XLSX column count mismatch: expected ~${expected}, got max ${maxRowCols}. Values will be trimmed/padded by index.`);
  }

  const depthCheck = validateRecordsTree(hasLevel ? nested : nested, { maxRows: maxFlatRows, maxDepth: Number.isFinite(lim.maxDepth) ? Number(lim.maxDepth) : 20 });
  if (!depthCheck.ok) {
    warnings.push(...depthCheck.errors);
  }
  warnings.push(...depthCheck.warnings);

  const toRec = (node)=>({
    cells: node.cells,
    subrows: node.subrows ? node.subrows.map(toRec) : undefined
  });

  return { records: ensureArray(nested).map(toRec), warnings, analysis };
}
