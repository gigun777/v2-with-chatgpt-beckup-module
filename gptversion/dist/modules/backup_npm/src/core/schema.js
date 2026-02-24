import { ensureArray } from './utils.js';

/**
 * Step 4: schema normalization / migration helpers.
 *
 * Goal:
 * - accept partially missing fields
 * - accept small legacy shapes
 * - return canonical bundle shape for adapter.applyTableDataBundle()
 */

/**
 * @param {any} bundle
 * @returns {{bundle:any, warnings:string[]}}
 */
export function normalizeTableDataBundle(bundle){
  const warnings = [];
  let b = bundle ?? {};

  // Legacy support: { format:'sdo-table-data', sheets:[...] }
  if (!b.datasets && Array.isArray(b.sheets)) {
    warnings.push('Legacy field "sheets" detected → migrated to "datasets".');
    b = { ...b, datasets: b.sheets };
  }

  // Tolerate missing formatVersion
  if (!Number.isFinite(b.formatVersion)) {
    warnings.push('bundle.formatVersion missing → defaulted to 1.');
    b = { ...b, formatVersion: 1 };
  }

  // Ensure datasets array
  const datasets = ensureArray(b.datasets).map((d, i) => {
    const dd = (d && typeof d === 'object') ? d : {};
    const records = Array.isArray(dd.records) ? dd.records : [];
    if (!Array.isArray(dd.records)) warnings.push(`datasets[${i}].records missing → treated as empty.`);
    return { ...dd, records };
  });

  if (!datasets.length) warnings.push('bundle.datasets empty. Nothing to apply.');

  return { bundle: { ...b, datasets }, warnings };
}
