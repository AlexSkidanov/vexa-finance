'use client';

import { useState } from 'react';
import { useClient } from '@/components/session';
import {
  Empty,
  Loading,
  OnceSecret,
  PageHead,
  ProblemNote,
  Sheet,
  StatusChip,
  useAction,
  useLoad,
} from '@/components/ui';
import type { ViewKeySummary } from '@/lib/client';
import { AUDIT_URL } from '@/lib/config';
import { dateInputValue, formatDay } from '@/lib/format';

export default function Privacy() {
  const client = useClient();
  const keys = useLoad(() => client.viewKeys(), [client]);
  const sync = useAction();
  const [synced, setSynced] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<{ title: string; key: string; recorded?: number } | null>(
    null,
  );
  const [revoking, setRevoking] = useState<ViewKeySummary | null>(null);
  const active = keys.data?.filter((k) => !k.revokedAt) ?? [];

  return (
    <>
      <PageHead
        title="Privacy"
        lede="View keys give an accountant or auditor read-only access to your transfers in a date range, and nothing else. You can revoke one at any time."
      >
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
          New view key
        </button>
      </PageHead>

      <div className="notice" style={{ marginBottom: 24 }}>
        Your device re-encrypts each transfer in scope to the key, so Vexa stores only ciphertexts
        it can’t read. Auditors open the key at{' '}
        <a href={AUDIT_URL} target="_blank" rel="noopener noreferrer">
          vexa.finance/audit
        </a>
        , no account needed.
      </div>

      <div className="section-head">
        <h2 className="section-title">Your view keys</h2>
        {active.length > 0 && (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={sync.busy}
            aria-busy={sync.busy}
            onClick={() =>
              void sync.run(async () => {
                setSynced(await client.syncViewKeys());
              })
            }
          >
            {sync.busy ? 'Syncing…' : 'Sync new transfers'}
          </button>
        )}
      </div>
      {synced !== null && (
        <p className="field-ok" role="status" style={{ marginTop: 0, marginBottom: 12 }}>
          {synced === 0
            ? 'Everything was already shared.'
            : `Added ${synced} transfer${synced === 1 ? '' : 's'}.`}
        </p>
      )}
      <ProblemNote problem={sync.error} />
      {keys.loading && !keys.data && <Loading />}
      <ProblemNote problem={keys.error} onRetry={keys.reload} />
      {keys.data && keys.data.length === 0 && (
        <Empty>No view keys yet. Create one when someone needs to see your books.</Empty>
      )}
      {keys.data && keys.data.length > 0 && (
        <div className="list">
          {keys.data.map((k) => (
            <div
              key={k.id}
              className="item"
              style={{ gridTemplateColumns: 'minmax(0,1fr) auto', cursor: 'default' }}
            >
              <span className="min0">
                <span className="item-title" style={{ display: 'block' }}>
                  {k.label ?? 'Untitled key'}
                </span>
                <span className="item-sub" style={{ display: 'block' }}>
                  {formatDay(k.from)} – {formatDay(new Date(new Date(k.to).getTime() - 1))} · issued{' '}
                  {formatDay(k.createdAt)}
                </span>
              </span>
              <span className="row" style={{ justifyContent: 'flex-end' }}>
                {k.revokedAt ? (
                  <StatusChip status="revoked" />
                ) : (
                  <>
                    <button
                      type="button"
                      className="max-btn"
                      onClick={() =>
                        setShown({ title: k.label ?? 'View key', key: client.viewKeyFor(k.id) })
                      }
                    >
                      Show
                    </button>
                    <button type="button" className="max-btn" onClick={() => setRevoking(k)}>
                      Revoke
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <CreateSheet
          onClose={() => setCreating(false)}
          onCreated={(title, key, recorded) => {
            setCreating(false);
            setShown({ title, key, recorded });
            keys.reload();
          }}
        />
      )}
      {shown && (
        <Sheet title={shown.title} onClose={() => setShown(null)}>
          {shown.recorded !== undefined && (
            <p className="help" style={{ marginTop: 0, marginBottom: 12 }}>
              Shared {shown.recorded} transfer{shown.recorded === 1 ? '' : 's'} so far. Use Sync to
              add new ones in the range.
            </p>
          )}
          <OnceSecret
            value={shown.key}
            what="view key"
            warning={
              <>
                <strong>Send it privately.</strong> Anyone with this key can read every transfer in
                its range. You can show it again here while unlocked, or revoke it.
              </>
            }
          />
          <p className="help">
            They open it at{' '}
            <a href={AUDIT_URL} target="_blank" rel="noopener noreferrer">
              vexa.finance/audit
            </a>
            .
          </p>
        </Sheet>
      )}
      {revoking && (
        <RevokeSheet
          viewKey={revoking}
          onClose={() => setRevoking(null)}
          onDone={() => {
            setRevoking(null);
            keys.reload();
          }}
        />
      )}
    </>
  );
}

function CreateSheet({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (title: string, key: string, recorded: number) => void;
}) {
  const client = useClient();
  const act = useAction();
  const now = new Date();
  const [label, setLabel] = useState('');
  const [from, setFrom] = useState(dateInputValue(new Date(now.getFullYear(), 0, 1)));
  const [to, setTo] = useState(dateInputValue(now));
  // The range is [from, to), so the end date is included by going to the next midnight.
  const fromDate = new Date(`${from}T00:00:00`);
  const toDate = new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000);
  const valid = !!from && !!to && fromDate < toDate;

  return (
    <Sheet title="New view key" onClose={onClose} dismissable={!act.busy}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          if (!valid) return;
          void act.run(async () => {
            const r = await client.createViewKey({
              ...(label.trim() ? { label: label.trim() } : {}),
              from: fromDate,
              to: toDate,
            });
            onCreated(label.trim() || 'View key', r.viewKey, r.recorded);
          });
        }}
      >
        <div>
          <label className="field-label" htmlFor="vk-label">
            Label
          </label>
          <input
            id="vk-label"
            className="input"
            maxLength={64}
            placeholder="FY2026 accountant"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <div className="grid" style={{ ['--min' as string]: '180px', gap: 12 }}>
          <div>
            <label className="field-label" htmlFor="vk-from">
              From
            </label>
            <input
              id="vk-from"
              className="input"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="vk-to">
              To (inclusive)
            </label>
            <input
              id="vk-to"
              className="input"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
        {!valid && <p className="field-error">The start has to be before the end.</p>}
        <p className="help">
          Covers transfers sent and received in the range: amounts, memos and counterparties.
          Balances, agents and anything outside the range stay private.
        </p>
        <ProblemNote problem={act.error} />
        <button
          className="btn btn-primary btn-lg"
          disabled={!valid || act.busy}
          aria-busy={act.busy}
        >
          {act.busy ? 'Encrypting records on this device…' : 'Create view key'}
        </button>
      </form>
    </Sheet>
  );
}

function RevokeSheet({
  viewKey,
  onClose,
  onDone,
}: {
  viewKey: ViewKeySummary;
  onClose: () => void;
  onDone: () => void;
}) {
  const client = useClient();
  const act = useAction();
  return (
    <Sheet title="Revoke view key?" onClose={onClose} dismissable={!act.busy}>
      <p className="help" style={{ marginTop: 0 }}>
        {viewKey.label ?? 'This key'} stops working straight away and Vexa deletes its records.
        Anything the auditor already downloaded stays with them.
      </p>
      <ProblemNote problem={act.error} />
      <div className="sheet-actions">
        <button
          type="button"
          className="btn btn-primary btn-lg"
          disabled={act.busy}
          aria-busy={act.busy}
          onClick={() =>
            void act.run(async () => {
              await client.revokeViewKey(viewKey.id);
              onDone();
            })
          }
        >
          {act.busy ? 'Revoking…' : 'Revoke'}
        </button>
        <button type="button" className="btn btn-secondary" disabled={act.busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
