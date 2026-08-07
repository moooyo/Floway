import { serverSecretBytes } from '../../../../shared/server-secret.ts';
import { appendOpaqueTrailer, concatBytes, decodeOpaqueValue, encodeOpaqueValue, MAX_OPAQUE_TRAILER_BYTES, splitOpaqueTrailer, uint16be, type AliasRules, type OpaqueValueOrigin } from '@floway-dev/protocols/common';

export interface AffinityTarget {
  upstreamId: string;
  modelId: string;
  rules?: AliasRules;
}

interface AffinityData {
  version: 1;
  origin?: OpaqueValueOrigin;
  syntheticItem?: true;
  affinity: AffinityTarget;
}

export type DecodedAffinityBlob =
  | { kind: 'foreign'; value: string }
  | ({ kind: 'owned'; value?: string } & AffinityData);

const IV_BYTES = 12;
const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const hasOnlyKeys = (value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(value).every(key => allowed.has(key));

const AFFINITY_DATA_KEYS = new Set(['version', 'origin', 'syntheticItem', 'affinity']);
const AFFINITY_TARGET_KEYS = new Set(['upstreamId', 'modelId', 'rules']);

const parseAffinityData = (value: unknown): AffinityData | null => {
  if (
    !isRecord(value)
    || !hasOnlyKeys(value, AFFINITY_DATA_KEYS)
    || value.version !== 1
    || !isRecord(value.affinity)
    || !hasOnlyKeys(value.affinity, AFFINITY_TARGET_KEYS)
  ) return null;
  const origin = value.origin;
  if (origin !== undefined && origin !== 'raw' && origin !== 'base64' && origin !== 'base64url') return null;
  const syntheticItem = value.syntheticItem;
  if (
    (syntheticItem !== undefined && syntheticItem !== true)
    || (syntheticItem === true && origin !== undefined)
  ) return null;

  const affinity = value.affinity;
  if (
    typeof affinity.upstreamId !== 'string'
    || typeof affinity.modelId !== 'string'
    || (affinity.rules !== undefined && !isRecord(affinity.rules))
  ) return null;

  const parsedAffinity: AffinityTarget = {
    upstreamId: affinity.upstreamId,
    modelId: affinity.modelId,
    ...(affinity.rules !== undefined ? { rules: affinity.rules as AliasRules } : {}),
  };
  return {
    version: 1,
    ...(origin !== undefined ? { origin } : {}),
    ...(syntheticItem === true ? { syntheticItem: true } : {}),
    affinity: parsedAffinity,
  };
};

const ownedBuffer = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;

const deriveAffinityKey = async (serverSecret: Uint8Array): Promise<CryptoKey> => {
  const root = await crypto.subtle.importKey(
    'raw',
    ownedBuffer(serverSecret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: ownedBuffer(textEncoder.encode('Floway server secret v1')),
      info: ownedBuffer(textEncoder.encode('client-carried affinity v1')),
    },
    root,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
};

const authenticatedCarrierData = (domain: string, original: Uint8Array): Uint8Array => {
  const domainBytes = textEncoder.encode(domain);
  if (domainBytes.length > MAX_OPAQUE_TRAILER_BYTES) throw new RangeError('Affinity carrier domain exceeds the 2-byte length marker');
  return concatBytes(uint16be(domainBytes.length), domainBytes, original);
};

// Why a carrier failed to open, for the operator-facing report only. Callers
// still receive the same `foreign` verdict for every one of these.
type UnopenableCarrierReason =
  // AES-GCM rejected the trailer. The likely causes are a carrier issued under
  // a different server secret and a carrier read back at a different domain
  // than it was wrapped at.
  | 'authentication'
  // The trailer authenticated, but its plaintext is not affinity data this
  // build understands.
  | 'plaintext-shape'
  // The trailer authenticated and claims to carry no original value, yet the
  // frame holds original bytes.
  | 'plaintext-origin';

// Floway forwards a carrier it cannot open to the upstream verbatim, trailer
// and all. That pass-through is deliberate and must stay: a carrier this
// instance cannot open may belong to another Floway it is chained behind, and
// stripping the trailer would corrupt that carrier instead of repairing it.
//
// The cost is that one of this gateway's own carriers going bad is
// indistinguishable, on every operator surface, from an ordinary foreign
// value. The upstream rejects a blob it cannot parse, and nothing here records
// why: dumps capture response frames before affinity wrapping, and no dump
// record holds the upstream request at all. `splitOpaqueTrailer` succeeding is
// the signal that separates the two cases, so report it rather than discard it.
//
// `authentication` still admits a false positive, because a value this gateway
// never wrapped can decode as base64 and happen to end in a plausible two-byte
// length marker. The two `plaintext-*` reasons cannot: AES-GCM already
// authenticated the trailer under this instance's key before either is
// reachable, so those carriers are provably this gateway's own.
const reportUnopenableCarrier = (
  domain: string,
  reason: UnopenableCarrierReason,
  valueLength: number,
): void => {
  console.warn(
    'Floway affinity carrier could not be opened and is being forwarded upstream unchanged '
    + `(reason=${reason}, domain=${domain}, chars=${valueLength}). `
    + `A plaintext-* reason means the carrier is provably this gateway's own.`,
  );
};

export class AffinityCodec {
  readonly #key: Promise<CryptoKey>;

  constructor(serverSecret: string) {
    this.#key = deriveAffinityKey(serverSecretBytes(serverSecret));
  }

  async wrap(
    value: string | undefined,
    affinity: AffinityTarget,
    domain: string,
    options: { readonly syntheticItem?: true } = {},
  ): Promise<string> {
    if (options.syntheticItem === true && value !== undefined) {
      throw new TypeError('A synthetic affinity item cannot carry an original value');
    }
    const original = value === undefined ? undefined : decodeOpaqueValue(value);
    const originalBytes = original?.bytes ?? new Uint8Array();
    const data: AffinityData = {
      version: 1,
      ...(original !== undefined ? { origin: original.origin } : {}),
      ...(options.syntheticItem === true ? { syntheticItem: true } : {}),
      affinity,
    };
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: ownedBuffer(authenticatedCarrierData(domain, originalBytes)) },
      await this.#key,
      textEncoder.encode(JSON.stringify(data)),
    ));
    const encrypted = concatBytes(iv, ciphertext);
    if (encrypted.length > MAX_OPAQUE_TRAILER_BYTES) throw new RangeError('Encrypted affinity data exceeds the 2-byte length marker');
    return appendOpaqueTrailer(original, encrypted);
  }

  async unwrap(value: string, domain: string): Promise<DecodedAffinityBlob> {
    const framed = splitOpaqueTrailer(value, IV_BYTES + 16);
    // No trailer framing at all, so this gateway never wrapped the value. That
    // is the ordinary case — a blob minted by the upstream, or by a gateway
    // this one sits behind — and the only exit that stays silent.
    if (framed === null) return { kind: 'foreign', value };

    const encrypted = framed.trailer;
    const original = framed.original;
    const iv = encrypted.subarray(0, IV_BYTES);
    const ciphertext = encrypted.subarray(IV_BYTES);
    const key = await this.#key;
    const additionalData = ownedBuffer(authenticatedCarrierData(domain, original));
    try {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: ownedBuffer(iv), additionalData },
        key,
        ownedBuffer(ciphertext),
      );
      const data = parseAffinityData(JSON.parse(fatalTextDecoder.decode(plaintext)) as unknown);
      if (data === null) return this.#unopenable(value, domain, 'plaintext-shape');
      if (data.origin === undefined) {
        return original.length === 0
          ? { kind: 'owned', ...data }
          : this.#unopenable(value, domain, 'plaintext-origin');
      }
      return { kind: 'owned', value: encodeOpaqueValue(original, data.origin), ...data };
    } catch {
      return this.#unopenable(value, domain, 'authentication');
    }
  }

  // The value carried this gateway's own trailer framing and still could not be
  // opened. Callers get the same `foreign` verdict they already act on — the
  // wire behaviour is unchanged on purpose — but the occurrence is reported so
  // the failure stops being invisible.
  #unopenable(value: string, domain: string, reason: UnopenableCarrierReason): DecodedAffinityBlob {
    reportUnopenableCarrier(domain, reason, value.length);
    return { kind: 'foreign', value };
  }
}
