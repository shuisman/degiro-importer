# CLAUDE.md — DeGiro Importer for Wealthfolio

Project context for Claude Code. Read this before touching anything.

---

## What this is

A Wealthfolio addon (TypeScript/React, Vite) that parses DeGiro's Dutch-locale
Account Statement CSV and imports activities into Wealthfolio via the addon SDK.

The addon is a single bundled JS file (`dist/addon.js`) loaded by Wealthfolio.
No backend, no server — everything runs inside the Wealthfolio addon sandbox.

---

## Build & test

```bash
npm run build           # tsc --noEmit + vite build → dist/addon.js
npm run bundle          # build + PowerShell zip → degiro-importer.zip (Windows only)
npm run dev             # vite build --watch
npx tsx test-parse.mts Account.csv   # smoke-test parser without Wealthfolio
```

Install in Wealthfolio: Settings → Addons → Install from file → select zip.

---

## Key file map

| File | Purpose |
|---|---|
| `src/addon.tsx` | Entry point — default-exported `enable(ctx)` registers the route component |
| `manifest.json` | Permissions, `contributes` (route + sidebar link), `hostDependencies` |
| `src/types.ts` | Re-exports from `@wealthfolio/addon-sdk` — import from here, not the SDK directly |
| `src/parser/csv.ts` | Raw CSV text → `DeGiroRow[]` |
| `src/parser/mapper.ts` | `DeGiroRow[]` → `ActivityImport[]` |
| `src/parser/symbols.ts` | Extract unique ISINs, apply ticker mappings |
| `src/components/ImporterPage.tsx` | Orchestrator: idle → mapping → review → importing → done |
| `src/components/SymbolMappingStep.tsx` | ISIN lookup + confirm step |
| `src/components/ActivityTable.tsx` | Editable review table |
| `src/components/FileUpload.tsx` | Drag-drop CSV upload |

---

## SDK API — confirmed working patterns

### Use `saveMany`, NOT `activities.import()`

`api.activities.import()` runs pre-insert validation that requires `quoteCcy`
**and** `instrumentType` on every asset-linked row (BUY/SELL/DIVIDEND — any row
with a symbol but no `assetId`). If either field is missing the row is marked
invalid and the whole run reports `success=false` with per-row errors. Because
DeGiro's CSV contains no `instrumentType` data, we can't satisfy those
requirements. Use `api.activities.saveMany({ creates: ActivityCreate[] })` instead
— it uses a different code path (`prepare_activities_for_save →
resolve_import_asset_inputs`) that resolves both fields automatically by hitting
the asset service. It returns `{ created: Activity[], errors: ActivityBulkMutationError[] }`.

The SDK owner has acknowledged the inconsistency and plans to converge the two
code paths in a future release. Keep using `saveMany` until then.

### `ActivityCreate` requirements (hard-won)

- `activityDate`: must be `YYYY-MM-DD` string — datetime strings without
  timezone (e.g. `"2020-04-21T09:30:00"`) are rejected with "Invalid date format".
  Always strip the time component.
- `asset.quoteCcy`: **required for ALL activity types**, including cash ones
  (DEPOSIT/WITHDRAWAL/FEE/INTEREST). Error if missing: "Quote currency is required".
  - Cash: `asset: { quoteCcy: currency }` — no `symbol` field.
  - Stock: `asset: { symbol: ticker, quoteCcy: currency }`.
- `accountId`: set per-activity in `ImporterPage` before import.

### Import mapping persistence

- `api.activities.getImportMapping(accountId)` → `{ symbolMappings: Record<string, string> }`
- `api.activities.saveImportMapping({ accountId, symbolMappings, fieldMappings: {}, activityMappings: {}, accountMappings: {} })`
- Saved per account — switching accounts reloads mappings.

### Sandbox runtime (Wealthfolio 3.6+, SDK 3.9)

The addon runs in an isolated iframe. Consequences:

- **Permissions** are enforced per call as `<category>:<function>`. Manifest
  function names are bare (`"getAll"`, not `"accounts.getAll"`), and category
  ids must match `PERMISSION_CATEGORIES` in the SDK (`market-data`, not
  `market`). A mismatch throws "Addon '…' is not allowed to call x.y".
- **Routing**: `contributes.routes` + `contributes.links.sidebar` in the
  manifest declare the page and sidebar entry; `addon.tsx` registers
  `ctx.router.add({ id, path, component })` with the **same id**. The host owns
  the React root. Don't call `createRoot`, and don't use `ctx.sidebar.addItem`.
- **Sidebar icon** is a curated name string (`AddonIconName`, e.g. `"files"`),
  not a React element.
- **React is host-provided**: `vite.config.ts` marks `react`, `react-dom`, and
  `@wealthfolio/addon-sdk` as ESM `external`. Keep that list in sync with
  `manifest.hostDependencies`. Never bundle React.
- No `localStorage` / `sessionStorage` (they throw; use `ctx.api.storage`), and no
  raw `fetch` (use `ctx.api.network.request` + `network.allowedHosts`).
- `manifest.json` uses `"main": "addon.js"`: both zips (local `bundle.mjs` and
  CI `release.yml`) put `manifest.json` and `addon.js` at the zip root.
- After changing permissions, **reinstall** the addon so the new consent applies.

---

## DeGiro CSV quirks

The "Account statement" export has **12 actual columns but only 10 named headers**.
`Mutatie` and `Saldo` each secretly span two columns (currency + amount):

```
Datum | Tijd | Valutadatum | Product | ISIN | Omschrijving | FX
  | Mutatie (ccy) | Mutatie (amt) | Saldo (ccy) | Saldo (amt) | Order Id
```

- Numbers: European locale — `.` thousands separator, `,` decimal.
- Dates: `DD-MM-YYYY`. Times: `HH:MM` (no timezone — always Europe/Amsterdam).
- Trades come in groups by Order Id (partial fills + fee row share the same id).
- French FTT (`Transactiebelasting`) is sometimes reversed same-day — only
  import negative amounts.

---

## Transaction type mapping

Descriptions follow the DeGiro account's country, not the platform language
(a Spanish account exports English headers with `Compra`, `Dividendo`,
`Retención del dividendo`, `Ingreso/Retirada Cambio de Divisa`). `classify()`
matches NL / EN / ES / DE wording; unmatched money-moving rows are listed on
the review screen. Dutch names below.

| Dutch description | Wealthfolio type | Notes |
|---|---|---|
| `Koop N @ P CCY` | `BUY` | Aggregated by Order Id |
| `Verkoop N @ P CCY` | `SELL` | Aggregated by Order Id |
| `Transactiekosten` | fee on trade | Merged into parent trade's `fee` field |
| `Transactiebelasting` (negative) | `tax` on the trade | French FTT folded into the trade (BUY = gross + fee + tax, SELL = gross − fee − tax) when in the trade's currency or settled via its AutoFX; otherwise a standalone `TAX`. Positive = reversal, skip |
| `Dividendbelasting` | `tax` on the dividend | Paired with the dividend (same ISIN, day, currency): `tax` = withholding, `amount` = gross − tax (net cash; the host derives gross = amount + tax). Unpaired → standalone `TAX` |
| `flatex Storting` / `iDEAL storting` | `DEPOSIT` | |
| `Processed Flatex Withdrawal` (negative) | `WITHDRAWAL` | Positive = cancellation, skip |
| `Dividend` | `DIVIDEND` | |
| `Flatex Interest` | `INTEREST` | Can be negative (charged) |
| `Service-fee` / `Aansluitingskosten` / `B.T.W` | `FEE` | |
| `Valuta Debitering` + `Valuta Creditering` (no trade in the order) | `TRANSFER_OUT` + `TRANSFER_IN` | AutoFX conversion of income: same-account pair with shared `sourceGroupId` and `metadata.fx` (`rateSource: implied_from_import`) so Wealthfolio treats it as contribution-neutral. DeGiro's rate is also set as `fxRate` on the dividend/tax it converts (next conversion within 7 days) |
| `Valuta Debitering` + `Valuta Creditering` (same Order Id as a trade) | folded into the trade | `fxRate` = EUR leg / foreign leg, so Wealthfolio books the trade's cash in EUR (BUY/SELL with `fxRate` ≠ account ccy book in account currency). No transfer pair — that would double-count. EUR fees are converted into the trade currency at the same rate |
| `TRASPASO DE SALIDA: Venta N …` | `TRANSFER_OUT` (security) | Shares moved to another broker, no cash, `flow.is_external: true` |
| `FUSIÓN: Compra/Venta …` | `BUY` / `SELL` | Merger legs, no Order Id — each row is its own group |
| `CAMBIO DE PRODUCTO` / `flatex Withdrawal` | skip | Product rename at 0; flatex-side leg of a withdrawal (like `flatex terugstorting`) |
| Cash Sweep / Overboeking / WIJZIGING ISIN | skip | Internal noise |
| ISIN `LU1959429272` | skip | Morgan Stanley money market fund |
| ISIN `NLFLATEXACNT` | skip | Flatex bank account representation |

---

## Symbol mapping step

`SymbolMappingStep` is the ISIN → ticker confirmation step between CSV upload
and activity review.

**Architecture:**
- Parent owns `mappings: Record<string, string>` (confirmed tickers) and
  `suggestions: Record<string, SymbolSearchResult>` (pending, needs user action).
- The parent loads the securities already in Wealthfolio (unique `assetSymbol`s from `activities.getAll()`); each `RowEditor` auto-searches via `api.market.searchTicker(isin)` once they are loaded.
- Existing securities win: if any hit is existing (`isExisting` or in that set) only those are considered for auto-confirm/suggestion. The dropdown lists "In your portfolio" above new results, and an "In portfolio" badge marks them, to avoid duplicate assets.
- `filterResults()` strips results where `symbol === isin` or symbol contains
  spaces or is longer than 15 chars (those are product names, not tickers).
- If exactly **one** currency-matching result → auto-confirm silently.
- If **multiple** → surface a suggestion chip with Accept (✓) / Skip (✕).
- **"Accept all (N)"** button bulk-accepts all pending suggestions.
- Confirmed mappings are persisted via `saveImportMapping` so repeat imports skip this step.
- `onMouseDown={e => e.preventDefault()}` on dropdown items prevents the input
  blur from firing before the click, which would clear the selection.

**isValidTicker:** `!t.includes(' ') && t.length <= 15` — rejects full product
names that old auto-confirm code may have saved as tickers.

**OpenFIGI** (batch POST to `api.openfigi.com/v3/mapping`, free, no key) was
prototyped and removed. If re-added, it must go through `ctx.api.network.request`
with `network.allowedHosts: ["api.openfigi.com"]`. The community listing then
shows that data leaves the device.

---

## Cash semantics (Wealthfolio)

- `amount` is the **final cash** booked: BUY = gross + fee, SELL = gross − fee.
  The host recomputes `quantity × unitPrice ± fee` and flags a mismatch over
  half a cent for review, so trade unit prices and converted fees are sent
  unrounded (`round8`).
- Negative interest is imported as `FEE` (an `INTEREST` always adds cash).
- Order Id `-1` (product changes, transfer fees) means no order — `parseCsv`
  blanks it so those rows don't group together.
- Reconcile with DeGiro: simulated per-currency cash over a full export
  should end at the statement's final EUR balance and USD 0.00.

---

## Smoke test results (Account.csv, 820 rows)

280 activities: 142 BUY, 74 DEPOSIT, 21 SELL, 12 DIVIDEND, 11 FEE,
8 INTEREST, 7 TAX, 5 WITHDRAWAL — all 280 created successfully via `saveMany`.
