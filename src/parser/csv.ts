/**
 * DeGiro CSV parser.
 *
 * The exported "Account statement" CSV has 12 actual columns despite only 10
 * named headers — both "Mutatie" and "Saldo" secretly span a currency column
 * followed by an unlabelled amount column:
 *
 *   Datum | Tijd | Valutadatum | Product | ISIN | Omschrijving | FX
 *     | Mutatie (ccy) | Mutatie (amt) | Saldo (ccy) | Saldo (amt) | Order Id
 *
 * Numbers use European locale: comma as decimal separator, period as thousands.
 * Dates are DD-MM-YYYY.
 */

export interface DeGiroRow {
  date: string;            // DD-MM-YYYY as-is; convert with toIsoDate()
  time: string;            // HH:MM
  valueDate: string;
  product: string;
  isin: string;
  description: string;
  fx: number | null;       // FX rate (e.g. 1.0857 = USD per EUR)
  mutatieCurrency: string; // EUR, USD, …
  mutatieAmount: number | null;
  saldoCurrency: string;
  saldoAmount: number | null;
  orderId: string;
}

/** Parse a European-formatted number string ("1.234,56" → 1234.56). */
function parseAmount(s: string): number | null {
  const trimmed = s.trim();
  if (!trimmed) return null;
  // Remove thousands separators (period), replace decimal comma with dot
  const cleaned = trimmed.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/** Split a CSV line that may contain quoted fields with embedded commas. */
function splitLine(line: string): string[] {
  const result: string[] = [];
  let field = '';
  let inQuotes = false;

  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  result.push(field);
  return result;
}

/** Parse the full CSV file content into structured rows. */
export function parseCsv(content: string): DeGiroRow[] {
  const lines = content
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter(l => l.trim());

  const rows: DeGiroRow[] = [];

  // Line 0 is the header — skip it
  for (let i = 1; i < lines.length; i++) {
    const f = splitLine(lines[i]);
    if (f.length < 11) continue;
    if (!f[0].trim()) continue; // blank date = trailing empty line

    rows.push({
      date: f[0].trim(),
      time: f[1].trim(),
      valueDate: f[2].trim(),
      product: f[3].trim(),
      isin: f[4].trim(),
      description: f[5].trim(),
      fx: parseAmount(f[6]),
      mutatieCurrency: f[7].trim(),
      mutatieAmount: parseAmount(f[8]),
      saldoCurrency: f[9].trim(),
      saldoAmount: parseAmount(f[10]),
      // "-1" marks rows without a real order (product changes, transfer fees)
      orderId: (f[11] ?? '').trim().replace(/^-1$/, ''),
    });
  }

  return rows;
}

/** Convert "DD-MM-YYYY" + "HH:MM" to an ISO 8601 datetime string in Europe/Amsterdam time. */
export function toIsoDate(ddmmyyyy: string, time: string): string {
  const [d, m, y] = ddmmyyyy.split('-');
  const datePart = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;

  // Determine CET (+01:00) vs CEST (+02:00) for this date by checking what
  // hour noon-UTC maps to in Amsterdam — avoids hardcoding DST rules.
  const noonUtc = new Date(`${datePart}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(noonUtc);
  const localHour = parseInt(parts.find(p => p.type === 'hour')!.value, 10);
  const tz = `+${String(localHour - 12).padStart(2, '0')}:00`;

  return `${datePart}T${time}:00${tz}`;
}
