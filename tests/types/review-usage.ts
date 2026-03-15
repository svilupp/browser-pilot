/**
 * Consumer type test: Delta & Review usage
 *
 * Verifies delta and review types work for downstream consumers.
 */
import type {
  DeltaChange,
  DeltaResult,
  KeyValuePair,
  PageState,
  ReviewResult,
  SummaryCard,
  TableData,
} from '../../src/index.ts';

// Verify PageState shape
declare const state: PageState;
const _url: string = state.url;
const _title: string = state.title;
const _headings: string[] = state.headings;
const _visibleText: string = state.visibleText;
void _url;
void _title;
void _headings;
void _visibleText;

// Verify DeltaResult shape
declare const delta: DeltaResult;
const _hasChanges: boolean = delta.hasChanges;
const _changes: DeltaChange[] = delta.changes;
const _before: PageState = delta.before;
const _after: PageState = delta.after;
void _hasChanges;
void _changes;
void _before;
void _after;

// Verify DeltaChange kinds
declare const change: DeltaChange;
const _kind: string = change.kind;
void _kind;

// Verify ReviewResult shape
declare const review: ReviewResult;
const _rUrl: string = review.url;
const _rTitle: string = review.title;
const _rHeadings: string[] = review.headings;
const _rAlerts: string[] = review.alerts;
const _rStatusLabels: string[] = review.statusLabels;
const _rTables: TableData[] = review.tables;
const _rKeyValues: KeyValuePair[] = review.keyValues;
const _rSummaryCards: SummaryCard[] = review.summaryCards;
void _rUrl;
void _rTitle;
void _rHeadings;
void _rAlerts;
void _rStatusLabels;
void _rTables;
void _rKeyValues;
void _rSummaryCards;

// Verify TableData
declare const table: TableData;
const _headers: string[] = table.headers;
const _rows: string[][] = table.rows;
void _headers;
void _rows;

// Verify KeyValuePair
declare const kv: KeyValuePair;
const _key: string = kv.key;
const _value: string = kv.value;
void _key;
void _value;
