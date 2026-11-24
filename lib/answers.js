// Answer normalisation and free-text matching (server is the only judge).
//
// Normalisation: Unicode accents removed, lower case, apostrophes / dashes /
// simple punctuation turned into spaces, spaces collapsed. Optionally leading
// articles are dropped ("Les Rita Mitsouko" = "Rita Mitsouko").
//
// Typo tolerance (optional, off by default) uses the Levenshtein distance:
//   normalised answer of 6+ characters  -> 1 edit allowed
//   normalised answer of 12+ characters -> 2 edits allowed
//   never more than 2 edits.

const ARTICLES = new Set(['le', 'la', 'les', 'l', 'un', 'une', 'des', 'du', 'de', 'the', 'a', 'an']);

function canon(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’'`´]/g, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function stripArticles(n) {
  const words = n.split(' ');
  while (words.length > 1 && ARTICLES.has(words[0])) words.shift();
  return words.join(' ');
}

/** Levenshtein distance with an early exit once it exceeds `max`. */
function distance(a, b, max = Infinity) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const allowedTypos = (len) => (len >= 12 ? 2 : len >= 6 ? 1 : 0);

/**
 * Judges a typed answer. Returns
 *   { accepted, rule, normalized, matched, ambiguous }
 * rule: 'exact' | 'alias' | 'articles' | 'typo' | null.
 * ambiguous: true when the input is just outside the tolerance (for manual review).
 */
function matchFreeText(input, { answer, aliases = [], ignoreArticles = true, typoTolerance = false } = {}) {
  const normalized = canon(input);
  const out = { accepted: false, rule: null, normalized, matched: null, ambiguous: false };
  if (!normalized) return out;
  const targets = [{ text: answer, rule: 'exact' }, ...aliases.map((a) => ({ text: a, rule: 'alias' }))]
    .map((t) => ({ ...t, n: canon(t.text) })).filter((t) => t.n);
  for (const t of targets) if (t.n === normalized) return { ...out, accepted: true, rule: t.rule, matched: t.text };
  if (ignoreArticles) {
    const ni = stripArticles(normalized);
    for (const t of targets) if (stripArticles(t.n) === ni) return { ...out, accepted: true, rule: 'articles', matched: t.text };
  }
  let best = Infinity; let bestT = null;
  const cmpIn = ignoreArticles ? stripArticles(normalized) : normalized;
  for (const t of targets) {
    const cmpT = ignoreArticles ? stripArticles(t.n) : t.n;
    const d = distance(cmpIn, cmpT, 3);
    if (d < best) { best = d; bestT = { ...t, cmpT }; }
  }
  if (bestT) {
    const allowed = typoTolerance ? allowedTypos(bestT.cmpT.length) : 0;
    if (allowed && best <= allowed) return { ...out, accepted: true, rule: 'typo', matched: bestT.text };
    if (best <= Math.max(allowed, 0) + 1 && bestT.cmpT.length >= 4) out.ambiguous = true;
  }
  return out;
}

module.exports = { canon, stripArticles, distance, allowedTypos, matchFreeText, ARTICLES };
