'use client';

import { useId, useState } from 'react';
import {
  AuditError,
  MSG_INVALID,
  MSG_NETWORK,
  openViewKey,
  sampleReport,
  setReport,
  VIEW_KEY_RE,
} from '@/lib/audit';
import { usePageTransition } from './transition';

export function AuditForm() {
  const { navigate } = usePageTransition();
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const id = useId();

  const open = async () => {
    if (loading) return;
    const k = key.trim();
    if (!VIEW_KEY_RE.test(k)) {
      setError(MSG_INVALID);
      return;
    }
    setError('');
    setLoading(true);
    try {
      const report = await openViewKey(k);
      setReport(report);
      setKey('');
      navigate('/audit/report/');
    } catch (e) {
      setError(e instanceof AuditError ? e.message : MSG_NETWORK);
    } finally {
      setLoading(false);
    }
  };

  const sample = () => {
    setError('');
    setKey('');
    setReport(sampleReport());
    navigate('/audit/report/');
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void open();
      }}
      noValidate
    >
      <label className="field-label" htmlFor={`${id}-key`}>
        View key
      </label>
      <input
        id={`${id}-key`}
        type="text"
        className="input"
        placeholder="vxview_…"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        value={key}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        onChange={(e) => {
          setKey(e.target.value);
          setError('');
        }}
      />
      {error && (
        <p id={`${id}-err`} className="error-note" role="alert">
          {error}
        </p>
      )}
      <div
        style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 18, alignItems: 'center' }}
      >
        <button type="submit" className="btn btn-primary" aria-busy={loading} disabled={loading}>
          {loading ? 'Decrypting in your browser…' : 'Open report'}
        </button>
        <button
          type="button"
          onClick={sample}
          style={{
            background: 'transparent',
            border: 0,
            color: 'var(--ash)',
            font: '400 17px/1 var(--sans)',
            cursor: 'pointer',
            padding: '12px 8px',
            minHeight: 44,
            textDecoration: 'underline',
            textUnderlineOffset: 4,
          }}
          className="sample-btn"
        >
          Use a sample key
        </button>
      </div>
    </form>
  );
}
