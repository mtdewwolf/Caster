export {
  canonicalJson,
  deriveServerId,
  getServerIdentity,
  loadServerIdentity,
  remoteIdentityFilePath,
  signWithServerIdentity,
  verifyWithPublicKey
} from './identity';
export type { ServerIdentity } from './identity';

export {
  collectEndpointCandidates
} from './endpoints';
export type { EndpointCandidate, EndpointKind } from './endpoints';

export {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
  DEFAULT_MAX_ATTEMPTS,
  HeartbeatClient,
  MIN_HEARTBEAT_INTERVAL_SECONDS,
  verifyHeartbeatSignature
} from './control-plane-client';
export type {
  ControlPlaneStubOutcome,
  FetchLike,
  HeartbeatClientOptions,
  HeartbeatPayload,
  HeartbeatResult,
  HeartbeatState,
  SignedHeartbeat
} from './control-plane-client';

export const REMOTE_ACCESS_MIGRATION = {
  version: 15,
  name: 'remote_access_control_plane',
  statements: [
    `CREATE TABLE remote_registration (
      singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
      server_id TEXT NOT NULL UNIQUE,
      control_plane_url TEXT,
      enrolled_at TEXT,
      disabled_at TEXT,
      join_name TEXT UNIQUE,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE remote_heartbeat_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      seq INTEGER NOT NULL,
      attempted_at TEXT NOT NULL,
      ok INTEGER NOT NULL CHECK(ok IN (0, 1)),
      status_code INTEGER,
      error TEXT
    )`,
    `CREATE INDEX idx_remote_heartbeat_log_attempted_at
      ON remote_heartbeat_log(attempted_at DESC)`
  ]
} as const;
