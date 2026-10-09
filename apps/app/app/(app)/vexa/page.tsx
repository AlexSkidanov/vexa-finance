'use client';

import { TIERS } from '@vexa/core';
import { useState } from 'react';
import { useClient } from '@/components/session';
import {
  AmountInput,
  amountState,
  Loading,
  PageHead,
  ProblemNote,
  Row,
  useAction,
  useLoad,
} from '@/components/ui';
import { amountToInput, formatAmount, formatBps, percentOf } from '@/lib/amount';
import { formatDay, untilText } from '@/lib/format';
import { SITE_URL } from '@/lib/config';

export default function Vexa() {
  const client = useClient();
  const tier = useLoad(() => client.tier(), [client]);
  const t = tier.data;
  const live = !!t?.vexaMint;
  const next = t ? TIERS.find((x) => x.level === t.tier.level + 1) : undefined;

  return (
    <>
      <PageHead
        title="$VEXA"
        lede="Hold or stake $VEXA for lower fees and bigger agent limits. Your weight is what you stake plus half of what’s in your wallet."
      />
      {tier.loading && !t && <Loading />}
      <ProblemNote problem={tier.error} onRetry={tier.reload} />

      {t && !live && (
        <div className="notice" style={{ marginBottom: 24 }}>
          <strong>$VEXA isn’t live yet.</strong> Staking opens when the token launches; until then
          everyone is on tier 0. Follow{' '}
          <a href={`${SITE_URL}/vexa/`} target="_blank" rel="noopener noreferrer">
            vexa.finance/vexa
          </a>{' '}
          for the launch.
        </div>
      )}

      {t && (
        <section className="hgrid" style={{ ['--min' as string]: '180px' }}>
          <div className="hcell">
            <div className="num-label">Tier</div>
            <div className="big" style={{ fontSize: 40 }}>
              {t.tier.level}
            </div>
            <p className="help">{formatBps(t.tier.discountBps)} off fees</p>
          </div>
          <div className="hcell">
            <div className="num-label">Weight</div>
            <div className="big" style={{ fontSize: 40 }}>
              {formatAmount(t.weight, { minDecimals: 0 })}
            </div>
            {next && (
              <>
                <div className="meter" style={{ marginTop: 14 }} aria-hidden="true">
                  <div style={{ width: `${percentOf(t.weight, next.minWeight)}%` }} />
                </div>
                <p className="help">
                  {formatAmount(next.minWeight, { minDecimals: 0 })} for tier {next.level}
                </p>
              </>
            )}
          </div>
          <div className="hcell">
            <div className="num-label">Agents</div>
            <div className="big" style={{ fontSize: 40 }}>
              {t.tier.maxAgents}
            </div>
            <p className="help">
              up to {formatAmount(t.tier.agentDailyLimit, { minDecimals: 0 })} USDC a day each
            </p>
          </div>
        </section>
      )}

      {t && (
        <section className="section grid gap-lg" style={{ ['--min' as string]: '300px' }}>
          <div className="panel-flat stack-sm">
            <Row k="Staked" v={`${formatAmount(t.staked)} $VEXA`} />
            <Row k="In wallet" v={`${formatAmount(t.held)} $VEXA`} />
            <Row
              k="Unlocks"
              v={
                t.unlockAt
                  ? new Date(t.unlockAt) > new Date()
                    ? `${formatDay(t.unlockAt)} (${untilText(t.unlockAt)})`
                    : 'Unlocked'
                  : '—'
              }
            />
          </div>
          <StakeForms
            live={live}
            staked={t.staked}
            held={t.held}
            unlockAt={t.unlockAt}
            onDone={tier.reload}
          />
        </section>
      )}

      <section className="section">
        <h2 className="section-title" style={{ marginBottom: 14 }}>
          Tiers
        </h2>
        <div className="tscroll" tabIndex={0} role="region" aria-label="Tiers">
          <div
            className="tbl"
            role="table"
            style={{ gridTemplateColumns: '.6fr 1.2fr 1fr .8fr 1.2fr', minWidth: 520 }}
          >
            {['Tier', 'Weight', 'Fee discount', 'Agents', 'Agent limit / day'].map((h) => (
              <div key={h} className="th" role="columnheader">
                {h}
              </div>
            ))}
            {TIERS.map((x) => {
              const mine = t?.tier.level === x.level;
              const cls = mine ? 'td first signal' : 'td';
              return [
                <div key={`${x.level}a`} className={cls} role="cell">
                  {x.level}
                  {mine ? ' ·  you' : ''}
                </div>,
                <div key={`${x.level}b`} className={cls} role="cell">
                  {formatAmount(x.minWeight, { minDecimals: 0 })}
                </div>,
                <div key={`${x.level}c`} className={cls} role="cell">
                  {formatBps(x.discountBps)}
                </div>,
                <div key={`${x.level}d`} className={cls} role="cell">
                  {x.maxAgents}
                </div>,
                <div key={`${x.level}e`} className={cls} role="cell">
                  ${formatAmount(x.agentDailyLimit, { minDecimals: 0 })}
                </div>,
              ];
            })}
          </div>
        </div>
      </section>
    </>
  );
}

function StakeForms({
  live,
  staked,
  held,
  unlockAt,
  onDone,
}: {
  live: boolean;
  staked: bigint;
  held: bigint;
  unlockAt: string | null;
  onDone: () => void;
}) {
  const client = useClient();
  const [mode, setMode] = useState<'stake' | 'unstake'>('stake');
  const [input, setInput] = useState('');
  const act = useAction();
  const [done, setDone] = useState<string | null>(null);
  const { parsed, problem } = amountState(input);
  const limit = mode === 'stake' ? held : staked;
  const locked = !live || (mode === 'unstake' && !!unlockAt && new Date(unlockAt) > new Date());
  const over = parsed.ok && parsed.value > limit;

  return (
    <div className="panel-flat stack">
      <div className="row" role="group">
        {(['stake', 'unstake'] as const).map((m) => (
          <button
            key={m}
            type="button"
            className="seg"
            aria-pressed={mode === m}
            disabled={!live}
            onClick={() => {
              setMode(m);
              setInput('');
              setDone(null);
            }}
          >
            {m === 'stake' ? 'Stake' : 'Unstake'}
          </button>
        ))}
      </div>
      <AmountInput
        id="stake-amount"
        label={mode === 'stake' ? 'Stake from wallet' : 'Return to wallet'}
        unit="$VEXA"
        value={input}
        onChange={setInput}
        disabled={locked}
        {...(limit > 0n ? { onMax: () => setInput(amountToInput(limit)) } : {})}
      />
      {problem && <p className="field-error">{problem}</p>}
      {over && (
        <p className="field-error">
          You have {formatAmount(limit)} to {mode}.
        </p>
      )}
      {locked && unlockAt && <p className="help">Staked $VEXA unlocks {untilText(unlockAt)}.</p>}
      {mode === 'stake' && (
        <p className="help">Each stake locks your staked $VEXA for 7 days. Staked counts double.</p>
      )}
      <ProblemNote problem={act.error} />
      {done && (
        <p className="field-ok" role="status">
          {done}
        </p>
      )}
      <button
        type="button"
        className="btn btn-primary"
        disabled={!parsed.ok || over || locked || act.busy}
        aria-busy={act.busy}
        onClick={() =>
          parsed.ok &&
          void act.run(async () => {
            if (mode === 'stake') await client.stake(parsed.value);
            else await client.unstake(parsed.value);
            setDone(
              `${mode === 'stake' ? 'Staked' : 'Unstaked'} ${formatAmount(parsed.value)} $VEXA.`,
            );
            setInput('');
            onDone();
          })
        }
      >
        {act.busy ? 'Confirming…' : mode === 'stake' ? 'Stake' : 'Unstake'}
      </button>
    </div>
  );
}
