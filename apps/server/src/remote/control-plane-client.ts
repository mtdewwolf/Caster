import crypto from 'crypto';

import type { EndpointCandidate } from './endpoints';
import {
  canonicalJson,
  getServerIdentity,
  signWithServerIdentity
} from './identity';

export const MIN_HEARTBEAT_INTERVAL_SECONDS = 30;
export const DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 60;
export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BACKOFF_BASE_MS = 1_000;

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }
) => Promise<Response>;

export interface HeartbeatResult {
  ok: boolean;
  status?: number;
  error?: string;
  attempts: number;
  at: string;
}

export interface HeartbeatState {
  enabled: boolean;
  running: boolean;
  controlPlaneUrl: string | null;
  configError: string | null;
  intervalSeconds: number;
  seq: number;
  lastHeartbeatAt: string | null;
  lastHeartbeatResult: HeartbeatResult | null;
}

export interface HeartbeatPayload {
  serverId: string;
  ts: string;
  nonce: string;
  advertisedEndpoints: Array<Pick<EndpointCandidate, 'kind' | 'url' | 'tls'>>;
}

export interface SignedHeartbeat {
  payload: HeartbeatPayload;
  canonicalPayload: string;
  signature: string;
}

export type ControlPlaneStubOutcome = {
  ok: false;
  code: 'NOT_IMPLEMENTED';
  message: string;
};

export interface HeartbeatClientOptions {
  controlPlaneUrl?: string | null;
  intervalSeconds?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  jitterRatio?: number;
  fetchImpl?: FetchLike;
  now?: () => number;
  random?: () => number;
  dataDir?: string;
  getEndpoints?: () => EndpointCandidate[];
}

function parseIntervalSeconds(raw: string | undefined, fallback: number): number {
  const parsed = parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(MIN_HEARTBEAT_INTERVAL_SECONDS, parsed);
}

function normalizeControlPlaneUrl(raw: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { error: 'CASTER_REMOTE_CONTROL_PLANE_URL is not a valid URL' };
  }
  if (url.protocol === 'https:') return { url };
  const loopbackHost = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname.toLowerCase());
  if (url.protocol === 'http:' && loopbackHost) return { url };
  return { error: 'The control plane URL must use HTTPS' };
}

export function verifyHeartbeatSignature(
  publicKeyPem: string,
  canonicalPayload: string,
  signatureBase64Url: string
): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(canonicalPayload, 'utf8'),
      crypto.createPublicKey(publicKeyPem),
      Buffer.from(signatureBase64Url, 'base64url')
    );
  } catch {
    return false;
  }
}

export class HeartbeatClient {
  private readonly controlPlaneUrl: URL | null;
  private readonly configError: string | null;
  private readonly intervalSeconds: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly jitterRatio: number;
  private readonly fetchImpl: FetchLike;
  private readonly nowProvider: () => number;
  private readonly randomProvider: () => number;
  private readonly identityOptions: { dataDir?: string };
  private readonly endpointProvider: () => EndpointCandidate[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private runningState = false;
  private stoppedState = false;
  private seqCounter = 0;
  private lastResult: HeartbeatResult | null = null;
  private lastAt: string | null = null;

  constructor(options: HeartbeatClientOptions = {}) {
    const rawUrl = options.controlPlaneUrl !== undefined
      ? options.controlPlaneUrl
      : process.env.CASTER_REMOTE_CONTROL_PLANE_URL?.trim() || null;
    if (!rawUrl) {
      this.controlPlaneUrl = null;
      this.configError = null;
    } else {
      const normalized = normalizeControlPlaneUrl(rawUrl);
      if ('url' in normalized) {
        this.controlPlaneUrl = normalized.url;
        this.configError = null;
      } else {
        this.controlPlaneUrl = null;
        this.configError = normalized.error;
      }
    }
    this.intervalSeconds = parseIntervalSeconds(
      options.intervalSeconds?.toString() ?? process.env.CASTER_HEARTBEAT_INTERVAL_SECONDS,
      DEFAULT_HEARTBEAT_INTERVAL_SECONDS
    );
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.backoffBaseMs = Math.max(0, options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS);
    this.jitterRatio = Math.min(0.9, Math.max(0, options.jitterRatio ?? 0.2));
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.nowProvider = options.now ?? Date.now;
    this.randomProvider = options.random ?? Math.random;
    this.identityOptions = options.dataDir !== undefined ? { dataDir: options.dataDir } : {};
    this.endpointProvider = options.getEndpoints ?? (() => []);
  }

  get enabled(): boolean {
    return this.controlPlaneUrl !== null;
  }

  get running(): boolean {
    return this.runningState;
  }

  get disabledByStop(): boolean {
    return this.stoppedState;
  }

  getState(): HeartbeatState {
    return {
      enabled: this.enabled && !this.stoppedState,
      running: this.runningState,
      controlPlaneUrl: this.controlPlaneUrl?.toString() ?? null,
      configError: this.configError,
      intervalSeconds: this.intervalSeconds,
      seq: this.seqCounter,
      lastHeartbeatAt: this.lastAt,
      lastHeartbeatResult: this.lastResult
    };
  }

  buildSignedHeartbeat(): SignedHeartbeat {
    const identity = getServerIdentity(this.identityOptions);
    const payload: HeartbeatPayload = {
      serverId: identity.serverId,
      ts: new Date(this.nowProvider()).toISOString(),
      nonce: crypto.randomBytes(16).toString('base64url'),
      advertisedEndpoints: this.endpointProvider().map(({ kind, url, tls }) => ({ kind, url, tls }))
    };
    const canonicalPayload = canonicalJson(payload);
    return {
      payload,
      canonicalPayload,
      signature: signWithServerIdentity(canonicalPayload, this.identityOptions)
    };
  }

  async sendHeartbeat(): Promise<HeartbeatResult> {
    if (!this.controlPlaneUrl) {
      const result: HeartbeatResult = {
        ok: false,
        error: 'Remote control plane is not configured',
        attempts: 0,
        at: new Date(this.nowProvider()).toISOString()
      };
      this.lastResult = result;
      this.lastAt = result.at;
      return result;
    }

    const signed = this.buildSignedHeartbeat();
    const body = JSON.stringify({ payload: signed.canonicalPayload, signature: signed.signature });
    const url = `${this.controlPlaneUrl.toString().replace(/\/$/, '')}/servers/heartbeat`;
    let lastError = 'unknown failure';
    let lastStatus: number | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body
        });
        lastStatus = response.status;
        if (response.ok) {
          lastError = undefined;
          const result: HeartbeatResult = {
            ok: true,
            status: response.status,
            attempts: attempt,
            at: new Date(this.nowProvider()).toISOString()
          };
          this.seqCounter += 1;
          this.lastResult = result;
          this.lastAt = result.at;
          return result;
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < this.maxAttempts) await this.sleep(this.delayForAttempt(attempt));
    }

    const result: HeartbeatResult = {
      ok: false,
      ...(lastStatus !== undefined ? { status: lastStatus } : {}),
      error: lastError,
      attempts: this.maxAttempts,
      at: new Date(this.nowProvider()).toISOString()
    };
    this.lastResult = result;
    this.lastAt = result.at;
    return result;
  }

  private delayForAttempt(attempt: number): number {
    const exponential = this.backoffBaseMs * 2 ** (attempt - 1);
    const jitter = exponential * this.jitterRatio * this.randomProvider();
    return Math.round(exponential + jitter);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  start(): boolean {
    if (!this.enabled || this.runningState || this.stoppedState) return this.runningState;
    this.runningState = true;
    void this.beat();
    return true;
  }

  private async beat(): Promise<void> {
    if (!this.runningState) return;
    await this.sendHeartbeat();
    if (!this.runningState) return;
    this.timer = setTimeout(() => void this.beat(), this.intervalSeconds * 1000);
    this.timer.unref?.();
  }

  stop(): void {
    this.runningState = false;
    this.stoppedState = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  resume(): boolean {
    if (!this.enabled) return false;
    this.stoppedState = false;
    if (this.runningState) return true;
    this.runningState = true;
    void this.beat();
    return true;
  }

  async enroll(): Promise<ControlPlaneStubOutcome> {
    return stubOutcome('enroll');
  }

  async revoke(): Promise<ControlPlaneStubOutcome> {
    return stubOutcome('revoke');
  }

  async lookup(): Promise<ControlPlaneStubOutcome> {
    return stubOutcome('lookup');
  }
}

function stubOutcome(operation: string): ControlPlaneStubOutcome {
  return {
    ok: false,
    code: 'NOT_IMPLEMENTED',
    message: `The hosted control plane does not implement ${operation} yet`
  };
}
