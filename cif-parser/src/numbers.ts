/**
 * Number parsing straight from bytes, without building substrings.
 *
 * Floats use the Clinger fast path: up to 15 significant digits accumulate exactly into an integer
 * mantissa, and one multiplication or division by an exact power of ten (|e| <= 22) gives the correctly
 * rounded result, bit-identical to Number(). Anything outside the fast path falls back to Number() on the
 * decoded text. A trailing standard uncertainty such as "1.234(5)" is ignored (PDB files use separate
 * *_esd items, but the CIF grammar allows it). Invalid text gives NaN.
 */

const POW10 = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22];

function slowParse(b: Uint8Array, s: number, e: number): number {
  let t = "";
  for (let i = s; i < e; i++) {
    if (b[i] === 40) break; // standard uncertainty
    t += String.fromCharCode(b[i]!);
  }
  if (t.length === 0) return NaN;
  const v = Number(t);
  return v;
}

export function parseFloatBytes(b: Uint8Array, s: number, e: number): number {
  let i = s;
  let neg = false;
  if (i < e && (b[i] === 45 || b[i] === 43)) { neg = b[i] === 45; i++; }
  let mant = 0, sig = 0, exp = 0, digits = 0, truncated = false;
  while (i < e) {
    const d = b[i]! - 48;
    if (d < 0 || d > 9) break;
    digits++;
    if (sig < 15) { mant = mant * 10 + d; if (mant !== 0) sig++; }
    else { exp++; if (d !== 0) truncated = true; }
    i++;
  }
  if (i < e && b[i] === 46) {
    i++;
    while (i < e) {
      const d = b[i]! - 48;
      if (d < 0 || d > 9) break;
      digits++;
      if (sig < 15) { mant = mant * 10 + d; if (mant !== 0) sig++; exp--; }
      else if (d !== 0) truncated = true;
      i++;
    }
  }
  if (digits === 0) return slowParse(b, s, e);
  if (i < e && (b[i] === 101 || b[i] === 69)) {
    i++;
    let eneg = false;
    if (i < e && (b[i] === 45 || b[i] === 43)) { eneg = b[i] === 45; i++; }
    let ev = 0, edigits = 0;
    while (i < e) {
      const d = b[i]! - 48;
      if (d < 0 || d > 9) break;
      if (ev < 100000) ev = ev * 10 + d;
      edigits++;
      i++;
    }
    if (edigits === 0) return slowParse(b, s, e);
    exp += eneg ? -ev : ev;
  }
  if (i !== e) {
    if (b[i] !== 40) return slowParse(b, s, e); // not a standard uncertainty "(...)": invalid or exotic
    e = i;
  }
  if (truncated) return slowParse(b, s, e);
  let v: number;
  if (exp === 0) v = mant;
  else if (exp > 0 && exp <= 22) v = mant * POW10[exp]!;
  else if (exp < 0 && exp >= -22) v = mant / POW10[-exp]!;
  else return slowParse(b, s, e);
  return neg ? -v : v;
}

/** Integer parse; values outside the safe range or with a fraction fall back to Number(). */
export function parseIntBytes(b: Uint8Array, s: number, e: number): number {
  let i = s;
  let neg = false;
  if (i < e && (b[i] === 45 || b[i] === 43)) { neg = b[i] === 45; i++; }
  if (i >= e) return NaN;
  let v = 0;
  const start = i;
  while (i < e) {
    const d = b[i]! - 48;
    if (d < 0 || d > 9) {
      if (b[i] === 40 && i > start) break; // standard uncertainty "(...)"
      return slowParse(b, s, e);
    }
    v = v * 10 + d;
    i++;
  }
  if (i - start > 15) return slowParse(b, s, i);
  return neg ? -v : v;
}
