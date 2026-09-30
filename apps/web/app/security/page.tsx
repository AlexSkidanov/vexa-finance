import { LiveReserve } from '@/components/live-reserve';
import { minCol, SubHero } from '@/components/ui';
import { pageMeta } from '@/lib/meta';
import {
  CONTRACT_LIST,
  CONTRACTS,
  DOCS,
  SECURITY_EMAIL,
  VAULT_BYTES,
  VAULT_SHA256,
  VAULT_VERSION,
} from '@/lib/site';

export const metadata = pageMeta(
  'Security and transparency',
  'Every dollar in the reserve is public. Every balance is not. Live reserve and supply, contract addresses and the deployed bytecode hash.',
  '/security/',
);

const CAN: [boolean, string][] = [
  [true, 'pause deposits and withdrawals'],
  [false, 'move user funds'],
  [false, 'read balances or memos'],
  [false, "change an agent's policy"],
];

const inlineMono = { font: '400 14px var(--mono)' } as const;

export default function Security() {
  return (
    <>
      <SubHero
        eyebrow="Security and transparency"
        title="Every dollar in the reserve is public. Every balance is not."
      />
      <section className="wrap sec-next">
        <LiveReserve variant="security" />
      </section>
      <section className="wrap sec-next">
        <h2 data-reveal="1" className="h2-sm" style={{ marginBottom: 24, textWrap: 'initial' }}>
          Contracts
        </h2>
        <div
          data-reveal="1"
          data-delay="80"
          style={{ display: 'grid', borderTop: '1px solid var(--paper)' }}
        >
          {CONTRACT_LIST.map((c) => (
            <div key={c.name} className="contract-row">
              <div style={{ font: '400 19px/1.3 var(--sans)', color: 'var(--paper)' }}>
                {c.name}{' '}
                <span
                  style={{ font: '400 13px/1 var(--mono)', color: 'var(--moss)', marginLeft: 8 }}
                >
                  {c.chain}
                </span>
              </div>
              <a
                href={c.href}
                target="_blank"
                rel="noopener noreferrer"
                className="contract-addr"
                aria-label={`${c.name}: ${c.addr}, opens ${c.chain === 'NEAR' ? 'NearBlocks' : 'Solscan'}`}
                style={{ display: 'flex', gap: '0.5ch', minHeight: 44, alignItems: 'center' }}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                  }}
                >
                  {c.addr}
                </span>
                <span aria-hidden="true" style={{ flex: 'none' }}>
                  ↗
                </span>
              </a>
            </div>
          ))}
        </div>
        <div data-reveal="1" className="grid" style={{ ...minCol(300), marginTop: 28, gap: 24 }}>
          <div className="box" style={{ padding: 'clamp(20px,2.6vw,28px)' }}>
            <div className="num-label" style={{ marginBottom: 12 }}>
              Deployed bytecode hash · vault {VAULT_VERSION}
            </div>
            <div
              style={{
                font: '400 14px/1.5 var(--mono)',
                color: 'var(--paper)',
                wordBreak: 'break-all',
                userSelect: 'all',
              }}
            >
              sha256:{VAULT_SHA256}
            </div>
            <p
              style={{
                font: '400 16px/1.45 var(--sans)',
                color: 'var(--body)',
                margin: '12px 0 0',
              }}
            >
              Dump the program with{' '}
              <span style={{ ...inlineMono, wordBreak: 'break-all' }}>
                solana program dump {CONTRACTS.vault} vault.so -um
              </span>{' '}
              and hash the first {VAULT_BYTES.toLocaleString('en-US')} bytes:{' '}
              <span style={inlineMono}>head -c {VAULT_BYTES} vault.so | shasum -a 256</span>.
            </p>
          </div>
          <div className="box" style={{ padding: 'clamp(20px,2.6vw,28px)' }}>
            <div className="num-label" style={{ marginBottom: 12 }}>
              What Vexa can and cannot do
            </div>
            <ul
              style={{
                display: 'grid',
                gap: 8,
                font: '400 17px/1.4 var(--sans)',
                color: 'var(--body)',
                listStyle: 'none',
                margin: 0,
                padding: 0,
              }}
            >
              {CAN.map(([can, text]) => (
                <li key={text}>
                  <span
                    style={{
                      color: can ? 'var(--signal)' : 'var(--moss)',
                      fontFamily: 'var(--mono)',
                      fontSize: 14,
                      marginRight: 10,
                    }}
                  >
                    {can ? 'can' : "can't"}
                  </span>
                  {text}
                </li>
              ))}
            </ul>
          </div>
        </div>
        <p
          data-reveal="1"
          style={{ font: '400 17px/1.45 var(--sans)', color: 'var(--ash)', margin: '28px 0 0' }}
        >
          Responsible disclosure:{' '}
          <span style={{ font: '400 15px var(--mono)', color: 'var(--paper)', userSelect: 'all' }}>
            {SECURITY_EMAIL}
          </span>
          . Scope and process in{' '}
          <a
            href={DOCS.security}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-link hit"
          >
            SECURITY.md
          </a>
          .
        </p>
      </section>
    </>
  );
}
