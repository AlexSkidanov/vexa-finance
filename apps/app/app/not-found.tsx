import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="flow">
      <p className="eyebrow">404</p>
      <h1 className="page-title">This page is encrypted. Or it doesn&rsquo;t exist.</h1>
      <p className="page-lede" style={{ marginBottom: 28 }}>
        The link may be old, or the address mistyped.
      </p>
      <Link href="/" className="btn btn-primary">
        Back to Vexa
      </Link>
    </div>
  );
}
