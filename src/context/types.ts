export type ContextKind =
  | 'pr-description'
  | 'commits'
  | 'rules'
  | 'diff'
  | 'changed-file'
  | 'call-sites'
  | 'dependency'
  | 'dependent'
  | 'test'
  | 'convention'
  | 'history'
  | 'signals';

export interface ContextItem {
  id: string;
  kind: ContextKind;
  title: string;
  path?: string;
  content: string;
  // Higher wins when the budget is tight. Required items ignore the budget.
  score: number;
  required?: boolean;
  // Why this item was picked, in words a reviewer would recognise. These end
  // up in the dry-run report so the selection can be audited.
  reasons: string[];
  // A smaller version to fall back on when the full item doesn't fit.
  fallback?: { content: string; note: string };
}

export interface PackedItem extends ContextItem {
  tokens: number;
  usedFallback: boolean;
}

export interface DroppedItem {
  id: string;
  title: string;
  tokens: number;
  score: number;
}

export interface ContextPack {
  items: PackedItem[];
  dropped: DroppedItem[];
  budget: number;
  used: number;
}
