import { buildJournalJson, journalJsonToBundle } from './core/json.js';
import { makeZipStore, unzipEntries } from './core/zip_store.js';
import { exportXLSXTable, exportDOCXTable } from './core/office.js';
import { readXlsxSheet1, gridToRecordsV2, analyzeXlsxGrid } from './core/xlsx_import.js';
import { flattenRecords, nowStamp, safeName, makeIdGenerator, collectIdsFromRecords, applyRowIdPolicy, validateRecordsTree } from './core/utils.js';
import { assertAdapter } from './core/assert.js';
import { validateTableDataBundle } from './core/validate.js';
import { makeImportResult, countRecordsTree } from './core/result.js';
import { buildImportMappingPlan, xlsxToRecordsByMapping } from './core/import_mapping.js';

export const BACKUP_MODULE_VERSION = '0.2.0';


function enforceLimitsAndIds({ adapter, journalId, records, mode, rowIdPolicy, limits, warnings }){
  const lim = limits || {};
  const chk = validateRecordsTree(records, lim);
  if (!chk.ok){
    // treat as hard error
    throw new Error(chk.errors[0] || 'Import limits exceeded');
  }
  warnings.push(...chk.warnings);

  // Only meaningful for merge when records have ids
  const pol = rowIdPolicy || 'generate';
  if (mode === 'merge' && pol !== 'overwrite'){
    // collect existing ids
    // adapter.getDataset is required, but we keep it tolerant (if fails, proceed)
    return adapter.getDataset(journalId).then(ds=>{
      const existing = collectIdsFromRecords(ds?.records, new Set());
      const gen = makeIdGenerator('imp');
      return applyRowIdPolicy(records, existing, pol, gen, warnings);
    }).catch(()=>{
      warnings.push('Could not read existing dataset for rowId conflict resolution. Proceeding without it.');
      return records;
    });
  }
  return Promise.resolve(records);
}


/**
 * Backup module factory.
 *
 * Важливо:
 * - Модуль НЕ читає DOM.
 * - Всі дані беруться з "першоджерела" через adapter (storage/DB/table-store).
 * - UI тут немає. Тільки функції імпорту/експорту.
 *
 * @param {object} args
 * @param {import('./adapters/table_adapter.js').TableAdapter} args.adapter
 */
export function createBackup({ adapter }) {
  assertAdapter(adapter);

  return {
    /**
     * Export single journal to JSON Blob.
     * JSON містить максимум метаданих, але import толерантний до їх відсутності.
     */
    async exportJournalJson({ journalId }) {
      const payload = await buildJournalJson({ adapter, journalId });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      return { blob, filename: `${safeName(payload?.meta?.title ?? journalId)}_${nowStamp()}.json`, payload };
    },

    /** Import journal JSON file into table engine via adapter */
    async importJournalJson({ journalId, file, mode = 'merge', rowIdPolicy = 'generate', limits = null, includeEngineResult = false }) {
      try {
        const txt = await file.text();
        const payload = JSON.parse(txt);
        const { bundle, warnings } = await journalJsonToBundle({ adapter, journalId, payload, mode });
        // safety + rowId conflicts
        bundle.datasets[0].records = await enforceLimitsAndIds({ adapter, journalId, records: bundle.datasets[0].records, mode, rowIdPolicy, limits, warnings });
        // safety + rowId conflicts per dataset
        for (const ds of (bundle.datasets||[])) {
          ds.records = await enforceLimitsAndIds({ adapter, journalId: ds.journalId, records: ds.records, mode, rowIdPolicy, limits, warnings });
        }
        const engine = await adapter.applyTableDataBundle(bundle, { mode });
        const stats = countRecordsTree(bundle?.datasets?.[0]?.records);
        return makeImportResult({ ok: true, mode, journalId, warnings, errors: [], stats: { datasets: 1, ...stats }, engine });
      } catch (e) {
        return makeImportResult({ ok: false, mode, journalId, warnings: [], errors: [String(e?.message ?? e)], stats: {}, engine: null });
      }
    },

    /**
     * Export single journal to XLSX Blob.
     * Subrows: якщо includeSubrows=true — додає службову колонку `_level`.
     */
    async exportJournalXlsx({ journalId, includeSubrows = true }) {
      const schema = await adapter.getSheetSchema(journalId);
      const dataset = await adapter.getDataset(journalId);

      const columns = (schema.columns || []).map(c => c.name);

      let flat = [];
      if (includeSubrows) {
        const flattened = flattenRecords(dataset.records || []);
        // add _level marker column
        columns.unshift('_level');
        flat = flattened.map(({ level, record }) => {
          const row = { _level: String(level) };
          for (const c of schema.columns || []) row[c.name] = String(record.cells?.[c.colId] ?? '');
          return row;
        });
      } else {
        flat = (dataset.records || []).map(r => {
          const row = {};
          for (const c of schema.columns || []) row[c.name] = String(r.cells?.[c.colId] ?? '');
          return row;
        });
      }

      const { blob, filename } = exportXLSXTable({
        title: schema.title,
        columns,
        rows: flat,
        filenameBase: safeName(schema.title)
      });
      return { blob, filename };
    },

    /**
     * Step 2: XLSX import plan (for future UI constructor).
     * Повертає аналіз файлу (header/preview/maxCols), але НЕ застосовує імпорт.
     */
    async buildXlsxImportPlan({ file, previewRows = 20, dataRowStart = null, dataRowEnd = null }) {
      const buf = await file.arrayBuffer();
      const grid = await readXlsxSheet1(buf);
      const analysis = analyzeXlsxGrid({ grid, previewRows, dataRowStart, dataRowEnd });
      return { grid, analysis };
    },

    /**
     * Import XLSX into journal.
     *
     * Вимоги (важливо):
     * - має імпортувати "будь-який" Excel-файл (не залежить від назви файла/листа).
     * - якщо кількість колонок не збігається → trim/pad.
     * - якщо є `_level` → відновлює підстроки.
     *
     * В майбутньому UI-конструктор буде передавати ручний mapping.
     *//**
 * Step 5: Build a UI-agnostic mapping plan for XLSX import.
 * Returns source/target columns, previews and best-effort suggestions.
 * UI will later allow user to manually map source -> destination columns.
 */
async buildImportMappingPlan({ journalId, file, previewRows = 20, dataRowStart = null, dataRowEnd = null }) {
  return await buildImportMappingPlan({ adapter, journalId, file, previewRows, dataRowStart, dataRowEnd });
},

/**
 * Step 5: Apply a user-provided mapping and import XLSX into a single journal.
 * No UI here — just core behavior.
 *
 * mapping can be:
 * - Array<{targetColId, sourceIndex}>
 * - Object { [targetColId]: sourceIndex }
 * - (also supports inverted object { [sourceIndex]: targetColId })
 */
async applyImportMapping({
  journalId,
  file,
  mapping,
  mode = 'merge',
  rowIdPolicy = 'generate',
  limits = null,
  dataRowStart = null,
  dataRowEnd = null,
  hasHeader = null,
  levelSourceIndex = null,
  includeEngineResult = false
}) {
  const warnings = [];
  const { records, warnings: mapWarn, analysis } = await xlsxToRecordsByMapping({
    adapter,
    journalId,
    file,
    mapping,
    mode,
    rowIdPolicy,
    limits,
    dataRowStart,
    dataRowEnd,
    hasHeader,
    levelSourceIndex
  });
  warnings.push(...mapWarn);

  const schema = adapter.getSheetSchema(journalId);
  const columns = ensureArray(schema?.columns);

  const recs = enforceLimitsAndIds({ adapter, journalId, records, mode, rowIdPolicy, limits, warnings });
  const bundle = {
    schema: 'sdo-table-data',
    formatVersion: 1,
    createdAt: nowStamp(),
    scope: 'journal',
    datasets: [{ journalId, title: schema?.title ?? '', templateId: schema?.templateId, columns, records: recs }]
  };

  const val = validateTableDataBundle(bundle);
  if (!val.ok) {
    return makeImportResult({ ok: false, mode, journalId, errors: val.errors, warnings: [...warnings, ...val.warnings], stats: { records: 0, subrecords: 0 }, analysis });
  }
  warnings.push(...val.warnings);

  const engineRes = await adapter.applyTableDataBundle(bundle, { mode });
  const stats = countRecordsTree(recs);

  // Keep engine result always (pseudo flag), per project decision.
  return makeImportResult({ ok: true, mode, journalId, warnings, errors: [], stats, engine: engineRes, analysis });
},

    async importJournalXlsx({
      journalId,
      file,
      mode = 'merge',
      rowIdPolicy = 'generate',
      allowHeader = true,
      headerMinMatches = 1,
      // Optional explicit range (1-based inclusive). Future import constructor will drive this.
      dataRowStart = null,
      dataRowEnd = null,
      limits = null,
      includeEngineResult = false
    }) {
      try {
        const schema = await adapter.getSheetSchema(journalId);
        const buf = await file.arrayBuffer();
        const grid = await readXlsxSheet1(buf);

        const { records, warnings, analysis } = gridToRecordsV2({
          grid,
          columns: schema.columns,
          allowHeader,
          headerMinMatches,
          dataRowStart,
          dataRowEnd,
          limits
        });

        // safety
        const enforcedRecords = await enforceLimitsAndIds({ adapter, journalId, records, mode, rowIdPolicy, limits, warnings });

        const bundle = {
          format: 'sdo-table-data',
          formatVersion: 1,
          exportedAt: new Date().toISOString(),
          datasets: [{
            journalId,
            schemaId: schema.schemaId,
            records: enforcedRecords,
            meta: {
              importedAt: new Date().toISOString(),
              importMode: mode,
              xlsx: {
                rows: analysis?.rows,
                maxCols: analysis?.maxCols
              }
            }
          }]
        };

        // safety + rowId conflicts per dataset
        for (const ds of (bundle.datasets||[])) {
          ds.records = await enforceLimitsAndIds({ adapter, journalId: ds.journalId, records: ds.records, mode, rowIdPolicy, limits, warnings });
        }
        const engine = await adapter.applyTableDataBundle(bundle, { mode });
        const stats = countRecordsTree(records);
        return makeImportResult({ ok: true, mode, journalId, warnings, errors: [], stats: { datasets: 1, ...stats }, engine, analysis });
      } catch (e) {
        return makeImportResult({ ok: false, mode, journalId, warnings: [], errors: [String(e?.message ?? e)], stats: {}, engine: null });
      }
    },

    /** Export whole project as ZIP with backup.json (datasets for all journals) */
    async exportAllZip() {
      const journals = await adapter.listJournals();
      const datasets = [];
      for (const j of journals) {
        const schema = await adapter.getSheetSchema(j.journalId);
        const ds = await adapter.getDataset(j.journalId);
        datasets.push({ ...ds, journalId: j.journalId, schemaId: schema.schemaId });
      }

      const backupJson = {
        format: 'sdo-table-data',
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        datasets
      };

      const manifest = {
        module: '@dilovodstvo/backup',
        moduleVersion: BACKUP_MODULE_VERSION,
        exportedAt: backupJson.exportedAt,
        engineVersion: (typeof adapter.getEngineVersion === 'function') ? await adapter.getEngineVersion() : undefined,
        datasets: datasets.length
      };

      const files = [
        { name: 'backup.json', data: new TextEncoder().encode(JSON.stringify(backupJson, null, 2)) },
        { name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) }
      ];

      const zipBytes = makeZipStore(files);
      const blob = new Blob([zipBytes], { type: 'application/zip' });
      return { blob, filename: `backup_${nowStamp()}.zip`, payload: backupJson, manifest };
    },

    /**
     * Import whole project ZIP.
     * Tolerance:
     * - шукаємо backup.json, або будь-який *.json який містить `format:'sdo-table-data'`.
     */
    async importAllZip({ file, mode = 'merge', limits = null, rowIdPolicy = 'generate', includeEngineResult = false }) {
      try {
        const buf = await file.arrayBuffer();
        const entries = await unzipEntries(buf);
        let backup = entries.find(e => e.name === 'backup.json');
        if (!backup) {
          const jsonEntries = entries.filter(e => e.name.toLowerCase().endsWith('.json'));
          for (const e of jsonEntries) {
            try {
              const obj = JSON.parse(new TextDecoder().decode(e.data));
              if (obj && obj.format === 'sdo-table-data' && (Array.isArray(obj.datasets) || Array.isArray(obj.sheets))) {
                backup = e;
                break;
              }
            } catch {
              // ignore
            }
          }
        }
        if (!backup) throw new Error('ZIP does not contain compatible table backup JSON');
        const json = JSON.parse(new TextDecoder().decode(backup.data));
        const v = validateTableDataBundle(json);
        if (!v.ok) {
          return makeImportResult({ ok: false, mode, warnings: v.warnings, errors: v.errors, stats: {}, engine: null });
        }
        const engine = await adapter.applyTableDataBundle(json, { mode });
        // stats
        const ds = Array.isArray(json.datasets) ? json.datasets : [];
        let rec=0, sub=0;
        for (const d of ds) {
          const c = countRecordsTree(d?.records);
          rec += c.records;
          sub += c.subrecords;
        }
        return makeImportResult({ ok: true, mode, warnings: v.warnings, errors: [], stats: { datasets: ds.length, records: rec, subrecords: sub }, engine });
      } catch (e) {
        return makeImportResult({ ok: false, mode, warnings: [], errors: [String(e?.message ?? e)], stats: {}, engine: null });
      }
    },

    /** Export single journal as DOCX (table) */
    async exportJournalDocx({ journalId, includeSubrows = true }) {
      const schema = await adapter.getSheetSchema(journalId);
      const dataset = await adapter.getDataset(journalId);
      const columns = (schema.columns || []).map(c => c.name);
      let flat = [];
      if (includeSubrows) {
        const flattened = flattenRecords(dataset.records || []);
        columns.unshift('_level');
        flat = flattened.map(({ level, record }) => {
          const row = { _level: String(level) };
          for (const c of schema.columns || []) row[c.name] = String(record.cells?.[c.colId] ?? '');
          return row;
        });
      } else {
        flat = (dataset.records || []).map(r => {
          const row = {};
          for (const c of schema.columns || []) row[c.name] = String(r.cells?.[c.colId] ?? '');
          return row;
        });
      }
      const { blob, filename } = exportDOCXTable({
        title: schema.title,
        subtitle: '',
        columns,
        rows: flat,
        filenameBase: safeName(schema.title)
      });
      return { blob, filename };
    }
  };
}
