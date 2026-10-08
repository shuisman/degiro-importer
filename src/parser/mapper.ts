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
  | 'FX'          // Valuta Debitering/Creditering — AutoFX currency conversion leg
  | 'SECURITY_OUT' // Portfolio transfer to another broker (no cash)
  | 'SKIP'        // Known noise
  | 'UNKNOWN';    // Description not recognised in any supported language

const MONEY_MARKET_ISIN = 'LU1959429272'; // Morgan Stanley EUR Liquidity Fund
const FLATEX_ISIN = 'NLFLATEXACNT';       // Flatex Euro Bank Account

// The description language follows the DeGiro account's country, not the
// "Trader platform language" setting — a Spanish account exports English
// headers with Spanish descriptions. Patterns are matched against the
// lowercased, accent-stripped description (NL / EN / ES / DE).
// "Koop 14 @ 119,285 EUR" (NL) or "Compra 10 Product Name@95,35 EUR (ISIN)" (ES),
// optionally prefixed by a merger marker ("FUSIÓN: Venta 10 Example Corp@12,50 USD")
const BUY_RE  = /^(?:fusion:\s*)?(koop|buy|compra|kauf)\s+[\d.,]+\s.*@/;
const SELL_RE = /^(?:fusion:\s*)?(verkoop|sell|venta|verkauf)\s+[\d.,]+\s.*@/;

const has = (d: string, needles: string[]) => needles.some(n => d.includes(n));

function normalise(description: string): string {
  return description.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function classify(row: DeGiroRow): RowKind {
  const d = normalise(row.description);
  const amount = row.mutatieAmount ?? 0;

  // ── Always skip ────────────────────────────────────────────────────────────

  // Money market fund — daily price ticks, conversions in/out, pure noise
  if (row.isin === MONEY_MARKET_ISIN) return 'SKIP';
  // Flatex bank account representation inside DeGiro
  if (row.isin === FLATEX_ISIN) return 'SKIP';

  // Internal cash sweep between DeGiro trading balance and flatex bank account
  if (d.includes('cash sweep transfer')) return 'SKIP';
  // Both sides of the cash sweep ("Overboeking", "Transferir a su Cuenta de Efectivo…")
  if (has(d, ['overboeking', 'cuenta de efectivo', 'cash account', 'geldkonto'])) return 'SKIP';
  // Informational rows without a Change amount move no money
  if (row.mutatieAmount === null) return 'SKIP';

  // flatex terugstorting is always the negative reversal side of a withdrawal
  // pair — the actual withdrawal is recorded separately as "Processed Flatex Withdrawal"
  if (d.startsWith('flatex terugstorting') || d.startsWith('flatex withdrawal')) return 'SKIP';

  // Processed Flatex Withdrawal with a POSITIVE amount is the reversal entry
  // that cancels a previously initiated withdrawal; skip it
  if (d.includes('processed flatex withdrawal') && amount > 0) return 'SKIP';

  // iDEAL reservation is a temporary hold that pairs with the final deposit
  if (d.startsWith('reservation')) return 'SKIP';

  // ISIN renames generate paired buy+sell that net to zero
  if (has(d, ['wijziging isin', 'isin change', 'cambio de isin', 'isin-anderung'])) return 'SKIP';
  // Product changes swap a line for a renamed one at 0 EUR
  if (has(d, ['cambio de producto', 'productwijziging', 'product change'])) return 'SKIP';

  // Shares moved out to another broker: "TRASPASO DE SALIDA: Venta 10 Example ETF@80,00 EUR"
  if (d.startsWith('traspaso de salida')) return 'SECURITY_OUT';

  // ── FX conversion rows (paired into TRANSFER_OUT/TRANSFER_IN) ────────────

  if (d.startsWith('valuta debitering') || d.startsWith('valuta creditering')) return 'FX';
  if (has(d, ['cambio de divisa', 'fx debit', 'fx credit', 'fx withdrawal', 'fx deposit', 'wahrungswechsel'])) return 'FX';

  // ── Trades ────────────────────────────────────────────────────────────────

  // "Koop 14 @ 119,285 EUR"  /  "Compra 13 @ 428 USD"
  if (BUY_RE.test(d)) return 'BUY';
  // "Verkoop 84 @ 122 EUR"  /  "Venta 84 @ 122 EUR"
  if (SELL_RE.test(d)) return 'SELL';

  // ── Fees ──────────────────────────────────────────────────────────────────

  // Per-trade broker fee — always has an Order Id, gets merged into trade
  if (has(d, ['transactiekosten', 'transaction and/or third', 'transaction fee', 'costes de transaccion', 'transaktionsgebuhr', 'transaktionskosten'])) {
    return 'TRADE_FEE';
  }

  // ── Taxes ─────────────────────────────────────────────────────────────────

  // French Financial Transaction Tax, charged and sometimes reversed same day
  if (has(d, ['transactiebelasting', 'transaction tax', 'impuesto', 'finanztransaktionssteuer'])) return 'TAX';
  // Dividend withholding tax
  if (has(d, ['dividendbelasting', 'dividend tax', 'retencion del dividendo', 'dividendensteuer', 'quellensteuer'])) return 'TAX';

  // ── Deposits ─────────────────────────────────────────────────────────────

  // "flatex Storting", "iDEAL storting", bare "Storting", "iDEAL Deposit"
  // Guard against "terugstorting" (refund/withdrawal) matching "storting"
  if (d.includes('storting') && !d.includes('terugstorting')) return 'DEPOSIT';
  if (has(d, ['deposit', 'deposito', 'einzahlung'])) return 'DEPOSIT';
  // Spanish "Ingreso …" on a plain cash row (FX "Ingreso Cambio de Divisa" is handled above)
  if (d.startsWith('ingreso') && !row.isin && amount > 0) return 'DEPOSIT';

  // ── Withdrawals ───────────────────────────────────────────────────────────

  // Negative Processed Flatex Withdrawal = actual money leaving the account
  if (d.includes('processed flatex withdrawal') && amount < 0) return 'WITHDRAWAL';
  // Bare "Terugstorting" (not prefixed with flatex) = direct withdrawal/refund
  if (d.includes('terugstorting') && !d.includes('flatex') && amount < 0) return 'WITHDRAWAL';
  if (has(d, ['withdrawal', 'retirada', 'auszahlung']) && !row.isin && amount < 0) return 'WITHDRAWAL';

  // ── Income ────────────────────────────────────────────────────────────────

  // "Dividend", "Dividendo", "Dividende"
  if (d.startsWith('dividend')) return 'DIVIDEND';

  // "Flatex Interest Income" (0.00 when rate is zero) and "Flatex Interest"
  // (can be negative when the account is charged)
  if (has(d, ['flatex interest', 'interes', 'zinsen'])) return 'INTEREST';

  // ── Standalone fees ───────────────────────────────────────────────────────

  // Annual exchange connectivity fee
  if (has(d, ['aansluitingskosten', 'connection fee', 'anschlussgebuhr'])) return 'FEE';
  // Spanish commissions: market connectivity, real-time data, portfolio transfer
  if (d.startsWith('comision')) return 'FEE';
  // Corporate action fee
  if (d.startsWith('coste de la accion')) return 'FEE';
  if (d.includes('service-fee') || d.includes('service fee')) return 'FEE';
  // VAT on the monthly service fee
  if (d.includes('b.t.w') || /\b(vat|iva|mwst)\b/.test(d)) return 'FEE';

  return 'UNKNOWN';
}

/**
 * Descriptions of rows that moved money but matched no known pattern, so they
 * are not imported. Surfaced in the UI so unsupported languages are visible.
 */
export function findUnrecognised(rows: DeGiroRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.mutatieAmount && classify(row) === 'UNKNOWN') seen.add(row.description);
  }
  return [...seen];
}

// ─── Trade description parsing ────────────────────────────────────────────────

interface TradeInfo {
  quantity: number;
  price: number;
  currency: string;
}

/**
 * Extract quantity, price and currency from a trade description.
 * Handles: "Koop 14 @ 119,285 EUR"  "Verkoop 84 @ 122 EUR"
 *          "Compra 10 Example Corp@25,50 USD (US0000000000)"  "FUSIÓN: Venta 10 Example Corp@12,50 USD"
 * Only called on rows already classified as BUY/SELL, so the verb is not checked.
 */
/** "1.234,5" → 1234.5 */
function parseEuropean(s: string): number {
  return parseFloat(s.replace(/\./g, '').replace(',', '.'));
}

function parseTradeDescription(desc: string): TradeInfo | null {
  const m = desc.match(/^(?:[^:@]+:\s*)?\S+\s+([\d.,]+)\s.*@\s*([\d.,]+)\s+([A-Za-z]{3})\b/);
  if (!m) return null;
  return {
    quantity: parseEuropean(m[1]),
    price: parseEuropean(m[2]),
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

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
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

// ─── FX conversions ───────────────────────────────────────────────────────────

/** One DeGiro AutoFX conversion: a debit leg in one currency, a credit leg in another. */
interface FxConversion {
  time: number;       // epoch ms of the conversion
  orderId: string;
  date: string;       // ISO datetime of the conversion
  from: string;
  fromAmount: number;
  to: string;
  toAmount: number;
  rate: number;       // units of `to` per unit of `from`
  foldedIntoTrade?: boolean; // settled a trade in the same order; no transfer pair
}

/**
 * Pair FX rows into conversions. Both legs share an Order Id (trades) or a
 * timestamp (dividends, interest). The FX column holds the rate as foreign
 * currency per EUR, so it is used when one side is EUR; otherwise the rate is
 * implied from the two amounts.
 */
function pairFxRows(rows: DeGiroRow[]): FxConversion[] {
  const buckets = new Map<string, DeGiroRow[]>();
  for (const row of rows) {
    if (classify(row) !== 'FX' || !row.mutatieAmount) continue;
    const key = row.orderId || `${row.date} ${row.time}`;
    buckets.set(key, [...(buckets.get(key) ?? []), row]);
  }

  const result: FxConversion[] = [];
  for (const bucket of buckets.values()) {
    const credits = bucket.filter(r => r.mutatieAmount! > 0);
    for (const debit of bucket.filter(r => r.mutatieAmount! < 0)) {
      const i = credits.findIndex(c => c.mutatieCurrency !== debit.mutatieCurrency);
      if (i < 0) continue;
      const [credit] = credits.splice(i, 1);

      const from = debit.mutatieCurrency;
      const to = credit.mutatieCurrency;
      const fromAmount = Math.abs(debit.mutatieAmount!);
      const toAmount = credit.mutatieAmount!;
      const fx = debit.fx ?? credit.fx;
      const rate = fx && to === 'EUR' ? 1 / fx
                 : fx && from === 'EUR' ? fx
                 : toAmount / fromAmount;
      const date = toIsoDate(debit.date, debit.time);

      result.push({ time: Date.parse(date), orderId: debit.orderId, date, from, fromAmount, to, toAmount, rate });
    }
  }
  return result;
}

function newGroupId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `degiro-fx-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * A conversion as a linked same-account TRANSFER_OUT/TRANSFER_IN pair. The
 * metadata mirrors what Wealthfolio's own import linker writes, which marks
 * the pair contribution-neutral (money only changed currency).
 */
function fxTransferPair(c: FxConversion): ActivityImport[] {
  const sourceGroupId = newGroupId();
  const metadata = JSON.stringify({
    flow: { is_external: false },
    fx: {
      sourceCurrency: c.from,
      destinationCurrency: c.to,
      sourceAmount: String(c.fromAmount),
      destinationAmount: String(c.toAmount),
      impliedRate: String(c.toAmount / c.fromAmount),
      rateSource: 'implied_from_import',
    },
  });
  const comment = `FX ${c.from} → ${c.to} @ ${round3(c.rate)}`;
  const leg = (activityType: ActivityType, currency: string, amount: number) => makeActivity({
    date: c.date, symbol: cashSymbol(currency), quantity: 1,
    activityType, unitPrice: amount, currency, fee: 0, amount,
    sourceGroupId, metadata, comment,
  });
  return [
    leg('TRANSFER_OUT', c.from, c.fromAmount),
    leg('TRANSFER_IN', c.to, c.toAmount),
  ];
}

/** Rate from `currency` into the other side of `c`, or null if `c` doesn't involve it. */
function rateFrom(c: FxConversion, currency: string): { fxRate: number; fxCurrency: string } | null {
  if (c.from === currency) return { fxRate: c.rate, fxCurrency: c.to };
  if (c.to === currency) return { fxRate: 1 / c.rate, fxCurrency: c.from };
  return null;
}

const FX_LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * DeGiro's rate for a foreign-currency cash flow without an Order Id: the
 * first conversion of that currency at or after it (AutoFX converts dividends
 * the next business day, net of withholding tax).
 */
function laterFxRate(conversions: FxConversion[], date: string, currency: string) {
  const t = Date.parse(date);
  for (const c of conversions) {
    if (c.orderId || c.time < t || c.time - t > FX_LOOKAHEAD_MS) continue;
    const r = rateFrom(c, currency);
    if (r) return r;
  }
  return null;
}

// ─── Order group processing ───────────────────────────────────────────────────

function processOrderGroup(rows: DeGiroRow[], conversions: FxConversion[]): ActivityImport[] {
  const result: ActivityImport[] = [];

  const tradeRows = rows.filter(r => { const k = classify(r); return k === 'BUY' || k === 'SELL'; });
  const feeRows   = rows.filter(r => classify(r) === 'TRADE_FEE');
  // Only include tax rows where money actually left (negative amount).
  // Positive Transactiebelasting rows are intra-day reversals that net to zero.
  const taxRows   = rows.filter(r => classify(r) === 'TAX' && (r.mutatieAmount ?? 0) < 0);

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

  const date = toIsoDate(firstTrade.date, firstTrade.time);

  // AutoFX: DeGiro settled the trade in another currency (EUR) within the same
  // order. Book it at the rate implied by the conversion legs so the cash lands
  // in the settlement currency to the cent, and fold the conversion into the
  // trade instead of emitting it as a transfer pair.
  const groupFx = conversions.filter(c => c.orderId && c.orderId === firstTrade.orderId);
  let foreign = 0, settled = 0, settleCcy = '';
  for (const c of groupFx) {
    if (c.from === currency) { foreign += c.fromAmount; settled += c.toAmount; settleCcy = c.to; }
    else if (c.to === currency) { foreign += c.toAmount; settled += c.fromAmount; settleCcy = c.from; }
  }
  const settledViaFx = groupFx.length > 0 && Math.abs(foreign - totalAmount) < 0.01;
  const fxRate = settledViaFx ? settled / foreign : null;
  if (settledViaFx) groupFx.forEach(c => { c.foldedIntoTrade = true; });

  // Broker fees are charged in EUR. They belong in the trade's fee when they
  // share its currency or settle through its conversion; otherwise they are
  // booked as separate FEE activities so each currency's cash stays right.
  let fee = 0;
  for (const row of feeRows) {
    const amt = Math.abs(row.mutatieAmount ?? 0);
    if (row.mutatieCurrency === currency) fee += amt;
    else if (fxRate && row.mutatieCurrency === settleCcy) fee += amt / fxRate;
    else result.push(makeActivity({
      date, symbol: cashSymbol(row.mutatieCurrency), quantity: 1,
      activityType: 'FEE', unitPrice: amt, currency: row.mutatieCurrency, fee: 0, amount: amt,
      comment: rowComment(row.description, row.product),
    }));
  }

  // Transaction tax (French FTT) goes on the trade's `tax` field under the same
  // currency rules as fees; anything else stays a separate TAX activity.
  let tax = 0;
  const looseTax: DeGiroRow[] = [];
  for (const row of taxRows) {
    const amt = Math.abs(row.mutatieAmount ?? 0);
    if (amt === 0) continue;
    if (row.mutatieCurrency === currency) tax += amt;
    else if (fxRate && row.mutatieCurrency === settleCcy) tax += amt / fxRate;
    else looseTax.push(row);
  }

  // `amount` is the final cash Wealthfolio books: gross plus fee and tax for a
  // buy, minus them for a sell. Unit price is left unrounded so the host's
  // quantity × price ± fee check reproduces it exactly.
  result.push(makeActivity({
    date,
    isin:         isin || undefined,
    symbol,
    symbolName:   product || undefined,
    quantity:     totalQty,
    activityType: tradeKind as ActivityType,
    unitPrice:    round8(totalAmount / totalQty),
    currency,
    fee:          round8(fee),
    tax:          round8(tax),
    amount:       round8(tradeKind === 'BUY' ? totalAmount + fee + tax : totalAmount - fee - tax),
    isValid:      !!symbol,
    errors:       symbol ? {} : { symbol: ['No symbol found for this trade'] },
    comment:      rowComment(tradeRows.map(r => r.description).join(' | '), firstTrade.product),
    ...(fxRate ? { fxRate: round8(fxRate), fxCurrency: settleCcy } : {}),
  }));

  for (const taxRow of looseTax) {
    const taxAmt = Math.abs(taxRow.mutatieAmount ?? 0);

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

function processStandaloneRow(row: DeGiroRow, conversions: FxConversion[]): ActivityImport | null {
  const activity = buildStandaloneActivity(row);
  if (!activity || activity.currency === 'EUR') return activity;
  const fx = laterFxRate(conversions, String(activity.date), activity.currency!);
  return fx ? { ...activity, ...fx } : activity;
}

function buildStandaloneActivity(row: DeGiroRow): ActivityImport | null {
  const kind     = classify(row);
  const rawAmt   = row.mutatieAmount ?? 0;
  const absAmt   = Math.abs(rawAmt);
  const currency = row.mutatieCurrency || 'EUR';
  const date     = toIsoDate(row.date, row.time);

  if (kind === 'SECURITY_OUT') {
    // No cash moves; the shares leave the account at DeGiro's transfer price
    const info = parseTradeDescription(row.description);
    if (!info || !row.isin) return null;
    return makeActivity({
      date, isin: row.isin, symbol: row.isin, symbolName: row.product || undefined,
      quantity: info.quantity, activityType: 'TRANSFER_OUT', unitPrice: info.price,
      currency: info.currency, fee: 0, amount: round2(info.quantity * info.price),
      metadata: JSON.stringify({ flow: { is_external: true } }),
      comment: rowComment(row.description, row.product),
    });
  }

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
      // Negative interest = DeGiro charging you (e.g. "Flatex Interest -0.89"),
      // booked as a FEE so the cash goes down
      return makeActivity({
        date, symbol: cashSymbol(currency), quantity: 1,
        activityType: rawAmt < 0 ? 'FEE' : 'INTEREST', unitPrice: absAmt, currency, fee: 0, amount: absAmt,
        comment: rowComment(row.description, row.product),
      });

    case 'FEE':
    case 'TRADE_FEE': // trade fee without an Order Id to merge into
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

/**
 * Wealthfolio dedupes on a key of account, type, day, asset, quantity, price,
 * amount, fee, currency and comment, so genuinely repeated rows (e.g. two
 * identical deposits on the same day) would collapse into one. Number the
 * comments of such repeats so each gets its own key.
 */
function disambiguateDuplicates(activities: ActivityImport[]): void {
  const seen = new Map<string, number>();
  for (const a of activities) {
    const key = [
      a.activityType, String(a.date).slice(0, 10), a.symbol, a.quantity,
      a.unitPrice, a.amount, a.fee, a.currency, a.comment,
    ].join('|');
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) a.comment = `${a.comment ?? ''} (${n})`.trim();
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
 * - Transactiebelasting (French FTT) is folded into its trade's `tax`
 * - AutoFX conversions become linked TRANSFER_OUT/TRANSFER_IN pairs, and their
 *   rate is set as `fxRate` on the trade or income they belong to
 * - Cash sweep rows, money market fund rows, and ISIN renames are discarded
 */
export function mapToActivities(rows: DeGiroRow[]): ActivityImport[] {
  const result: ActivityImport[] = [];

  // Bucket rows by Order Id
  const orderGroups = new Map<string, DeGiroRow[]>();
  const standalone: DeGiroRow[] = [];

  rows.forEach((row, i) => {
    const kind = classify(row);
    if (kind === 'SKIP' || kind === 'UNKNOWN') return;

    // Trades without an Order Id (merger legs) form a group of their own
    const key = row.orderId || (kind === 'BUY' || kind === 'SELL' ? `row-${i}` : '');
    if (key) {
      const bucket = orderGroups.get(key) ?? [];
      bucket.push(row);
      orderGroups.set(key, bucket);
    } else {
      standalone.push(row);
    }
  });

  const conversions = pairFxRows(rows).sort((a, b) => a.time - b.time);

  for (const group of orderGroups.values()) {
    result.push(...processOrderGroup(group, conversions));
  }

  // Dividend withholding tax rides on its dividend (same ISIN, day, currency)
  // as the `tax` field instead of becoming a separate TAX activity
  const taxKey = (r: DeGiroRow) => `${r.isin}|${r.date}|${r.mutatieCurrency || 'EUR'}`;
  const withholding = new Map<string, DeGiroRow[]>();
  const dividendKeys = new Set(
    standalone.filter(r => classify(r) === 'DIVIDEND' && r.isin).map(taxKey),
  );
  const rest: DeGiroRow[] = [];
  for (const row of standalone) {
    if (classify(row) === 'TAX' && row.isin && (row.mutatieAmount ?? 0) < 0 && dividendKeys.has(taxKey(row))) {
      withholding.set(taxKey(row), [...(withholding.get(taxKey(row)) ?? []), row]);
    } else {
      rest.push(row);
    }
  }

  for (const row of rest) {
    const activity = processStandaloneRow(row, conversions);
    if (!activity) continue;
    if (activity.activityType === 'DIVIDEND' && row.isin) {
      const taxRows = withholding.get(taxKey(row));
      const taxRow = taxRows?.shift();
      if (taxRow) {
        const tax = Math.abs(taxRow.mutatieAmount ?? 0);
        // `amount` is the final (net) cash; the host derives gross = amount + tax
        activity.tax = tax;
        activity.amount = round2((activity.amount as number) - tax);
        activity.comment = `${activity.comment ?? ''} + ${taxRow.description}`.trim();
      }
    }
    result.push(activity);
  }

  // Withholding rows with no dividend left to attach to stay standalone TAX
  for (const rows of withholding.values()) {
    for (const row of rows) {
      const activity = processStandaloneRow(row, conversions);
      if (activity) result.push(activity);
    }
  }

  for (const c of conversions) {
    if (!c.foldedIntoTrade) result.push(...fxTransferPair(c));
  }

  disambiguateDuplicates(result);

  // Sort chronologically so the review table is easy to scan
  return result.sort((a, b) =>
    String(a.date ?? '').localeCompare(String(b.date ?? '')),
  );
}
