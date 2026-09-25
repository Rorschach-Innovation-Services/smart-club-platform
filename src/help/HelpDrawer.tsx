/**
 * The help drawer: one right-hand panel per app that explains a topic from
 * `HELP_TOPICS` in full — summary, a few paragraphs, a worked example and a link into the
 * league structures guide.
 *
 *   <HelpProvider>            // once, near the root; renders the drawer
 *     …
 *     <HelpLink topic="blocks-vs-stages" />
 *   </HelpProvider>
 *
 * The drawer is a modal dialog: focus moves into it, Tab cycles inside it, Escape or a
 * backdrop click closes it, and focus goes back to whatever opened it. Escape is caught
 * in the capture phase and stopped, so a drawer opened from inside a task modal closes
 * without also closing the modal underneath.
 *
 * Deliberately imports nothing from atoms.tsx: atoms renders HelpLink, so importing back
 * would make a cycle.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { HELP_TOPICS, type HelpTopic, type HelpTopicId } from './topics';

/** Where the long-form guide is served. A topic's `guideAnchor` is appended as `#…`. */
export const GUIDE_URL = '/guides/league-structures-tutorial.html';

interface HelpApi {
  open: (topicId: string) => void;
  close: () => void;
}

const HelpContext = createContext<HelpApi | null>(null);

/** The drawer's controls, or null outside a `HelpProvider`. */
export function useHelp(): HelpApi | null {
  return useContext(HelpContext);
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const [topicId, setTopicId] = useState<string | null>(null);
  // The element that had focus when the drawer opened; focus returns there on close.
  const openerRef = useRef<HTMLElement | null>(null);

  const open = useCallback((id: string) => {
    // Switching topics while open keeps the original opener.
    if (!openerRef.current) {
      const active = document.activeElement;
      openerRef.current = active instanceof HTMLElement ? active : null;
    }
    setTopicId(id);
  }, []);

  const close = useCallback(() => setTopicId(null), []);

  // Once the drawer has unmounted (so its focus trap is gone), hand focus back.
  useEffect(() => {
    if (topicId !== null) return;
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected) opener.focus();
  }, [topicId]);

  const api = useMemo(() => ({ open, close }), [open, close]);

  return (
    <HelpContext.Provider value={api}>
      {children}
      {topicId !== null && <HelpDrawer topicId={topicId} onClose={close} />}
    </HelpContext.Provider>
  );
}

/** The (i) glyph, drawn inline so this module needs nothing from atoms.tsx. */
function InfoGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="14" height="14">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 7.2v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="4.9" r="0.85" fill="currentColor" />
    </svg>
  );
}

/**
 * A quiet text button that opens a topic in the drawer. Outside a `HelpProvider` it
 * falls back to a plain link into the guide, so it never renders a dead button.
 */
export function HelpLink({ topic, children }: { topic: HelpTopicId; children?: ReactNode }) {
  const help = useHelp();
  const text = children ?? 'How does this work?';
  if (!help) {
    const anchor = (HELP_TOPICS as Record<string, HelpTopic | undefined>)[topic]?.guideAnchor;
    return (
      <a
        className="help-link"
        href={anchor ? `${GUIDE_URL}#${anchor}` : GUIDE_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        <InfoGlyph />
        <span>{text}</span>
      </a>
    );
  }
  return (
    <button type="button" className="help-link" onClick={() => help.open(topic)}>
      <InfoGlyph />
      <span>{text}</span>
    </button>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function HelpDrawer({ topicId, onClose }: { topicId: string; onClose: () => void }) {
  const topic = (HELP_TOPICS as Record<string, HelpTopic | undefined>)[topicId];
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
  }, [topicId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const guideHref = topic?.guideAnchor ? `${GUIDE_URL}#${topic.guideAnchor}` : null;

  return createPortal(
    <div className="help-drawer-root">
      <div className="help-drawer-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className="help-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="help-drawer-head">
          <div className="help-drawer-eyebrow">How it works</div>
          <h2 id={titleId} className="help-drawer-title">
            {topic ? topic.title : 'No help written for this yet'}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="help-drawer-close"
            aria-label="Close help"
            onClick={onClose}
          >
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="14" height="14">
              <path
                d="M4 4l8 8M12 4l-8 8"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="help-drawer-body">
          {topic ? (
            <>
              <p className="help-drawer-lede">{topic.summary}</p>
              {topic.body.map((para, i) => (
                <p key={i}>{para}</p>
              ))}
              {topic.example && (
                <div className="help-drawer-eg">
                  <div className="help-drawer-eg-label">Example</div>
                  <p>{topic.example}</p>
                </div>
              )}
              {guideHref && (
                <a
                  className="help-drawer-more"
                  href={guideHref}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Read more in the guide
                </a>
              )}
            </>
          ) : (
            <p className="help-drawer-lede">
              There is no explainer for this topic yet. The league structures guide covers the whole
              setup.
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
