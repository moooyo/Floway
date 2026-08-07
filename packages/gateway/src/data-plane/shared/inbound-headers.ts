import type { Context } from 'hono';

import type { InboundHeaderMatcher, Provider } from '@floway-dev/provider';

export const inboundHeaders = (c: Context): Headers => new Headers(c.req.raw.headers);

// Whether the headers taken from a request context describe the turn being
// dispatched. `turn` is the ordinary case: one HTTP request, one turn.
// `connection` means the headers came from a request that opened a connection
// which then carried this turn and will carry more — the Responses WebSocket
// upgrade — so anything a provider would read as a property of the turn is
// stale for every turn after the first.
export type InboundHeadersScope = 'turn' | 'connection';

const regexpMatches = (regexp: RegExp, value: string): boolean =>
  new RegExp(regexp.source, regexp.flags).test(value);

const matchesAny = (allowlist: readonly InboundHeaderMatcher[], normalizedName: string): boolean => {
  for (const entry of allowlist) {
    if (typeof entry === 'string') {
      if (entry.toLowerCase() === normalizedName) return true;
      continue;
    }
    if (regexpMatches(entry, normalizedName)) return true;
  }
  return false;
};

export const filterInboundHeaders = (
  headers: Headers,
  allowlist: readonly InboundHeaderMatcher[],
  withheld: readonly InboundHeaderMatcher[] = [],
): Headers => {
  const filtered = new Headers();
  for (const [name, value] of headers) {
    const normalizedName = name.toLowerCase();
    if (!matchesAny(allowlist, normalizedName)) continue;
    if (matchesAny(withheld, normalizedName)) continue;
    filtered.append(name, value);
  }
  return filtered;
};

// Connection-scoped headers are handed to the provider with its turn-scoped
// names withheld. Withholding is what makes the provider fall back to a
// per-turn surface — the frame's own body — instead of reading a value frozen
// at the handshake. Turn-scoped headers pass through the allowlist alone.
export const filterInboundHeadersForProvider = (
  headers: Headers,
  provider: Provider,
  scope: InboundHeadersScope = 'turn',
): Headers => filterInboundHeaders(
  headers,
  provider.inboundHeaderAllowlist,
  scope === 'connection' ? provider.turnScopedInboundHeaders : [],
);
