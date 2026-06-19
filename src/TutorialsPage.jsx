/**
 * Public "How to use the app" tutorials page (`/tutorials`). No auth — chairs open it
 * from the link in their onboarding WhatsApp/email, usually on a phone. Reads the video
 * set from the public `/tenant` payload (falls back to the backend's DEFAULT_TUTORIALS),
 * so it needs no token and works the same in dev (tenant via header) and prod (by host).
 */
import { useQuery } from '@tanstack/react-query';
import { qk } from './query';
import { getTenant } from './api';

export function TutorialsPage() {
  const tenantQuery = useQuery({ queryKey: qk.tenant(), queryFn: getTenant, retry: 0 });
  const branding = tenantQuery.data?.branding;
  const videos = tenantQuery.data?.tutorials ?? [];
  const orgTitle = branding?.title || branding?.name || 'Smart Club';

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--paper, #f6f8fb)',
        color: 'var(--ink, #1B2A4A)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '16px 20px',
          borderBottom: '1px solid var(--line, #e3e8f0)',
          background: 'var(--white, #fff)',
        }}
      >
        {branding?.logoUrl ? (
          <img src={branding.logoUrl} alt={orgTitle} style={{ height: 34, width: 'auto' }} />
        ) : null}
        <div style={{ fontFamily: "'Montserrat',sans-serif", fontWeight: 700, fontSize: 15 }}>
          {orgTitle}
        </div>
      </header>

      <main style={{ maxWidth: 820, margin: '0 auto', padding: '28px 20px 56px' }}>
        <div
          style={{
            fontSize: 11,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--muted-2, #8a97ad)',
            fontFamily: "'Montserrat',sans-serif",
            fontWeight: 700,
            marginBottom: 6,
          }}
        >
          How to use the app
        </div>
        <h1 style={{ fontFamily: "'Montserrat',sans-serif", fontSize: 24, margin: '0 0 8px' }}>
          Quick video tutorials
        </h1>
        <p
          style={{
            fontSize: 14,
            color: 'var(--muted, #5A6B8C)',
            maxWidth: 560,
            margin: '0 0 24px',
          }}
        >
          Short walkthroughs covering everything you need — registering players, completing
          affiliation, fixtures and clearances. Watch them in any order.
        </p>

        {tenantQuery.isLoading ? (
          <p style={{ color: 'var(--muted, #5A6B8C)' }}>Loading…</p>
        ) : tenantQuery.isError ? (
          <p style={{ color: 'var(--muted, #5A6B8C)' }}>
            Couldn’t load the tutorials — please check your connection and refresh.
          </p>
        ) : videos.length === 0 ? (
          <p style={{ color: 'var(--muted, #5A6B8C)' }}>Tutorial videos are coming soon.</p>
        ) : (
          <div style={{ display: 'grid', gap: 24 }}>
            {videos.map((v, i) => (
              <section key={v.url || i}>
                <div
                  style={{
                    fontFamily: "'Montserrat',sans-serif",
                    fontWeight: 700,
                    fontSize: 15,
                    marginBottom: 8,
                  }}
                >
                  {i + 1}. {v.title}
                </div>
                <video
                  controls
                  preload="metadata"
                  poster={v.poster || undefined}
                  style={{
                    width: '100%',
                    borderRadius: 12,
                    background: '#000',
                    border: '1px solid var(--line, #e3e8f0)',
                    aspectRatio: '16 / 9',
                  }}
                >
                  <source src={v.url} type="video/mp4" />
                  Your browser can’t play this video. <a href={v.url}>Download it instead</a>.
                </video>
              </section>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
