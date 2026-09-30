'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { AuditReport as Report } from '@/lib/audit';
import { decryptedCsv, downloadText, getReport, totals } from '@/lib/audit';
import { formatDay, formatUsdc, isoDay, shortSig } from '@/lib/format';
import { solscanTx } from '@/lib/site';
import { Decrypt } from './decrypt';
import { DataTable, minCol } from './ui';

const shortParty = (s: string) =>
  s.startsWith('@') || s.length <= 14 ? s : `${s.slice(0, 5)}…${s.slice(-4)}`;

export function AuditReportView() {
  const router = useRouter();
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    const r = getReport();
    if (!r) router.replace('/audit/');
    else setReport(r);
  }, [router]);

  if (!report) return <section className="wrap" style={{ minHeight: '60vh' }} aria-busy="true" />;

  const t = totals(report.rows);
  const scope =
    report.scopeFrom && report.scopeTo
      ? `${formatDay(report.scopeFrom)} – ${formatDay(report.scopeTo)}`
      : 'Audit report';
  const base = `vexa-audit-${report.sample ? 'sample' : report.keyId}`;

  const downloadDecrypted = () => downloadText(`${base}-decrypted.csv`, decryptedCsv(report));
  const downloadOriginal = () => {
    if (!report.rawCsv) return;
    downloadText(`${base}.csv`, report.rawCsv);
    const sig = [
      `signature ${report.signature ?? 'missing'}`,
      `public_key ${report.publicKey ?? 'unknown'}`,
      'algorithm ed25519 over the exact bytes of the .csv file',
      '',
    ].join('\n');
    window.setTimeout(() => downloadText(`${base}.csv.sig`, sig, 'text/plain;charset=utf-8'), 300);
  };

  return (
    <section
      className="wrap"
      style={{ paddingTop: 'clamp(120px,16vh,170px)', paddingBottom: 'clamp(40px,6vw,80px)' }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          gap: 16,
          alignItems: 'flex-end',
          marginBottom: 28,
        }}
      >
        <div>
          <p className="eyebrow" style={{ marginBottom: 14 }}>
            Audit report
          </p>
          <h1
            style={{
              font: '500 clamp(34px,4.4vw,56px)/1 var(--sans)',
              letterSpacing: '-.035em',
              color: 'var(--paper)',
              margin: 0,
            }}
          >
            {scope}
          </h1>
        </div>
        {report.sample ? (
          <div className="chip chip-warn" style={{ padding: '9px 13px' }}>
            <span className="dot dot-paper" />
            Sample data · not a real account
          </div>
        ) : report.signatureValid ? (
          <div className="chip chip-signal" style={{ padding: '9px 13px' }}>
            <span className="dot" />
            Signed by Vexa · signature verified
          </div>
        ) : (
          <div className="chip chip-warn" style={{ padding: '9px 13px' }} role="alert">
            <span className="dot dot-paper" />
            Signature failed. Do not rely on this file.
          </div>
        )}
      </div>

      <div className="hgrid" style={{ ...minCol(200), marginBottom: 32 }}>
        <div className="hcell" style={{ padding: 'clamp(18px,2.4vw,28px)' }}>
          <div className="num-label" style={{ marginBottom: 12 }}>
            Transfers
          </div>
          <div className="big" style={{ fontSize: 'clamp(28px,3vw,40px)', letterSpacing: 0 }}>
            {report.rows.length}
          </div>
          {t.decrypted < report.rows.length && (
            <div className="muted-caption" style={{ marginTop: 8 }}>
              {t.decrypted} of {report.rows.length} decrypted
            </div>
          )}
        </div>
        <div className="hcell" style={{ padding: 'clamp(18px,2.4vw,28px)' }}>
          <div className="num-label" style={{ marginBottom: 12 }}>
            Total sent
          </div>
          <Decrypt
            text={formatUsdc(t.sent, 2)}
            className="big"
            style={{
              fontSize: 'clamp(28px,3vw,40px)',
              letterSpacing: 0,
              whiteSpace: 'pre',
              overflow: 'hidden',
            }}
          />
        </div>
        <div className="hcell" style={{ padding: 'clamp(18px,2.4vw,28px)' }}>
          <div className="num-label" style={{ marginBottom: 12 }}>
            Total received
          </div>
          <Decrypt
            text={formatUsdc(t.received, 2)}
            className="big"
            style={{
              fontSize: 'clamp(28px,3vw,40px)',
              letterSpacing: 0,
              whiteSpace: 'pre',
              overflow: 'hidden',
            }}
          />
        </div>
        <div
          className="hcell"
          style={{
            padding: 'clamp(18px,2.4vw,28px)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: 10,
          }}
        >
          <button
            type="button"
            className="btn btn-primary"
            style={{ fontSize: 16, padding: '12px 18px', minHeight: 44 }}
            onClick={downloadDecrypted}
          >
            Download decrypted CSV
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            style={{ fontSize: 16, padding: '11px 18px', minHeight: 44 }}
            onClick={downloadOriginal}
            disabled={!report.rawCsv}
            title={report.rawCsv ? undefined : 'Sample data has no signed original'}
          >
            Download signed original
          </button>
        </div>
      </div>

      <DataTable
        label="Transfers in scope"
        head={['Date', 'Direction', 'Counterparty', 'Amount (USDC)', 'Memo', 'Tx']}
        template="1fr .7fr 1.3fr 1fr 1.4fr .8fr"
        minWidth={720}
        headStyle={(c) => (c === 3 ? { textAlign: 'right', paddingRight: 24 } : undefined)}
        cell={(c) => {
          const base = { font: '400 15px/1.3 var(--mono)', padding: '15px 0' } as const;
          if (c === 2)
            return {
              style: {
                ...base,
                color: 'var(--paper)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                paddingRight: 12,
              },
            };
          if (c === 3)
            return {
              style: {
                ...base,
                color: 'var(--paper)',
                padding: '15px 24px 15px 0',
                textAlign: 'right',
              },
            };
          if (c === 4)
            return {
              style: {
                font: '400 17px/1.3 var(--sans)',
                padding: '14px 16px 14px 0',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            };
          return { style: base };
        }}
        rows={report.rows.map((r) => [
          isoDay(r.createdAt),
          r.direction,
          <span key="cp" title={r.counterparty}>
            {shortParty(r.counterparty)}
          </span>,
          r.amount === null ? (
            <span
              key="a"
              style={{ color: 'var(--moss)' }}
              title="This record did not decrypt with this key"
            >
              —
            </span>
          ) : (
            formatUsdc(r.amount)
          ),
          <span key="m" title={r.memo ?? undefined}>
            {r.memo ?? ''}
          </span>,
          !r.txSig ? (
            ''
          ) : report.sample ? (
            <span key="tx" style={{ color: 'var(--moss)' }}>
              {r.txSig}
            </span>
          ) : (
            <a
              key="tx"
              className="hit tx-link"
              href={solscanTx(r.txSig)}
              target="_blank"
              rel="noopener noreferrer"
            >
              {shortSig(r.txSig)} ↗
            </a>
          ),
        ])}
      />
      {report.rows.length === 0 && (
        <p className="body-18" style={{ padding: '20px 0', color: 'var(--ash)' }}>
          No transfers in this key&rsquo;s scope yet.
        </p>
      )}
      <p style={{ font: '400 15px/1.45 var(--sans)', color: 'var(--moss)', margin: '20px 0 0' }}>
        {report.sample
          ? 'This is sample data for illustration. It was generated in this browser and is not a real account.'
          : 'Amounts were decrypted in this browser. The key is held in memory only.'}
      </p>
    </section>
  );
}
