import type { ScopeDirection } from './types.js';

const SCOPE_SEPARATOR = '::';

export interface ScopedField {
  methodName: string;
  direction: ScopeDirection;
  parentPath: string;
  keyName: string;
}

export function makeScopedFieldKey(
  methodName: string,
  direction: ScopeDirection,
  parentPath: string,
  keyName: string,
): string {
  return `${methodName}${SCOPE_SEPARATOR}${direction}${SCOPE_SEPARATOR}${parentPath}${SCOPE_SEPARATOR}${keyName}`;
}

export function parseScopedFieldKey(key: string): ScopedField | null {
  const parts = key.split(SCOPE_SEPARATOR);
  if (parts.length === 3) {
    // Legacy scoped key: method::direction::keyName
    const [methodName, direction, keyName] = parts;
    if (!methodName || !keyName) return null;
    if (direction !== 'request' && direction !== 'response') return null;
    return { methodName, direction, parentPath: '$', keyName };
  }
  if (parts.length !== 4) return null;
  const [methodName, direction, parentPath, keyName] = parts;
  if (!methodName || !keyName) return null;
  if (direction !== 'request' && direction !== 'response') return null;
  return { methodName, direction, parentPath, keyName };
}

export function decisionLookupKeys(
  methodName: string,
  direction: ScopeDirection,
  parentPath: string,
  keyName: string,
): string[] {
  return [makeScopedFieldKey(methodName, direction, parentPath, keyName)];
}
