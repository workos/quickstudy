/** Browser-safe canonicalization and structural identity diffing. */

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export interface IdentityMismatch {
  path: string;
  a: unknown;
  b: unknown;
}

export function diffIdentity(a: unknown, b: unknown, path = "identity"): IdentityMismatch[] {
  if (canonicalJson(a) === canonicalJson(b)) return [];
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object" && !Array.isArray(a) && !Array.isArray(b)) {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    return [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .sort()
      .flatMap((key) => diffIdentity(left[key], right[key], `${path}.${key}`));
  }
  return [{ path, a: a ?? null, b: b ?? null }];
}
