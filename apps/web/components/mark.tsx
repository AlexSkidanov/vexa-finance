export const PETALS = [
  'M24 2A22 22 0 0 1 46 24V43A3 3 0 0 1 43 46H24A22 22 0 0 1 2 24A22 22 0 0 1 24 2Z',
  'M72 2A22 22 0 0 1 94 24A22 22 0 0 1 72 46H53A3 3 0 0 1 50 43V24A22 22 0 0 1 72 2Z',
  'M53 50H72A22 22 0 0 1 94 72A22 22 0 0 1 72 94A22 22 0 0 1 50 72V53A3 3 0 0 1 53 50Z',
  'M2 72A22 22 0 0 1 24 50H43A3 3 0 0 1 46 53V96A22 22 0 0 1 24 118A22 22 0 0 1 2 96V72Z',
] as const;

/** The compact white mark used in the header and footer. */
export function Mark({ height }: { height: number }) {
  return (
    <svg
      viewBox="0 0 96 120"
      style={{ height, width: 'auto' }}
      aria-hidden="true"
      focusable="false"
    >
      {PETALS.map((d) => (
        <path key={d} d={d} fill="#F2F2F2" />
      ))}
    </svg>
  );
}
