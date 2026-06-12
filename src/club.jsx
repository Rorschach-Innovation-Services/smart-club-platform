/* ─── Club-side views ─── */

import {
  useState as useStateC,
  useMemo as useMemoC,
  useEffect as useEffectC,
  useRef as useRefC,
} from 'react';
import { createPortal } from 'react-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  DISTRICTS,
  COACHING_BODIES,
  COACHING_LEVELS,
  greeting,
  REQUIRED_DOCS,
  CQI_STRUCTURE,
  docFileMeta,
  DOC_ACCEPT,
  resolveDocMime,
  isAllowedDocMime,
  extFromMime,
  safeguardingMeta,
  MIN_SAFEGUARDING_FILES,
  docCompletion,
  docsUploadedCount,
  overallProgress,
  affiliationSubmitted,
  fixtureCost,
  formatDeadlineLong,
  formatDeadlineShort,
  daysUntil,
  BATTING_TYPES,
  BOWLER_TYPES,
  HANDS,
  RACES,
  GENDERS,
  dobFromSaId,
  clearanceOverdue,
  clearanceDaysRemaining,
} from './data.jsx';
import { leagueOptionsForDistrict, findByKey, labelByKey, teamCounts } from './leagues.js';
import { shortAddress, suburbOf, SA_BOUNDS, isInSouthAfrica } from './geocode.js';
import {
  Icon,
  Pill,
  Btn,
  Card,
  KPI,
  ClubNameCell,
  YN,
  Choice,
  MoneyInput,
  NumSlider,
  CountUp,
  cqiBand,
  scoreCQI,
} from './atoms.jsx';
import { getDocUploadUrl, uploadToPresigned } from './api.js';
import { DocPreviewModal } from './DocPreviewModal.jsx';

/* ─── Compliance doc upload — presigned S3 PUT, then mark uploaded ─── */
function DocUploadButton({
  clubId,
  docKey,
  label,
  onUploaded,
  toast,
  variant = 'button',
  buttonLabel,
}) {
  const inputRef = useRefC(null);
  const [busy, setBusy] = useStateC(false);
  const isReplace = variant === 'link';
  async function handleFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    // file.type is often empty for .doc/.docx — resolve from the extension before
    // validating, or valid Word files get rejected / mislabelled as PDF.
    const mime = resolveDocMime(file);
    if (!isAllowedDocMime(mime)) {
      toast('PDF or Word documents only', 'warn');
      if (inputRef.current) inputRef.current.value = '';
      return;
    }
    setBusy(true);
    try {
      if (import.meta.env.VITE_LOCAL_AUTH === '1') {
        // Local dev: no S3 — record the doc metadata without an actual upload.
        // The key must be unique per file: safeguarding stores several entries,
        // and a constant key would make every upload dedupe into the first.
        await onUploaded(docKey, {
          objectKey: `local/${docKey}-${crypto.randomUUID()}.${extFromMime(mime)}`,
          size: file.size,
          contentType: mime,
        });
      } else {
        // Use the server-echoed contentType for the PUT — it must match the
        // presigned ContentType exactly or S3 rejects the upload.
        const { uploadUrl, objectKey, contentType } = await getDocUploadUrl(clubId, docKey, mime);
        await uploadToPresigned(uploadUrl, file, contentType);
        await onUploaded(docKey, { objectKey, size: file.size, contentType });
      }
      // onUploaded rejects if the server-side record failed, so this only fires on
      // real success (and the failure toast is surfaced by the caller's withToast).
      toast(`${label} ${isReplace ? 'replaced' : 'uploaded'}`);
    } catch (err) {
      // The mark-uploaded step toasts its own error (err.alreadyToasted); only the
      // presigned-upload steps (getDocUploadUrl / uploadToPresigned) need surfacing here.
      if (err && !err.alreadyToasted) toast(err.message || 'Upload failed', 'warn');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  }
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={DOC_ACCEPT}
        style={{ display: 'none' }}
        onChange={handleFile}
      />
      {isReplace ? (
        <button
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => inputRef.current?.click()}
          style={{
            background: 'none',
            border: 'none',
            padding: 0,
            font: 'inherit',
            color: 'var(--teal-deep)',
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy ? 'Replacing…' : buttonLabel || 'Replace'}
        </button>
      ) : (
        <Btn tone="ink" size="sm" icon={Icon.Upload} onClick={() => inputRef.current?.click()}>
          {busy ? 'Uploading…' : buttonLabel || 'Upload'}
        </Btn>
      )}
    </>
  );
}

/* ─── Ground map (Leaflet + OpenStreetMap + Nominatim geocoding) ─── */

export function GroundMap({ query, coords: savedPin, onResolved, onAddressPicked }) {
  const elRef = useRefC(null);
  const mapRef = useRefC(null);
  const markerRef = useRefC(null);
  // A persisted pin is only restorable when it carries finite coords INSIDE South
  // Africa. A truthy-but-malformed pin would feed undefined into setView/placeMarker
  // and make the coords badge's `.toFixed` throw; an out-of-SA pin (saved before the
  // SA lock existed) would restore a maxBounds-clamped view with the marker off-screen.
  // Either way → fall through to forward-geocode.
  const validPin = savedPin && isInSouthAfrica(savedPin.lat, savedPin.lon) ? savedPin : null;
  const [coords, setCoords] = useStateC(validPin);
  // True only when we mounted with a valid saved pin. Used once to skip the mount-time
  // forward-geocode so a remount (e.g. returning to step 1) restores the dropped pin
  // instead of re-geocoding `query` and clobbering it. Re-arms on each fresh mount.
  const hydratedRef = useRefC(Boolean(validPin));
  const [loading, setLoading] = useStateC(false);
  const [notFound, setNotFound] = useStateC(false); // geocode returned no result
  const [loadError, setLoadError] = useStateC(false); // request itself failed (network / rate-limit)

  // Latest parent callbacks, kept in refs so the mount-once click handler and
  // the captured reverseGeocode never close over a stale version.
  const onResolvedRef = useRefC(onResolved);
  const onAddressRef = useRefC(onAddressPicked);
  // Intentionally NO dependency array — this must run on every render to keep the
  // refs current. Do not add `[]`: that would reintroduce the stale-closure bug
  // the refs exist to prevent.
  useEffectC(() => {
    onResolvedRef.current = onResolved;
    onAddressRef.current = onAddressPicked;
  });

  // Monotonic request token shared by BOTH the forward (query) and reverse
  // (click) paths so the most recent interaction always wins, no matter which
  // request resolves last. Reverse requests are also abortable + debounced.
  const reqRef = useRefC(0);
  const reverseCtrlRef = useRefC(null);
  const reverseTimerRef = useRefC(null);

  // Drop / move the single ground marker. Popup is opt-in (forward-geocode
  // shows the resolved place name; clicks stay quiet — coords + field report it).
  function placeMarker(lat, lon, label) {
    if (!mapRef.current || !L) return;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (markerRef.current) markerRef.current.remove();
    const icon = L.divIcon({
      className: '',
      html: '<div class="ground-marker"></div>',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
    });
    markerRef.current = L.marker([lat, lon], { icon }).addTo(mapRef.current);
    if (label) markerRef.current.bindPopup(`<strong>${label}</strong>`).openPopup();
  }

  // Map click → drop the pin and store coords *immediately* for instant feedback,
  // then debounce the reverse-geocode lookup so a burst of clicks coalesces into
  // a single Nominatim request (their usage policy caps at ~1 req/s).
  function handleMapClick(lat, lon) {
    if (!mapRef.current || !L) return;
    // maxBounds keeps the viewport over SA, but its half-degree padding strip is
    // still clickable — silently ignore those points rather than pin them.
    if (!isInSouthAfrica(lat, lon)) return;
    const id = ++reqRef.current; // this click is now the latest interaction
    setNotFound(false);
    setLoadError(false);
    setLoading(true);
    placeMarker(lat, lon);
    setCoords({ lat, lon, name: null });
    onResolvedRef.current?.({ lat, lon });
    if (reverseTimerRef.current) clearTimeout(reverseTimerRef.current);
    reverseTimerRef.current = setTimeout(() => reverseGeocode(lat, lon, id), 600);
  }

  // Reverse-geocode the clicked point → prefill the address. `id` is the token
  // taken when the click happened, so a later interaction discards this result.
  function reverseGeocode(lat, lon, id) {
    if (id !== reqRef.current || !mapRef.current || !L) return;
    if (reverseCtrlRef.current) reverseCtrlRef.current.abort();
    const ctrl = new AbortController();
    reverseCtrlRef.current = ctrl;
    fetch(
      `https://nominatim.openstreetmap.org/reverse?format=json&addressdetails=1&lat=${lat}&lon=${lon}`,
      { signal: ctrl.signal, headers: { 'Accept-Language': 'en' } },
    )
      .then((r) => {
        if (!r.ok) throw new Error(`Nominatim reverse failed: ${r.status}`);
        return r.json();
      })
      .then((r) => {
        if (id !== reqRef.current) return; // a newer interaction superseded this
        setLoading(false);
        // The SA bbox contains Lesotho and Eswatini, so a click can land outside
        // South Africa proper — the resolved country is the precise gate. Reject
        // the pin entirely (the bbox click-guard already stored it optimistically).
        const cc = r?.address?.country_code;
        if (cc && cc !== 'za') {
          if (markerRef.current) markerRef.current.remove();
          setCoords(null);
          setNotFound(true);
          onResolvedRef.current?.(null);
          return;
        }
        const addr = shortAddress(r); // '' when no readable address resolves
        onResolvedRef.current?.({ lat, lon, name: r?.display_name || null, suburb: suburbOf(r) });
        // Only fill the field with a real address — never a raw lat/lon string.
        if (addr) onAddressRef.current?.(addr);
      })
      .catch((e) => {
        if (e.name === 'AbortError' || id !== reqRef.current) return;
        // Keep the click as an authoritative pin (already placed + coords stored);
        // we just couldn't resolve an address. Surface it instead of inventing one.
        console.warn('Reverse geocode failed', e);
        setLoading(false);
      });
  }

  // Initialise the map once + wire click-to-drop-pin
  useEffectC(() => {
    if (mapRef.current || !elRef.current || !L) return;
    const map = L.map(elRef.current, {
      scrollWheelZoom: false,
      attributionControl: true,
      // Hard-lock the viewport to South Africa. Half-degree padding keeps coastal
      // grounds off the hard edge; viscosity 1.0 makes panning out impossible.
      // minZoom 6, not lower: at 5 the SA bounds are narrower than the map frame
      // and Leaflet bounces fighting maxBoundsViscosity on zoom-out.
      minZoom: 6,
      maxBounds: L.latLngBounds(
        [SA_BOUNDS.south - 0.5, SA_BOUNDS.west - 0.5],
        [SA_BOUNDS.north + 0.5, SA_BOUNDS.east + 0.5],
      ),
      maxBoundsViscosity: 1.0,
    }).setView(
      validPin ? [validPin.lat, validPin.lon] : [-29.85, 31.02], // saved pin, else Durban default
      validPin ? 16 : 11,
    );
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '© OpenStreetMap contributors',
    }).addTo(map);
    map.on('click', (e) => handleMapClick(e.latlng.lat, e.latlng.lng));
    mapRef.current = map;
    // Restore the previously dropped pin so a remount (returning to step 1) keeps it.
    if (validPin) placeMarker(validPin.lat, validPin.lon);
    return () => {
      if (reverseTimerRef.current) clearTimeout(reverseTimerRef.current);
      if (reverseCtrlRef.current) reverseCtrlRef.current.abort();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Forward-geocode + drop marker whenever the typed query changes
  useEffectC(() => {
    if (!query || !mapRef.current || !L) return;
    // On a mount that restored a saved pin, skip this first (stale-query) geocode so the
    // restored pin survives. The pin click may never have updated `query`, so re-running
    // it here would relocate the marker and overwrite the real coords via onResolved.
    if (hydratedRef.current) {
      hydratedRef.current = false;
      return;
    }
    const id = ++reqRef.current;
    // A typed search supersedes any pending/in-flight click lookup.
    if (reverseTimerRef.current) clearTimeout(reverseTimerRef.current);
    if (reverseCtrlRef.current) reverseCtrlRef.current.abort();
    const ctrl = new AbortController();
    setLoading(true);
    setNotFound(false);
    setLoadError(false);
    // countrycodes=za hard-filters results to South Africa — typing "London" must
    // come back not-found, not fly the map abroad. A server-side filter beats
    // appending "South Africa" to the query string (no string-munging surprises).
    fetch(
      `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=za&q=${encodeURIComponent(query)}`,
      {
        signal: ctrl.signal,
        headers: { 'Accept-Language': 'en' },
      },
    )
      .then((r) => {
        if (!r.ok) throw new Error(`Nominatim search failed: ${r.status}`);
        return r.json();
      })
      .then((results) => {
        if (id !== reqRef.current) return; // a newer interaction superseded this
        setLoading(false);
        if (!results || !results.length) {
          setCoords(null);
          setNotFound(true);
          return;
        }
        const r = results[0];
        const lat = parseFloat(r.lat),
          lon = parseFloat(r.lon);
        // Belt-and-braces: countrycodes=za should guarantee this, but a result
        // outside the SA box would fight maxBounds — treat it as not-found.
        if (!isInSouthAfrica(lat, lon)) {
          setCoords(null);
          setNotFound(true);
          return;
        }
        mapRef.current.flyTo([lat, lon], 16, { duration: 0.8 });
        placeMarker(lat, lon, r.display_name.split(',').slice(0, 2).join(','));
        setNotFound(false);
        setCoords({ lat, lon, name: r.display_name });
        onResolvedRef.current?.({ lat, lon, name: r.display_name, suburb: suburbOf(r) });
      })
      .catch((e) => {
        if (e.name === 'AbortError' || id !== reqRef.current) return;
        // Distinguish "no such place" (refine search) from "lookup unavailable"
        // (network / rate-limit) so a 429 doesn't masquerade as not-found.
        console.warn('Forward geocode failed', e);
        setLoading(false);
        setCoords(null);
        setLoadError(true);
      });
    return () => ctrl.abort();
  }, [query]);

  return (
    <div className="ground-map-frame">
      <div ref={elRef} className="ground-map" />
      {loading && (
        <div className="ground-map-loading">
          <span className="spinner" />
          Finding location…
        </div>
      )}
      {!loading && coords && !notFound && !loadError && (
        <div className="ground-coords">
          <Icon.Field />
          {coords.lat.toFixed(4)}, {coords.lon.toFixed(4)}
        </div>
      )}
      {!loading && !loadError && notFound && (
        <div className="ground-coords" style={{ background: 'var(--ink)' }}>
          <Icon.Alert />
          Address not found — refine your search
        </div>
      )}
      {!loading && loadError && (
        <div className="ground-coords" style={{ background: 'var(--ink)' }}>
          <Icon.Alert />
          Location lookup unavailable — try again
        </div>
      )}
    </div>
  );
}

/* ─── Club Home: phase tracker + onboarding next step ─── */
export function ClubHome({
  club,
  goto,
  toast,
  replayOnboarding,
  submissionDeadline,
  allLeagues = [],
}) {
  const deadlineLong = formatDeadlineLong(submissionDeadline);
  const deadlineShort = formatDeadlineShort(submissionDeadline);
  const daysLeft = daysUntil(submissionDeadline);
  const daysLabel =
    daysLeft === 0
      ? 'Deadline today'
      : daysLeft === 1
        ? '1 day remaining'
        : `${daysLeft} days remaining`;
  const dc = docCompletion(club);
  const op = overallProgress(club);
  const band = cqiBand(club.cqi);
  // Team counts derive from the leagues entered on the affiliation form
  // (one side per league); club.teams/juniors are stale admin-era fields.
  const tc = teamCounts(club.leagues, allLeagues);
  // "Submitted" is the form fact (affiliation === 'complete').
  const affDone = affiliationSubmitted(club);

  const phases = [
    {
      n: '01',
      t: 'Affiliation',
      key: 'affiliation',
      done: affDone,
      action: 'Open form',
      target: 'affiliation',
    },
    {
      n: '02',
      t: 'Fixtures',
      key: 'fixtures',
      done: affDone,
      action: 'View leagues',
      target: 'fixtures',
      lock: !affDone,
      lockReason: 'Locked — finish phase 1 first',
    },
    {
      n: '03',
      t: 'Compliance & CQI',
      key: 'compliance',
      done: dc === 100 && club.cqi > 0,
      action: 'Continue',
      target: 'documents',
    },
  ];

  // Find next action
  const next = phases.find((p) => !p.done && !p.lock);

  return (
    <div>
      {/* Aspirational hero banner */}
      <div
        className="hero-banner"
        style={{ backgroundImage: "url('/venues/kingsmead-stadium.jpg')" }}
      >
        <div className="hero-content">
          <div className="hero-eyebrow">Hollywoodbets Dolphins · 2026/27 Season</div>
          <h2 className="hero-title">
            From your club to the <em>Dolphins</em>.
          </h2>
          <p className="hero-sub">
            Affiliate, register and integrate — be part of the same ecosystem that powers our
            provincial heroes.
          </p>
        </div>
      </div>

      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Club Portal · {club.name}</div>
          <h1 className="ph-title">
            {greeting()}, <em>{club.chair.split(' ')[0]}</em>
          </h1>
          <p className="ph-desc">
            Your 2026/27 Cricket Services club integration sits at{' '}
            <strong style={{ color: 'var(--ink)' }}>{next ? op : 100}% complete</strong>.{' '}
            {next
              ? `Next up — ${next.t.toLowerCase()}.`
              : 'All required steps are done — well batted.'}
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" size="sm" onClick={replayOnboarding}>
            Walkthrough
          </Btn>
          {next && (
            <Btn tone="ink" icon={Icon.Arrow} onClick={() => next.target && goto(next.target)}>
              Continue · {next.t}
            </Btn>
          )}
        </div>
      </div>

      <div className="deadline">
        <div className="deadline-icon">
          <Icon.Clock />
        </div>
        <div className="deadline-text">
          <strong>Submission deadline · {deadlineLong}.</strong> All three forms must reach the
          Union office before this date. <span className="days">{daysLabel}</span>.
        </div>
      </div>

      {/* Phase tracker — clickable */}
      <Card
        title="Your integration journey"
        sub="Three phases on the Medicoach Smart Club platform"
      >
        <div className="phase-track" style={{ borderRadius: 0, border: 'none' }}>
          {phases.map((p) => (
            <div
              key={p.n}
              className={`phase-step ${p.done ? 'done' : ''} ${next && next.n === p.n ? 'active' : ''}`}
              onClick={() => p.target && goto(p.target)}
              style={{ cursor: p.target ? 'pointer' : 'default', opacity: p.lock ? 0.55 : 1 }}
            >
              <div className="ps-n">PHASE {p.n}</div>
              <div className="ps-t">{p.t}</div>
              <div className="ps-l">
                {p.done
                  ? 'Complete'
                  : p.lock
                    ? p.lockReason || 'Locked — finish phase 1 first'
                    : 'Pending'}
              </div>
              {p.done && (
                <div className="ps-tick">
                  <Icon.Check />
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16, marginTop: 16 }}>
        <Card title="Outstanding items" sub={`Action required before ${deadlineLong}`}>
          <div className="stack" style={{ gap: 8 }}>
            <button
              className="row"
              style={{
                width: '100%',
                textAlign: 'left',
                padding: '12px 14px',
                border: '1px solid ' + (affDone ? 'rgba(15,77,46,0.25)' : 'var(--line)'),
                background: affDone ? 'var(--green-pale)' : 'var(--white)',
                borderRadius: 8,
                gap: 12,
              }}
              onClick={() => goto('affiliation')}
            >
              <div
                style={{
                  width: 32,
                  height: 32,
                  borderRadius: '50%',
                  background: affDone ? 'var(--green)' : 'var(--coral-pale)',
                  color: affDone ? '#fff' : 'var(--coral)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  boxShadow: affDone ? '0 3px 10px rgba(15,77,46,0.25)' : 'none',
                }}
              >
                {affDone ? <Icon.Check /> : <Icon.Form />}
              </div>
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    fontFamily: "'Montserrat',sans-serif",
                    fontSize: 13,
                    fontWeight: 700,
                    color: affDone ? 'var(--green)' : 'var(--ink)',
                  }}
                >
                  Affiliation Form
                </div>
                <div
                  style={{ fontSize: 11.5, color: affDone ? 'var(--green-mid)' : 'var(--muted)' }}
                >
                  {affDone
                    ? 'Submitted · tap to view'
                    : 'Complete the 2026/27 Cricket Services affiliation form — club details, exco, leagues & coaches.'}
                </div>
              </div>
              {affDone ? (
                <Pill tone="teal" dot>
                  Completed
                </Pill>
              ) : (
                <Pill tone="coral" dot>
                  Required
                </Pill>
              )}
            </button>
            {dc < 100 && (
              <button
                className="row"
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 14px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  gap: 12,
                }}
                onClick={() => goto('documents')}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    background: 'rgba(31,170,92,0.18)',
                    color: '#076B36',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon.Upload />
                </div>
                <div style={{ flex: 1 }}>
                  <div
                    style={{ fontFamily: "'Montserrat',sans-serif", fontSize: 13, fontWeight: 700 }}
                  >
                    Compliance documents
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    Upload your compliance documents. (
                    {REQUIRED_DOCS.length - docsUploadedCount(club)} remaining)
                  </div>
                </div>
                <Pill tone="gold" dot>
                  In progress
                </Pill>
              </button>
            )}
            {club.cqi === 0 && (
              <button
                className="row"
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '12px 14px',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  gap: 12,
                }}
                onClick={() => goto('cqi')}
              >
                <div
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: '50%',
                    background: 'rgba(10,15,20,0.08)',
                    color: 'var(--navy)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Icon.Star />
                </div>
                <div style={{ flex: 1 }}>
                  <div
                    style={{ fontFamily: "'Montserrat',sans-serif", fontSize: 13, fontWeight: 700 }}
                  >
                    CQI self-assessment
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                    Complete the Club Quality Index questionnaire across 5 categories.
                  </div>
                </div>
                <Pill tone="navy" dot>
                  Pending
                </Pill>
              </button>
            )}
            {affDone && dc === 100 && club.cqi > 0 && (
              <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--muted)' }}>
                Everything submitted. Your club has been forwarded to the Dolphins administrators
                for review.
              </div>
            )}
          </div>
        </Card>

        <Card title="Your club at a glance">
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 18px' }}>
            {[
              ['CQI score', club.cqi > 0 ? club.cqi.toFixed(1) : '—'],
              ['Members', club.players || 0],
              ['Senior teams', tc.senior],
              ['Junior teams', tc.junior],
              ['Sub-union', club.district || club.sub || '—'],
              ['Chair', club.chair.split(' ')[0]],
            ].map(([k, v], i) => (
              <div key={i}>
                <div
                  style={{
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    color: 'var(--muted-2)',
                    marginBottom: 3,
                  }}
                >
                  {k}
                </div>
                <div
                  style={{
                    fontFamily: "'Montserrat',sans-serif",
                    fontSize: 18,
                    fontWeight: 700,
                    color: 'var(--ink)',
                  }}
                >
                  {v}
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ─── Phase 1 · Affiliation form ─── */
const EMPTY_MEMBER = { name: '', cell: '', email: '', gender: '', race: '' };
const EMPTY_COACH = {
  name: '',
  body: 'None',
  level: 'None',
  status: 'Completed',
  cell: '',
  email: '',
  teams: [],
};

export function AffiliationForm({
  club,
  goto,
  toast,
  onSubmit,
  onSaveDraft,
  unionEmail,
  allLeagues = [],
}) {
  const [data, setData] = useStateC(() => {
    // Pre-fill exco from club.exco (single source of truth shared with the exco roster doc)
    const ex = club.exco || {};
    const seed = (key, fallback = {}) => ({
      name: ex[key]?.name ?? fallback.name ?? '',
      cell: ex[key]?.cell ?? fallback.cell ?? '',
      email: ex[key]?.email ?? fallback.email ?? '',
      gender: ex[key]?.gender ?? fallback.gender ?? '',
      race: ex[key]?.race ?? fallback.race ?? '',
    });
    const chairSeed = seed('chair', { name: club.chair });
    // Additional members are now an array (chair/sec/tre/vc remain fixed required slots)
    const stored = Array.isArray(ex.additionalMembers)
      ? ex.additionalMembers
      : ex.am?.name
        ? [ex.am]
        : [];
    const ground = club.ground || {};
    return {
      clubName: club.name,
      district: club.district || DISTRICTS[0],
      township: 'no',
      chairName: chairSeed.name,
      chairCell: chairSeed.cell,
      chairEmail: chairSeed.email,
      chairGender: chairSeed.gender,
      chairRace: chairSeed.race,
      secName: seed('sec').name,
      secCell: seed('sec').cell,
      secEmail: seed('sec').email,
      secGender: seed('sec').gender,
      secRace: seed('sec').race,
      treName: seed('tre').name,
      treCell: seed('tre').cell,
      treEmail: seed('tre').email,
      treGender: seed('tre').gender,
      treRace: seed('tre').race,
      vcName: seed('vc').name,
      vcCell: seed('vc').cell,
      vcEmail: seed('vc').email,
      vcGender: seed('vc').gender,
      vcRace: seed('vc').race,
      additionalMembers: stored.length ? stored : [{ ...EMPTY_MEMBER }],
      // Leagues come from the district-specific catalogue (V2). When the user changes
      // district in step 1 we wipe and re-seed below so the picker always matches.
      leagues: (() => {
        const prior = Array.isArray(club.leagues) ? club.leagues : null;
        const opts = leagueOptionsForDistrict(allLeagues, club.district || DISTRICTS[0]);
        return opts.reduce((acc, L) => {
          acc[L.key] = prior ? prior.includes(L.key) : false;
          return acc;
        }, {});
      })(),
      coaches: club.coaches && club.coaches.length ? club.coaches : [{ ...EMPTY_COACH, teams: [] }],
      // Home ground / venue
      groundVenue: ground.venue || '',
      groundAddress: ground.address || '',
      groundMapQuery: ground.mapQuery || 'Durban, KwaZulu-Natal, South Africa',
      // Restore the persisted pin so the map opens on it (and survives step round-trips)
      // instead of re-geocoding `mapQuery`. Only seed when real coords were saved.
      groundCoords:
        Number.isFinite(ground.lat) && Number.isFinite(ground.lon)
          ? { lat: ground.lat, lon: ground.lon, suburb: ground.suburb, name: ground.address }
          : null,
      // True when groundAddress came from clicking the map (reverse-geocode).
      // Suppresses re-geocoding on blur so a clicked pin isn't relocated.
      groundAddressFromPin: false,
    };
  });
  const [step, setStep] = useStateC(1);
  const [savingDraft, setSavingDraft] = useStateC(false);

  // Persist the in-progress form without locking it (no affiliation:'complete').
  // Toast only on success — updateClub can reject (e.g. version conflict) and we
  // must not show a false "saved" confirmation. district is included so a step-1
  // district change isn't lost and leagues validate against the right catalogue.
  function saveDraft() {
    if (!onSaveDraft) return;
    setSavingDraft(true);
    Promise.resolve(
      onSaveDraft({
        district: data.district,
        exco: getExcoPayload(),
        coaches: getCoachesPayload(),
        ground: getGroundPayload(),
        leagues: getLeaguesPayload(),
      }),
    )
      .then(() => toast('Draft saved'))
      .catch(() => toast('Could not save draft', 'warn'))
      .finally(() => setSavingDraft(false));
  }

  function updateMember(idx, field, val) {
    setData((d) => ({
      ...d,
      additionalMembers: d.additionalMembers.map((m, i) =>
        i === idx ? { ...m, [field]: val } : m,
      ),
    }));
  }
  function addMember() {
    setData((d) => ({ ...d, additionalMembers: [...d.additionalMembers, { ...EMPTY_MEMBER }] }));
  }
  function removeMember(idx) {
    setData((d) => ({ ...d, additionalMembers: d.additionalMembers.filter((_, i) => i !== idx) }));
  }

  function updateCoach(idx, field, val) {
    setData((d) => ({
      ...d,
      coaches: d.coaches.map((c, i) => (i === idx ? { ...c, [field]: val } : c)),
    }));
  }
  function toggleCoachTeam(idx, team) {
    setData((d) => ({
      ...d,
      coaches: d.coaches.map((c, i) => {
        if (i !== idx) return c;
        const has = c.teams.includes(team);
        return { ...c, teams: has ? c.teams.filter((t) => t !== team) : [...c.teams, team] };
      }),
    }));
  }
  function addCoach() {
    setData((d) => ({ ...d, coaches: [...d.coaches, { ...EMPTY_COACH }] }));
  }
  function addCoachForLeague(key) {
    setData((d) => ({ ...d, coaches: [...d.coaches, { ...EMPTY_COACH, teams: [key] }] }));
  }
  function removeCoach(idx) {
    setData((d) => ({ ...d, coaches: d.coaches.filter((_, i) => i !== idx) }));
  }

  function update(k, v) {
    setData((d) => ({ ...d, [k]: v }));
  }
  function updateLeague(k) {
    setData((d) => ({ ...d, leagues: { ...d.leagues, [k]: !d.leagues[k] } }));
  }
  // Changing district wipes prior league selections — the catalogue is district-specific
  // (Smart Club Integration V2) so cross-district keys would be invalid.
  function setDistrict(newDistrict) {
    setData((d) => {
      const opts = leagueOptionsForDistrict(allLeagues, newDistrict);
      const freshLeagues = opts.reduce((acc, L) => {
        acc[L.key] = false;
        return acc;
      }, {});
      const validKeys = new Set(opts.map((o) => o.key));
      const coaches = d.coaches.map((c) => ({
        ...c,
        teams: c.teams.filter((t) => validKeys.has(t)),
      }));
      return { ...d, district: newDistrict, leagues: freshLeagues, coaches };
    });
  }

  function dropGroundPin() {
    setData((d) => {
      // A clicked pin is authoritative — don't re-geocode the typed address
      // (which would jump the marker off the point the user picked).
      if (d.groundAddressFromPin) return d;
      const q = [d.groundVenue, d.groundAddress].filter(Boolean).join(', ');
      return { ...d, groundMapQuery: q || 'Durban, KwaZulu-Natal, South Africa' };
    });
  }

  function getGroundPayload() {
    // Persist the geocoded coordinates too — travel-cost / haversine math needs
    // them, and the prototype previously dropped them on submit.
    const coords = data.groundCoords || club.ground || {};
    return {
      venue: data.groundVenue,
      address: data.groundAddress,
      mapQuery: data.groundMapQuery,
      suburb: coords.suburb,
      lat: coords.lat,
      lon: coords.lon,
    };
  }

  function getExcoPayload() {
    const pick = (p) => ({
      name: data[p + 'Name'],
      cell: data[p + 'Cell'],
      email: data[p + 'Email'],
      gender: data[p + 'Gender'],
      race: data[p + 'Race'],
    });
    return {
      chair: pick('chair'),
      sec: pick('sec'),
      tre: pick('tre'),
      vc: pick('vc'),
      additionalMembers: data.additionalMembers.filter((m) => m.name),
    };
  }
  function getCoachesPayload() {
    return data.coaches.filter((c) => c.name);
  }
  function getLeaguesPayload() {
    return Object.entries(data.leagues)
      .filter(([_, v]) => v)
      .map(([k]) => k);
  }

  const valid = data.clubName && data.chairName && data.chairCell && data.chairEmail;
  // Form locks once affiliation is submitted (complete).
  const viewOnly = club.affiliation === 'complete';

  // Live summary values for the sidebar
  const filledBearers = [
    data.chairName,
    data.secName,
    data.treName,
    data.vcName,
    ...data.additionalMembers.map((m) => m.name),
  ].filter(Boolean).length;
  const leaguesCount = Object.values(data.leagues).filter(Boolean).length;
  const coachesCount = data.coaches.filter((c) => c.name).length;
  const STEPS = ['Club Details', 'Executive Committee', 'Leagues & Coaches'];
  const TOTAL_STEPS = STEPS.length;
  const stepLabel = STEPS[step - 1];

  return (
    <div className={viewOnly ? 'aff-locked' : ''}>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">
            <a onClick={() => goto('home')}>Home</a> &nbsp;/&nbsp; Affiliation
          </div>
          <h1 className="ph-title">
            2026/27 <em>Affiliation Form</em>
          </h1>
          <p className="ph-desc">
            Cricket Services · Club Registration. All fields marked{' '}
            <span style={{ color: 'var(--coral)' }}>*</span> are required. The digital form mirrors
            the official Excel template — your inputs are saved as you go.
          </p>
        </div>
      </div>

      {viewOnly && (
        <div className="aff-submitted-banner">
          <div className="aff-submitted-icon">
            <Icon.Check />
          </div>
          <div className="aff-submitted-text">
            <div className="aff-submitted-title">Affiliation submitted</div>
            <div className="aff-submitted-sub">
              Confirmed by the Dolphins office · This form is locked, contact the Union office to
              request an amendment.
            </div>
          </div>
          <Pill tone="teal" dot>
            Completed
          </Pill>
        </div>
      )}

      <div className="aff-layout">
        <div className="aff-main">
          <fieldset disabled={viewOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            {/* step strip */}
            <div
              style={{
                display: 'flex',
                gap: 0,
                marginBottom: 18,
                background: 'var(--white)',
                borderRadius: 10,
                border: '1px solid var(--line)',
                overflow: 'hidden',
              }}
            >
              {STEPS.map((s, i) => (
                <button
                  key={i}
                  onClick={() => setStep(i + 1)}
                  style={{
                    flex: 1,
                    padding: '12px 14px',
                    textAlign: 'left',
                    borderRight: i < STEPS.length - 1 ? '1px solid var(--line)' : 'none',
                    background:
                      step === i + 1
                        ? 'var(--ink)'
                        : i + 1 < step
                          ? 'var(--teal-pale)'
                          : 'var(--white)',
                    color:
                      step === i + 1 ? '#fff' : i + 1 < step ? 'var(--teal-deep)' : 'var(--ink)',
                  }}
                >
                  <div
                    style={{
                      fontFamily: "'Montserrat',sans-serif",
                      fontSize: 10,
                      letterSpacing: '0.1em',
                      opacity: 0.65,
                    }}
                  >
                    STEP {i + 1}
                  </div>
                  <div
                    style={{
                      fontFamily: "'Montserrat',sans-serif",
                      fontSize: 13,
                      fontWeight: 700,
                      marginTop: 2,
                    }}
                  >
                    {s}
                  </div>
                </button>
              ))}
            </div>

            {step === 1 && (
              <Card title="Club Details" sub="Identifies the club and its district affiliation">
                <div className="field">
                  <div className="field-label">
                    Club Name <span className="req">*</span>
                  </div>
                  <input
                    className="field-input"
                    value={data.clubName}
                    onChange={(e) => update('clubName', e.target.value)}
                  />
                </div>
                <div className="field-grid-2">
                  <div className="field">
                    <div className="field-label">
                      Municipal District / Sub-Union <span className="req">*</span>
                    </div>
                    <select
                      className="field-select"
                      value={data.district}
                      onChange={(e) => setDistrict(e.target.value)}
                    >
                      {DISTRICTS.map((d) => (
                        <option key={d}>{d}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <div className="field-label">
                      Located in a township area? <span className="req">*</span>
                    </div>
                    <div style={{ height: 42, display: 'flex', alignItems: 'center' }}>
                      <YN
                        value={data.township === 'yes'}
                        onChange={(v) => update('township', v ? 'yes' : 'no')}
                      />
                    </div>
                  </div>
                </div>

                <div className="hr" />

                {/* ─── Home ground locator ─── */}
                <div className="ground-section">
                  <div className="ground-section-head">
                    <div className="ground-section-title">
                      <Icon.Field /> Home ground
                    </div>
                    <div className="ground-section-sub">
                      Pin your ground location so fixtures, venue allocations and travel times are
                      accurate. Type the venue and address, or click the map, to drop the pin.
                    </div>
                  </div>

                  <div className="field-grid-2">
                    <div className="field" style={{ marginBottom: 0 }}>
                      <div className="field-label">
                        Venue Name <span className="req">*</span>
                      </div>
                      <input
                        className="field-input"
                        placeholder="e.g. Berea Rovers Oval"
                        value={data.groundVenue}
                        onChange={(e) =>
                          // Editing the venue re-enables typed-address geocoding,
                          // so a venue change after a map click still updates the map.
                          setData((d) => ({
                            ...d,
                            groundVenue: e.target.value,
                            groundAddressFromPin: false,
                          }))
                        }
                        onBlur={dropGroundPin}
                      />
                    </div>
                    <div className="field" style={{ marginBottom: 0 }}>
                      <div className="field-label">
                        Address <span className="req">*</span>
                      </div>
                      <input
                        className="field-input"
                        placeholder="Street, suburb, city"
                        value={data.groundAddress}
                        onChange={(e) =>
                          // Manual edit re-enables typed-address geocoding.
                          setData((d) => ({
                            ...d,
                            groundAddress: e.target.value,
                            groundAddressFromPin: false,
                          }))
                        }
                        onBlur={dropGroundPin}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            dropGroundPin();
                          }
                        }}
                      />
                    </div>
                  </div>

                  <div className="ground-map-card">
                    <div className="ground-map-head">
                      <div className={`ground-status ${data.groundAddress ? 'confirmed' : ''}`}>
                        <span className="dot" />
                        {data.groundAddress ? 'Pin dropped' : 'Awaiting address'}
                      </div>
                      <div className="ground-meta">
                        {data.groundVenue ||
                          (data.groundAddress ? data.groundAddress : 'Type the venue name above')}
                      </div>
                      <Btn tone="outline" size="sm" icon={Icon.Field} onClick={dropGroundPin}>
                        Drop pin
                      </Btn>
                    </div>
                    {/* GroundMap restores `coords` on mount and is wrapped in `step === 1`,
                        so it unmounts on step change and re-arms its hydration on return.
                        If steps ever switch to CSS hide instead of unmount, that restore breaks. */}
                    <GroundMap
                      query={data.groundMapQuery}
                      coords={data.groundCoords}
                      onResolved={(c) => update('groundCoords', c)}
                      onAddressPicked={(addr) =>
                        setData((d) => ({
                          ...d,
                          groundAddress: addr,
                          groundAddressFromPin: true,
                        }))
                      }
                    />
                  </div>
                </div>
              </Card>
            )}

            {step === 2 && (
              <Card
                title="Executive Committee Office Bearers"
                sub="Provide contact, gender &amp; race for each office bearer"
              >
                {[
                  { prefix: 'chair', title: 'Chairperson', req: true },
                  { prefix: 'sec', title: 'Secretary', req: true },
                  { prefix: 'tre', title: 'Treasurer', req: true },
                  { prefix: 'vc', title: 'Vice-Chair', req: false },
                ].map((role) => (
                  <div
                    key={role.prefix}
                    style={{
                      padding: '14px 16px',
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      marginBottom: 10,
                      background: 'var(--paper)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 10,
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "'Montserrat',sans-serif",
                          fontSize: 13,
                          fontWeight: 700,
                          color: 'var(--ink)',
                        }}
                      >
                        {role.title}
                        {role.req && (
                          <span style={{ color: 'var(--coral)', marginLeft: 4 }}>*</span>
                        )}
                      </div>
                      <div
                        style={{
                          fontSize: 10.5,
                          color: 'var(--muted-2)',
                          fontFamily: "'Montserrat',sans-serif",
                        }}
                      >
                        {role.prefix.toUpperCase()}
                      </div>
                    </div>
                    <div className="field-grid-3">
                      <div className="field" style={{ marginBottom: 8 }}>
                        <div className="field-label">Full Name</div>
                        <input
                          className="field-input"
                          value={data[role.prefix + 'Name'] || ''}
                          onChange={(e) => update(role.prefix + 'Name', e.target.value)}
                          placeholder="Name &amp; surname"
                        />
                      </div>
                      <div className="field" style={{ marginBottom: 8 }}>
                        <div className="field-label">Cell Number</div>
                        <input
                          className="field-input"
                          value={data[role.prefix + 'Cell'] || ''}
                          onChange={(e) => update(role.prefix + 'Cell', e.target.value)}
                          placeholder="0XX XXX XXXX"
                        />
                      </div>
                      <div className="field" style={{ marginBottom: 8 }}>
                        <div className="field-label">Email</div>
                        <input
                          className="field-input"
                          value={data[role.prefix + 'Email'] || ''}
                          onChange={(e) => update(role.prefix + 'Email', e.target.value)}
                          placeholder="name@club.co.za"
                        />
                      </div>
                    </div>
                    <div className="field-grid-2">
                      <div className="field" style={{ marginBottom: 0 }}>
                        <div className="field-label">Gender</div>
                        <select
                          className="field-select"
                          value={data[role.prefix + 'Gender'] || ''}
                          onChange={(e) => update(role.prefix + 'Gender', e.target.value)}
                        >
                          <option value="">Select…</option>
                          <option>Female</option>
                          <option>Male</option>
                          <option>Non-binary</option>
                        </select>
                      </div>
                      <div className="field" style={{ marginBottom: 0 }}>
                        <div className="field-label">Race</div>
                        <select
                          className="field-select"
                          value={data[role.prefix + 'Race'] || ''}
                          onChange={(e) => update(role.prefix + 'Race', e.target.value)}
                        >
                          <option value="">Select…</option>
                          <option>Black African</option>
                          <option>Coloured</option>
                          <option>Indian</option>
                          <option>White</option>
                        </select>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Additional members — dynamic array */}
                <div
                  style={{
                    marginTop: 18,
                    marginBottom: 10,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontFamily: "'Montserrat',sans-serif",
                        fontSize: 13,
                        fontWeight: 700,
                        color: 'var(--ink)',
                      }}
                    >
                      Additional Members
                    </div>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                      Add any further exco members — office bearers, committee reps, etc.
                    </div>
                  </div>
                  <Btn tone="outline" size="sm" icon={Icon.Plus} onClick={addMember}>
                    Add another member
                  </Btn>
                </div>

                {data.additionalMembers.map((m, idx) => (
                  <div
                    key={idx}
                    style={{
                      padding: '14px 16px',
                      border: '1px solid var(--line)',
                      borderRadius: 8,
                      marginBottom: 10,
                      background: 'var(--paper)',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 10,
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "'Montserrat',sans-serif",
                          fontSize: 13,
                          fontWeight: 700,
                          color: 'var(--ink)',
                        }}
                      >
                        Additional Member{' '}
                        <span style={{ color: 'var(--muted-2)', fontWeight: 500 }}>#{idx + 1}</span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div
                          style={{
                            fontSize: 10.5,
                            color: 'var(--muted-2)',
                            fontFamily: "'Montserrat',sans-serif",
                          }}
                        >
                          AM-{idx + 1}
                        </div>
                        {data.additionalMembers.length > 1 && (
                          <Btn tone="ghost" size="sm" onClick={() => removeMember(idx)}>
                            Remove
                          </Btn>
                        )}
                      </div>
                    </div>
                    <div className="field-grid-3">
                      <div className="field" style={{ marginBottom: 8 }}>
                        <div className="field-label">Full Name</div>
                        <input
                          className="field-input"
                          value={m.name}
                          onChange={(e) => updateMember(idx, 'name', e.target.value)}
                          placeholder="Name &amp; surname"
                        />
                      </div>
                      <div className="field" style={{ marginBottom: 8 }}>
                        <div className="field-label">Cell Number</div>
                        <input
                          className="field-input"
                          value={m.cell}
                          onChange={(e) => updateMember(idx, 'cell', e.target.value)}
                          placeholder="0XX XXX XXXX"
                        />
                      </div>
                      <div className="field" style={{ marginBottom: 8 }}>
                        <div className="field-label">Email</div>
                        <input
                          className="field-input"
                          value={m.email}
                          onChange={(e) => updateMember(idx, 'email', e.target.value)}
                          placeholder="name@club.co.za"
                        />
                      </div>
                    </div>
                    <div className="field-grid-2">
                      <div className="field" style={{ marginBottom: 0 }}>
                        <div className="field-label">Gender</div>
                        <select
                          className="field-select"
                          value={m.gender}
                          onChange={(e) => updateMember(idx, 'gender', e.target.value)}
                        >
                          <option value="">Select…</option>
                          <option>Female</option>
                          <option>Male</option>
                          <option>Non-binary</option>
                        </select>
                      </div>
                      <div className="field" style={{ marginBottom: 0 }}>
                        <div className="field-label">Race</div>
                        <select
                          className="field-select"
                          value={m.race}
                          onChange={(e) => updateMember(idx, 'race', e.target.value)}
                        >
                          <option value="">Select…</option>
                          <option>Black African</option>
                          <option>Coloured</option>
                          <option>Indian</option>
                          <option>White</option>
                        </select>
                      </div>
                    </div>
                  </div>
                ))}
              </Card>
            )}

            {step === 3 &&
              (() => {
                // District-specific league catalogue (Smart Club Integration V2) —
                // the picker only ever shows leagues that apply to the club's district.
                const districtOptions = leagueOptionsForDistrict(allLeagues, data.district);
                const selectedLeagueKeys = Object.entries(data.leagues)
                  .filter(([_, v]) => v)
                  .map(([k]) => k);
                const leagueGroups = districtOptions.reduce((acc, L) => {
                  (acc[L.group] = acc[L.group] || []).push(L);
                  return acc;
                }, {});
                return (
                  <Card
                    title="Leagues entered &amp; Coaches by Designation"
                    sub={`Leagues are filtered to your selected district — ${data.district}. Pick the ones your club is entering, then capture coaches under each team designation.`}
                  >
                    <div className="field">
                      <div className="field-label">
                        Leagues your club is entering <span className="req">*</span>
                      </div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 10 }}>
                        Showing leagues for{' '}
                        <strong style={{ color: 'var(--ink)' }}>{data.district}</strong>. Change
                        district in step 1 to see a different catalogue.
                      </div>
                      {Object.entries(leagueGroups).map(([group, opts]) => (
                        <div key={group} style={{ marginBottom: 12 }}>
                          <div
                            style={{
                              fontSize: 10.5,
                              letterSpacing: '0.12em',
                              textTransform: 'uppercase',
                              color: 'var(--muted-2)',
                              fontFamily: "'Montserrat',sans-serif",
                              fontWeight: 700,
                              marginBottom: 6,
                            }}
                          >
                            {group}
                          </div>
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: 'repeat(2,1fr)',
                              gap: 8,
                            }}
                          >
                            {opts.map((L) => (
                              <button
                                key={L.key}
                                className={`check-item ${data.leagues[L.key] ? 'on' : ''}`}
                                onClick={() => updateLeague(L.key)}
                                style={{
                                  flexDirection: 'column',
                                  alignItems: 'flex-start',
                                  gap: 4,
                                }}
                              >
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                                  <div className="box">{data.leagues[L.key] && <Icon.Check />}</div>
                                  <span>{L.label}</span>
                                </div>
                                {L.note && (
                                  <div
                                    style={{
                                      fontSize: 10.5,
                                      color: 'var(--muted)',
                                      marginLeft: 30,
                                      fontWeight: 500,
                                      fontStyle: 'italic',
                                    }}
                                  >
                                    {L.note}
                                  </div>
                                )}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="hr" />

                    {/* Coaches grouped by designation — one banner per selected league */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 14,
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontFamily: "'Montserrat',sans-serif",
                            fontSize: 13,
                            fontWeight: 700,
                            color: 'var(--ink)',
                          }}
                        >
                          Coaches by Designation
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                          Each league becomes its own banner. Add coaches under the designation they
                          manage — a coach can sit under more than one.
                        </div>
                      </div>
                    </div>

                    {selectedLeagueKeys.length === 0 ? (
                      <div
                        style={{
                          border: '1px dashed var(--paper3)',
                          borderRadius: 10,
                          padding: '22px 18px',
                          background: 'var(--paper)',
                          color: 'var(--muted)',
                          textAlign: 'center',
                          fontFamily: "'Montserrat',sans-serif",
                          fontSize: 12.5,
                        }}
                      >
                        <Icon.Alert /> Select at least one league above — each becomes a banner you
                        can attach coaches to.
                      </div>
                    ) : (
                      selectedLeagueKeys.map((key) => {
                        const L = findByKey(allLeagues, key);
                        const rows = data.coaches
                          .map((c, i) => ({ c, i }))
                          .filter((x) => x.c.teams.includes(key));
                        return (
                          <div
                            key={key}
                            style={{
                              border: '1px solid var(--line)',
                              borderRadius: 12,
                              marginBottom: 14,
                              overflow: 'hidden',
                              background: 'var(--white)',
                            }}
                          >
                            {/* Banner header */}
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 14,
                                padding: '12px 16px',
                                background:
                                  'linear-gradient(90deg, var(--ink) 0%, var(--ink2) 100%)',
                                color: '#fff',
                                borderLeft: '3px solid var(--teal)',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 14,
                                  minWidth: 0,
                                }}
                              >
                                <div
                                  style={{
                                    width: 36,
                                    height: 36,
                                    borderRadius: 8,
                                    background: 'rgba(15,143,74,0.18)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: 'var(--teal)',
                                    flexShrink: 0,
                                  }}
                                >
                                  <Icon.Whistle />
                                </div>
                                <div style={{ minWidth: 0 }}>
                                  <div
                                    style={{
                                      fontSize: 10,
                                      letterSpacing: '0.12em',
                                      textTransform: 'uppercase',
                                      opacity: 0.65,
                                      fontFamily: "'Montserrat',sans-serif",
                                      fontWeight: 700,
                                    }}
                                  >
                                    {L.group}
                                  </div>
                                  <div
                                    style={{
                                      fontFamily: "'Montserrat',sans-serif",
                                      fontSize: 15,
                                      fontWeight: 700,
                                      marginTop: 2,
                                    }}
                                  >
                                    {L.label}
                                  </div>
                                </div>
                              </div>
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 10,
                                  flexShrink: 0,
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 11,
                                    letterSpacing: '0.08em',
                                    textTransform: 'uppercase',
                                    opacity: 0.7,
                                    fontFamily: "'Montserrat',sans-serif",
                                    fontWeight: 600,
                                  }}
                                >
                                  {rows.length} coach{rows.length === 1 ? '' : 'es'}
                                </span>
                                <Btn
                                  tone="teal"
                                  size="sm"
                                  icon={Icon.Plus}
                                  onClick={() => addCoachForLeague(key)}
                                >
                                  Add coach
                                </Btn>
                              </div>
                            </div>

                            {/* Banner body */}
                            <div style={{ padding: '12px 14px' }}>
                              {rows.length === 0 ? (
                                <div
                                  style={{
                                    padding: '18px 12px',
                                    textAlign: 'center',
                                    color: 'var(--muted)',
                                    fontSize: 12.5,
                                  }}
                                >
                                  No coach assigned to{' '}
                                  <strong style={{ color: 'var(--ink)' }}>{L.label}</strong> yet —
                                  click <em>Add coach</em>.
                                </div>
                              ) : (
                                rows.map(({ c, i: idx }) => {
                                  const otherTeams = c.teams.filter((t) => t !== key);
                                  return (
                                    <div
                                      key={idx}
                                      style={{
                                        padding: '14px 14px',
                                        border: '1px solid var(--line)',
                                        borderRadius: 10,
                                        marginBottom: 10,
                                        background: c.name
                                          ? 'rgba(15,143,74,0.04)'
                                          : 'var(--paper)',
                                      }}
                                    >
                                      <div
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'space-between',
                                          marginBottom: 10,
                                        }}
                                      >
                                        <div
                                          style={{
                                            fontFamily: "'Montserrat',sans-serif",
                                            fontSize: 12.5,
                                            fontWeight: 700,
                                            color: 'var(--ink)',
                                            letterSpacing: '0.04em',
                                          }}
                                        >
                                          Coach #{idx + 1}
                                          {otherTeams.length > 0 && (
                                            <span
                                              style={{
                                                marginLeft: 10,
                                                fontSize: 10.5,
                                                fontWeight: 500,
                                                color: 'var(--muted)',
                                                letterSpacing: '0.08em',
                                                textTransform: 'uppercase',
                                              }}
                                            >
                                              · also:{' '}
                                              {otherTeams
                                                .map((t) => findByKey(allLeagues, t)?.label ?? t)
                                                .join(', ')}
                                            </span>
                                          )}
                                        </div>
                                        <div
                                          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                                        >
                                          {c.name && (
                                            <Pill tone="teal" dot>
                                              Captured
                                            </Pill>
                                          )}
                                          <Btn
                                            tone="ghost"
                                            size="sm"
                                            onClick={() => toggleCoachTeam(idx, key)}
                                          >
                                            Remove from {L.label}
                                          </Btn>
                                        </div>
                                      </div>
                                      <div className="field-grid-4">
                                        <div className="field" style={{ marginBottom: 8 }}>
                                          <div className="field-label">Coach Name</div>
                                          <input
                                            className="field-input"
                                            placeholder="Name &amp; surname"
                                            value={c.name}
                                            onChange={(e) =>
                                              updateCoach(idx, 'name', e.target.value)
                                            }
                                          />
                                        </div>
                                        <div className="field" style={{ marginBottom: 8 }}>
                                          <div className="field-label">Coaching Body</div>
                                          <select
                                            className="field-select"
                                            value={c.body}
                                            onChange={(e) =>
                                              updateCoach(idx, 'body', e.target.value)
                                            }
                                          >
                                            {COACHING_BODIES.map((b) => (
                                              <option key={b}>{b}</option>
                                            ))}
                                          </select>
                                        </div>
                                        <div className="field" style={{ marginBottom: 8 }}>
                                          <div className="field-label">Coaching Level</div>
                                          <select
                                            className="field-select"
                                            value={c.level}
                                            onChange={(e) =>
                                              updateCoach(idx, 'level', e.target.value)
                                            }
                                          >
                                            {COACHING_LEVELS.map((l) => (
                                              <option key={l}>{l}</option>
                                            ))}
                                          </select>
                                        </div>
                                        <div className="field" style={{ marginBottom: 8 }}>
                                          <div className="field-label">Status</div>
                                          <select
                                            className="field-select"
                                            value={c.status}
                                            onChange={(e) =>
                                              updateCoach(idx, 'status', e.target.value)
                                            }
                                          >
                                            <option>Completed</option>
                                            <option>In progress</option>
                                            <option>Not completed</option>
                                          </select>
                                        </div>
                                      </div>
                                      <div className="field-grid-2">
                                        <div className="field" style={{ marginBottom: 10 }}>
                                          <div className="field-label">Contact Number</div>
                                          <input
                                            className="field-input"
                                            placeholder="0XX XXX XXXX"
                                            value={c.cell}
                                            onChange={(e) =>
                                              updateCoach(idx, 'cell', e.target.value)
                                            }
                                          />
                                        </div>
                                        <div className="field" style={{ marginBottom: 10 }}>
                                          <div className="field-label">Email</div>
                                          <input
                                            className="field-input"
                                            placeholder="coach@club.co.za"
                                            value={c.email}
                                            onChange={(e) =>
                                              updateCoach(idx, 'email', e.target.value)
                                            }
                                          />
                                        </div>
                                      </div>

                                      {/* Cross-tag the same coach to other designations */}
                                      <div className="trb">
                                        <div className="trb-head">
                                          <span className="trb-label">Also coaches</span>
                                          <span className="trb-count filled">
                                            {c.teams.length} of {selectedLeagueKeys.length}{' '}
                                            designations
                                          </span>
                                        </div>
                                        <div className="trb-chips">
                                          {selectedLeagueKeys
                                            .filter((k) => k !== key)
                                            .map((k) => {
                                              const on = c.teams.includes(k);
                                              return (
                                                <button
                                                  key={k}
                                                  className={`trb-chip ${on ? 'on' : ''}`}
                                                  onClick={() => toggleCoachTeam(idx, k)}
                                                >
                                                  <span className="trb-chip-tick">
                                                    {on ? <Icon.Check /> : null}
                                                  </span>
                                                  {findByKey(allLeagues, k)?.label ?? k}
                                                </button>
                                              );
                                            })}
                                          {selectedLeagueKeys.length === 1 && (
                                            <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                                              Select another league above to cross-tag this coach.
                                            </span>
                                          )}
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </Card>
                );
              })()}

            {step < TOTAL_STEPS && (
              <div className="row" style={{ marginTop: 14, justifyContent: 'space-between' }}>
                <Btn
                  tone="ghost"
                  onClick={() => step > 1 && setStep(step - 1)}
                  disabled={step === 1}
                >
                  ← Back
                </Btn>
                <div className="row" style={{ gap: 8 }}>
                  <Btn tone="outline" size="sm" onClick={saveDraft} disabled={savingDraft}>
                    Save draft
                  </Btn>
                  <Btn tone="ink" onClick={() => setStep(step + 1)} disabled={step === 1 && !valid}>
                    Continue →
                  </Btn>
                </div>
              </div>
            )}

            {step === TOTAL_STEPS && (
              <div className="row" style={{ marginTop: 14, justifyContent: 'space-between' }}>
                <Btn tone="ghost" onClick={() => step > 1 && setStep(step - 1)}>
                  ← Back
                </Btn>
                <div className="row" style={{ gap: 8 }}>
                  <Btn tone="outline" size="sm" onClick={saveDraft} disabled={savingDraft}>
                    Save draft
                  </Btn>
                  <Btn
                    tone="teal"
                    icon={Icon.Check}
                    onClick={() => {
                      onSubmit({
                        district: data.district,
                        exco: getExcoPayload(),
                        coaches: getCoachesPayload(),
                        ground: getGroundPayload(),
                        leagues: getLeaguesPayload(),
                      });
                      toast('Affiliation submitted · Exco roster & leagues captured');
                    }}
                  >
                    Submit affiliation
                  </Btn>
                </div>
              </div>
            )}
          </fieldset>

          {viewOnly && (
            <div className="row" style={{ marginTop: 14, justifyContent: 'space-between', gap: 8 }}>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  fontFamily: "'Montserrat',sans-serif",
                  fontWeight: 500,
                }}
              >
                Need a change? Contact the Union office to amend.
              </div>
              <div className="row" style={{ gap: 8 }}>
                <Btn
                  tone="outline"
                  icon={Icon.Mail}
                  size="sm"
                  onClick={() =>
                    unionEmail
                      ? (window.location.href = `mailto:${unionEmail}?subject=${encodeURIComponent(
                          'Affiliation amendment request — ' + club.name,
                        )}`)
                      : toast('Union office contact unavailable', 'warn')
                  }
                >
                  Request amendment
                </Btn>
                <Btn tone="ink" onClick={() => goto('home')}>
                  Close
                </Btn>
              </div>
            </div>
          )}
        </div>

        {/* ─── Right-side sticky hero + live summary ─── */}
        <aside className="aff-side">
          <div
            className="aff-hero-card"
            style={{ backgroundImage: "url('/venues/kingsmead-stadium.jpg')" }}
          >
            <div className="aff-hero-content">
              <div className="aff-hero-badge">
                <span className="dot" />
                Affiliation · Step {step} / {TOTAL_STEPS}
              </div>
              <div>
                <div className="aff-hero-title">
                  Your club, <em>on the same platform</em> as our heroes.
                </div>
                <div className="aff-hero-sub">
                  Affiliated clubs join the Hollywoodbets Dolphins ecosystem — fixtures, talent ID,
                  clinical data and franchise readiness, all in one place.
                </div>
                <div className="aff-hero-credit">Hollywoodbets Dolphins</div>
              </div>
            </div>
          </div>

          <div className="aff-progress-pill">
            <div className="aff-progress-num">
              {step}
              <span style={{ color: 'var(--muted-3)', fontSize: 13, fontWeight: 500 }}>
                /{TOTAL_STEPS}
              </span>
            </div>
            <div className="aff-progress-info">
              <div className="aff-progress-label">You're on</div>
              <div className="aff-progress-sub">{stepLabel}</div>
            </div>
          </div>

          <div className="aff-summary">
            <div className="aff-summary-head">
              <div className="aff-summary-title">Your application</div>
              <div className="aff-summary-step">Live</div>
            </div>
            <div className="aff-summary-row">
              <div className="aff-summary-label">Club</div>
              <div className={`aff-summary-value ${!data.clubName ? 'muted' : ''}`}>
                {data.clubName || '—'}
              </div>
            </div>
            <div className="aff-summary-row">
              <div className="aff-summary-label">District</div>
              <div className={`aff-summary-value ${!data.district ? 'muted' : ''}`}>
                {data.district || '—'}
              </div>
            </div>
            <div className="aff-summary-row">
              <div className="aff-summary-label">Home ground</div>
              <div className={`aff-summary-value ${!data.groundVenue ? 'muted' : ''}`}>
                {data.groundVenue || '—'}
              </div>
            </div>
            <div className="aff-summary-row">
              <div className="aff-summary-label">Exco bearers</div>
              <div className={`aff-summary-value ${filledBearers === 0 ? 'muted' : ''}`}>
                {filledBearers ? `${filledBearers} captured` : '—'}
              </div>
            </div>
            <div className="aff-summary-row">
              <div className="aff-summary-label">Leagues</div>
              <div className={`aff-summary-value ${leaguesCount === 0 ? 'muted' : ''}`}>
                {leaguesCount ? `${leaguesCount} entered` : '—'}
              </div>
            </div>
            <div className="aff-summary-row">
              <div className="aff-summary-label">Coaches</div>
              <div className={`aff-summary-value ${coachesCount === 0 ? 'muted' : ''}`}>
                {coachesCount ? `${coachesCount} listed` : '—'}
              </div>
            </div>
            <div className="aff-summary-foot">
              Submitting to the <strong>Dolphins office</strong> · Cricket Services
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ─── Document upload + Exco form ─── */
const FIXED_EXCO_ROLES = [
  { key: 'chair', label: 'Chairperson', required: true },
  { key: 'sec', label: 'Secretary', required: true },
  { key: 'tre', label: 'Treasurer', required: true },
  { key: 'vc', label: 'Vice-Chair', required: false },
];

function ExcoFormModal({ club, onClose, onSave }) {
  const [members, setMembers] = useStateC(() => {
    // Fixed roles from club.exco
    const init = {};
    const stored = club.exco || {};
    FIXED_EXCO_ROLES.forEach((r) => {
      const s = stored[r.key];
      if (s) {
        init[r.key] = {
          name: s.name || '',
          cell: s.cell || '',
          email: s.email || '',
          gender: s.gender || '',
          race: s.race || '',
        };
      } else {
        init[r.key] = {
          name: r.key === 'chair' ? club.chair : '',
          cell: r.key === 'chair' ? '083 786 4098' : '',
          email: r.key === 'chair' ? 'chair@' + club.id + '.co.za' : '',
          gender: r.key === 'chair' ? 'Male' : '',
          race: r.key === 'chair' ? 'Indian' : '',
        };
      }
    });
    return init;
  });
  // Additional members are a separate array
  const [additionalMembers, setAdditionalMembers] = useStateC(() => {
    const stored = club.exco?.additionalMembers;
    if (Array.isArray(stored) && stored.length) return stored;
    return [];
  });

  function update(role, field, val) {
    setMembers((m) => ({ ...m, [role]: { ...m[role], [field]: val } }));
  }
  function updateAdditional(idx, field, val) {
    setAdditionalMembers((arr) => arr.map((m, i) => (i === idx ? { ...m, [field]: val } : m)));
  }
  function addAdditional() {
    setAdditionalMembers((arr) => [
      ...arr,
      { name: '', cell: '', email: '', gender: '', race: '' },
    ]);
  }
  function removeAdditional(idx) {
    setAdditionalMembers((arr) => arr.filter((_, i) => i !== idx));
  }

  const requiredFilled = FIXED_EXCO_ROLES.filter((r) => r.required).every(
    (r) => members[r.key].name && members[r.key].cell && members[r.key].email,
  );
  const completedCount =
    FIXED_EXCO_ROLES.filter((r) => members[r.key].name).length +
    additionalMembers.filter((m) => m.name).length;

  return (
    <div className="ob-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="ob-modal" style={{ width: 880, maxHeight: '92vh' }}>
        <div className="ob-head">
          <div>
            <div
              style={{
                fontFamily: "'Montserrat',sans-serif",
                fontSize: 10.5,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--muted-2)',
              }}
            >
              Compliance Template
            </div>
            <div
              style={{
                fontFamily: "'Montserrat',sans-serif",
                fontSize: 18,
                fontWeight: 700,
                marginTop: 3,
              }}
            >
              Executive Committee Roster
            </div>
          </div>
          <span className="ob-step-label" style={{ marginLeft: 'auto' }}>
            {completedCount} bearer{completedCount === 1 ? '' : 's'} captured
          </span>
          <button className="ob-close" onClick={onClose} title="Close (your draft is preserved)">
            <Icon.X />
          </button>
        </div>

        <div style={{ padding: '20px 26px', overflowY: 'auto' }}>
          <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 18 }}>
            Capture every executive committee bearer with their contact details. This roster is what
            the Union office uses for official correspondence — no PDF upload needed.
          </p>

          {FIXED_EXCO_ROLES.map((role, idx) => (
            <div
              key={role.key}
              style={{
                padding: '16px 18px',
                border: '1px solid var(--line)',
                borderRadius: 10,
                marginBottom: 10,
                background: members[role.key].name ? 'rgba(15,143,74,0.04)' : 'var(--paper)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    fontFamily: "'Montserrat',sans-serif",
                    fontSize: 13.5,
                    fontWeight: 700,
                    color: 'var(--ink)',
                  }}
                >
                  {role.label}
                  {role.required && <span style={{ color: 'var(--coral)', marginLeft: 4 }}>*</span>}
                  {!role.required && (
                    <span
                      style={{
                        fontSize: 10.5,
                        color: 'var(--muted-2)',
                        marginLeft: 8,
                        fontWeight: 500,
                        fontFamily: "'Montserrat',sans-serif",
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                      }}
                    >
                      Optional
                    </span>
                  )}
                </div>
                {members[role.key].name && (
                  <Pill tone="teal" dot>
                    Captured
                  </Pill>
                )}
              </div>
              <div className="field-grid-3">
                <div className="field" style={{ marginBottom: 8 }}>
                  <div className="field-label">Full Name</div>
                  <input
                    className="field-input"
                    value={members[role.key].name}
                    placeholder="Name &amp; surname"
                    onChange={(e) => update(role.key, 'name', e.target.value)}
                  />
                </div>
                <div className="field" style={{ marginBottom: 8 }}>
                  <div className="field-label">Cell Number</div>
                  <input
                    className="field-input"
                    value={members[role.key].cell}
                    placeholder="0XX XXX XXXX"
                    onChange={(e) => update(role.key, 'cell', e.target.value)}
                  />
                </div>
                <div className="field" style={{ marginBottom: 8 }}>
                  <div className="field-label">Email</div>
                  <input
                    className="field-input"
                    value={members[role.key].email}
                    placeholder="name@club.co.za"
                    onChange={(e) => update(role.key, 'email', e.target.value)}
                  />
                </div>
              </div>
              <div className="field-grid-2">
                <div className="field" style={{ marginBottom: 0 }}>
                  <div className="field-label">Gender</div>
                  <select
                    className="field-select"
                    value={members[role.key].gender}
                    onChange={(e) => update(role.key, 'gender', e.target.value)}
                  >
                    <option value="">Select…</option>
                    <option>Female</option>
                    <option>Male</option>
                    <option>Non-binary</option>
                  </select>
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <div className="field-label">Race</div>
                  <select
                    className="field-select"
                    value={members[role.key].race}
                    onChange={(e) => update(role.key, 'race', e.target.value)}
                  >
                    <option value="">Select…</option>
                    <option>Black African</option>
                    <option>Coloured</option>
                    <option>Indian</option>
                    <option>White</option>
                  </select>
                </div>
              </div>
            </div>
          ))}

          {/* Additional members — dynamic list */}
          <div
            style={{
              marginTop: 18,
              marginBottom: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <div
                style={{
                  fontFamily: "'Montserrat',sans-serif",
                  fontSize: 13.5,
                  fontWeight: 700,
                  color: 'var(--ink)',
                }}
              >
                Additional Members
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
                Add any further committee reps or office bearers.
              </div>
            </div>
            <Btn tone="outline" size="sm" icon={Icon.Plus} onClick={addAdditional}>
              Add member
            </Btn>
          </div>
          {additionalMembers.length === 0 && (
            <div
              style={{
                padding: '22px',
                border: '1px dashed var(--paper3)',
                borderRadius: 10,
                background: 'var(--paper)',
                color: 'var(--muted)',
                fontSize: 12.5,
                textAlign: 'center',
              }}
            >
              No additional members yet — click "Add member" to capture one.
            </div>
          )}
          {additionalMembers.map((m, idx) => (
            <div
              key={idx}
              style={{
                padding: '16px 18px',
                border: '1px solid var(--line)',
                borderRadius: 10,
                marginBottom: 10,
                background: m.name ? 'rgba(15,143,74,0.04)' : 'var(--paper)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: 12,
                }}
              >
                <div
                  style={{
                    fontFamily: "'Montserrat',sans-serif",
                    fontSize: 13.5,
                    fontWeight: 700,
                    color: 'var(--ink)',
                  }}
                >
                  Additional Member{' '}
                  <span style={{ color: 'var(--muted-2)', fontWeight: 500 }}>#{idx + 1}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  {m.name && (
                    <Pill tone="teal" dot>
                      Captured
                    </Pill>
                  )}
                  <Btn tone="ghost" size="sm" onClick={() => removeAdditional(idx)}>
                    Remove
                  </Btn>
                </div>
              </div>
              <div className="field-grid-3">
                <div className="field" style={{ marginBottom: 8 }}>
                  <div className="field-label">Full Name</div>
                  <input
                    className="field-input"
                    value={m.name}
                    placeholder="Name &amp; surname"
                    onChange={(e) => updateAdditional(idx, 'name', e.target.value)}
                  />
                </div>
                <div className="field" style={{ marginBottom: 8 }}>
                  <div className="field-label">Cell Number</div>
                  <input
                    className="field-input"
                    value={m.cell}
                    placeholder="0XX XXX XXXX"
                    onChange={(e) => updateAdditional(idx, 'cell', e.target.value)}
                  />
                </div>
                <div className="field" style={{ marginBottom: 8 }}>
                  <div className="field-label">Email</div>
                  <input
                    className="field-input"
                    value={m.email}
                    placeholder="name@club.co.za"
                    onChange={(e) => updateAdditional(idx, 'email', e.target.value)}
                  />
                </div>
              </div>
              <div className="field-grid-2">
                <div className="field" style={{ marginBottom: 0 }}>
                  <div className="field-label">Gender</div>
                  <select
                    className="field-select"
                    value={m.gender}
                    onChange={(e) => updateAdditional(idx, 'gender', e.target.value)}
                  >
                    <option value="">Select…</option>
                    <option>Female</option>
                    <option>Male</option>
                    <option>Non-binary</option>
                  </select>
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <div className="field-label">Race</div>
                  <select
                    className="field-select"
                    value={m.race}
                    onChange={(e) => updateAdditional(idx, 'race', e.target.value)}
                  >
                    <option value="">Select…</option>
                    <option>Black African</option>
                    <option>Coloured</option>
                    <option>Indian</option>
                    <option>White</option>
                  </select>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="ob-foot">
          <div className="ob-foot-hint">
            {requiredFilled
              ? `${completedCount} bearer${completedCount === 1 ? '' : 's'} ready to submit`
              : 'Chair, Secretary & Treasurer are required to submit'}
          </div>
          <div className="ob-foot-buttons">
            <Btn tone="ghost" onClick={onClose}>
              Save draft &amp; close
            </Btn>
            <Btn
              tone="teal"
              icon={Icon.Check}
              disabled={!requiredFilled}
              onClick={() =>
                requiredFilled &&
                onSave({ ...members, additionalMembers: additionalMembers.filter((m) => m.name) })
              }
            >
              Submit roster
            </Btn>
          </div>
        </div>
      </div>
    </div>
  );
}

export function DocumentsView({
  club,
  goto,
  toast,
  onUpload,
  onRemoveFile,
  onSaveExco,
  submissionDeadline,
  unionEmail,
}) {
  const deadlineShort = formatDeadlineShort(submissionDeadline);
  const daysLeft = daysUntil(submissionDeadline);
  const daysLabel =
    daysLeft === 0
      ? 'Deadline today'
      : daysLeft === 1
        ? '1 day remaining'
        : `${daysLeft} days remaining`;
  const dc = docCompletion(club);
  const [showExcoForm, setShowExcoForm] = useStateC(false);
  const [preview, setPreview] = useStateC(null);
  // Pending safeguarding-file removal ({ key, entry }) awaiting the confirm modal —
  // deletion also removes the S3 object, so a stray click must not be enough.
  const [confirmRemove, setConfirmRemove] = useStateC(null);
  const excoBearerCount = (() => {
    if (!club.exco) return 0;
    const fixed = FIXED_EXCO_ROLES.filter((r) => club.exco[r.key]?.name).length;
    const extra = (club.exco.additionalMembers || []).filter((m) => m.name).length;
    return fixed + extra;
  })();

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">
            <a onClick={() => goto('home')}>Home</a> &nbsp;/&nbsp; Compliance Documents
          </div>
          <h1 className="ph-title">
            Required <em>compliance documents</em>
          </h1>
          <p className="ph-desc">
            Per the 2026/27 Cricket Services Club Requirements, {REQUIRED_DOCS.length - 1} documents
            must be uploaded and one roster captured directly on the platform. PDF or Word documents
            — max 10 MB per file.
          </p>
        </div>
      </div>

      <div className="kpi-strip" style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <KPI
          tone="teal"
          label="Submitted"
          num={docsUploadedCount(club)}
          sub={`of ${REQUIRED_DOCS.length} required`}
        />
        <KPI
          tone="coral"
          label="Outstanding"
          num={REQUIRED_DOCS.length - docsUploadedCount(club)}
          sub="needs attention"
        />
        <KPI label="Completion" num={dc + '%'} sub="overall" />
        <KPI tone="gold" label="Deadline" num={deadlineShort} sub={daysLabel} />
      </div>

      <Card
        title="Submit your documents"
        sub={`${REQUIRED_DOCS.length - 1} file uploads · 1 on-platform form`}
      >
        {REQUIRED_DOCS.map((d) => {
          const up = club.docs[d.key];
          const isExco = d.key === 'exco';
          const isSafeguarding = d.key === 'safeguarding';
          // Real uploads carry docMeta with an objectKey; an admin "mark compliant"
          // override sets the flag with no file. Demo/local mode has no docMeta at all
          // but should still preview the bundled sample. Safeguarding is multi-file:
          // one certificate per person, at least two people.
          const meta = club.docMeta?.[d.key];
          const demo = import.meta.env.VITE_LOCAL_AUTH === '1';
          const { real, metaText } = docFileMeta(meta);
          const sg = isSafeguarding ? safeguardingMeta(meta) : null;
          return (
            <div key={d.key} className={`doc-row ${up ? 'uploaded' : ''}`}>
              <div className="doc-icon">{isExco ? <Icon.Form /> : <Icon.Doc />}</div>
              <div className="doc-info">
                <div className="doc-name">
                  {d.name}
                  {isExco && (
                    <span
                      style={{
                        fontSize: 9.5,
                        marginLeft: 8,
                        padding: '2px 7px',
                        borderRadius: 10,
                        background: 'rgba(10,15,20,0.08)',
                        color: 'var(--navy)',
                        fontFamily: "'Montserrat',sans-serif",
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        fontWeight: 600,
                      }}
                    >
                      On-platform
                    </span>
                  )}
                </div>
                <div className="doc-meta">
                  {isSafeguarding ? (
                    sg.files.length ? (
                      <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                        {sg.files.map((f) => {
                          const fm = docFileMeta(f);
                          return (
                            <span key={f.objectKey}>
                              {/* Real buttons (not the codebase's <a onClick> habit):
                                  keyboard focus matters here — View is per-file and
                                  Remove is destructive (gated by the confirm modal). */}
                              {fm.metaText || 'Document'} ·{' '}
                              <button
                                type="button"
                                onClick={() => setPreview({ key: d.key, entry: f })}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: 0,
                                  font: 'inherit',
                                  color: 'var(--teal-deep)',
                                  cursor: 'pointer',
                                }}
                              >
                                View
                              </button>{' '}
                              ·{' '}
                              <button
                                type="button"
                                onClick={() => setConfirmRemove({ key: d.key, entry: f })}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  padding: 0,
                                  font: 'inherit',
                                  color: 'var(--coral)',
                                  cursor: 'pointer',
                                }}
                              >
                                Remove
                              </button>
                            </span>
                          );
                        })}
                        {sg.files.length < MIN_SAFEGUARDING_FILES && !up && <span>{d.desc}</span>}
                      </span>
                    ) : (
                      d.desc
                    )
                  ) : up ? (
                    isExco ? (
                      <span>
                        Roster captured · {excoBearerCount} bearer{excoBearerCount === 1 ? '' : 's'}{' '}
                        · synced from your affiliation form ·{' '}
                        <a
                          style={{ color: 'var(--teal-deep)', cursor: 'pointer' }}
                          onClick={() => setShowExcoForm(true)}
                        >
                          Edit
                        </a>
                      </span>
                    ) : (
                      <span>
                        {metaText || 'Document'} ·{' '}
                        <DocUploadButton
                          clubId={club.id}
                          docKey={d.key}
                          label={d.name}
                          onUploaded={onUpload}
                          toast={toast}
                          variant="link"
                        />
                      </span>
                    )
                  ) : isExco ? (
                    <span>
                      Auto-captured from the affiliation form, or{' '}
                      <a
                        style={{ color: 'var(--teal-deep)', cursor: 'pointer' }}
                        onClick={() => setShowExcoForm(true)}
                      >
                        complete the roster here
                      </a>
                    </span>
                  ) : (
                    d.desc
                  )}
                </div>
              </div>
              {isSafeguarding ? (
                <>
                  {up ? (
                    <Pill tone="teal" dot>
                      Uploaded
                    </Pill>
                  ) : sg.files.length ? (
                    <Pill tone="gold" dot>
                      {sg.files.length} of {MIN_SAFEGUARDING_FILES} minimum
                    </Pill>
                  ) : null}
                  <DocUploadButton
                    clubId={club.id}
                    docKey={d.key}
                    label={d.name}
                    onUploaded={onUpload}
                    toast={toast}
                    buttonLabel="Add certificate"
                  />
                </>
              ) : up ? (
                <>
                  <Pill tone="teal" dot>
                    {isExco ? 'Completed' : 'Uploaded'}
                  </Pill>
                  {!isExco && (real || demo) && (
                    <Btn
                      tone="ghost"
                      size="sm"
                      icon={Icon.Eye}
                      title={`View ${d.name}`}
                      onClick={() => setPreview({ key: d.key })}
                    />
                  )}
                </>
              ) : isExco ? (
                <Btn tone="ink" size="sm" icon={Icon.Form} onClick={() => setShowExcoForm(true)}>
                  Complete form
                </Btn>
              ) : (
                <DocUploadButton
                  clubId={club.id}
                  docKey={d.key}
                  label={d.name}
                  onUploaded={onUpload}
                  toast={toast}
                />
              )}
            </div>
          );
        })}
      </Card>

      {showExcoForm && (
        <ExcoFormModal
          club={club}
          onClose={() => setShowExcoForm(false)}
          onSave={(members) => {
            onSaveExco(members);
            setShowExcoForm(false);
            const count = Object.values(members).filter((m) => m.name).length;
            toast(
              `Exco roster ${club.docs.exco ? 'updated' : 'submitted'} · ${count} bearer${count === 1 ? '' : 's'}`,
            );
          }}
        />
      )}

      {preview && (
        <DocPreviewModal
          clubId={club.id}
          docKey={preview.key}
          docName={REQUIRED_DOCS.find((d) => d.key === preview.key)?.name || 'Document'}
          clubName={club.name}
          // Safeguarding passes the selected file entry (the wrapper has no
          // objectKey of its own); single-file docs pass their stored meta.
          meta={preview.entry ?? club.docMeta?.[preview.key]}
          objectKey={preview.entry?.objectKey}
          onClose={() => setPreview(null)}
        />
      )}

      {confirmRemove &&
        // Portaled: the page root's fadeUp animation retains a transform, which
        // would otherwise become this fixed backdrop's containing block (same
        // trap documented on the admin confirm modal).
        createPortal(
          <div
            className="fix-confirm"
            onClick={(e) => e.target === e.currentTarget && setConfirmRemove(null)}
          >
            <div className="fix-confirm-box">
              <div className="fix-confirm-icon danger">
                <Icon.Alert />
              </div>
              <div className="fix-confirm-title">Remove this certificate?</div>
              <div className="fix-confirm-body">
                <strong>{docFileMeta(confirmRemove.entry).fileName || 'This certificate'}</strong>{' '}
                will be permanently deleted — there is no undo, and the holder would need to upload
                it again.
              </div>
              <div className="fix-confirm-actions">
                <Btn tone="outline" onClick={() => setConfirmRemove(null)}>
                  Cancel
                </Btn>
                <Btn
                  tone="ink"
                  onClick={() => {
                    const { key, entry } = confirmRemove;
                    setConfirmRemove(null);
                    onRemoveFile(key, entry.objectKey);
                  }}
                >
                  Yes, remove
                </Btn>
              </div>
            </div>
          </div>,
          document.body,
        )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginTop: 16 }}>
        <Card title="What we check">
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <li className="row" style={{ gap: 10, fontSize: 13, color: 'var(--ink3)' }}>
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: 'var(--teal-pale)',
                  color: 'var(--teal-deep)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon.Check />
              </span>
              Constitution is current (signed within the last 2 years)
            </li>
            <li className="row" style={{ gap: 10, fontSize: 13, color: 'var(--ink3)' }}>
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: 'var(--teal-pale)',
                  color: 'var(--teal-deep)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon.Check />
              </span>
              AGM Minutes are signed by Chair &amp; Secretary
            </li>
            <li className="row" style={{ gap: 10, fontSize: 13, color: 'var(--ink3)' }}>
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: 'var(--teal-pale)',
                  color: 'var(--teal-deep)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon.Check />
              </span>
              Financials cover the prior season &amp; show member income
            </li>
            <li className="row" style={{ gap: 10, fontSize: 13, color: 'var(--ink3)' }}>
              <span
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  background: 'var(--teal-pale)',
                  color: 'var(--teal-deep)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <Icon.Check />
              </span>
              Exco list includes Chair, Secretary, Treasurer + Vice-Chair
            </li>
          </ul>
        </Card>

        <Card title="Need help?">
          <p style={{ fontSize: 13, color: 'var(--ink3)', lineHeight: 1.6 }}>
            If your club is missing one of the required documents, reach out to the Union office
            {unionEmail ? (
              <>
                {' '}
                at <strong style={{ color: 'var(--navy)' }}>{unionEmail}</strong>
              </>
            ) : null}
            .
          </p>
          <div className="row" style={{ marginTop: 12, gap: 8 }}>
            <Btn
              tone="outline"
              icon={Icon.Mail}
              size="sm"
              onClick={() =>
                unionEmail
                  ? (window.location.href = `mailto:${unionEmail}?subject=${encodeURIComponent(
                      'Compliance documents — ' + club.name,
                    )}`)
                  : toast('Union office contact unavailable', 'warn')
              }
            >
              Contact union
            </Btn>
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ─── CQI Self-Assessment ─── */
export function CQIView({ club, goto, toast, onSubmit, submissionDeadline, allLeagues = [] }) {
  const deadlineLong = formatDeadlineLong(submissionDeadline);
  const [answers, setAnswers] = useStateC(() => {
    // Prefer the real stored answers (persisted on submit). Only fall back to the
    // score-band approximation for legacy clubs that have a score but no answers.
    if (club.cqiAnswers && Object.keys(club.cqiAnswers).length) {
      return { ...club.cqiAnswers };
    }
    const a = {};
    if (club.cqi > 0) {
      // approximate defaults based on the club's score band
      a.constitution = !!club.docs.constitution;
      a.agm = !!club.docs.agm;
      a.minutes = !!club.docs.agm;
      a.officers = true;
      a.conduct = true;
      a.inventory = true;
      a.playerdb = true;
      // Mirror the home-page glance card: team counts derive from leagues entered.
      const tc = teamCounts(club.leagues, allLeagues);
      a.senior = tc.senior;
      a.women = club.women;
      a.juniorB = tc.junior;
      a.juniorG = 0;
      a.premprom = true;
      a.coaches = 5;
      a.certified = 3;
      a.level2 = true;
      a.covers = true;
      a.boundary = true;
      a.scoreboard = true;
      a.ownFacility = false;
      a.fieldsGrass = 2;
      a.fieldsArt = 0;
      a.netsGrass = 4;
      a.netsArt = 2;
      a.pctBA = 7;
      a.pctIN = 9;
      a.pctWH = 5;
      a.pctCO = 2;
    }
    return a;
  });

  function setA(k, v) {
    setAnswers((a) => ({ ...a, [k]: v }));
  }

  const { total, byCat } = useMemoC(() => scoreCQI(answers), [answers]);
  const band = cqiBand(total || 0.0001);
  const submitted = club.cqi > 0;

  // Total players counted across demographics — informational only (no sum constraint).
  const repCount =
    (parseFloat(answers.pctBA) || 0) +
    (parseFloat(answers.pctIN) || 0) +
    (parseFloat(answers.pctCO) || 0) +
    (parseFloat(answers.pctWH) || 0);

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">
            <a onClick={() => goto('home')}>Home</a> &nbsp;/&nbsp; CQI Self-Assessment
          </div>
          <h1 className="ph-title">
            Club Quality <em>Index</em> · 2026/27
          </h1>
          <p className="ph-desc">
            Score your club across six dimensions of capability. Your responses are scored in real
            time using the official Dolphins CQI weighting model — administration 20 pts, teams 20
            pts, coaching 20 pts, facilities 15 pts, representation 10 pts, financial sustainability
            15 pts.
          </p>
        </div>
      </div>

      {/* Live total score */}
      <div className="total-score-block">
        <div className="tsb-num">
          <CountUp to={total} decimals={1} duration={600} />
        </div>
        <div className="tsb-mid">
          <div className="tsb-l">Live CQI score · auto-calculated</div>
          <div className="tsb-title">
            {total >= 80
              ? 'A — Premier-grade club'
              : total >= 65
                ? 'B — Strong club, minor gaps'
                : total >= 50
                  ? 'C — Functional club, several gaps'
                  : total > 0
                    ? 'D — Major gaps to address'
                    : 'Begin your assessment to see your score'}
          </div>
          <div className="tsb-sub">
            Score updates as you answer questions. Submit when you're satisfied — your assessment is
            shared with the Union office for franchise tracking.
          </div>
          <div className="tsb-pbar">
            <div className="tsb-pbar-fill" style={{ width: total + '%' }} />
          </div>
        </div>
      </div>

      {/* Per-category scores */}
      <div className="score-grid">
        {CQI_STRUCTURE.map((cat) => {
          const s = byCat[cat.key];
          return (
            <div
              key={cat.key}
              className="score-card"
              style={{ '--fill': (s.earned / cat.possible) * 100 + '%', '--accent': cat.accent }}
            >
              <div>
                <span className="sc-cat">{cat.title}</span>
                <span className="sc-w">{cat.weight} pts</span>
              </div>
              <div className="sc-num">{s.earned.toFixed(1)}</div>
            </div>
          );
        })}
      </div>

      {/* Each category */}
      {CQI_STRUCTURE.map((cat, i) => (
        <div key={cat.key} className="cqi-section">
          <div className="cqi-section-head">
            <div className="cqi-section-num">{i + 1}</div>
            <div>
              <div className="cqi-section-title">{cat.title}</div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{cat.desc}</div>
            </div>
            <div className="cqi-section-w">Weight · {cat.weight} pts</div>
          </div>

          {cat.questions.map((q) => (
            <div key={q.key} className="cqi-q">
              <div>
                <div className="cqi-q-label">{q.label}</div>
                <div className="cqi-q-hint">
                  {q.kind === 'num'
                    ? `Number · max ${q.max}`
                    : q.kind === 'count'
                      ? `Number of players · max ${q.max}`
                      : q.kind === 'choice'
                        ? 'Select one'
                        : q.kind === 'money'
                          ? 'Currency · amount per player'
                          : 'Yes / No'}
                </div>
              </div>
              {q.kind === 'yn' && <YN value={answers[q.key]} onChange={(v) => setA(q.key, v)} />}
              {q.kind === 'num' && (
                <NumSlider value={answers[q.key]} onChange={(v) => setA(q.key, v)} max={q.max} />
              )}
              {q.kind === 'count' && (
                <NumSlider value={answers[q.key]} onChange={(v) => setA(q.key, v)} max={q.max} />
              )}
              {q.kind === 'choice' && (
                <Choice
                  value={answers[q.key]}
                  onChange={(v) => setA(q.key, v)}
                  options={q.options}
                />
              )}
              {q.kind === 'money' && (
                <MoneyInput
                  value={answers[q.key]}
                  onChange={(v) => setA(q.key, v)}
                  currency={q.currency || 'R'}
                  suffix="/ player"
                />
              )}
            </div>
          ))}

          {/* Representation total — informational headcount, no sum constraint */}
          {cat.key === 'representation' && (
            <div
              style={{
                padding: '8px 18px',
                fontSize: 11.5,
                fontFamily: "'Montserrat',sans-serif",
                color: 'var(--muted)',
              }}
            >
              Total players counted: {repCount.toFixed(0)} across demographics
            </div>
          )}
        </div>
      ))}

      <Card>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontFamily: "'Montserrat',sans-serif", fontSize: 15, fontWeight: 700 }}>
              {submitted ? 'Submitted on 16 May 2026' : 'Ready to submit?'}
            </div>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>
              {submitted
                ? `Your score has been forwarded to the Dolphins Admin office. You can re-submit any time before ${deadlineLong}.`
                : 'Your CQI will be visible to the Dolphins administrators alongside your affiliation and compliance documents.'}
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Btn tone="outline">Save draft</Btn>
            <Btn
              tone="teal"
              icon={Icon.Check}
              onClick={() => {
                onSubmit(total, answers);
                toast('CQI submitted · score ' + total.toFixed(1));
              }}
            >
              Submit CQI
            </Btn>
          </div>
        </div>
      </Card>
    </div>
  );
}

/* ─── Phase 2 · Club Fixtures (only shown once admin has released) ─── */
export function ClubFixturesView({ club, allSeries, clubs, toast, onSendFixtures }) {
  const clubBy = (id) => clubs.find((c) => c.id === id);

  // Only series this club is in AND that have been released by the Dolphins office
  const myReleased = (allSeries || []).filter((s) => s.released && s.teams.includes(club.id));

  // Share-with-players modal state. Hooks must run before the early return below.
  const [shareOpen, setShareOpen] = useStateC(false);
  const [shareCh, setShareCh] = useStateC({ email: true, whatsapp: true });
  const [sharing, setSharing] = useStateC(false);
  const playerCount = club.players || 0;

  // Broadcast the released schedule to the club's registered players. The schedule is
  // built server-side; we only pick channels. A fresh idempotency key per click lets a
  // legitimate re-share (e.g. after a new series is released) through, while the disabled
  // state guards against an in-flight double-submit.
  async function doShareFixtures() {
    const channels = ['email', 'whatsapp'].filter((c) => shareCh[c]);
    if (!channels.length) return toast?.('Pick at least one channel', 'warn');
    setSharing(true);
    try {
      const idempotencyKey =
        globalThis.crypto?.randomUUID?.() || `fx-${Date.now()}-${Math.round(Math.random() * 1e9)}`;
      const res = await onSendFixtures?.(club.id, { channels, idempotencyKey });
      const results = res?.results || [];
      const detail = results
        .map((r) => `${r.channel === 'email' ? 'Email' : 'WhatsApp'} — ${r.summary || r.status}`)
        .join(' · ');
      const anySent = results.some((r) => r.status === 'sent');
      toast?.(detail || 'Fixtures shared with players', anySent ? 'ok' : 'warn');
      setShareOpen(false);
    } catch (e) {
      toast?.(e?.message || 'Could not share fixtures', 'warn');
    } finally {
      setSharing(false);
    }
  }

  // No releases yet — elegant placeholder
  if (!myReleased.length) {
    return (
      <div>
        <div className="page-head">
          <div className="ph-left">
            <div className="ph-crumb">Club Portal · {club.name} / Fixtures</div>
            <h1 className="ph-title">
              Your <em>Fixtures</em>
            </h1>
            <p className="ph-desc">
              Your league schedule lands here the moment the Dolphins office releases it.
            </p>
          </div>
        </div>
        <div className="club-fix-empty">
          <div className="club-fix-empty-icon">
            <svg viewBox="0 0 24 24" fill="none">
              <rect
                x="3"
                y="5"
                width="18"
                height="16"
                rx="2"
                stroke="currentColor"
                strokeWidth="1.6"
              />
              <path
                d="M3 9h18M8 3v4M16 3v4"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div className="club-fix-empty-title">Awaiting release from the Dolphins office</div>
          <div className="club-fix-empty-sub">
            Once the union office signs off on the 2026/27 fixture list, every match you're playing
            — round, date, opponent, venue and travel costs — will populate here automatically.
            You'll also receive an email &amp; WhatsApp the moment it goes live.
          </div>
          <div className="club-fix-empty-meta">
            <span className="sdot" /> Status: <strong>Draft · awaiting release</strong>
          </div>
        </div>
      </div>
    );
  }

  // Aggregate totals across all released series this club is in
  let totalMatches = 0,
    homeMatches = 0,
    awayMatches = 0,
    totalKm = 0,
    totalCost = 0;
  let nextFixture = null;
  const todayISO = new Date().toISOString().slice(0, 10);

  myReleased.forEach((s) => {
    s.fixtures.forEach((f) => {
      if (f.home !== club.id && f.away !== club.id) return;
      totalMatches++;
      if (f.home === club.id) homeMatches++;
      else {
        awayMatches++;
        const home = clubBy(f.home);
        if (home && home.ground && club.ground) {
          const c = fixtureCost(home, club, s.costPerKm || 4.5, s.carsPerAwayTrip || 3);
          totalKm += c.roundTripKm;
          totalCost += c.fuelR;
        }
      }
      if (f.date >= todayISO && (!nextFixture || f.date < nextFixture.date)) {
        nextFixture = { ...f, seriesName: s.name };
      }
    });
  });

  const daysToNext = nextFixture
    ? Math.max(0, Math.ceil((new Date(nextFixture.date) - new Date(todayISO)) / 86400000))
    : null;

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Club Portal · {club.name} / Fixtures</div>
          <h1 className="ph-title">
            Your <em>Fixtures</em>
          </h1>
          <p className="ph-desc">
            {myReleased.length} {myReleased.length === 1 ? 'series' : 'series'} released by the
            Dolphins office. {totalMatches} matches across the 2026/27 season — {homeMatches} at
            home, {awayMatches} on the road.
          </p>
        </div>
        <div className="ph-actions">
          <Btn
            tone="outline"
            size="sm"
            icon={Icon.Mail}
            disabled={!playerCount}
            title={
              playerCount
                ? 'Email & WhatsApp the schedule to your registered players'
                : 'No registered players yet'
            }
            onClick={() => setShareOpen(true)}
          >
            Share with players
          </Btn>
        </div>
      </div>

      {/* Hero KPI band */}
      <div className="club-fix-kpis">
        <div className="club-fix-kpi">
          <div className="club-fix-kpi-l">Matches</div>
          <div className="club-fix-kpi-n">{totalMatches}</div>
          <div className="club-fix-kpi-meta">
            {homeMatches} home · {awayMatches} away
          </div>
        </div>
        <div className="club-fix-kpi">
          <div className="club-fix-kpi-l">Series</div>
          <div className="club-fix-kpi-n">{myReleased.length}</div>
          <div className="club-fix-kpi-meta">
            {myReleased.map((s) => s.name.split(' · ')[0]).join(', ')}
          </div>
        </div>
        <div className="club-fix-kpi">
          <div className="club-fix-kpi-l">Travel · away</div>
          <div className="club-fix-kpi-n">
            {Math.round(totalKm).toLocaleString()}{' '}
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--muted)' }}>km</span>
          </div>
          <div className="club-fix-kpi-meta">round-trip across all away games</div>
        </div>
        <div className="club-fix-kpi green">
          <div className="club-fix-kpi-l">Season fuel</div>
          <div className="club-fix-kpi-n">R {Math.round(totalCost).toLocaleString()}</div>
          <div className="club-fix-kpi-meta">
            est · {myReleased[0]?.carsPerAwayTrip || 3} cars × R {myReleased[0]?.costPerKm || 4.5}
            /km
          </div>
        </div>
      </div>

      {/* Next match countdown */}
      {nextFixture && (
        <div className="club-fix-next">
          <div className="club-fix-next-eyebrow">⏱ Next match</div>
          <div className="club-fix-next-body">
            <div className="club-fix-next-day">
              <div className="club-fix-next-day-n">{daysToNext}</div>
              <div className="club-fix-next-day-l">{daysToNext === 1 ? 'day' : 'days'}</div>
            </div>
            <div className="club-fix-next-detail">
              <div className="club-fix-next-title">
                {nextFixture.home === club.id ? 'vs' : 'away to'}{' '}
                <strong>
                  {clubBy(nextFixture.home === club.id ? nextFixture.away : nextFixture.home)
                    ?.name || 'TBA'}
                </strong>
              </div>
              <div className="club-fix-next-sub">
                {new Date(nextFixture.date).toLocaleDateString('en-GB', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}{' '}
                · {nextFixture.seriesName} · Round {nextFixture.round}
              </div>
            </div>
            <div className="club-fix-next-tag">
              {nextFixture.home === club.id ? (
                <Pill tone="teal" dot>
                  Home fixture
                </Pill>
              ) : (
                <Pill tone="gold" dot>
                  Away fixture
                </Pill>
              )}
            </div>
          </div>
        </div>
      )}

      {/* One block per released series */}
      {myReleased.map((s) => {
        const mine = s.fixtures
          .filter((f) => f.home === club.id || f.away === club.id)
          .sort((a, b) => a.date.localeCompare(b.date));

        return (
          <div key={s.id} className="club-fix-series">
            <div className="club-fix-series-head">
              <div>
                <div className="club-fix-series-eyebrow">
                  Released ·{' '}
                  {new Date(s.releasedAt).toLocaleDateString('en-GB', {
                    day: 'numeric',
                    month: 'short',
                    year: 'numeric',
                  })}
                </div>
                <div className="club-fix-series-name">{s.name}</div>
                <div className="club-fix-series-meta">
                  {s.teams.length} clubs · {s.maxOvers} overs · {s.seriesType} · {mine.length} of
                  your matches
                </div>
              </div>
              <div className="club-fix-series-tags">
                {(s.tags || []).map((t, i) => (
                  <Pill key={i} tone="muted">
                    {t}
                  </Pill>
                ))}
              </div>
            </div>

            <div className="tbl-w">
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 50 }}>Rd</th>
                    <th>Date</th>
                    <th>Opponent</th>
                    <th>H/A</th>
                    <th>Venue</th>
                    <th style={{ textAlign: 'right' }}>Distance</th>
                    <th style={{ textAlign: 'right' }}>Travel cost</th>
                  </tr>
                </thead>
                <tbody>
                  {mine.map((f) => {
                    const isHome = f.home === club.id;
                    const opp = clubBy(isHome ? f.away : f.home);
                    const venueName = isHome
                      ? club.ground?.venue || 'Home ground TBA'
                      : opp?.ground?.venue || 'Opponent ground TBA';
                    let dist = null,
                      cost = null;
                    if (!isHome && opp && opp.ground && club.ground) {
                      const c = fixtureCost(opp, club, s.costPerKm || 4.5, s.carsPerAwayTrip || 3);
                      dist = c.roundTripKm;
                      cost = c.fuelR;
                    }
                    return (
                      <tr key={f.id}>
                        <td>
                          <span
                            style={{
                              fontFamily: "'Montserrat',sans-serif",
                              fontWeight: 700,
                              color: 'var(--muted)',
                            }}
                          >
                            R{f.round}
                          </span>
                        </td>
                        <td>
                          <div
                            style={{
                              fontFamily: "'Montserrat',sans-serif",
                              fontWeight: 700,
                              fontSize: 13,
                              color: 'var(--ink)',
                            }}
                          >
                            {new Date(f.date).toLocaleDateString('en-GB', {
                              day: 'numeric',
                              month: 'short',
                            })}
                          </div>
                          <div
                            style={{
                              fontSize: 10.5,
                              color: 'var(--muted)',
                              fontWeight: 500,
                              fontFamily: "'Montserrat',sans-serif",
                            }}
                          >
                            {new Date(f.date).toLocaleDateString('en-GB', { weekday: 'long' })}
                          </div>
                        </td>
                        <td>
                          <ClubNameCell club={opp || { name: 'TBA', short: 'TBA' }} />
                        </td>
                        <td>
                          {isHome ? (
                            <Pill tone="teal" dot>
                              Home
                            </Pill>
                          ) : (
                            <Pill tone="gold" dot>
                              Away
                            </Pill>
                          )}
                        </td>
                        <td>
                          <div
                            style={{
                              fontSize: 12.5,
                              fontFamily: "'Montserrat',sans-serif",
                              fontWeight: 600,
                              color: 'var(--ink)',
                            }}
                          >
                            {venueName}
                          </div>
                          {!isHome && opp?.ground?.suburb && (
                            <div style={{ fontSize: 10.5, color: 'var(--muted)' }}>
                              {opp.ground.suburb}
                            </div>
                          )}
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: "'Montserrat',sans-serif" }}>
                          {dist !== null ? (
                            <span style={{ fontWeight: 700, fontSize: 12.5 }}>
                              {Math.round(dist)} km
                            </span>
                          ) : (
                            <span style={{ color: 'var(--muted-2)' }}>—</span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right', fontFamily: "'Montserrat',sans-serif" }}>
                          {cost !== null ? (
                            <span style={{ fontWeight: 800, color: 'var(--green)', fontSize: 13 }}>
                              R {Math.round(cost).toLocaleString()}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--muted-2)' }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}

      {/* Footnote */}
      <div className="club-fix-foot">
        Travel cost is estimated at R {myReleased[0]?.costPerKm || 4.5}/km ×{' '}
        {myReleased[0]?.carsPerAwayTrip || 3} cars per away trip — published with the fixture
        release. Adjustments to schedule require a Dolphins office sign-off.
      </div>

      {/* Share-with-players modal — portaled for the same transformed-ancestor
          reason as the certificate-removal confirm. */}
      {shareOpen &&
        createPortal(
          <div
            className="fix-confirm"
            onClick={(e) => e.target === e.currentTarget && !sharing && setShareOpen(false)}
          >
            <div className="fix-confirm-box">
              <div className="fix-confirm-icon go">
                <Icon.Mail />
              </div>
              <div className="fix-confirm-title">Share fixtures with players</div>
              <div className="fix-confirm-body">
                Email the full schedule and send a WhatsApp heads-up to your{' '}
                <strong>{playerCount}</strong> registered player{playerCount === 1 ? '' : 's'}.
                Players registered as minors are skipped. Choose how to reach them:
              </div>
              <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginBottom: 4 }}>
                {[
                  { k: 'email', label: 'Email' },
                  { k: 'whatsapp', label: 'WhatsApp' },
                ].map(({ k, label }) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setShareCh((s) => ({ ...s, [k]: !s[k] }))}
                    className={`check-item ${shareCh[k] ? 'on' : ''}`}
                    style={{ padding: '8px 16px', width: 'auto' }}
                  >
                    <div className="box">{shareCh[k] && <Icon.Check />}</div>
                    {label}
                  </button>
                ))}
              </div>
              <div className="fix-confirm-actions" style={{ marginTop: 22 }}>
                <Btn tone="outline" onClick={() => !sharing && setShareOpen(false)}>
                  Cancel
                </Btn>
                <Btn tone="teal" onClick={doShareFixtures} disabled={sharing}>
                  {sharing ? 'Sending…' : 'Send to players'}
                </Btn>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

/* ─── Phase 03 · Player roster ─── */
const fmtDay = (iso) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';

export function ClubPlayersView({ club, players, clearances, leagues, onOpenRegister }) {
  const teamLabel = labelByKey(leagues);
  const label = (key) => teamLabel[key] || key || '—';
  const mine = players ?? [];
  // Players leaving this club appear as `incoming` clearances (this club is the source).
  const leaving = (clearances?.incoming ?? []).filter((r) => r.status === 'pending');
  const leavingFor = (nk) => leaving.find((r) => r.playerNaturalKey === nk);

  const allRounders = mine.filter((p) => p.isAllRounder).length;
  const wks = mine.filter((p) => p.isWk).length;
  const pendingClearance = mine.filter((p) => p.status === 'clearance-pending').length;

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Club Portal · {club.name} / Players</div>
          <h1 className="ph-title">
            Player <em>Roster</em>
          </h1>
          <p className="ph-desc">
            Register and maintain {club.name}'s playing members for the 2026/27 season. All
            registrations sync with the Union office and your fixtures.
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="teal" size="sm" icon={Icon.Plus} onClick={onOpenRegister}>
            Register player
          </Btn>
        </div>
      </div>

      <div className="players-stats">
        <div className="players-stat">
          <div className="players-stat-l">Registered</div>
          <div className="players-stat-n">{mine.length}</div>
        </div>
        <div className="players-stat">
          <div className="players-stat-l">All-rounders</div>
          <div className="players-stat-n">{allRounders}</div>
        </div>
        <div className="players-stat">
          <div className="players-stat-l">WK keepers</div>
          <div className="players-stat-n">{wks}</div>
        </div>
        <div className="players-stat">
          <div className="players-stat-l">Awaiting clearance</div>
          <div
            className="players-stat-n"
            style={{ color: pendingClearance ? 'var(--coral)' : 'var(--ink)' }}
          >
            {pendingClearance}
          </div>
        </div>
      </div>

      <div className="tbl-w" style={{ marginTop: 14 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>Player</th>
              <th>ID number</th>
              <th>Team</th>
              <th>Role</th>
              <th>Bowler type</th>
              <th>ID doc</th>
              <th>Status</th>
              <th style={{ width: 140 }}></th>
            </tr>
          </thead>
          <tbody>
            {mine.map((p) => {
              const outbound = leavingFor(p.naturalKey);
              const roleBits = [
                p.battingHand ? p.battingHand + ' hand' : null,
                p.battingType,
                p.isAllRounder ? 'All-rounder' : null,
                p.isWk ? 'WK' : null,
              ]
                .filter(Boolean)
                .join(' · ');
              return (
                <tr key={p.naturalKey}>
                  <td>
                    <div className="rost-name">
                      {p.firstName} {p.lastName}
                    </div>
                    <div className="rost-sub">
                      {p.district || '—'} · {p.gender || '—'}
                    </div>
                  </td>
                  <td>
                    <span className="rost-id">{p.idNumber || '—'}</span>
                  </td>
                  <td>
                    {p.team ? (
                      <Pill tone="navy">{label(p.team)}</Pill>
                    ) : (
                      <span className="rost-sub">—</span>
                    )}
                  </td>
                  <td>
                    <span className="rost-sub">{roleBits || '—'}</span>
                  </td>
                  <td>
                    <span className="rost-sub">{p.bowlerType || '—'}</span>
                  </td>
                  <td>
                    {p.idDocMeta ? (
                      <Pill tone="teal" dot>
                        Uploaded
                      </Pill>
                    ) : (
                      <Pill tone="coral" dot>
                        Missing
                      </Pill>
                    )}
                  </td>
                  <td>
                    {p.status === 'clearance-pending' ? (
                      <Pill tone="gold" dot>
                        Clearance pending
                      </Pill>
                    ) : p.status === 'inactive' ? (
                      <Pill tone="muted">Inactive</Pill>
                    ) : (
                      <Pill tone="teal" dot>
                        Active
                      </Pill>
                    )}
                  </td>
                  <td style={{ textAlign: 'right', paddingRight: 14 }}>
                    {outbound && <span className="rost-sub">→ {outbound.toClubName}</span>}
                  </td>
                </tr>
              );
            })}
            {mine.length === 0 && (
              <tr>
                <td
                  colSpan="8"
                  style={{ padding: 28, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}
                >
                  No players registered yet — click <strong>Register player</strong> to add your
                  first.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const EMPTY_PLAYER = {
  surname: '',
  firstNames: '',
  idNumber: '',
  race: '',
  gender: '',
  postalAddress: '',
  postalCode: '',
  phone: '',
  email: '',
  team: '',
  district: '',
  lastClub: '',
  battingHand: 'Right',
  battingType: 'Mid Order',
  bowlingHand: 'Right',
  isAllRounder: false,
  isWk: false,
  bowlerType: '',
  consentChecked: false,
};

/**
 * In-portal chair registration form (the official Union form). Collects the full field
 * set; `onSubmit(payload, idFile)` hands back backend-shaped fields plus the chosen ID
 * document File (main.jsx creates the player then presigns + uploads the doc). `leagues`
 * is the tenant catalogue — Team options come from it so the value is a valid league key.
 */
export function RegisterPlayerForm({ club, leagues, onSubmit, onCancel, toast, busy }) {
  const [d, setD] = useStateC(EMPTY_PLAYER);
  const [idFile, setIdFile] = useStateC(null);
  const set = (k, v) => setD((prev) => ({ ...prev, [k]: v }));

  const teamOptions = leagueOptionsForDistrict(leagues, club.district);
  const dob = dobFromSaId(d.idNumber);
  const idValid = /^\d{13}$/.test(d.idNumber);
  const required = [
    'surname',
    'firstNames',
    'idNumber',
    'race',
    'gender',
    'phone',
    'team',
    'district',
  ];
  const missing = required.filter((k) => !d[k]);
  const canSubmit =
    missing.length === 0 && idValid && !!dob && !!idFile && d.consentChecked && !busy;

  function pickFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      toast?.('ID document must be under 5 MB', 'warn');
      return;
    }
    setIdFile(file);
    toast?.(`ID document attached · ${file.name}`);
  }

  function submit() {
    if (!canSubmit) {
      toast?.('Fill all required fields, upload ID, accept consent', 'warn');
      return;
    }
    onSubmit(
      {
        firstName: d.firstNames.trim(),
        lastName: d.surname.trim(),
        idNumber: d.idNumber,
        race: d.race,
        gender: d.gender,
        cell: d.phone,
        email: d.email || undefined,
        postalAddress: d.postalAddress || undefined,
        postalCode: d.postalCode || undefined,
        team: d.team,
        district: d.district,
        lastClub: d.lastClub || undefined,
        battingHand: d.battingHand,
        bowlingHand: d.bowlingHand,
        battingType: d.battingType,
        bowlerType: d.bowlerType || undefined,
        isAllRounder: d.isAllRounder,
        isWk: d.isWk,
      },
      idFile,
    );
  }

  return (
    <div className="rp-form">
      <div className="rp-section">
        <div className="rp-section-head">
          <div className="rp-section-eyebrow">Section 01</div>
          <div className="rp-section-title">Club &amp; Team</div>
        </div>
        <div className="field-grid-2">
          <div>
            <label className="field-label">Club</label>
            <input className="field-input" value={club.name} disabled />
          </div>
          <div>
            <label className="field-label">
              Team <span className="req">*</span>
            </label>
            <select
              className="field-select"
              value={d.team}
              onChange={(e) => set('team', e.target.value)}
            >
              <option value="">Select team</option>
              {teamOptions.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="rp-section">
        <div className="rp-section-head">
          <div className="rp-section-eyebrow">Section 02</div>
          <div className="rp-section-title">Player identity</div>
        </div>
        <div className="field-grid-2">
          <div>
            <label className="field-label">
              Surname <span className="req">*</span>
            </label>
            <input
              className="field-input"
              value={d.surname}
              onChange={(e) => set('surname', e.target.value)}
              placeholder="e.g. Mthembu"
            />
          </div>
          <div>
            <label className="field-label">
              First name(s) <span className="req">*</span>
            </label>
            <input
              className="field-input"
              value={d.firstNames}
              onChange={(e) => set('firstNames', e.target.value)}
              placeholder="e.g. Sanele"
            />
          </div>
        </div>
        <div className="field-grid-2" style={{ marginTop: 12 }}>
          <div>
            <label className="field-label">
              ID number <span className="req">*</span>
            </label>
            <input
              className="field-input"
              value={d.idNumber}
              onChange={(e) => set('idNumber', e.target.value.replace(/\D/g, '').slice(0, 13))}
              placeholder="13-digit RSA ID"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            />
            {d.idNumber && !idValid && (
              <div className="rp-hint err">Must be exactly 13 digits.</div>
            )}
            {dob && (
              <div className="rp-hint">
                ✓ Date of birth: <strong style={{ color: 'var(--ink)' }}>{dob}</strong>
              </div>
            )}
          </div>
          <div>
            <label className="field-label">
              Race <span className="req">*</span>
            </label>
            <select
              className="field-select"
              value={d.race}
              onChange={(e) => set('race', e.target.value)}
            >
              <option value="">Select</option>
              {RACES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="field-grid-2" style={{ marginTop: 12 }}>
          <div>
            <label className="field-label">
              Gender <span className="req">*</span>
            </label>
            <select
              className="field-select"
              value={d.gender}
              onChange={(e) => set('gender', e.target.value)}
            >
              <option value="">Select</option>
              {GENDERS.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">
              Phone <span className="req">*</span>
            </label>
            <input
              className="field-input"
              type="tel"
              value={d.phone}
              onChange={(e) => set('phone', e.target.value)}
              placeholder="065 299 1365"
            />
          </div>
        </div>
      </div>

      <div className="rp-section">
        <div className="rp-section-head">
          <div className="rp-section-eyebrow">Section 03</div>
          <div className="rp-section-title">Address &amp; contact</div>
        </div>
        <div>
          <label className="field-label">Postal address</label>
          <input
            className="field-input"
            value={d.postalAddress}
            onChange={(e) => set('postalAddress', e.target.value)}
            placeholder="67 Fiona Street, Mobeni Heights"
          />
        </div>
        <div className="field-grid-2" style={{ marginTop: 12 }}>
          <div>
            <label className="field-label">Postal code</label>
            <input
              className="field-input"
              value={d.postalCode}
              onChange={(e) => set('postalCode', e.target.value.replace(/\D/g, '').slice(0, 4))}
              placeholder="4092"
            />
          </div>
          <div>
            <label className="field-label">Email</label>
            <input
              className="field-input"
              type="email"
              value={d.email}
              onChange={(e) => set('email', e.target.value)}
              placeholder="player@example.com"
            />
          </div>
        </div>
      </div>

      <div className="rp-section">
        <div className="rp-section-head">
          <div className="rp-section-eyebrow">Section 04</div>
          <div className="rp-section-title">Playing profile</div>
        </div>
        <div className="field-grid-2">
          <div>
            <label className="field-label">Batting hand</label>
            <div className="seg">
              {HANDS.map((h) => (
                <button
                  key={h}
                  type="button"
                  className={`seg-btn ${d.battingHand === h ? 'on' : ''}`}
                  onClick={() => set('battingHand', h)}
                >
                  {h} hander
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="field-label">Bowling hand</label>
            <div className="seg">
              {HANDS.map((h) => (
                <button
                  key={h}
                  type="button"
                  className={`seg-btn ${d.bowlingHand === h ? 'on' : ''}`}
                  onClick={() => set('bowlingHand', h)}
                >
                  {h} hander
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="field-grid-2" style={{ marginTop: 12 }}>
          <div>
            <label className="field-label">Batting type</label>
            <select
              className="field-select"
              value={d.battingType}
              onChange={(e) => set('battingType', e.target.value)}
            >
              {BATTING_TYPES.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">Bowler type</label>
            <select
              className="field-select"
              value={d.bowlerType}
              onChange={(e) => set('bowlerType', e.target.value)}
            >
              <option value="">— Not a bowler —</option>
              {BOWLER_TYPES.map((b) => (
                <option key={b}>{b}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="row" style={{ marginTop: 12, gap: 14, flexWrap: 'wrap' }}>
          <label className="rp-check">
            <input
              type="checkbox"
              checked={d.isAllRounder}
              onChange={(e) => set('isAllRounder', e.target.checked)}
            />
            <span>All-rounder</span>
          </label>
          <label className="rp-check">
            <input
              type="checkbox"
              checked={d.isWk}
              onChange={(e) => set('isWk', e.target.checked)}
            />
            <span>Wicket-keeper</span>
          </label>
        </div>
      </div>

      <div className="rp-section">
        <div className="rp-section-head">
          <div className="rp-section-eyebrow">Section 05</div>
          <div className="rp-section-title">Registration history</div>
        </div>
        <div className="field-grid-2">
          <div>
            <label className="field-label">Club for which last registered</label>
            <input
              className="field-input"
              value={d.lastClub}
              onChange={(e) => set('lastClub', e.target.value)}
              placeholder="Previous club, or — if first registration"
            />
          </div>
          <div>
            <label className="field-label">
              District <span className="req">*</span>
            </label>
            <input
              className="field-input"
              value={d.district}
              onChange={(e) => set('district', e.target.value)}
              placeholder="e.g. Chatsworth"
            />
          </div>
        </div>
      </div>

      <div className="rp-section">
        <div className="rp-section-head">
          <div className="rp-section-eyebrow">Section 06</div>
          <div className="rp-section-title">
            ID document upload{' '}
            <span style={{ color: 'var(--coral)', fontWeight: 700, fontSize: 11, marginLeft: 6 }}>
              REQUIRED
            </span>
          </div>
        </div>
        <div className={`rp-upload ${idFile ? 'uploaded' : ''}`}>
          <input
            id="rp-id-file"
            type="file"
            accept="image/jpeg,image/png,application/pdf"
            onChange={pickFile}
            style={{ display: 'none' }}
          />
          <label htmlFor="rp-id-file" className="rp-upload-inner">
            {idFile ? (
              <>
                <div className="rp-upload-icon ok">
                  <Icon.Check />
                </div>
                <div>
                  <div className="rp-upload-title">{idFile.name}</div>
                  <div className="rp-upload-sub">
                    Click to replace · The Union office reviews ID documents on submission.
                  </div>
                </div>
              </>
            ) : (
              <>
                <div className="rp-upload-icon">
                  <Icon.Upload />
                </div>
                <div>
                  <div className="rp-upload-title">Tap to attach ID document</div>
                  <div className="rp-upload-sub">
                    SA ID book photo or scan · JPG, PNG or PDF · max ~5MB
                  </div>
                </div>
              </>
            )}
          </label>
        </div>
      </div>

      <div className="rp-section rp-consent">
        <label className="rp-check">
          <input
            type="checkbox"
            checked={d.consentChecked}
            onChange={(e) => set('consentChecked', e.target.checked)}
          />
          <span>
            I, on behalf of <strong>{club.name}</strong>, request to register the above player under
            the <strong>Union Rules and Byelaws</strong>. I declare that the player is not being
            paid by the club for their services as a cricketer.
          </span>
        </label>
      </div>

      <div className="rp-actions">
        <Btn tone="outline" onClick={onCancel}>
          Cancel
        </Btn>
        <Btn tone="teal" icon={Icon.Check} onClick={submit} disabled={!canSubmit}>
          {busy ? 'Submitting…' : 'Submit registration'}
        </Btn>
      </div>
      {!canSubmit && !busy && (missing.length || !idFile || !d.consentChecked) && (
        <div className="rp-validation">
          {missing.length > 0 && <>Missing: {missing.join(', ')}. </>}
          {!idFile && <>Attach ID. </>}
          {!d.consentChecked && <>Consent required.</>}
        </div>
      )}
    </div>
  );
}

/** Destination-initiated clearance request: pick the source club + the player's ID. */
export function RequestPlayerForm({ club, directory, onSubmit, onCancel, busy }) {
  const [fromClubId, setFromClubId] = useStateC('');
  const [idNumber, setIdNumber] = useStateC('');
  const [note, setNote] = useStateC('');
  const others = (directory ?? []).filter((c) => c.id !== club.id);
  const canSubmit = fromClubId && /^\d{13}$/.test(idNumber) && !busy;

  return (
    <div className="rp-form">
      <div className="rp-section">
        <div className="rp-section-head">
          <div className="rp-section-eyebrow">Incoming transfer</div>
          <div className="rp-section-title">Request a player for {club.name}</div>
        </div>
        <p className="ph-desc" style={{ marginBottom: 12 }}>
          The player&apos;s current club has 14 days to confirm fees + misconduct cleared, then
          issue the clearance. After that the Union office may override.
        </p>
        <div className="field-grid-2">
          <div>
            <label className="field-label">
              Current club <span className="req">*</span>
            </label>
            <select
              className="field-select"
              value={fromClubId}
              onChange={(e) => setFromClubId(e.target.value)}
            >
              <option value="">Select club</option>
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label">
              Player ID number <span className="req">*</span>
            </label>
            <input
              className="field-input"
              value={idNumber}
              onChange={(e) => setIdNumber(e.target.value.replace(/\D/g, '').slice(0, 13))}
              placeholder="13-digit RSA ID"
              style={{ fontVariantNumeric: 'tabular-nums' }}
            />
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <label className="field-label">Note (optional)</label>
          <input
            className="field-input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Player relocating — joining us for 2026/27."
          />
        </div>
      </div>
      <div className="rp-actions">
        <Btn tone="outline" onClick={onCancel}>
          Cancel
        </Btn>
        <Btn
          tone="teal"
          icon={Icon.Arrow}
          disabled={!canSubmit}
          onClick={() => onSubmit({ fromClubId, idNumber, note: note || undefined })}
        >
          {busy ? 'Sending…' : 'Send request'}
        </Btn>
      </div>
    </div>
  );
}

/* ─── Phase 04 · Clearances (club side) ─── */
export function ClubClearancesView({
  club,
  clearances,
  leagues,
  onClearFees,
  onClearMisconduct,
  onApprove,
  onOpenRequest,
  busyId,
}) {
  const teamLabel = labelByKey(leagues);
  const incoming = clearances?.incoming ?? [];
  const outgoing = clearances?.outbound ?? [];
  const incomingPending = incoming.filter((r) => r.status === 'pending');
  const incomingResolved = incoming.filter((r) => r.status !== 'pending');

  return (
    <div>
      <div className="page-head">
        <div className="ph-left">
          <div className="ph-crumb">Club Portal · {club.name} / Clearances</div>
          <h1 className="ph-title">
            Player <em>Clearance Requests</em>
          </h1>
          <p className="ph-desc">
            Players leaving {club.name} need a clearance certificate. Confirm{' '}
            <strong>fees cleared</strong> and <strong>misconduct charges cleared</strong> within{' '}
            <strong>14 days</strong>, or the Union office may override and approve on your behalf.
          </p>
        </div>
        <div className="ph-actions">
          <Btn tone="outline" size="sm" icon={Icon.Plus} onClick={onOpenRequest}>
            Request a player
          </Btn>
        </div>
      </div>

      <Card
        title="Incoming requests"
        sub={`Players asking to leave ${club.name}. You have 14 days to action each one.`}
      >
        {incomingPending.length === 0 && incomingResolved.length === 0 && (
          <div
            style={{
              padding: '24px 16px',
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 13,
            }}
          >
            No clearance requests pending. Players will appear here when they apply to move clubs.
          </div>
        )}
        <div className="clr-list">
          {incomingPending.map((req) => {
            const daysLeft = clearanceDaysRemaining(req);
            const overdue = clearanceOverdue(req);
            const busy = busyId === req.id;
            return (
              <div key={req.id} className={`clr-card ${overdue ? 'overdue' : ''}`}>
                <div className="clr-card-head">
                  <div>
                    <div className="clr-eyebrow">
                      {overdue
                        ? '⚠ Overdue · Union may override'
                        : `${daysLeft} ${daysLeft === 1 ? 'day' : 'days'} remaining`}
                    </div>
                    <div className="clr-name">{req.playerName}</div>
                    <div className="clr-meta">
                      {teamLabel[req.team] || req.team || '—'} · ID {req.idNumber || '—'} ·
                      Requested {fmtDay(req.requestedAt)}
                    </div>
                  </div>
                  <div className="clr-route">
                    <div className="clr-route-from">{req.fromClubName}</div>
                    <Icon.Arrow />
                    <div className="clr-route-to">{req.toClubName}</div>
                  </div>
                </div>
                {req.note && <div className="clr-note">"{req.note}"</div>}
                <div className="clr-checklist">
                  <button
                    className={`clr-check ${req.feesCleared ? 'on' : ''}`}
                    disabled={busy}
                    onClick={() => onClearFees(req)}
                  >
                    <span className="clr-check-box">{req.feesCleared && <Icon.Check />}</span>
                    <span className="clr-check-label">Fees cleared</span>
                    <span className="clr-check-sub">
                      All monies due to {club.name} paid in full
                    </span>
                  </button>
                  <button
                    className={`clr-check ${req.misconductCleared ? 'on' : ''}`}
                    disabled={busy}
                    onClick={() => onClearMisconduct(req)}
                  >
                    <span className="clr-check-box">{req.misconductCleared && <Icon.Check />}</span>
                    <span className="clr-check-label">Misconduct cleared</span>
                    <span className="clr-check-sub">No outstanding disciplinary charges</span>
                  </button>
                </div>
                {req.feesCleared && req.misconductCleared && (
                  <div className="clr-ready">
                    <span className="clr-ready-msg">
                      ✓ Both checks complete. Issue clearance certificate.
                    </span>
                    <Btn
                      tone="teal"
                      size="sm"
                      icon={Icon.Arrow}
                      disabled={busy}
                      onClick={() => onApprove(req)}
                    >
                      {busy ? 'Issuing…' : `Issue clearance to ${req.toClubName}`}
                    </Btn>
                  </div>
                )}
              </div>
            );
          })}
          {incomingResolved.map((req) => (
            <div key={req.id} className="clr-card resolved">
              <div className="clr-card-head">
                <div>
                  <div className="clr-eyebrow" style={{ color: 'var(--green)' }}>
                    {req.status === 'admin-override' ? 'Union override' : 'Issued'} ·{' '}
                    {fmtDay(req.clubApprovedAt || req.adminOverrideAt)}
                  </div>
                  <div className="clr-name">{req.playerName}</div>
                  <div className="clr-meta">Now at {req.toClubName}</div>
                </div>
                <Pill tone="teal" dot>
                  {req.status === 'admin-override' ? 'Union approved' : 'Cleared'}
                </Pill>
              </div>
            </div>
          ))}
        </div>
      </Card>

      {outgoing.length > 0 && (
        <Card title="Players moving to your club" sub="Awaiting clearance from their current club">
          <div className="clr-list">
            {outgoing.map((req) => (
              <div key={req.id} className="clr-card incoming">
                <div className="clr-card-head">
                  <div>
                    <div className="clr-eyebrow">
                      Incoming · {req.status === 'pending' ? 'Pending source club' : 'Cleared'}
                    </div>
                    <div className="clr-name">{req.playerName}</div>
                    <div className="clr-meta">
                      From <strong>{req.fromClubName}</strong> · Requested {fmtDay(req.requestedAt)}
                    </div>
                  </div>
                  {req.status === 'pending' ? (
                    <Pill tone="gold" dot>
                      Waiting on {req.fromClubName}
                    </Pill>
                  ) : (
                    <Pill tone="teal" dot>
                      Cleared
                    </Pill>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

Object.assign(window, {
  ClubHome,
  AffiliationForm,
  DocumentsView,
  CQIView,
  ClubFixturesView,
  ClubPlayersView,
  RegisterPlayerForm,
  RequestPlayerForm,
  ClubClearancesView,
});
