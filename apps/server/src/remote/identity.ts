import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

export interface ServerIdentity {
  serverId: string;
  publicKeyPem: string;
  createdAt: string;
}

interface StoredServerIdentity extends ServerIdentity {
  version: 1;
  privateKeyPem: string;
}

export interface IdentityOptions {
  dataDir?: string;
}

const IDENTITY_FILE_VERSION = 1;
const SERVER_ID_PREFIX = 'srv_';
const identityCache = new Map<string, StoredServerIdentity>();

export function defaultRemoteDataDir(): string {
  return process.env.MEDIA_DATA_DIR || path.join(process.cwd(), 'data');
}

export function remoteIdentityDir(options: IdentityOptions = {}): string {
  return path.join(options.dataDir ?? defaultRemoteDataDir(), 'remote');
}

export function remoteIdentityFilePath(options: IdentityOptions = {}): string {
  return path.join(remoteIdentityDir(options), 'server-identity.json');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

export function deriveServerId(publicKeyPem: string): string {
  const digest = crypto.createHash('sha256').update(publicKeyPem).digest('hex');
  return `${SERVER_ID_PREFIX}${digest.slice(0, 40)}`;
}

function generateStoredIdentity(): StoredServerIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    version: IDENTITY_FILE_VERSION,
    serverId: deriveServerId(publicKey.export({ type: 'spki', format: 'pem' }).toString()),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdAt: new Date().toISOString()
  };
}

function isValidStoredIdentity(value: unknown): value is StoredServerIdentity {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredServerIdentity>;
  if (candidate.version !== IDENTITY_FILE_VERSION) return false;
  if (typeof candidate.privateKeyPem !== 'string' || !candidate.privateKeyPem.includes('PRIVATE KEY')) {
    return false;
  }
  if (typeof candidate.publicKeyPem !== 'string' || !candidate.publicKeyPem.includes('PUBLIC KEY')) {
    return false;
  }
  return typeof candidate.serverId === 'string' &&
    candidate.serverId.startsWith(SERVER_ID_PREFIX) &&
    typeof candidate.createdAt === 'string';
}

function persistIdentity(filePath: string, identity: StoredServerIdentity): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(identity, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // File permission semantics are best-effort across platforms.
  }
}

export function loadServerIdentity(options: IdentityOptions = {}): ServerIdentity {
  const filePath = remoteIdentityFilePath(options);
  if (!fs.existsSync(filePath)) {
    const identity = generateStoredIdentity();
    persistIdentity(filePath, identity);
    identityCache.set(filePath, identity);
    return publicIdentity(identity);
  }

  let stored: unknown;
  try {
    stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    stored = null;
  }
  if (!isValidStoredIdentity(stored)) {
    fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    const identity = generateStoredIdentity();
    persistIdentity(filePath, identity);
    identityCache.set(filePath, identity);
    return publicIdentity(identity);
  }

  try {
    crypto.createPrivateKey(stored.privateKeyPem);
  } catch {
    fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    const identity = generateStoredIdentity();
    persistIdentity(filePath, identity);
    identityCache.set(filePath, identity);
    return publicIdentity(identity);
  }

  identityCache.set(filePath, stored);
  return publicIdentity(stored);
}

function publicIdentity(identity: StoredServerIdentity): ServerIdentity {
  return {
    serverId: identity.serverId,
    publicKeyPem: identity.publicKeyPem,
    createdAt: identity.createdAt
  };
}

export function getServerIdentity(options: IdentityOptions = {}): ServerIdentity {
  const filePath = remoteIdentityFilePath(options);
  const cached = identityCache.get(filePath);
  if (cached) return publicIdentity(cached);
  return loadServerIdentity(options);
}

export function readStoredIdentity(options: IdentityOptions = {}): StoredServerIdentity {
  const filePath = remoteIdentityFilePath(options);
  getServerIdentity(options);
  return identityCache.get(filePath)!;
}

export function readStoredPrivateKey(options: IdentityOptions = {}): crypto.KeyObject {
  return crypto.createPrivateKey(readStoredIdentity(options).privateKeyPem);
}

export function signWithServerIdentity(payload: string, options: IdentityOptions = {}): string {
  return crypto.sign(null, Buffer.from(payload, 'utf8'), readStoredPrivateKey(options))
    .toString('base64url');
}

export function verifyWithPublicKey(
  publicKeyPem: string,
  payload: string,
  signatureBase64Url: string
): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(payload, 'utf8'),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(signatureBase64Url, 'base64url')
    );
  } catch {
    return false;
  }
}
