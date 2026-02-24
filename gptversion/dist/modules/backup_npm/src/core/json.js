import { ensureArray, alignCellsToCount } from './utils.js';

/**
 * JSON format for a single journal backup (v2-oriented).
 *
 * Design goals:
 * - Export максимальної кількості метаданих (структура, налаштування, порядок, типи, meta рядків).
 * - Import має бути **толерантним**: якщо частина полів відсутня — все одно відновлюємо дані журналу.
 * - Дані завжди беруться з першоджерела через adapter (НЕ DOM).
 */

/**
 * @param {object} args
 * @param {import('../adapters/table_adapter.js').TableAdapter} args.adapter
 * @param {string} args.journalId
 * @returns {Promise<object>} json payload
 */
export async function buildJournalJson({ adapter, journalId }) {
  const schema = await adapter.getSheetSchema(journalId);
  const dataset = await adapter.getDataset(journalId);

  const cols = ensureArray(schema?.columns);
  const colOrder = cols.map(c => c.colId);

  const colMeta = cols.map(c => ({
    colId: c.colId,
    name: c.name,
    type: c.type,
    settings: c.settings
  }));

  const toCellsArray = (cellsObj) => colOrder.map(id => String(cellsObj?.[id] ?? ''));

  const mapRecord = (r) => ({
    id: r.id,
    meta: {
      createdAt: r.meta?.createdAt,
      updatedAt: r.meta?.updatedAt
    },
    cells: toCellsArray(r.cells),
    subrows: Array.isArray(r.subrows)
      ? r.subrows.map(s => ({
          meta: { createdAt: s.meta?.createdAt, updatedAt: s.meta?.updatedAt },
          cells: toCellsArray(s.cells),
          subrows: Array.isArray(s.subrows) ? s.subrows.map(ss => ({
            meta: { createdAt: ss.meta?.createdAt, updatedAt: ss.meta?.updatedAt },
            cells: toCellsArray(ss.cells)
          })) : undefined
        }))
      : undefined
  });

  return {
    meta: {
      type: 'journal',
      version: 2,
      exportedAt: new Date().toISOString(),
      journalId,
      title: schema?.title,
      schemaId: schema?.schemaId,
      engine: {
        // optional, adapter may not implement
        // keep as best-effort metadata for diagnostics
        version: (typeof adapter.getEngineVersion === 'function') ? await adapter.getEngineVersion() : undefined
      }
    },
    schema: {
      columns: colMeta,
      sheetSettings: schema?.sheetSettings
    },
    data: {
      // keep dataset meta if provided by engine
      datasetMeta: dataset?.meta,
      records: ensureArray(dataset?.records).map(mapRecord)
    }
  };
}

function normalizeStr(s){
  return String(s ?? '').trim().toLowerCase();
}

/**
 * Build mapping from source columns → destination columns.
 * Priority:
 * 1) by colId (if present)
 * 2) by column name (case-insensitive)
 * 3) by index
 */
function buildColumnMapper({ srcColumns, dstColumns }){
  const dstIds = dstColumns.map(c => c.colId);
  const dstById = new Map(dstColumns.map(c => [c.colId, c]));
  const dstByName = new Map(dstColumns.map(c => [normalizeStr(c.name), c]));

  const src = ensureArray(srcColumns);

  // mapper: srcIndex -> dstColId | null
  const mapper = new Array(src.length).fill(null);

  // 1) by colId
  for (let i = 0; i < src.length; i++) {
    const id = src[i]?.colId;
    if (id && dstById.has(id)) mapper[i] = id;
  }

  // 2) by name
  for (let i = 0; i < src.length; i++) {
    if (mapper[i]) continue;
    const nm = normalizeStr(src[i]?.name);
    if (!nm) continue;
    const dst = dstByName.get(nm);
    if (dst) mapper[i] = dst.colId;
  }

  // 3) fallback by index
  for (let i = 0; i < src.length; i++) {
    if (mapper[i]) continue;
    mapper[i] = dstIds[i] ?? null;
  }

  return mapper;
}

function mapCellsArrayToObj({ cellsArr, mapIdxToColId }){
  const cells = {};
  const { cells: aligned } = alignCellsToCount(ensureArray(cellsArr), mapIdxToColId.length);
  for (let i = 0; i < mapIdxToColId.length; i++) {
    const colId = mapIdxToColId[i];
    if (!colId) continue;
    cells[colId] = String(aligned[i] ?? '');
  }
  return cells;
}

function mapRecordTree({ record, mapIdxToColId }){
  const r = record ?? {};
  return {
    id: r.id,
    cells: mapCellsArrayToObj({ cellsArr: r.cells, mapIdxToColId }),
    meta: {
      createdAt: r.createdAt ?? r.meta?.createdAt,
      updatedAt: r.updatedAt ?? r.meta?.updatedAt
    },
    subrows: Array.isArray(r.subrows)
      ? r.subrows.map(s => mapRecordTree({ record: s, mapIdxToColId }))
      : undefined
  };
}

/**
 * Parses Journal JSON and produces a v2 TableDataBundle compatible with v2 table store.
 *
 * Import tolerance:
 * - Якщо немає schema.columns → імпортуємо по поточній схемі (by index).
 * - Якщо немає data.records → імпортуємо порожній журнал (можна replace/merge).
 * - Якщо не вистачає meta — не блокуємо.
 *
 * @param {object} args
 * @param {import('../adapters/table_adapter.js').TableAdapter} args.adapter
 * @param {string} args.journalId
 * @param {object} args.payload - parsed JSON
 * @param {'merge'|'replace'} args.mode
 * @returns {Promise<{bundle: any, warnings: string[]}>}
 */
export async function journalJsonToBundle({ adapter, journalId, payload, mode = 'merge' }) {
  const warnings = [];
  const curSchema = await adapter.getSheetSchema(journalId);
  const dstCols = ensureArray(curSchema?.columns);

  const srcCols = ensureArray(payload?.schema?.columns);
  const hasSomeSchema = srcCols.length > 0;

  const mapIdxToColId = hasSomeSchema
    ? buildColumnMapper({ srcColumns: srcCols, dstColumns: dstCols })
    : dstCols.map(c => c.colId);

  if (!hasSomeSchema) {
    warnings.push('JSON schema.columns is missing → mapping by current schema order (index).');
  }

  const srcRecords = ensureArray(payload?.data?.records);
  if (!srcRecords.length) {
    warnings.push('JSON data.records is empty/missing → nothing to import.');
  }

  const records = srcRecords.map(r => mapRecordTree({ record: r, mapIdxToColId }));

  // column mismatch warnings
  const srcCount = hasSomeSchema ? srcCols.length : null;
  if (srcCount !== null && srcCount !== dstCols.length) {
    warnings.push(`Column count differs: src=${srcCount}, dst=${dstCols.length}. Values will be trimmed/padded.`);
  }

  const bundle = {
    format: 'sdo-table-data',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    datasets: [{
      journalId,
      schemaId: curSchema?.schemaId,
      records,
      meta: {
        importedAt: new Date().toISOString(),
        importMode: mode,
        source: {
          // keep original meta for diagnostics, but do not require it
          exportedAt: payload?.meta?.exportedAt,
          schemaId: payload?.meta?.schemaId
        }
      }
    }]
  };

  return { bundle, warnings };
}
