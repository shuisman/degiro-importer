import type { ActivityImport as _ActivityImport } from '@wealthfolio/addon-sdk';

// `isin` exists in the Rust struct and is accepted on the wire, but the TS SDK
// types don't declare it yet — extend locally until the SDK catches up.
// The rest are addon-side fields carried through to `ActivityCreate`.
export type ActivityImport = _ActivityImport & {
  isin?: string;
  fxCurrency?: string;    // currency `fxRate` converts into; applied only when it is the account currency
  sourceGroupId?: string; // links the two legs of an FX conversion
  metadata?: string;      // JSON, sent as-is
};

export type {
  ActivityCreate,
  ActivityType,
  Account,
  ImportActivitiesResult,
  ImportActivitiesSummary,
  SymbolSearchResult,
} from '@wealthfolio/addon-sdk';
export type { HostAPI } from '@wealthfolio/addon-sdk';
export type { AddonContext } from '@wealthfolio/addon-sdk';
