import type { ReactNode } from 'react';

/** Line icons, 24px grid, stroke follows currentColor. */
function I({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const Icon = {
  card: () => (
    <I>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 10h18" />
      <path d="M7 15h3" />
    </I>
  ),
  home: () => (
    <I>
      <path d="M4 10.5 12 4l8 6.5V20H4z" />
      <path d="M10 20v-5h4v5" />
    </I>
  ),
  send: () => (
    <I>
      <path d="M5 19 19 5" />
      <path d="M8 5h11v11" />
    </I>
  ),
  add: () => (
    <I>
      <path d="M12 5v14M5 12h14" />
    </I>
  ),
  withdraw: () => (
    <I>
      <path d="M12 4v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M5 20h14" />
    </I>
  ),
  receive: () => (
    <I>
      <path d="M19 5 5 19" />
      <path d="M16 19H5V8" />
    </I>
  ),
  activity: () => (
    <I>
      <path d="M4 12h4l2-6 4 12 2-6h4" />
    </I>
  ),
  agents: () => (
    <I>
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 4v4M9 13h.01M15 13h.01" />
    </I>
  ),
  privacy: () => (
    <I>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </I>
  ),
  hidden: () => (
    <I>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.6A10 10 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.8M6.2 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1" />
    </I>
  ),
  token: () => (
    <I>
      <circle cx="12" cy="12" r="8" />
      <path d="M9 9l3 6 3-6" />
    </I>
  ),
  settings: () => (
    <I>
      <circle cx="12" cy="12" r="3" />
      <path d="M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3 1a7 7 0 0 0-2-1.2L14.2 3h-4.4l-.4 2.7a7 7 0 0 0-2 1.2l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 2 1.2l.4 2.7h4.4l.4-2.7a7 7 0 0 0 2-1.2l2.3 1 2-3.4-2-1.5c.1-.4.1-.8.1-1.2Z" />
    </I>
  ),
  more: () => (
    <I>
      <path d="M5 12h.01M12 12h.01M19 12h.01" />
    </I>
  ),
  lock: () => (
    <I>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </I>
  ),
  stealth: () => (
    <I>
      <path d="M12 3 4 6v6c0 4.5 3.4 8 8 9 4.6-1 8-4.5 8-9V6z" />
      <path d="M9 12h6" />
    </I>
  ),
  copy: () => (
    <I>
      <rect x="8" y="8" width="12" height="12" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </I>
  ),
  check: () => (
    <I>
      <path d="m5 12 5 5 9-10" />
    </I>
  ),
  back: () => (
    <I>
      <path d="M15 5l-7 7 7 7" />
    </I>
  ),
  deposit: () => (
    <I>
      <path d="M12 20V9" />
      <path d="m7 14 5-5 5 5" />
      <path d="M5 4h14" />
    </I>
  ),
};
