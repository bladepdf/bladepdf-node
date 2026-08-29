import { InvalidRenderConfigurationError } from './errors.js';

export function encodeJson(value: unknown, label: string): string {
  try {
    const encoded = JSON.stringify(value);

    if (encoded === undefined) {
      throw new TypeError('The value is not JSON serializable.');
    }

    return encoded;
  } catch (error) {
    throw new InvalidRenderConfigurationError(
      `BladePDF ${label} must be JSON serializable.`,
      { cause: error },
    );
  }
}

export function cloneJsonObject(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const encoded = encodeJson(value, 'context');

  return JSON.parse(encoded) as Record<string, unknown>;
}

export function deepFreezeJson<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreezeJson(child);
  }

  return Object.freeze(value);
}

export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === '[object Object]'
  );
}

export async function replaceAsync(
  input: string,
  expression: RegExp,
  replacer: (match: RegExpExecArray) => Promise<string>,
): Promise<string> {
  if (!expression.global) {
    throw new TypeError('replaceAsync requires a global regular expression.');
  }

  expression.lastIndex = 0;
  const matches = [...input.matchAll(expression)];

  if (matches.length === 0) {
    return input;
  }

  const replacements = await Promise.all(matches.map(replacer));
  let cursor = 0;
  let output = '';

  for (const [index, match] of matches.entries()) {
    const offset = match.index;
    output += input.slice(cursor, offset);
    output += replacements[index] ?? match[0];
    cursor = offset + match[0].length;
  }

  return output + input.slice(cursor);
}

export function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}
