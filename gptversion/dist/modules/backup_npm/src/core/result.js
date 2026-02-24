/**
 * Stable result shape returned from import/apply operations.
 *
 * We keep the adapter (engine) response under `engine` for diagnostics,
 * but the top-level fields are stable for UI and automation.
 */

/**
 * @typedef {object} ImportStats
 * @property {number} [datasets]
 * @property {number} [records]
 * @property {number} [subrecords]
 */

/**
 * @typedef {object} ImportResult
 * @property {boolean} ok
 * @property {'merge'|'replace'} mode
 * @property {string} [journalId]
 * @property {string[]} warnings
 * @property {string[]} errors
 * @property {ImportStats} stats
 * @property {any} [engine]
 * @property {any} [analysis]
 */

export function makeImportResult({ ok, mode, journalId, warnings, errors, stats, engine, analysis }){
  return {
    ok: Boolean(ok),
    mode: mode || 'merge',
    journalId,
    warnings: Array.isArray(warnings) ? warnings : [],
    errors: Array.isArray(errors) ? errors : [],
    stats: stats || {},
    engine,
    analysis
  };
}

export function countRecordsTree(records){
  let recordsCount = 0;
  let subCount = 0;
  const walk = (arr, level)=>{
    if(!Array.isArray(arr)) return;
    for(const r of arr){
      recordsCount++;
      if(level>0) subCount++;
      walk(r?.subrows, level+1);
    }
  };
  walk(records, 0);
  return { records: recordsCount, subrecords: subCount };
}
