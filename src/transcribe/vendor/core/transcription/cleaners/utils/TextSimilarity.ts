export function normalizeForComparison(text: string): string {
  const normalized = text.trim().normalize('NFKC').toLowerCase();
  let out = '';

  for (let i = 0; i < normalized.length; i++) {
    let ch = normalized[i] ?? '';
    if (!ch) {
      continue;
    }

    // Unify katakana to hiragana for comparison
    const code = ch.charCodeAt(0);
    if (code >= 0x30A1 && code <= 0x30F6) {
      ch = String.fromCharCode(code - 0x60);
    }

    // Drop whitespace / punctuation / symbols / format controls (e.g., zero-width chars)
    if (/[\p{White_Space}\p{P}\p{S}\p{Cf}]/u.test(ch)) {
      continue;
    }

    out += ch;
  }

  return out;
}

/**
 * Character-inclusion similarity (fast and conservative).
 * Counts how many characters from the shorter string appear somewhere in the longer string.
 */
export function calculateInclusionSimilarity(a: string, b: string): number {
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (longer.length === 0) {
    return 1;
  }

  const longerChars = new Set(longer);
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    const ch = shorter[i];
    if (ch && longerChars.has(ch)) {
      matches++;
    }
  }
  return matches / longer.length;
}

export function areSimilarNormalizedText(a: string, b: string, threshold: number): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return calculateInclusionSimilarity(a, b) >= threshold;
}
