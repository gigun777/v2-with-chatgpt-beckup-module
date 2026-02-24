/**
 * Runtime assertions for adapter.
 *
 * Important: backup module MUST read data from the primary source (DB/storage/table-store),
 * not from rendered HTML.
 */

const REQUIRED_FUNCS = [
  'listJournals',
  'getSheetSchema',
  'getDataset',
  'applyTableDataBundle'
];

/**
 * @param {any} adapter
 */
export function assertAdapter(adapter) {
  if (!adapter) throw new Error('backup: adapter is required');
  for (const fn of REQUIRED_FUNCS) {
    if (typeof adapter[fn] !== 'function') {
      throw new Error(`backup: adapter.${fn} is required`);
    }
  }
}
