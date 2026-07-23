/**
 * Naming utilities inlined from `@workos/oagen` (`src/utils/naming.ts`), same
 * as the types in `./types.ts`: the published `dist/policy.mjs` must have zero
 * runtime imports from `@workos/oagen`, because a runtime dependency on oagen
 * drags its native tree-sitter toolchain into every consumer's install (see
 * workos/cli#202). Keep in sync with the upstream definitions.
 */

/**
 * Known compound tokens that the regex-based splitter over-splits.
 * Each entry is [lowercase-word-sequence, canonical-form].
 * Sorted longest-first so greedy matching works correctly.
 */
const COMPOUND_WORDS: [string[], string][] = [
  [['m', '2', 'm'], 'M2M'],
  [['o', 'auth'], 'OAuth'],
];

/**
 * Recombine adjacent words that form a known compound token.
 */
function recombineCompounds(words: string[]): string[] {
  const result: string[] = [];
  let i = 0;
  while (i < words.length) {
    let matched = false;
    for (const [pattern, canonical] of COMPOUND_WORDS) {
      if (i + pattern.length <= words.length) {
        const matches = pattern.every((p, j) => words[i + j].toLowerCase() === p);
        if (matches) {
          result.push(canonical);
          i += pattern.length;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      result.push(words[i]);
      i++;
    }
  }
  return result;
}

/**
 * Split a string into words, handling:
 * - camelCase / PascalCase boundaries
 * - snake_case / kebab-case separators
 * - Consecutive capitals (e.g., "HTTPClient" → ["HTTP", "Client"])
 * - Numbers as word boundaries (e.g., "OAuth2Token" → ["OAuth", "2", "Token"])
 * - Known compounds are recombined (e.g., "M2M" stays as one word)
 */
function splitWords(s: string): string[] {
  if (!s) return [];

  const words = s
    .replace(/[^a-zA-Z0-9_\-\s.]/g, '_') // replace non-alphanumeric chars with separator
    .replace(/([a-z])([A-Z])/g, '$1\0$2') // camelCase boundary
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1\0$2') // consecutive caps boundary
    .replace(/([a-zA-Z])(\d)/g, '$1\0$2') // letter to number
    .replace(/(\d)([a-zA-Z])/g, '$1\0$2') // number to letter
    .split(/[\0_\-\s.]+/)
    .filter((w) => w.length > 0);

  return recombineCompounds(words);
}

const ACRONYM_SET = new Set(['SSO', 'FGA', 'SAML', 'SCIM', 'JWT', 'HMAC', 'M2M']);

export function toCamelCase(s: string, acronyms?: Set<string>): string {
  const merged = acronyms ? new Set([...ACRONYM_SET, ...acronyms]) : ACRONYM_SET;
  const words = splitWords(s);
  if (words.length === 0) return '';
  return words
    .map((w, i) => {
      if (i === 0) return w.toLowerCase();
      const upper = w.toUpperCase();
      if (merged.has(upper)) return upper;
      if (upper === 'OAUTH') return 'OAuth';
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join('');
}
