/**
 * Minimal ULID generator (https://github.com/ulid/spec).
 *
 * The data model keys runs and attempts by ulid, but this phase's runtime
 * dependencies are limited to `zod` and `yaml` — so we hand-roll the 26
 * characters here rather than pull a package: 48-bit millisecond timestamp +
 * 80 bits of randomness, Crockford base32. Lexicographic order is creation
 * order, which keeps `results/<run>/<attempt>/` listings chronological.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * `random` overrides the 16 entropy bytes — only fixture seeders pass it, so
 * committed dev data regenerates byte-identically. Production callers omit it.
 */
export function ulid(now: number = Date.now(), random?: Uint8Array): string {
  const chars: string[] = Array.from({ length: 26 }, () => "0");
  let time = now;
  for (let i = 9; i >= 0; i -= 1) {
    chars[i] = ENCODING[time % 32] as string;
    time = Math.floor(time / 32);
  }
  // 256 is an exact multiple of 32, so a modulo here is bias-free.
  const bytes = random ?? crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 16; i += 1) {
    chars[10 + i] = ENCODING[(bytes[i] as number) % 32] as string;
  }
  return chars.join("");
}
