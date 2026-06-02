export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 200;

export interface PaginationInput {
  pageIdx?: number;
  pageSize?: number;
}

export interface PaginationMeta {
  pageIdx: number;
  pageSize: number;
  total: number;
  pages: number;
  hasNext: boolean;
  hasPrev: boolean;
  showing: string; // "1-20 of 89"
}

export function paginationParams(input: PaginationInput = {}): { limit: number; offset: number; pageIdx: number; pageSize: number } {
  const pageIdx = Math.max(0, Math.floor(input.pageIdx ?? 0));
  const pageSize = Math.min(Math.max(1, Math.floor(input.pageSize ?? DEFAULT_PAGE_SIZE)), MAX_PAGE_SIZE);
  return { pageIdx, pageSize, limit: pageSize, offset: pageIdx * pageSize };
}

export function paginationMeta(total: number, pageIdx: number, pageSize: number): PaginationMeta {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const start = total === 0 ? 0 : pageIdx * pageSize + 1;
  const end = Math.min(total, (pageIdx + 1) * pageSize);
  return {
    pageIdx,
    pageSize,
    total,
    pages,
    hasNext: pageIdx + 1 < pages,
    hasPrev: pageIdx > 0,
    showing: total === 0 ? "0 of 0" : `${start}-${end} of ${total}`,
  };
}
