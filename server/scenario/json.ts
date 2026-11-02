/** Lectura segura de las respuestas estructuradas de Concord (sin `as`). */
import type { JsonValue } from '../concord/session.ts';

export function field(value: JsonValue | null | undefined, ...path: string[]): JsonValue | undefined {
  let current: JsonValue | null | undefined = value;
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    if (Array.isArray(current)) return undefined;
    current = current[key];
  }
  return current ?? undefined;
}

export function asNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function asString(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asArray(value: JsonValue | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}
