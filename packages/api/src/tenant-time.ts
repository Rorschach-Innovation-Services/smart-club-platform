/**
 * The union's wall-clock offset from UTC (SAST, +02:00).
 *
 * Lambda runs in UTC, so anything that asks "what day is it" on behalf of a human here
 * has to add this or it stays on yesterday until 02:00 local. The region has no DST, so
 * a fixed offset is exact rather than an approximation — see ADR 0008 on why times are
 * wall-clock and never converted. Shared by the API routes and the certificate renderer.
 */
export const TENANT_UTC_OFFSET_MINUTES = 120;
