import { FAILURE_LABELS } from '../shared/errors.js';
import type { FailureKind, Rating, ServerConfigView, ValidationStatus } from '../shared/types.js';
import { h } from './dom.js';
import { formatBytes, relativeTime, truncate } from '../shared/util.js';

export function siteTypeLabel(siteType: string): string {
  const known: Record<string, string> = { e621: 'e621', danbooru: 'Danbooru', gelbooru: 'Gelbooru' };
  return known[siteType] ?? siteType;
}

export function siteTypeChip(siteType: string): HTMLElement {
  return h('span', { class: `chip chip-site chip-${siteType}`, text: siteTypeLabel(siteType) });
}

export function validationDot(status: ValidationStatus, message?: string): HTMLElement {
  const labels: Record<ValidationStatus, string> = {
    valid: 'Validated',
    invalid: 'Validation failed',
    unreachable: 'Unreachable / rate limited',
    partial: 'Partially validated',
    unknown: 'Not validated yet',
  };
  return h('span', {
    class: `dot dot-${status}`,
    title: message ? `${labels[status]} - ${message}` : labels[status],
    ariaLabel: labels[status],
  });
}

/** Failure label that also accepts the `ok` validation kind. */
export function kindLabel(kind: string): string {
  if (kind === 'ok') return 'OK';
  return (FAILURE_LABELS as Record<string, string>)[kind] ?? kind;
}

export function failureChip(kind: FailureKind, message?: string): HTMLElement {
  return h('span', { class: `chip chip-failure chip-${kind}`, text: FAILURE_LABELS[kind] ?? kind, title: message ?? '' });
}

export function ratingChip(rating: Rating): HTMLElement {
  return h('span', { class: `chip chip-rating chip-rating-${rating}`, text: rating });
}

export function accountLine(server: ServerConfigView): HTMLElement {
  const pieces: string[] = [];
  if (server.username) pieces.push(server.username);
  if (server.userId) pieces.push(`id ${server.userId}`);
  const label = pieces.length ? `Signed in: ${pieces.join(' · ')}` : server.hasApiKey ? 'API key saved' : 'No account saved (read-only)';
  const status =
    server.validationStatus === 'valid'
      ? 'verified'
      : server.validationStatus === 'invalid'
        ? 'not verified'
        : server.lastValidatedAt
          ? `checked ${relativeTime(server.lastValidatedAt)}`
          : 'never checked';
  return h('span', { class: 'muted small', text: `${label} · ${status}` });
}

export function ratingFilterLine(server: ServerConfigView): string {
  if (!server.ratingFilterEnabled) return 'Rating filter off';
  const allowed = server.allowedRatings?.length ? server.allowedRatings.join(', ') : 'not configured';
  return `Rating filter on: ${allowed}`;
}

export function maskPreview(view: ServerConfigView): string {
  return view.hasApiKey ? view.apiKeyMask : 'no key stored';
}

export function relativeOrNever(iso: string | null): string {
  return iso ? relativeTime(iso) : 'never';
}

export function bytesOrDash(bytes: number | null): string {
  return bytes === null ? '—' : formatBytes(bytes);
}

export function shortText(value: string, max = 60): string {
  return truncate(value, max);
}
