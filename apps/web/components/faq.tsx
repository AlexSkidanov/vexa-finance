'use client';

import { useId, useState } from 'react';

export function Faq({ items }: { items: [string, string][] }) {
  const [open, setOpen] = useState(-1);
  const id = useId();
  return (
    <div data-reveal="1" style={{ borderTop: '1px solid var(--paper)' }}>
      {items.map(([q, a], i) => (
        <div key={q} style={{ borderBottom: '1px solid var(--hair)' }}>
          <h2 style={{ margin: 0, font: 'inherit' }}>
            <button
              type="button"
              className="faq-q"
              aria-expanded={open === i}
              aria-controls={`${id}-${i}`}
              onClick={() => setOpen(open === i ? -1 : i)}
            >
              {q}
              <span className="faq-sign" aria-hidden="true">
                {open === i ? '−' : '+'}
              </span>
            </button>
          </h2>
          <p id={`${id}-${i}`} className="faq-a" hidden={open !== i}>
            {a}
          </p>
        </div>
      ))}
    </div>
  );
}
