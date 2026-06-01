/** Domain types shared across the API. Mirrors the frontend's data shapes. */

export type Role = 'admin' | 'rep';

export interface Membership {
  tenantId: string;
  role: Role;
  /** Clubs a rep is scoped to. Ignored for admins (who see the whole tenant). */
  clubIds: string[];
}

export interface UserProfile {
  sub: string;
  email: string;
  memberships: Membership[];
  onboardingSeen: Record<string, boolean>;
}

export interface TenantConfig {
  tenant: string;
  branding: {
    name: string;
    /** Human title for <title> and headers, e.g. "Dolphins Pipeline". */
    title: string;
    logoUrl: string;
    /** CSS color tokens injected at the edge, e.g. { '--navy': '#1B2A4A' }. */
    colors: Record<string, string>;
    /** Org copy strings keyed by slot (welcome, eyebrow, office, footer, support). */
    copy: Record<string, string>;
  };
  submissionDeadline: string;
  knownClubs: unknown[];
  /** Optional per-tenant required-docs override; falls back to shared default. */
  requiredDocs?: unknown[];
}

/** Stored club record. Catalogue-derived fields stay client-side. */
export interface Club {
  id: string;
  name: string;
  district: string;
  sub: string;
  chair: string;
  affiliation: 'not_started' | 'in_progress' | 'complete';
  paid: boolean;
  cqi: number;
  cqiAnswers?: Record<string, unknown>;
  docs: Record<string, boolean>;
  /** Per-doc upload metadata (objectKey, size, uploadedAt), keyed by doc key. */
  docMeta?: Record<string, unknown>;
  /** Surfaced as `players` on read; derived from registrations. */
  players: number;
  /** Denormalized registration count, bumped atomically on each registration. */
  playerCount?: number;
  teams: number;
  women: number;
  juniors: number;
  color: string;
  ground: {
    venue?: string;
    address?: string;
    suburb?: string;
    lat?: number;
    lon?: number;
  };
  leagues: string[];
  exco?: Record<string, unknown>;
  coaches?: unknown[];
  playerRegLink?: { token: string; createdAt: string };
  onboardedAt?: string;
  /** Optimistic-concurrency version + audit trail. */
  version: number;
  changedBy?: string;
  changedAt?: string;
}

export interface Series {
  id: string;
  name: string;
  startDate: string;
  teams: string[];
  fixtures: unknown[];
  released: boolean;
  releasedAt: string | null;
  version: number;
  [key: string]: unknown;
}

export interface PlayerRegistration {
  naturalKey: string;
  clubId: string;
  firstName: string;
  lastName: string;
  dob: string;
  cell?: string;
  email?: string;
  isMinor: boolean;
  guardianName?: string;
  consentAt: string;
  createdAt: string;
}
