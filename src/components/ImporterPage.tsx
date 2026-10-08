import React, { useState, useCallback } from 'react';
import type { ActivityImport, ActivityCreate, Account, HostAPI, ImportActivitiesSummary } from '../types';
import { parseCsv } from '../parser/csv';
import { mapToActivities, findUnrecognised } from '../parser/mapper';
import { extractUniqueSymbols, applyMappings } from '../parser/symbols';
import FileUpload from './FileUpload';
import ActivityTable from './ActivityTable';
import SymbolMappingStep from './SymbolMappingStep';
import {
  Alert, AlertDescription, AlertTitle,
  Card, CardContent, CardDescription, CardHeader, CardTitle,
  Icons, Page, PageContent, PageHeader,
} from '@wealthfolio/ui';
import { version } from '../../package.json';

type Stage = 'idle' | 'mapping' | 'review' | 'importing' | 'done';

interface Props {
  api: HostAPI;
}

export default function ImporterPage({ api }: Props) {
  const [stage, setStage]               = useState<Stage>('idle');
  const [rawActivities, setRawActivities] = useState<ActivityImport[]>([]); // pre-mapping
  const [activities, setActivities]     = useState<ActivityImport[]>([]);   // post-mapping
  const [accounts, setAccounts]         = useState<Account[]>([]);
  const [accountId, setAccountId]       = useState('');
  const [clearFirst, setClearFirst]     = useState(false);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [clearConfirmInput, setClearConfirmInput] = useState('');
  const [result, setResult]             = useState<ImportActivitiesSummary | null>(null);
  const [error, setError]               = useState<string | null>(null);
  const [unrecognised, setUnrecognised] = useState<string[]>([]);

  // ── Step 1: file uploaded → go to symbol mapping ───────────────────────────

  const handleFile = useCallback(async (content: string) => {
    setError(null);
    try {
      const rows = parseCsv(content);
      const acts = mapToActivities(rows);
      const accs = await api.accounts.getAll();

      if (acts.length === 0) {
        setError('No importable activities found in this file. Make sure you export the Account statement (not Transactions) from DeGiro.');
        return;
      }

      setRawActivities(acts);
      setUnrecognised(findUnrecognised(rows));
      setAccounts(accs);
      setAccountId(accs[0]?.id ?? '');
      setStage('mapping');
    } catch (e) {
      setError(`Could not parse the file: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [api]);

  // ── Step 2: symbol mappings confirmed → apply and go to review ─────────────

  const handleMappingConfirm = useCallback((mappings: Record<string, string>) => {
    setActivities(applyMappings(rawActivities, mappings));
    setStage('review');
  }, [rawActivities]);

  // ── Step 3: user clicks Import ─────────────────────────────────────────────

  const handleImport = useCallback(async () => {
    if (!accountId) return;
    setStage('importing');
    setError(null);
    try {
      if (clearFirst) {
        const existing = await api.activities.getAll(accountId);
        if (existing.length > 0) {
          await api.activities.saveMany({ deleteIds: existing.map(a => a.id) });
        }
      }

      // Convert to ActivityCreate — bypasses the broken import flow, gives
      // per-activity errors so we can see exactly what the server rejects
      const accountCurrency = accounts.find(acc => acc.id === accountId)?.currency;
      const creates: ActivityCreate[] = activities.map(a => {
        const isCash = !a.symbol || a.symbol.startsWith('$CASH-');
        return {
          accountId,
          activityType: a.activityType,
          activityDate: String(a.date ?? ''),
          currency: a.currency,
          quantity: a.quantity ?? null,
          unitPrice: a.unitPrice ?? null,
          amount: a.amount ?? null,
          fee: a.fee ?? null,
          tax: a.tax ?? null,
          comment: a.comment ?? null,
          // DeGiro's own conversion rate; only meaningful into the account currency
          fxRate: a.fxRate != null && a.fxCurrency === accountCurrency ? a.fxRate : null,
          sourceGroupId: a.sourceGroupId,
          metadata: a.metadata,
          // quoteCcy is required for all activities — even cash ones (no symbol)
          asset: isCash
            ? { quoteCcy: a.currency }
            : { symbol: a.symbol as string, quoteCcy: a.currency },
        };
      });

      let imported = 0;
      let duplicates = 0;

      try {
        const saveResult = await api.activities.saveMany({ creates });
        imported = saveResult.created.length;
        const flagged = saveResult.created.filter(c => c.needsReview || c.status !== 'POSTED');
        for (const c of flagged) {
          api.logger.info(
            `needs review: ${c.activityType} ${c.activityDate} status=${c.status} ` +
            `qty=${c.quantity} price=${c.unitPrice} amount=${c.amount} fee=${c.fee} ` +
            `ccy=${c.currency} fx=${c.fxRate} asset=${c.assetId}`,
          );
        }
        const byError = saveResult.errors.reduce<Record<string, number>>((acc, e) => {
          const key = e.message ?? 'unknown';
          acc[key] = (acc[key] ?? 0) + 1;
          return acc;
        }, {});
        api.logger.info(
          `saveMany: created=${saveResult.created.length}  errors=${saveResult.errors.length}\n` +
          Object.entries(byError).map(([msg, n]) => `  ${n}× ${msg}`).join('\n'),
        );
      } catch (bulkErr) {
        const msg = bulkErr instanceof Error ? bulkErr.message : String(bulkErr);
        if (!msg.toLowerCase().includes('duplicate')) throw bulkErr;

        // Batch rejected due to duplicates — fall back to one-at-a-time so new
        // activities still get imported and duplicates are counted, not fatal.
        api.logger.info('Bulk import hit duplicate; retrying individually…');
        for (const create of creates) {
          try {
            const r = await api.activities.saveMany({ creates: [create] });
            imported += r.created.length;
          } catch (e) {
            const m = e instanceof Error ? e.message : String(e);
            if (m.toLowerCase().includes('duplicate')) {
              duplicates++;
            } else {
              throw e;
            }
          }
        }
        api.logger.info(`individual retry: created=${imported}  duplicates=${duplicates}`);
      }

      const res = {
        summary: {
          total: activities.length,
          imported,
          skipped: activities.length - imported - duplicates,
          duplicates,
          assetsCreated: 0,
          success: imported > 0 || duplicates === activities.length,
        },
      };
      setResult(res.summary);
      setStage('done');
    } catch (e) {
      setError(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      setStage('review');
    }
  }, [activities, accountId, clearFirst, api]);

  // ── Step 4: reset ──────────────────────────────────────────────────────────

  function reset() {
    setStage('idle');
    setRawActivities([]);
    setUnrecognised([]);
    setActivities([]);
    setAccounts([]);
    setAccountId('');
    setClearFirst(false);
    setResult(null);
    setError(null);
  }

  // ─── Renders ───────────────────────────────────────────────────────────────

  if (stage === 'idle') {
    return (
      <Page>
        <PageHeader
          heading="DeGiro Importer"
          text="Import your DeGiro account statement into Wealthfolio"
          dragRegion={false}
        />
        <PageContent>
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            <p className="text-muted-foreground">
              Bring your DeGiro history into Wealthfolio. This addon reads DeGiro's{' '}
              <strong className="text-foreground">Account statement</strong> export and turns it
              into Wealthfolio activities: buys, sells, dividends, deposits, withdrawals, fees and
              taxes. Nothing is saved until you have reviewed the result.
            </p>

            <Card>
              <CardHeader>
                <CardTitle>Your first step</CardTitle>
                <CardDescription>
                  In DeGiro: Inbox → Account statement → select a date range → Download as CSV.
                  The Transactions export will not work.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {error && (
                  <Alert variant="error" className="mb-4">
                    <Icons.AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}
                <FileUpload onFile={handleFile} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>How it works</CardTitle>
              </CardHeader>
              <CardContent>
                <ol className="flex flex-col gap-4">
                  {IMPORT_STEPS.map(([title, text], i) => (
                    <li key={title} className="flex gap-3">
                      <span className="bg-muted flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold">
                        {i + 1}
                      </span>
                      <div>
                        <p className="font-medium">{title}</p>
                        <p className="text-muted-foreground text-sm">{text}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Notes</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Alert>
                  <Icons.Info className="h-4 w-4" />
                  <AlertTitle>About</AlertTitle>
                  <AlertDescription className="text-muted-foreground">
                    DeGiro Importer v{version} is an open-source community addon (MIT licence),
                    not affiliated with DeGiro or flatex. Source code and issue tracker:{' '}
                    <span className="text-foreground select-all font-mono text-xs">{REPO_URL}</span>
                  </AlertDescription>
                </Alert>
                <Alert>
                  <Icons.Clock className="h-4 w-4" />
                  <AlertTitle>Time zones</AlertTitle>
                  <AlertDescription className="text-muted-foreground">
                    DeGiro timestamps carry no time zone, so activity times are always read as{' '}
                    <strong className="text-foreground">Europe/Amsterdam</strong> local time
                    (CET / CEST).
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>
          </div>
        </PageContent>
      </Page>
    );
  }

  if (stage === 'mapping') {
    return (
      <SymbolMappingStep
        symbols={extractUniqueSymbols(rawActivities)}
        accounts={accounts}
        accountId={accountId}
        onAccountChange={setAccountId}
        api={api}
        onConfirm={handleMappingConfirm}
        onBack={reset}
      />
    );
  }

  if (stage === 'done' && result) {
    return (
      <div className="p-8 max-w-lg mx-auto">
        <h1 className="text-2xl font-bold mb-6">Import complete</h1>
        <div className="grid grid-cols-2 gap-4 mb-8">
          <StatCard label="Total"      value={result.total}      />
          <StatCard label="Imported"   value={result.imported}   accent="green" />
          <StatCard label="Skipped"    value={result.skipped}    />
          <StatCard label="Duplicates" value={result.duplicates} />
        </div>
        <button
          onClick={reset}
          className="w-full rounded-lg border px-4 py-2 text-sm font-medium hover:bg-muted transition-colors"
        >
          Import another file
        </button>
      </div>
    );
  }

  // review | importing
  const invalidCount = activities.filter(a => !a.isValid).length;

  return (
    <div className="p-6 flex flex-col gap-4 h-full">
      {/* ── Header bar ── */}
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-xl font-bold leading-tight">Review activities</h1>
          <p className="text-xs text-muted-foreground">
            {activities.length} activities parsed
            {invalidCount > 0 && ` · ${invalidCount} need a symbol`}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-3 flex-wrap">
          {/* Account selector */}
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground whitespace-nowrap">Import into</span>
            <select
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              disabled={stage === 'importing'}
              className="rounded-md border bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            >
              {accounts.length === 0 && (
                <option value="">No accounts found</option>
              )}
              {accounts.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={clearFirst}
              onChange={e => setClearFirst(e.target.checked)}
              disabled={stage === 'importing'}
              className="h-4 w-4 rounded border accent-destructive"
            />
            <span className={clearFirst ? 'text-destructive font-medium' : 'text-muted-foreground'}>
              Clear account first
            </span>
          </label>

          <button
            onClick={() => setStage('mapping')}
            disabled={stage === 'importing'}
            className="rounded-lg px-3 py-1.5 text-sm hover:bg-muted transition-colors disabled:opacity-50"
          >
            Back
          </button>

          <button
            onClick={() => {
              if (clearFirst) {
                setClearConfirmInput('');
                setShowClearConfirm(true);
              } else {
                handleImport();
              }
            }}
            disabled={stage === 'importing' || !accountId || accounts.length === 0}
            className="rounded-lg bg-primary text-primary-foreground px-4 py-1.5 text-sm font-semibold hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {stage === 'importing'
              ? 'Importing…'
              : `Import ${activities.length} activities`}
          </button>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {unrecognised.length > 0 && (
        <Alert>
          <Icons.AlertCircle className="h-4 w-4" />
          <AlertTitle>
            {unrecognised.length} unrecognised {unrecognised.length === 1 ? 'description' : 'descriptions'} not imported
          </AlertTitle>
          <AlertDescription className="text-muted-foreground">
            <p>These rows moved money but don't match a known DeGiro transaction type. Please report them on GitHub so they can be supported:</p>
            <ul className="mt-1 list-disc pl-5 font-mono text-xs">
              {unrecognised.map(d => <li key={d}>{d}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* ── Table ── */}
      <div className="flex-1 overflow-auto">
        <ActivityTable activities={activities} onChange={setActivities} />
      </div>

      {/* ── Clear-account confirmation dialog ── */}
      {showClearConfirm && (() => {
        const accountName = accounts.find(a => a.id === accountId)?.name ?? '';
        const confirmed = clearConfirmInput.trim() === accountName;
        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="bg-background rounded-xl border shadow-xl p-6 max-w-md w-full mx-4">
              <h2 className="text-lg font-bold mb-2 text-destructive">Delete all activities?</h2>
              <p className="text-sm text-muted-foreground mb-4">
                All existing activities in <strong>{accountName}</strong> will be permanently
                deleted before import. Type the account name to confirm.
              </p>
              <input
                autoFocus
                className="w-full rounded border bg-background px-3 py-2 text-sm font-mono mb-4 focus:outline-none focus:ring-2 focus:ring-destructive"
                placeholder={accountName}
                value={clearConfirmInput}
                onChange={e => setClearConfirmInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && confirmed) { setShowClearConfirm(false); handleImport(); } }}
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setShowClearConfirm(false)}
                  className="rounded-lg px-4 py-2 text-sm hover:bg-muted transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => { setShowClearConfirm(false); handleImport(); }}
                  disabled={!confirmed}
                  className="rounded-lg bg-destructive text-destructive-foreground px-4 py-2 text-sm font-semibold hover:bg-destructive/90 transition-colors disabled:opacity-50"
                >
                  Delete and import
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ─── Small helpers ────────────────────────────────────────────────────────────

// Shown as selectable text: the addon sandbox (allow-scripts only) can't open
// external links.
const REPO_URL = 'https://github.com/shuisman/degiro-importer';

const IMPORT_STEPS: [string, string][] = [
  ['Upload', 'Drop your Account statement CSV. It is parsed inside Wealthfolio.'],
  ['Map symbols', 'Confirm the ticker for each ISIN. Your choices are remembered per account.'],
  ['Review', 'Check or edit the parsed activities and choose the destination account.'],
  ['Import', 'Activities are created in Wealthfolio. Duplicates are detected and skipped.'],
];

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="rounded-lg bg-destructive/10 border border-destructive/30 px-4 py-3 text-sm text-destructive mb-4">
      {message}
    </div>
  );
}

function StatCard({ label, value, accent }: { label: string; value: number; accent?: 'green' }) {
  return (
    <div className="rounded-xl border p-4">
      <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-3xl font-bold ${accent === 'green' ? 'text-green-600 dark:text-green-400' : ''}`}>
        {value}
      </p>
    </div>
  );
}
