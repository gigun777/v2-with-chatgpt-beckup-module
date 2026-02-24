import { ensureArray } from './utils.js';
import { normalizeTableDataBundle } from './schema.js';

/**
 * Minimal validation of `sdo-table-data` bundle before applying.
 * The goal is to fail fast on totally wrong files, but stay tolerant to missing optional fields.
 *
 * @param {any} bundle
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
const SUPPORTED_FORMAT_VERSION = 1;

export function validateTableDataBundle(bundle) {
  const errors = [];
  const warnings = [];
  const norm = normalizeTableDataBundle(bundle);
  warnings.push(...norm.warnings);
  const b = norm.bundle ?? {};

  if (b.format !== 'sdo-table-data') {
    errors.push('bundle.format must be "sdo-table-data"');
  }
  // formatVersion handled by normalizeTableDataBundle
  if (!Number.isFinite(b.formatVersion)) {
    errors.push('bundle.formatVersion must be a number');
  } else if (b.formatVersion > SUPPORTED_FORMAT_VERSION) {
    errors.push(`Unsupported bundle.formatVersion=${b.formatVersion}. Supported <= ${SUPPORTED_FORMAT_VERSION}.`);
  } else if (b.formatVersion < 1) {
    warnings.push(`bundle.formatVersion=${b.formatVersion} is unusual (<1). Proceeding in tolerant mode.`);
  }

  const ds = ensureArray(b.datasets);
  if (!ds.length) {
    errors.push('bundle.datasets must be a non-empty array');
  }
  for (const [i, d] of ds.entries()) {
    if (!d || typeof d !== 'object') {
      errors.push(`datasets[${i}] must be an object`);
      continue;
    }
    if (!d.journalId) warnings.push(`datasets[${i}].journalId is missing`);
    if (!Array.isArray(d.records)) warnings.push(`datasets[${i}].records is missing (treated as empty)`);
  }

  return { ok: errors.length === 0, errors, warnings };
}
