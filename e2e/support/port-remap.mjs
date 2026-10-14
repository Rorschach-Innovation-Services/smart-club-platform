/**
 * TEST-ONLY Node preload (`NODE_OPTIONS=--import <this file>`): remaps the local stack's FIXED
 * ports so a second, isolated stack (and its Playwright run) can coexist with one already bound
 * on the defaults. Used by playwright.altports.config.ts; nothing in production loads it.
 *
 *   3333 (API) → 3433    3201 (vite) → 3301    4567 (dynalite) → 4767    4799 (stub medicoach) → 4899
 *
 * Every Node process that inherits NODE_OPTIONS (concurrently → npm → tsx → the API; vite; the
 * Playwright runner and its workers) has BOTH sides remapped: server.listen(...) and outbound
 * socket connects to a loopback host. The browser is not Node — it is pointed at the new ports
 * by the config (baseURL) and VITE_API_URL.
 */
import net from 'node:net';

const MAP = new Map([
  [3333, 3433],
  [3201, 3301],
  [4567, 4767],
  [4799, 4899],
]);
const LOOPBACK = new Set([undefined, null, '', 'localhost', '127.0.0.1', '::1', '0.0.0.0', '::']);
const remap = (p) => {
  const to = MAP.get(Number(p));
  return to === undefined ? p : typeof p === 'string' ? String(to) : to;
};

const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function (...args) {
  const a = args[0];
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) args[0] = remap(a);
  else if (a && typeof a === 'object' && !Array.isArray(a) && a.port !== undefined)
    args[0] = { ...a, port: remap(a.port) };
  return listen.apply(this, args);
};

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = args[0];
  // net.connect() hands Socket#connect a normalized [options, cb] array (tagged with an internal
  // symbol on the ARRAY) — swap in a remapped COPY of its options. Never mutate the options
  // object itself: http.Agent re-derives its pool name from that same object when the socket is
  // freed, so an in-place port change strands keep-alive sockets under a different pool name and
  // the agent eventually stops handing out sockets (every request then hangs).
  const opts = Array.isArray(a) ? a[0] : a && typeof a === 'object' ? a : null;
  if (opts && opts.port !== undefined && LOOPBACK.has(opts.host) && MAP.has(Number(opts.port))) {
    const copy = { ...opts, port: remap(opts.port) };
    if (Array.isArray(a)) a[0] = copy;
    else args[0] = copy;
  } else if (!opts && (typeof a === 'number' || typeof a === 'string') && LOOPBACK.has(args[1]))
    args[0] = remap(a);
  return connect.apply(this, args);
};

globalThis.__SMART_CLUB_PORT_REMAP__ = true;
