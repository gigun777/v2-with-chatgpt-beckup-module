/**
 * TableAdapter (contract) between Table Engine v2 and Backup module.
 *
 * Backup module MUST NOT read DOM.
 * Adapter MUST expose data from the engine/store/DB (source of truth), not from renderer/HTML.
 *
 * Required concepts:
 * - Journal (sheet) id: journalId
 * - Schema with stable column ids (colId) and display names (name)
 * - Records with cells keyed by colId
 * - Subrows are nested records with the same schema
 *
 * @typedef {{ colId: string, name: string, type?: string, settings?: any }} ColumnDef
 * @typedef {{
 *   journalId: string,
 *   title: string,
 *   schemaId?: string,
 *   columns: ColumnDef[],
 *   sheetSettings?: any
 * }} SheetSchema
 *
 * @typedef {{
 *   id: string,
 *   cells: Record<string, any>,
 *   subrows?: Array<{ cells: Record<string, any> }>,
 *   meta?: { createdAt?: string, updatedAt?: string }
 * }} RecordV2
 *
 * @typedef {{
 *   journalId: string,
 *   schemaId?: string,
 *   records: RecordV2[],
 *   meta?: any
 * }} DatasetV2
 *
 * @typedef {{
 *   format: 'sdo-table-data',
 *   formatVersion: 1,
 *   exportedAt: string,
 *   datasets: DatasetV2[]
 * }} TableDataBundleV2
 */

/**
 * @typedef {object} TableAdapter
 * @property {(journalId: string) => Promise<SheetSchema>} getSheetSchema
 * @property {(journalId: string) => Promise<DatasetV2>} getDataset
 * @property {(bundle: TableDataBundleV2, opts?: {mode?: 'merge'|'replace'}) => Promise<{applied:number, warnings:string[]}>} applyTableDataBundle
 * @property {() => Promise<{journalId:string,title:string}[]>} listJournals
 * @property {() => Promise<string|null>} getActiveJournalId
 * @property {() => Promise<string>} [getEngineVersion] - optional, for diagnostics/manifest
 */

/**
 * Helper: builds a v2 TableAdapter from an existing `tableStore` module of the v2 engine.
 * You must also provide a schemaResolver: (schemaId) => {columns:[{id,name,type,...}], ...}
 *
 * @param {object} deps
 * @param {object} deps.tableStore - v2 table store module instance (must have exportTableData/importTableData equivalents)
 * @param {object} deps.storage - v2 storage iface used by tableStore
 * @param {(schemaId:string) => Promise<{columns:ColumnDef[], title?:string, sheetSettings?:any}>} deps.schemaResolver
 * @param {() => Promise<string|null>} deps.getActiveJournalId
 * @param {() => Promise<{journalId:string,title:string}[]>} deps.listJournals
 * @returns {TableAdapter}
 */
export function createAdapterFromV2TableStore({ tableStore, storage, schemaResolver, getActiveJournalId, listJournals }) {
  return {
    async getSheetSchema(journalId) {
      const dataset = await (tableStore.getDataset.length >= 2 ? tableStore.getDataset(storage, journalId) : tableStore.getDataset(journalId));
      const schemaId = dataset.schemaId;
      const schema = await schemaResolver(schemaId, journalId);
      const columns = Array.isArray(schema?.columns) ? schema.columns : [];
      return {
        journalId,
        title: schema?.title ?? journalId,
        schemaId,
        columns: columns.map(c => ({
          colId: c.id ?? c.colId,
          name: c.name,
          type: c.type,
          settings: c.settings
        })),
        sheetSettings: schema.sheetSettings
      };
    },
    async getDataset(journalId) {
      return await (tableStore.getDataset.length >= 2 ? tableStore.getDataset(storage, journalId) : tableStore.getDataset(journalId));
    },
    async applyTableDataBundle(bundle, opts) {
      await (tableStore.importTableData.length >= 2 ? tableStore.importTableData(storage, bundle, opts) : tableStore.importTableData(bundle, opts));
      return { applied: bundle.datasets?.length || 0, warnings: [] };
    },
    listJournals,
    getActiveJournalId
  };
}
