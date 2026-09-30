'use client';

import Lenis from 'lenis';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ComponentProps, MouseEvent, ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

type Phase = 'pre' | 'in' | 'out' | null;

interface Ctx {
  navigate: (href: string) => void;
  menuOpen: boolean;
  setMenuOpen: (open: boolean) => void;
}

const TransitionContext = createContext<Ctx>({
  navigate: () => {},
  menuOpen: false,
  setMenuOpen: () => {},
});

export const usePageTransition = () => useContext(TransitionContext);

let lenis: Lenis | null = null;

export function scrollToTop(immediate: boolean) {
  if (lenis) lenis.scrollTo(0, { immediate });
  else window.scrollTo({ top: 0, behavior: immediate ? 'instant' : 'smooth' });
}

export function setScrollLocked(locked: boolean) {
  if (lenis) {
    if (locked) lenis.stop();
    else lenis.start();
  }
  document.documentElement.style.overflow = locked ? 'hidden' : '';
}

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** "/pricing", "/pricing/" and "/pricing/?x" all name the same page. */
const pathOf = (href: string) => {
  const p = href.split(/[?#]/)[0] ?? '/';
  return p.length > 1 ? p.replace(/\/+$/, '') : '/';
};

const ENTER_MS = 780;
const SETTLE_MS = 80;
const EXIT_MS = 950;

export function TransitionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [phase, setPhase] = useState<Phase>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const busy = useRef(false);
  const pending = useRef<string | null>(null);
  const timers = useRef<number[]>([]);
  const mounted = useRef(false);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  // Smooth scroll.
  useEffect(() => {
    if (reducedMotion()) return;
    lenis = new Lenis({ lerp: 0.09, smoothWheel: true });
    let id = 0;
    const raf = (t: number) => {
      lenis?.raf(t);
      id = requestAnimationFrame(raf);
    };
    id = requestAnimationFrame(raf);
    return () => {
      cancelAnimationFrame(id);
      lenis?.destroy();
      lenis = null;
    };
  }, []);

  useEffect(() => () => timers.current.forEach((t) => clearTimeout(t)), []);

  const finish = useCallback(() => {
    scrollToTop(true);
    later(() => setPhase('out'), SETTLE_MS);
    later(() => {
      setPhase(null);
      busy.current = false;
    }, EXIT_MS);
  }, []);

  // The new route has rendered: reset scroll and lift the columns.
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (pending.current !== null) {
      if (pending.current === pathOf(pathname)) {
        pending.current = null;
        finish();
      }
      return;
    }
    scrollToTop(true);
  }, [pathname, finish]);

  const navigate = useCallback(
    (href: string) => {
      setMenuOpen(false);
      const target = pathOf(href);
      if (target === pathOf(pathname)) {
        scrollToTop(false);
        return;
      }
      if (busy.current) return;
      if (reducedMotion()) {
        router.push(href);
        return;
      }
      busy.current = true;
      router.prefetch(href);
      setPhase('pre');
      // rAF can be throttled (background tab); never let a late frame re-cover the page.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setPhase((p) => (p === 'pre' ? 'in' : p))),
      );
      later(() => {
        pending.current = target;
        router.push(href, { scroll: false });
        // If the route never commits (offline, error), don't leave the screen covered.
        later(() => {
          if (pending.current === target) {
            pending.current = null;
            finish();
          }
        }, 4000);
      }, ENTER_MS);
    },
    [pathname, router, finish],
  );

  return (
    <TransitionContext.Provider value={{ navigate, menuOpen, setMenuOpen }}>
      {children}
      <Stairs phase={phase} />
      <RevealObserver pathname={pathname} />
    </TransitionContext.Provider>
  );
}

function Stairs({ phase }: { phase: Phase }) {
  if (!phase) return null;
  return (
    <div
      className="stairs"
      aria-hidden="true"
      style={{ pointerEvents: phase === 'out' ? 'none' : 'auto' }}
    >
      {[0, 1, 2, 3, 4].map((i) => {
        const odd = i % 2 === 1;
        const transform =
          phase === 'in'
            ? 'translateY(0)'
            : phase === 'pre'
              ? `translateY(${odd ? '101%' : '-101%'})`
              : `translateY(${odd ? '-101%' : '101%'})`;
        return (
          <div
            key={i}
            style={{
              transform,
              transition:
                phase === 'pre' ? 'none' : `transform .72s var(--ease-stairs) ${i * 55}ms`,
            }}
          />
        );
      })}
    </div>
  );
}

/** Reveals every [data-reveal] block once it is 12% in view; also starts [data-delay] staggers. */
function RevealObserver({ pathname }: { pathname: string }) {
  useEffect(() => {
    const show = (el: HTMLElement) => el.setAttribute('data-in', '');
    if (reducedMotion() || !('IntersectionObserver' in window)) {
      document.querySelectorAll<HTMLElement>('[data-reveal]').forEach(show);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const el = en.target as HTMLElement;
          io.unobserve(el);
          const d = Number(el.dataset.delay) || 0;
          if (d) window.setTimeout(() => show(el), d);
          else show(el);
        }
      },
      { threshold: 0.12, rootMargin: '0px 0px -6% 0px' },
    );
    const scan = (root: ParentNode) =>
      root.querySelectorAll<HTMLElement>('[data-reveal]:not([data-in])').forEach((el) => {
        io.observe(el);
      });
    scan(document);
    const mo = new MutationObserver((ms) => {
      for (const m of ms)
        m.addedNodes.forEach((n) => {
          if (!(n instanceof HTMLElement)) return;
          if (n.matches('[data-reveal]:not([data-in])')) io.observe(n);
          scan(n);
        });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      io.disconnect();
      mo.disconnect();
    };
  }, [pathname]);
  return null;
}

type AnchorProps = Omit<ComponentProps<'a'>, 'href'> & { href: string };

/** An internal link that runs the page transition before navigating. */
export function TLink({ href, onClick, children, ...rest }: AnchorProps) {
  const { navigate } = usePageTransition();
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(href);
  };
  return (
    <Link href={href} onClick={handle} {...rest}>
      {children}
    </Link>
  );
}

/** Internal paths get the transition; everything else is a plain external link. */
export function SmartLink({ href, children, ...rest }: AnchorProps) {
  if (href.startsWith('/')) {
    return (
      <TLink href={href} {...rest}>
        {children}
      </TLink>
    );
  }
  const external = /^https?:/.test(href);
  return (
    <a
      href={href}
      {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
      {...rest}
    >
      {children}
    </a>
  );
}
