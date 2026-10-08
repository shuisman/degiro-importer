import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { Account, HostAPI, SymbolSearchResult } from '../types';
import type { SymbolEntry } from '../parser/symbols';

// A security already present in the user's Wealthfolio (seen in any account's activities)
interface ExistingAsset {
  symbol: string;
  name: string;
  currency: string;
}

// Dropdown row: a search hit or a local existing asset
interface Option {
  symbol: string;
  name: string;
  currency?: string;
  existing: boolean;
}

interface Props {
  symbols: SymbolEntry[];
  accounts: Account[];
  accountId: string;
  onAccountChange: (id: string) => void;
  api: HostAPI;
  onConfirm: (mappings: Record<string, string>) => void;
  onBack: () => void;
}

export default function SymbolMappingStep({
  symbols,
  accounts,
  accountId,
  onAccountChange,
  api,
  onConfirm,
  onBack,
}: Props) {
  // isin → confirmed ticker (empty string = import as custom asset)
  const [mappings, setMappings] = useState<Record<string, string>>({});
  // isin → auto-suggested result pending user confirmation
  const [suggestions, setSuggestions] = useState<Record<string, SymbolSearchResult>>({});
  const [loadingMappings, setLoadingMappings] = useState(false);
  const [saving, setSaving] = useState(false);
  // null while loading; row auto-search waits for it so existing assets win
  const [existing, setExisting] = useState<ExistingAsset[] | null>(null);

  useEffect(() => {
    api.activities
      .getAll()
      .then(acts => {
        const seen = new Map<string, ExistingAsset>();
        for (const a of acts) {
          const sym = a.assetSymbol;
          if (!sym || sym.startsWith('$CASH-') || seen.has(sym)) continue;
          seen.set(sym, { symbol: sym, name: a.assetName ?? '', currency: a.currency });
        }
        setExisting(Array.from(seen.values()));
      })
      .catch(() => setExisting([]));
  }, []);

  useEffect(() => {
    if (!accountId) return;
    setLoadingMappings(true);
    api.activities
      .getImportMapping(accountId)
      .then(data => setMappings(data.symbolMappings ?? {}))
      .catch(() => setMappings({}))
      .finally(() => setLoadingMappings(false));
  }, [accountId]);

  function setTicker(isin: string, ticker: string) {
    setMappings(prev => ({ ...prev, [isin]: ticker }));
  }

  function setSuggestion(isin: string, result: SymbolSearchResult | null) {
    setSuggestions(prev => {
      const next = { ...prev };
      if (result) next[isin] = result;
      else delete next[isin];
      return next;
    });
  }

  function acceptAll() {
    const additions: Record<string, string> = {};
    for (const [isin, result] of Object.entries(suggestions)) {
      if (!mappings[isin]) additions[isin] = result.symbol;
    }
    setMappings(prev => ({ ...prev, ...additions }));
    setSuggestions({});
  }

  async function handleConfirm() {
    const clean = Object.fromEntries(
      Object.entries(mappings).filter(([k, v]) => v && v !== k),
    );
    setSaving(true);
    try {
      await api.activities.saveImportMapping({
        accountId,
        fieldMappings: {},
        activityMappings: {},
        symbolMappings: clean,
        accountMappings: {},
      });
    } catch {
      // non-fatal — import can still proceed
    }
    setSaving(false);
    onConfirm(clean);
  }

  const mappedCount = symbols.filter(s => {
    const t = mappings[s.isin];
    return t && t !== s.isin;
  }).length;

  const suggestCount = Object.keys(suggestions).length;

  return (
    <div className="p-6 flex flex-col gap-4 h-full">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-bold leading-tight">Map symbols</h1>
          <p className="text-xs text-muted-foreground">
            {symbols.length} unique {symbols.length === 1 ? 'ISIN' : 'ISINs'}
            {' · '}{mappedCount} mapped
            {suggestCount > 0 && ` · ${suggestCount} suggested`}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground whitespace-nowrap">Import into</span>
            <select
              value={accountId}
              onChange={e => onAccountChange(e.target.value)}
              className="rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>

          {suggestCount > 0 && (
            <button
              onClick={acceptAll}
              className="rounded-lg border border-green-500 text-green-700 dark:text-green-400 px-3 py-1.5 text-sm font-medium hover:bg-green-50 dark:hover:bg-green-950/30 transition-colors"
            >
              Accept all ({suggestCount})
            </button>
          )}

          <button
            onClick={onBack}
            className="rounded-lg px-3 py-1.5 text-sm hover:bg-muted transition-colors"
          >
            Back
          </button>

          <button
            onClick={handleConfirm}
            disabled={loadingMappings || saving || !accountId}
            className="rounded-lg bg-primary text-primary-foreground px-4 py-1.5 text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Continue'}
          </button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground -mt-2">
        Each ISIN is auto-searched, preferring securities already in your Wealthfolio (marked <b>In portfolio</b>). Confirm the suggested ticker or search manually; pick an existing security rather than a new one to avoid duplicates. Unconfirmed ISINs import as custom assets.
      </p>

      {/* ── Table ── */}
      <div className="flex-1 overflow-auto">
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50 text-muted-foreground text-xs uppercase tracking-wide">
                <th className="px-3 py-2 text-left whitespace-nowrap">ISIN</th>
                <th className="px-3 py-2 text-left">Product name</th>
                <th className="px-3 py-2 text-left">CCY</th>
                <th className="px-3 py-2 text-left">Ticker</th>
                <th className="px-3 py-2 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {symbols.map(s => (
                <RowEditor
                  key={`${accountId}-${s.isin}`}
                  entry={s}
                  confirmedTicker={mappings[s.isin] ?? ''}
                  suggestion={suggestions[s.isin] ?? null}
                  existing={existing}
                  api={api}
                  onTicker={t => setTicker(s.isin, t)}
                  onSuggest={result => setSuggestion(s.isin, result)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// A "real" ticker has no spaces and is short; full product names and ISINs are not tickers
function isValidTicker(t: string): boolean {
  return !!t && !t.includes(' ') && t.length <= 15;
}

// ─── Per-row search editor ────────────────────────────────────────────────────

interface RowEditorProps {
  entry: SymbolEntry;
  confirmedTicker: string;  // controlled from parent mappings
  suggestion: SymbolSearchResult | null;
  existing: ExistingAsset[] | null;
  api: HostAPI;
  onTicker: (ticker: string) => void;
  onSuggest: (result: SymbolSearchResult | null) => void;
}

function RowEditor({ entry, confirmedTicker, suggestion, existing, api, onTicker, onSuggest }: RowEditorProps) {
  const [inputVal, setInputVal] = useState(isValidTicker(confirmedTicker) ? confirmedTicker : '');
  const [results, setResults] = useState<SymbolSearchResult[]>([]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  // Viewport position of the dropdown; it is portalled to <body> so the
  // table's overflow containers can't clip it
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const focusedRef = useRef(false);
  const autoSearched = useRef(false);
  const isInitiallyMapped = useRef(isValidTicker(confirmedTicker) && confirmedTicker !== entry.isin);

  // Sync input when confirmed ticker changes externally (e.g. "Accept all")
  useEffect(() => {
    if (confirmedTicker && confirmedTicker !== entry.isin) {
      setInputVal(confirmedTicker);
    }
  }, [confirmedTicker, entry.isin]);

  const existingSymbols = new Set((existing ?? []).map(e => e.symbol.toUpperCase()));
  const isExistingResult = (r: SymbolSearchResult) =>
    !!r.isExisting ||
    existingSymbols.has(r.symbol.toUpperCase()) ||
    (!!r.canonicalSymbol && existingSymbols.has(r.canonicalSymbol.toUpperCase()));

  // Auto-search by ISIN once the existing securities are loaded
  useEffect(() => {
    if (existing && !autoSearched.current && !isInitiallyMapped.current) {
      autoSearched.current = true;
      runSearch(entry.isin, true);
    }
  }, [existing]); // eslint-disable-line react-hooks/exhaustive-deps

  function filterResults(res: SymbolSearchResult[]): SymbolSearchResult[] {
    return res.filter(r => r.symbol !== entry.isin && isValidTicker(r.symbol));
  }

  function runSearch(query: string, isAuto: boolean) {
    if (!query.trim()) return;
    setSearching(true);
    api.market
      .searchTicker(query)
      .then(res => {
        setSearching(false);
        // Existing securities first (stable sort keeps provider order within groups)
        const trimmed = filterResults(res)
          .sort((a, b) => Number(isExistingResult(b)) - Number(isExistingResult(a)))
          .slice(0, 8);
        setResults(trimmed);
        setQuery(query);
        if (isAuto && trimmed.length > 0) {
          // Prefer a security already in Wealthfolio over creating a new one
          const existingHits = trimmed.filter(isExistingResult);
          const pool = existingHits.length > 0 ? existingHits : trimmed;
          const currencyMatches = pool.filter(r => r.currency === entry.currency);
          if (currencyMatches.length === 1) {
            // Exactly one match for this currency — auto-confirm, no user action needed
            setInputVal(currencyMatches[0].symbol);
            onTicker(currencyMatches[0].symbol);
          } else {
            // Multiple options — surface the best match for the user to confirm
            const best = currencyMatches[0] ?? pool[0];
            onSuggest(best);
          }
        } else if (!isAuto && focusedRef.current) {
          setOpen(true);
        }
      })
      .catch(() => setSearching(false));
  }

  // Track the input's position while the menu is open; scrolling or resizing
  // moves the input under a fixed-position menu
  useEffect(() => {
    if (!open) return;
    function place() {
      const r = inputRef.current?.getBoundingClientRect();
      if (r) setMenuPos({ top: r.bottom + 4, left: r.left });
    }
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  function handleChange(val: string) {
    setInputVal(val);
    onTicker(''); // clear while the user is editing
    clearTimeout(debounceRef.current);
    if (val.trim()) {
      debounceRef.current = setTimeout(() => runSearch(val, false), 400);
    } else {
      setResults([]);
      setOpen(false);
    }
  }

  function handleSelect(symbol: string) {
    setInputVal(symbol);
    onTicker(symbol);
    onSuggest(null); // dismiss any pending suggestion
    setOpen(false);
  }

  function handleFocus() {
    focusedRef.current = true;
    if (results.length > 0) {
      setOpen(true);
    } else if (!searching) {
      runSearch(inputVal.trim() || entry.isin, false);
    }
  }

  function handleBlur() {
    focusedRef.current = false;
    setTimeout(() => setOpen(false), 150);
    onTicker(inputVal.trim());
  }

  function acceptSuggestion() {
    if (!suggestion) return;
    setInputVal(suggestion.symbol);
    onTicker(suggestion.symbol);
    onSuggest(null);
  }

  function rejectSuggestion() {
    onSuggest(null);
  }

  // Dropdown: existing securities (search hits + local matches) above new ones
  const needle = (inputVal.trim() || query).toLowerCase();
  const options: Option[] = [];
  const addedSyms = new Set<string>();
  const push = (o: Option) => {
    if (addedSyms.has(o.symbol.toUpperCase())) return;
    addedSyms.add(o.symbol.toUpperCase());
    options.push(o);
  };
  for (const r of results) {
    if (isExistingResult(r))
      push({ symbol: r.symbol, name: r.shortName || r.longName, currency: r.currency ?? r.exchange, existing: true });
  }
  for (const e of existing ?? []) {
    if (needle && (e.symbol.toLowerCase().includes(needle) || e.name.toLowerCase().includes(needle)))
      push({ symbol: e.symbol, name: e.name, currency: e.currency, existing: true });
  }
  for (const r of results) {
    if (!isExistingResult(r))
      push({ symbol: r.symbol, name: r.shortName || r.longName, currency: r.currency ?? r.exchange, existing: false });
  }
  const existingOptions = options.filter(o => o.existing);
  const newOptions = options.filter(o => !o.existing);
  const suggestionExisting = !!suggestion && isExistingResult(suggestion);

  const isMapped = isValidTicker(confirmedTicker) && confirmedTicker !== entry.isin;

  function renderOption(o: Option) {
    return (
      <button
        key={o.symbol}
        className={`w-full text-left px-3 py-2 text-xs hover:bg-muted/60 flex items-center gap-2 ${
          o.existing ? 'bg-green-50/60 dark:bg-green-950/20' : ''
        }`}
        onMouseDown={e => e.preventDefault()}
        onClick={() => handleSelect(o.symbol)}
      >
        <span className="font-mono font-semibold w-20 shrink-0 truncate">{o.symbol}</span>
        <span className="text-muted-foreground flex-1 truncate">{o.name}</span>
        <span className="text-muted-foreground shrink-0 ml-1">{o.currency}</span>
      </button>
    );
  }

  return (
    <tr className="hover:bg-muted/20">
      <td className="px-3 py-2 font-mono text-xs text-muted-foreground whitespace-nowrap">
        {entry.isin}
      </td>
      <td className="px-3 py-2 text-xs max-w-[200px] truncate" title={entry.name}>
        {entry.name !== entry.isin ? entry.name : <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">{entry.currency}</td>
      <td className="px-3 py-2 min-w-[180px]">
        <div>
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              className="flex-1 min-w-0 rounded border bg-background px-2 py-1 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-ring"
              value={inputVal}
              placeholder="Search ticker…"
              onChange={e => handleChange(e.target.value)}
              onFocus={handleFocus}
              onBlur={handleBlur}
              spellCheck={false}
            />
            {searching && <Spinner />}
          </div>

          {open && menuPos && options.length > 0 && createPortal(
            <div
              className="fixed z-50 w-80 max-h-72 overflow-y-auto rounded-lg border border-border bg-background shadow-lg"
              style={{ top: menuPos.top, left: menuPos.left }}
            >
              {existingOptions.length > 0 && <MenuHeading>In your portfolio</MenuHeading>}
              {existingOptions.map(o => renderOption(o))}
              {newOptions.length > 0 && (
                <MenuHeading>{existingOptions.length > 0 ? 'New securities' : 'Search results'}</MenuHeading>
              )}
              {newOptions.map(o => renderOption(o))}
            </div>,
            document.body,
          )}
        </div>
      </td>
      <td className="px-3 py-2">
        {isMapped ? (
          <span className="text-xs text-green-600 dark:text-green-400 font-medium">
            Mapped ✓ · <span className="font-mono">{confirmedTicker}</span>
            {existingSymbols.has(confirmedTicker.toUpperCase()) && <ExistingBadge />}
          </span>
        ) : suggestion ? (
          <div className="flex items-center gap-1.5 min-w-[180px]">
            <div className="flex flex-col min-w-0 flex-1">
              <span className="font-mono text-xs font-semibold">
                {suggestion.symbol}
                {suggestionExisting && <ExistingBadge />}
              </span>
              <span className="text-[10px] text-muted-foreground truncate">
                {suggestion.exchangeName || suggestion.exchange}
                {suggestion.currency ? ` · ${suggestion.currency}` : ''}
              </span>
            </div>
            <button
              onClick={acceptSuggestion}
              className="shrink-0 rounded px-1.5 py-0.5 text-xs font-medium text-green-700 dark:text-green-400 border border-green-500 hover:bg-green-50 dark:hover:bg-green-950/30 transition-colors"
              title="Accept suggestion"
            >
              ✓
            </button>
            <button
              onClick={rejectSuggestion}
              className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground border border-border hover:bg-muted transition-colors"
              title="Skip — import as custom asset"
            >
              ✕
            </button>
          </div>
        ) : searching ? (
          <div className="flex items-center gap-1.5">
            <Spinner />
            <span className="text-xs text-muted-foreground">Searching…</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Custom asset</span>
        )}
      </td>
    </tr>
  );
}

function ExistingBadge() {
  return (
    <span className="ml-1.5 rounded bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300 px-1 py-0.5 text-[10px] font-medium font-sans">
      In portfolio
    </span>
  );
}

function MenuHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-0 bg-muted px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-3 w-3 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
    </svg>
  );
}
