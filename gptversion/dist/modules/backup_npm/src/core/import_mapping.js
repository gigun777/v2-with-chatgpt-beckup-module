import { readXlsxSheet1, analyzeXlsxGrid } from './xlsx_import.js';
import { ensureArray, nestFromLevels, validateRecordsTree } from './utils.js';

/**
 * Build an import mapping plan for "any" XLSX file.
 * This is UI-agnostic: it returns source/target columns + previews + best-effort suggestions.
 *
 * @param {object} args
 * @param {import('../adapters/table_adapter.js').TableAdapter} args.adapter
 * @param {string} args.journalId
 * @param {Blob} args.file
 * @param {number} [args.previewRows=20]
 * @param {number|null} [args.dataRowStart=null] - 1-based inclusive
 * @param {number|null} [args.dataRowEnd=null]   - 1-based inclusive
 * @returns {Promise<{analysis:any, sourceColumns:Array<{index:number, header:string, sample:string[]}>, targetColumns:any[], suggestions:Array<{sourceIndex:number,targetColId:string,score:number}>}>}
 */
export async function buildImportMappingPlan({
  adapter,
  journalId,
  file,
  previewRows = 20,
  dataRowStart = null,
  dataRowEnd = null
}){
  if (!adapter) throw new Error('buildImportMappingPlan: adapter is required');
  if (!journalId) throw new Error('buildImportMappingPlan: journalId is required');
  if (!file) throw new Error('buildImportMappingPlan: file is required');

  const buf = await file.arrayBuffer();
  const grid = await readXlsxSheet1(buf);
  const analysis = analyzeXlsxGrid({ grid, previewRows, dataRowStart, dataRowEnd });

  const schema = await adapter.getSheetSchema(journalId);
  const targetColumns = ensureArray(schema?.columns);

  const maxCols = analysis.maxCols || 0;
  const headerRow = ensureArray(analysis.header);
  const norm = (s)=>String(s??'').trim().toLowerCase();

  // Build simple samples: take up to 3 values under each column from preview.
  const preview = ensureArray(analysis.preview);
  const sourceColumns = [];
  for (let i=0;i<maxCols;i++){
    const header = String(headerRow[i] ?? '');
    const sample = [];
    for (let r=1; r<Math.min(preview.length, 4); r++){
      const v = ensureArray(preview[r])[i];
      if (v != null && String(v).trim() !== '') sample.push(String(v));
    }
    sourceColumns.push({ index: i, header, sample });
  }

  // Best-effort suggestions by exact/contains match of header -> target name.
  const suggestions = [];
  const tnames = targetColumns.map(c=>({ colId: c.colId, name: String(c.name??''), n: norm(c.name) }));
  for (const sc of sourceColumns){
    const h = norm(sc.header);
    if (!h) continue;
    for (const t of tnames){
      if (!t.n) continue;
      let score = 0;
      if (h === t.n) score = 1.0;
      else if (h.includes(t.n) || t.n.includes(h)) score = 0.7;
      if (score>0){
        suggestions.push({ sourceIndex: sc.index, targetColId: t.colId, score });
      }
    }
  }

  // keep highest score per targetColId
  const bestByTarget = new Map();
  for (const s of suggestions.sort((a,b)=>b.score-a.score)){
    if (!bestByTarget.has(s.targetColId)) bestByTarget.set(s.targetColId, s);
  }

  return { analysis, sourceColumns, targetColumns, suggestions: Array.from(bestByTarget.values()) };
}

/**
 * Apply a mapping (source column index -> target column colId) and build v2 records.
 *
 * @param {object} args
 * @param {import('../adapters/table_adapter.js').TableAdapter} args.adapter
 * @param {string} args.journalId
 * @param {Blob} args.file
 * @param {object|Array<{targetColId:string,sourceIndex:number}>} args.mapping
 * @param {'merge'|'replace'} [args.mode='merge']
 * @param {'overwrite'|'keep'|'generate'} [args.rowIdPolicy='generate']
 * @param {object|null} [args.limits=null]
 * @param {number|null} [args.dataRowStart=null] - 1-based inclusive
 * @param {number|null} [args.dataRowEnd=null]   - 1-based inclusive
 * @param {boolean|null} [args.hasHeader=null] - if true, skip first row in chosen range
 * @param {number|null} [args.levelSourceIndex=null] - if provided, treat this source column as _level
 * @returns {Promise<{records:any[], warnings:string[], analysis:any}>}
 */
export async function xlsxToRecordsByMapping({
  adapter,
  journalId,
  file,
  mapping,
  mode = 'merge',
  rowIdPolicy = 'generate',
  limits = null,
  dataRowStart = null,
  dataRowEnd = null,
  hasHeader = null,
  levelSourceIndex = null
}){
  if (!adapter) throw new Error('xlsxToRecordsByMapping: adapter is required');
  if (!journalId) throw new Error('xlsxToRecordsByMapping: journalId is required');
  if (!file) throw new Error('xlsxToRecordsByMapping: file is required');

  const buf = await file.arrayBuffer();
  const grid0 = await readXlsxSheet1(buf);
  const analysis = analyzeXlsxGrid({ grid: grid0, previewRows: 20, dataRowStart, dataRowEnd });

  // apply range
  let grid = ensureArray(grid0);
  if (Number.isFinite(dataRowStart) || Number.isFinite(dataRowEnd)) {
    const s = Math.max(1, Number(dataRowStart ?? 1));
    const e = Math.max(s, Number(dataRowEnd ?? grid.length));
    grid = grid.slice(s-1, e);
  }

  // header handling (if caller decides)
  if (hasHeader === true && grid.length) {
    grid = grid.slice(1);
  }

  const schema = await adapter.getSheetSchema(journalId);
  const cols = ensureArray(schema?.columns);
  const warnings = [];

  // normalize mapping into {targetColId -> sourceIndex}
  const map = {};
  if (Array.isArray(mapping)) {
    for (const m of mapping) {
      if (!m) continue;
      const t = String(m.targetColId ?? '');
      const si = Number(m.sourceIndex);
      if (t && Number.isFinite(si)) map[t] = si;
    }
  } else if (mapping && typeof mapping === 'object') {
    // support either {targetColId: sourceIndex} or {sourceIndex: targetColId}
    for (const [k,v] of Object.entries(mapping)) {
      if (typeof v === 'number' || String(v).match(/^\d+$/)) {
        map[String(k)] = Number(v);
      }
    }
    // if seems inverted, fix it
    const keysAreNumbers = Object.keys(map).every(k => /^\d+$/.test(k));
    if (keysAreNumbers) {
      const inv = {};
      for (const [k,v] of Object.entries(mapping)) {
        inv[String(v)] = Number(k);
      }
      for (const [t,si] of Object.entries(inv)) map[t]=si;
    }
  }

  const flat = [];
  const lim = limits || {};
  const maxFlatRows = Number.isFinite(lim.maxRows) ? Number(lim.maxRows) : 50000;

  for (const row of grid) {
    if (flat.length >= maxFlatRows) {
      warnings.push(`XLSX import truncated: exceeded maxRows=${maxFlatRows}.`);
      break;
    }
    const r = ensureArray(row);
    let level = 0;
    if (Number.isFinite(levelSourceIndex)) {
      const lv = Number(String(r[levelSourceIndex] ?? '0').trim());
      level = Number.isFinite(lv) ? lv : 0;
    }
    const cells = {};
    for (const c of cols) {
      const si = map[c.colId];
      cells[c.colId] = String(r[Number.isFinite(si) ? si : -1] ?? '');
    }
    flat.push({ level, cells });
  }

  const nested = Number.isFinite(levelSourceIndex) ? nestFromLevels(flat) : flat.map(x=>({ cells:x.cells }));
  const chk = validateRecordsTree(nested, { maxRows: maxFlatRows, maxDepth: Number.isFinite(lim.maxDepth)?Number(lim.maxDepth):20 });
  if (!chk.ok) throw new Error(chk.errors[0] || 'Import limits exceeded');
  warnings.push(...chk.warnings);

  const toRec = (node)=>({ cells: node.cells, subrows: node.subrows ? node.subrows.map(toRec) : undefined });
  return { records: ensureArray(nested).map(toRec), warnings, analysis, meta: { mode, rowIdPolicy } };
}
