import { DeGiroRow, toIsoDate } from './csv';
import type { ActivityImport, ActivityType } from '../types';

// ─── Row classification ───────────────────────────────────────────────────────

type RowKind =
  | 'BUY'
  | 'SELL'
  | 'TRADE_FEE'   // Transactiekosten — merged into the parent trade's fee field
  | 'TAX'         // Transactiebelasting / Dividendbelasting — separate TAX activity
  | 'DEPOSIT'
  | 'WITHDRAWAL'
  | 'DIVIDEND'
  | 'INTEREST'
  | 'FEE'         // Standalone fees (service fee, connectivity fee, VAT)
  | 'FX'          // Valuta Debitering/Creditering — used only to extract FX rate
  | 'SKIP';

const MONEY_MARKET_ISIN = 'LU1959429272'; // Morgan Stanley EUR Liquidity Fund
const FLATEX_ISIN = 'NLFLATEXACNT';       // Flatex Euro Bank Account

function classify(row: DeGiroRow): RowKind {
  const d = row.description.toLowerCase();
  const amount = row.mutatieAmount ?? 0;

  // ── Always skip ────────────────────────────────────────────────────────────

  // Money market fund — daily price ticks, conversions in/out, pure noise
  if (row.isin === MONEY_MARKET_ISIN) return 'SKIP';
  // Flatex bank account representation inside DeGiro
  if (row.isin === FLATEX_ISIN) return 'SKIP';

  // Internal cash sweep between DeGiro trading balance and flatex bank account
  if (d.includes('cash sweep transfer')) return 'SKIP';
  // Both sides of the cash sweep
  if (d.includes('overboeking')) return 'SKIP';

  // flatex terugstorting is always the negative reversal side of a withdrawal
  // pair — the actual withdrawal is recorded separately as "Processed Flatex Withdrawal"
  if (d.startsWith('flatex terugstorting')) return 'SKIP';

  // Processed Flatex Withdrawal with a POSITIVE amount is the reversal entry
  // that cancels a previously initiated withdrawal; skip it
  if (d.includes('processed flatex withdrawal') && amount > 0) return 'SKIP';

  // iDEAL reservation is a temporary hold that pairs with the final deposit
  if (d.startsWith('reservation')) return 'SKIP';

  // ISIN renames (WIJZIGING ISIN) generate paired buy+sell that net to zero
  if (d.includes('wijziging isin')) return 'SKIP';

  // ── FX conversion rows (needed only for USD trade/dividend FX rate) ────────

  if (d.startsWith('valuta debitering') || d.startsWith('valuta creditering')) return 'FX';

  // ── Trades ────────────────────────────────────────────────────────────────

  // "Koop 14 @ 119,285 EUR"  /  "Koop 13 @ 428 USD"
  // Numbers may contain "." thousands separators: "Koop 1.000 @ 1.234,5 EUR"
  if (/^koop\s+[\d.,]+\s+@/i.test(row.description)) return 'BUY';
  // "Verkoop 84 @ 122 EUR"
  if (/^verkoop\s+[\d.,]+\s+@/i.test(row.description)) return 'SELL';

  // ── Fees ──────────────────────────────────────────────────────────────────

  // Per-trade broker fee — always has an Order Id, gets merged into trade
  if (d.includes('transactiekosten')) return 'TRADE_FEE';

  // ── Taxes ─────────────────────────────────────────────────────────────────

  // French Financial Transaction Tax, charged and sometimes reversed same day
  if (d.includes('transactiebelasting')) return 'TAX';
  // Dividend withholding tax
  if (d.includes('dividendbelasting')) return 'TAX';

  // ── Deposits ─────────────────────────────────────────────────────────────

  // "flatex Storting", "iDEAL storting", bare "Storting", "iDEAL Deposit"
  // Guard against "terugstorting" (refund/withdrawal) matching "storting"
  if (d.includes('storting') && !d.includes('terugstorting')) return 'DEPOSIT';
  if (d.includes('deposit')) return 'DEPOSIT';

  // ── Withdrawals ───────────────────────────────────────────────────────────

  // Negative Processed Flatex Withdrawal = actual money leaving the account
  if (d.includes('processed flatex withdrawal') && amount < 0) return 'WITHDRAWAL';
  // Bare "Terugstorting" (not prefixed with flatex) = direct withdrawal/refund
  if (d.includes('terugstorting') && !d.includes('flatex') && amount < 0) return 'WITHDRAWAL';

  // ── Income ────────────────────────────────────────────────────────────────

  if (d === 'dividend' || d.startsWith('dividend')) return 'DIVIDEND';

  // "Flatex Interest Income" (0.00 when rate is zero) and "Flatex Interest"
  // (can be negative when the account is charged)
  if (d.includes('flatex interest')) return 'INTEREST';

  // ── Standalone fees ───────────────────────────────────────────────────────

  if (d.includes('aansluitingskosten')) return 'FEE'; // annual exchange connectivity fee
  if (d.includes('service-fee') || d.includes('service fee')) return 'FEE';
  if (d.includes('b.t.w')) return 'FEE'; // VAT on the monthly service fee

  return 'SKIP';
}

// ─── Trade description parsing ────────────────────────────────────────────────

interface TradeInfo {
  quantity: number;
  price: number;
  currency: string;
}

/**
 * Extract quantity, price and currency from a trade description.
 * Handles: "Koop 14 @ 119,285 EUR"  "Verkoop 84 @ 122 EUR"  "Koop 13 @ 428 USD"
 */
function parseTradeDescription(desc: string): TradeInfo | null {
  const m = desc.match(/(?:koop|verkoop)\s+([\d.,]+)\s+@\s+([\d.,]+)\s+(\w+)/i);
  if (!m) return null;
  // European locale: strip "." thousands separators, "," is the decimal
  const num = (s: string) => parseFloat(s.replace(/\./g, '').replace(',', '.'));
  return {
    quantity: num(m[1]),
    price: num(m[2]),
    currency: m[3].toUpperCase(),
  };
}

// ─── Activity builders ────────────────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function cashSymbol(currency: string): string {
  return `$CASH-${currency}`;
}

function rowComment(description: string, product: string): string {
  return [description, product].filter(Boolean).join(' ');
}

type ActivityPartial = Partial<ActivityImport> & { activityType: ActivityType };

function makeActivity(partial: ActivityPartial): ActivityImport {
  return {
    accountId: '',    // ImporterPage injects the selected accountId before import
    isDraft: false,
    isValid: true,
    errors: {},
    warnings: {},
    ...partial,
  };
}

// ─── Order group processing ───────────────────────────────────────────────────

function processOrderGroup(rows: DeGiroRow[]): ActivityImport[] {
  const result: ActivityImport[] = [];

  const tradeRows = rows.filter(r => { const k = classify(r); return k === 'BUY' || k === 'SELL'; });
  const feeRows   = rows.filter(r => classify(r) === 'TRADE_FEE');
  // Only include tax rows where money actually left (negative amount).
  // Positive Transactiebelasting rows are intra-day reversals that net to zero.
  const taxRows   = rows.filter(r => classify(r) === 'TAX' && (r.mutatieAmount ?? 0) < 0);
  const fxRows    = rows.filter(r => classify(r) === 'FX');

  if (tradeRows.length === 0) return result;

  const firstTrade = tradeRows[0];
  const tradeKind  = classify(firstTrade) as 'BUY' | 'SELL';
  const isin       = firstTrade.isin;
  const product    = firstTrade.product;
  const symbol     = isin || product;

  // Aggregate partial fills: sum quantities, compute weighted-average price
  let totalQty    = 0;
  let totalAmount = 0;
  let currency    = 'EUR';

  for (const row of tradeRows) {
    const info = parseTradeDescription(row.description);
    if (!info) continue;
    totalQty    += info.quantity;
    totalAmount += Math.abs(row.mutatieAmount ?? 0);
    currency     = info.currency;
  }

  if (totalQty === 0) return result;

  const unitPrice = totalAmount / totalQty;

  // Sum broker fees (always EUR; convert to trade currency for USD trades)
  let totalFee = feeRows.reduce((s, r) => s + Math.abs(r.mutatieAmount ?? 0), 0);

  if (currency !== 'EUR' && feeRows.some(r => r.mutatieCurrency === 'EUR')) {
    // Find the FX rate: Valuta Creditering carries the rate as "USD per EUR"
    const fxRow = fxRows.find(r => r.fx !== null && r.fx > 0);
    if (fxRow?.fx) {
      totalFee = totalFee * fxRow.fx; // convert EUR fee → trade currency
    }
  }

  result.push(makeActivity({
    date:         toIsoDate(firstTrade.date, firstTrade.time),
    isin:         isin || undefined,
    symbol,
    symbolName:   product || undefined,
    quantity:     totalQty,
    activityType: tradeKind as ActivityType,
    unitPrice:    round3(unitPrice),
    currency,
    fee:          round2(totalFee),
    amount:       round2(totalAmount),
    isValid:      !!symbol,
    errors:       symbol ? {} : { symbol: ['No symbol found for this trade'] },
    comment:      rowComment(tradeRows.map(r => r.description).join(' | '), firstTrade.product),
  }));

  // Separate TAX activity for each French FTT charge (only negative = paid)
  for (const taxRow of taxRows) {
    const taxAmt = Math.abs(taxRow.mutatieAmount ?? 0);
    if (taxAmt === 0) continue;

    result.push(makeActivity({
      date:         toIsoDate(taxRow.date, taxRow.time),
      isin:         taxRow.isin || undefined,
      symbol:       taxRow.isin || taxRow.product || cashSymbol(taxRow.mutatieCurrency || 'EUR'),
      symbolName:   taxRow.product || undefined,
      quantity:     1,
      activityType: 'TAX',
      unitPrice:    taxAmt,
      currency:     taxRow.mutatieCurrency || 'EUR',
      fee:          0,
      amount:       taxAmt,
      comment:      rowComment(taxRow.description, taxRow.product),
    }));
  }

  return result;
}

// ─── Standalone row processing ────────────────────────────────────────────────

function processStandaloneRow(row: DeGiroRow): ActivityImport | null {
  const kind     = classify(row);
  const rawAmt   = row.mutatieAmount ?? 0;
  const absAmt   = Math.abs(rawAmt);
  const currency = row.mutatieCurrency || 'EUR';
  const date     = toIsoDate(row.date, row.time);

  // Skip zero-amount rows (e.g. "Flatex Interest Income 0.00")
  if (absAmt === 0) return null;

  switch (kind) {
    case 'DEPOSIT':
      return makeActivity({
        date, symbol: cashSymbol(currency), quantity: 1,
        activityType: 'DEPOSIT', unitPrice: absAmt, currency, fee: 0, amount: absAmt,
        comment: rowComment(row.description, row.product),
      });

    case 'WITHDRAWAL':
      return makeActivity({
        date, symbol: cashSymbol(currency), quantity: 1,
        activityType: 'WITHDRAWAL', unitPrice: absAmt, currency, fee: 0, amount: absAmt,
        comment: rowComment(row.description, row.product),
      });

    case 'DIVIDEND': {
      const symbol = row.isin || row.product;
      if (!symbol) return null;
      return makeActivity({
        date, isin: row.isin || undefined, symbol, symbolName: row.product || undefined, quantity: 1,
        activityType: 'DIVIDEND', unitPrice: absAmt, currency, fee: 0, amount: absAmt,
        isValid: !!row.isin,
        errors:  row.isin ? {} : { symbol: ['No ISIN — set symbol manually'] },
        comment: rowComment(row.description, row.product),
      });
    }

    case 'INTEREST':
      // Negative interest = DeGiro charging you (e.g. "Flatex Interest -0.89")
      return makeActivity({
        date, symbol: cashSymbol(currency), quantity: 1,
        activityType: 'INTEREST', unitPrice: absAmt, currency, fee: 0, amount: absAmt,
        warnings: rawAmt < 0 ? { amount: ['Negative interest — DeGiro charged you'] } : {},
        comment: rowComment(row.description, row.product),
      });

    case 'FEE':
      return makeActivity({
        date, symbol: cashSymbol(currency), quantity: 1,
        activityType: 'FEE', unitPrice: absAmt, currency, fee: 0, amount: absAmt,
        comment: rowComment(row.description, row.product),
      });

    case 'TAX':
      // Only import negative tax (money paid); positive = reversal, skip
      if (rawAmt >= 0) return null;
      return makeActivity({
        date,
        isin:         row.isin || undefined,
        symbol:       row.isin || row.product || cashSymbol(currency),
        symbolName:   row.product || undefined,
        quantity:     1,
        activityType: 'TAX',
        unitPrice:    absAmt,
        currency,
        fee:          0,
        amount:       absAmt,
        comment:      row.description,
      });

    default:
      return null;
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Convert an array of raw DeGiro rows (from parseCsv) into Wealthfolio
 * ActivityImport objects.
 *
 * Rules applied:
 * - Rows belonging to the same Order Id are aggregated into one activity
 *   (partial fills are summed; weighted-average price is used)
 * - DEGIRO Transactiekosten rows are merged into the parent trade's fee field
 * - Transactiebelasting (French FTT) becomes a separate TAX activity
 * - Cash sweep rows, money market fund rows, ISIN renames, and FX conversion
 *   rows are silently discarded
 */
export function mapToActivities(rows: DeGiroRow[]): ActivityImport[] {
  const result: ActivityImport[] = [];

  // Bucket rows by Order Id
  const orderGroups = new Map<string, DeGiroRow[]>();
  const standalone: DeGiroRow[] = [];

  for (const row of rows) {
    const kind = classify(row);
    if (kind === 'SKIP') continue;

    if (row.orderId) {
      const bucket = orderGroups.get(row.orderId) ?? [];
      bucket.push(row);
      orderGroups.set(row.orderId, bucket);
    } else {
      standalone.push(row);
    }
  }

  for (const group of orderGroups.values()) {
    result.push(...processOrderGroup(group));
  }

  for (const row of standalone) {
    const activity = processStandaloneRow(row);
    if (activity) result.push(activity);
  }

  // Sort chronologically so the review table is easy to scan
  return result.sort((a, b) =>
    String(a.date ?? '').localeCompare(String(b.date ?? '')),
  );
}
