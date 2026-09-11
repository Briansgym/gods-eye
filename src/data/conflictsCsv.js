// src/data/conflictsCsv.js — UCDP Candidate GED CSV → compact conflict records.
//
// Shared by the local proxy (vite.config.js conflictsProxy) and the unit
// tests. Pure ESM: no Cesium, no DOM, safe to import from node.
//
// Source: Uppsala Conflict Data Program (UCDP) Candidate GED dataset,
// downloaded keylessly from the official distribution server
// https://ucdp.uu.se/downloads/ — CC BY 4.0, cite UCDP / Uppsala University.
// The UCDP REST API (ucdpapi.pcr.uu.se) now requires an emailed access
// token, so the dataset download is the keyless official channel. This is a
// published dataset fetch, not a page scrape.
//
// Records keep only the fields the globe needs; rows without a usable
// id/latitude/longitude are dropped. Output is sorted most-recent-first so
// "current conflicts" is simply the head of the array.

/** @param {string|undefined} value @returns {string|null} trimmed text or null */
function toText(value) {
  const t = String(value ?? '').trim();
  return t || null;
}

/** @param {string|undefined} value @returns {number|null} finite number or null */
function toNumber(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse RFC 4180 CSV text into an array of rows (arrays of string fields).
 * Handles quoted fields, escaped double quotes, commas and newlines inside
 * quotes, CRLF line endings, and a leading BOM.
 * @param {string} text Raw CSV document.
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = [[]];
  let field = '';
  let inQuotes = false;
  const source = typeof text === 'string' && text.charCodeAt(0) === 0xfeff
    ? text.slice(1)
    : String(text ?? '');
  for (let pos = 0; pos < source.length; pos += 1) {
    const ch = source[pos];
    if (inQuotes) {
      if (ch === '"') {
        if (source[pos + 1] === '"') { field += '"'; pos += 1; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { inQuotes = true; continue; }
    if (ch === ',') { rows[rows.length - 1].push(field); field = ''; continue; }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[pos + 1] === '\n') pos += 1;
      rows[rows.length - 1].push(field);
      rows.push([]);
      field = '';
      continue;
    }
    field += ch;
  }
  rows[rows.length - 1].push(field);
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }
  return rows;
}

/**
 * Map one CSV row (array of fields) to a compact conflict record using a
 * header-name → column-index map. Returns null when the row has no usable
 * numeric id or no valid latitude/longitude — those rows cannot be placed on
 * the globe and are never faked.
 * @param {string[]} row Fields in file order.
 * @param {Map<string, number>} index Header name → column index.
 * @returns {object|null}
 */
export function mapConflictRow(row, index) {
  const at = (key) => (index.has(key) ? row[index.get(key)] : undefined);
  const id = toNumber(at('id'));
  const lat = toNumber(at('latitude'));
  const lon = toNumber(at('longitude'));
  if (id === null || lat === null || lon === null) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const rawType = toNumber(at('type_of_violence'));
  return {
    id,
    relid: toText(at('relid')),
    year: toNumber(at('year')),
    type: rawType === 1 || rawType === 2 || rawType === 3 ? rawType : null,
    conflict: toText(at('conflict_name')),
    dyad: toText(at('dyad_name')),
    sideA: toText(at('side_a')),
    sideB: toText(at('side_b')),
    where: toText(at('where_coordinates')),
    adm1: toText(at('adm_1')),
    country: toText(at('country')),
    region: toText(at('region')),
    lat,
    lon,
    dateStart: toText(at('date_start')),
    dateEnd: toText(at('date_end')),
    deathsCivilians: toNumber(at('deaths_civilians')),
    best: toNumber(at('best')),
    high: toNumber(at('high')),
    low: toNumber(at('low')),
  };
}

/**
 * Parse a full UCDP Candidate GED CSV document into deduplicated conflict
 * records, sorted by date_start descending (most recent first). Returns []
 * for empty or schema-mismatched input rather than throwing.
 * @param {string} text Raw CSV document.
 * @returns {object[]}
 */
export function parseConflictCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const header = rows[0];
  const index = new Map(header.map((name, i) => [String(name).trim(), i]));
  const required = ['id', 'latitude', 'longitude', 'date_start'];
  if (required.some((key) => !index.has(key))) return [];
  const records = [];
  const seen = new Set();
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row || (row.length === 1 && row[0] === '')) continue;
    const record = mapConflictRow(row, index);
    if (!record) continue;
    const key = String(record.id);
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(record);
  }
  records.sort((a, b) => String(b.dateStart ?? '').localeCompare(String(a.dateStart ?? '')));
  return records;
}
