'use client';

import { api } from '@/lib/api';
import { toPage, type AuditPage } from './types';

export interface AuditFilters {
  action?: string;
  entityId?: string;
}

/** The page size the API caps at 100. Fifty rows is roughly two days of use. */
export const AUDIT_PAGE_SIZE = 50;

export const auditKeys = {
  all: ['audit'] as const,
  list: (filters: AuditFilters) => ['audit', 'list', filters] as const,
};

function search(params: Record<string, string | number | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') qs.set(key, String(value));
  }
  const text = qs.toString();
  return text ? `?${text}` : '';
}

export async function fetchAudit(filters: AuditFilters, cursor?: string): Promise<AuditPage> {
  return toPage(
    await api<unknown>(
      `/audit${search({ limit: AUDIT_PAGE_SIZE, cursor, action: filters.action, entityId: filters.entityId })}`,
    ),
  );
}
