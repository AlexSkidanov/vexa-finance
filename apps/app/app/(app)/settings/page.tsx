'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Icon } from '@/components/icons';
import { useClient, useSession } from '@/components/session';
import {
  CopyButton,
  Empty,
  Loading,
  newIdempotencyKey,
  OnceSecret,
  PageHead,
  ProblemNote,
  Row,
  Sheet,
  useAction,
  useLoad,
} from '@/components/ui';
import { WEBHOOK_EVENTS, type WebhookEvent } from '@/lib/client';
import { DOCS_URL } from '@/lib/config';
import { formatDay, formatWhen, LEGAL, shortAddress, STATUS_URL } from '@/lib/format';

export default function Settings() {
  const client = useClient();
  const { profile, lock, signOut } = useSession();
  const address = client.address();

  return (
    <>
      <PageHead title="Settings" />

      <nav className="mobile-only" aria-label="More" style={{ marginBottom: 32 }}>
        <div className="list">
          {[
            { href: '/add/', label: 'Add money', icon: Icon.add },
            { href: '/withdraw/', label: 'Withdraw', icon: Icon.withdraw },
            { href: '/privacy/', label: 'Privacy and view keys', icon: Icon.privacy },
            { href: '/vexa/', label: '$VEXA', icon: Icon.token },
          ].map(({ href, label, icon: Ic }) => (
            <Link
              key={href}
              href={href}
              className="item"
              style={{ gridTemplateColumns: '40px 1fr' }}
            >
              <span className="item-icon">
                <Ic />
              </span>
              <span className="item-title">{label}</span>
            </Link>
          ))}
        </div>
      </nav>

      <section>
        <h2 className="section-title" style={{ marginBottom: 14 }}>
          Account
        </h2>
        <div className="panel-flat stack-sm">
          <Row k="Handle" v={profile?.handle ?? '—'} />
          <Row k="Email" v={profile?.email ?? '—'} />
          <Row k="Solana address" v={<span className="mono">{shortAddress(address, 6, 6)}</span>} />
          {profile && <Row k="Member since" v={formatDay(profile.createdAt)} />}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <CopyButton value={address} label="Copy address" />
        </div>
      </section>

      <section className="section">
        <h2 className="section-title" style={{ marginBottom: 14 }}>
          Passkey
        </h2>
        <div className="panel-flat stack-sm">
          <p className="body-18">
            Your passkey is the only way into this account: your keys are computed from it each time
            you unlock. Keep it in a password manager that syncs across your devices (iCloud
            Keychain, Google Password Manager, 1Password) and it survives a lost phone.
          </p>
          <p className="help">
            A second, different passkey would compute different keys and couldn’t open this balance,
            so Vexa doesn’t offer to add one. To use Vexa on another device, sync this passkey
            there.
          </p>
        </div>
      </section>

      <ApiKeys />
      <Webhooks />

      <section className="section">
        <h2 className="section-title" style={{ marginBottom: 14 }}>
          Session
        </h2>
        <p className="help" style={{ marginTop: 0, marginBottom: 14 }}>
          Locking forgets your keys on this device; your passkey brings them back. Vexa also locks
          itself after ten minutes in the background.
        </p>
        <div className="row">
          <button type="button" className="btn btn-secondary" onClick={lock}>
            Lock now
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => signOut()}>
            Sign out
          </button>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title" style={{ marginBottom: 14 }}>
          About
        </h2>
        <div className="row" style={{ gap: 18 }}>
          {LEGAL.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="tlink"
              target="_blank"
              rel="noopener noreferrer"
            >
              {l.label}
            </a>
          ))}
          <a href={DOCS_URL} className="tlink" target="_blank" rel="noopener noreferrer">
            API docs
          </a>
          <a href={STATUS_URL} className="tlink" target="_blank" rel="noopener noreferrer">
            Status
          </a>
        </div>
      </section>
    </>
  );
}

function ApiKeys() {
  const client = useClient();
  const keys = useLoad(() => client.apiKeys(), [client]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [key, setKey] = useState(newIdempotencyKey);
  const [secret, setSecret] = useState<string | null>(null);
  const create = useAction();
  const revoke = useAction();
  const [revoking, setRevoking] = useState<string | null>(null);
  const list = keys.data?.filter((k) => !k.revokedAt) ?? [];

  const close = () => {
    setCreating(false);
    setSecret(null);
    setName('');
    setKey(newIdempotencyKey());
    create.setError(null);
  };

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">API keys</h2>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setCreating(true)}
        >
          New key
        </button>
      </div>
      <p className="help" style={{ marginTop: -6, marginBottom: 14 }}>
        For your servers and agents. A key acts as you, except that it can’t create keys or register
        passkeys.
      </p>
      {keys.loading && !keys.data && <Loading />}
      <ProblemNote problem={keys.error ?? revoke.error} onRetry={keys.reload} />
      {keys.data && list.length === 0 && <Empty>No API keys.</Empty>}
      {list.length > 0 && (
        <div className="list">
          {list.map((k) => (
            <div
              key={k.id}
              className="item"
              style={{ gridTemplateColumns: 'minmax(0,1fr) auto', cursor: 'default' }}
            >
              <span className="min0">
                <span className="item-title" style={{ display: 'block' }}>
                  {k.name}
                </span>
                <span className="item-sub mono" style={{ display: 'block' }}>
                  {k.prefix}… · {k.lastUsedAt ? `used ${formatWhen(k.lastUsedAt)}` : 'never used'}
                </span>
              </span>
              <button
                type="button"
                className="max-btn"
                disabled={revoke.busy}
                onClick={() => setRevoking(k.id)}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
      {revoking && (
        <Sheet
          title="Revoke this key?"
          onClose={() => setRevoking(null)}
          dismissable={!revoke.busy}
        >
          <p className="help" style={{ marginTop: 0 }}>
            Anything using it stops working straight away, including agents that use it.
          </p>
          <div className="sheet-actions">
            <button
              type="button"
              className="btn btn-primary btn-lg"
              disabled={revoke.busy}
              onClick={() =>
                void revoke.run(async () => {
                  await client.revokeApiKey(revoking);
                  setRevoking(null);
                  keys.reload();
                })
              }
            >
              {revoke.busy ? 'Revoking…' : 'Revoke'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => setRevoking(null)}>
              Cancel
            </button>
          </div>
        </Sheet>
      )}
      {creating && (
        <Sheet
          title={secret ? 'Your new API key' : 'New API key'}
          onClose={close}
          dismissable={!create.busy}
        >
          {secret ? (
            <div className="stack">
              <OnceSecret value={secret} what="key" />
              <button type="button" className="btn btn-primary" onClick={close}>
                I’ve stored it
              </button>
            </div>
          ) : (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) return;
                void create.run(async () => {
                  const k = await client.createApiKey(name.trim(), key);
                  // A replayed request doesn't repeat the secret.
                  setSecret(k.secret ?? null);
                  if (!k.secret) close();
                  keys.reload();
                });
              }}
            >
              <div>
                <label className="field-label" htmlFor="key-name">
                  Name
                </label>
                <input
                  id="key-name"
                  className="input"
                  maxLength={64}
                  placeholder="research-bot server"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
              <ProblemNote problem={create.error} />
              <button
                className="btn btn-primary btn-lg"
                disabled={!name.trim() || create.busy}
                aria-busy={create.busy}
              >
                {create.busy ? 'Creating…' : 'Create key'}
              </button>
            </form>
          )}
        </Sheet>
      )}
    </section>
  );
}

function Webhooks() {
  const client = useClient();
  const hooks = useLoad(() => client.webhooks(), [client]);
  const [creating, setCreating] = useState(false);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>([...WEBHOOK_EVENTS]);
  const [key, setKey] = useState(newIdempotencyKey);
  const [secret, setSecret] = useState<string | null>(null);
  const create = useAction();
  const remove = useAction();
  const urlOk = /^https:\/\/[^\s/$.?#].[^\s]*$/i.test(url.trim());

  const close = () => {
    setCreating(false);
    setSecret(null);
    setUrl('');
    setEvents([...WEBHOOK_EVENTS]);
    setKey(newIdempotencyKey());
    create.setError(null);
  };

  return (
    <section className="section">
      <div className="section-head">
        <h2 className="section-title">Webhooks</h2>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={() => setCreating(true)}
        >
          New webhook
        </button>
      </div>
      <p className="help" style={{ marginTop: -6, marginBottom: 14 }}>
        Signed notifications to your server. They carry ids, signatures and ciphertexts, never
        amounts.
      </p>
      {hooks.loading && !hooks.data && <Loading />}
      <ProblemNote problem={hooks.error ?? remove.error} onRetry={hooks.reload} />
      {hooks.data && hooks.data.length === 0 && <Empty>No webhooks.</Empty>}
      {hooks.data && hooks.data.length > 0 && (
        <div className="list">
          {hooks.data.map((h) => (
            <div
              key={h.id}
              className="item"
              style={{ gridTemplateColumns: 'minmax(0,1fr) auto', cursor: 'default' }}
            >
              <span className="min0">
                <span className="item-title mono" style={{ display: 'block', fontSize: 15 }}>
                  {h.url}
                </span>
                <span className="item-sub" style={{ display: 'block' }}>
                  {h.events.join(', ')}
                </span>
              </span>
              <button
                type="button"
                className="max-btn"
                disabled={remove.busy}
                onClick={() =>
                  void remove.run(async () => {
                    await client.removeWebhook(h.id);
                    hooks.reload();
                  })
                }
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
      {creating && (
        <Sheet
          title={secret ? 'Signing secret' : 'New webhook'}
          onClose={close}
          dismissable={!create.busy}
        >
          {secret ? (
            <div className="stack">
              <OnceSecret value={secret} what="signing secret" />
              <p className="help">Verify deliveries with verifyWebhookSignature from @vexa/sdk.</p>
              <button type="button" className="btn btn-primary" onClick={close}>
                I’ve stored it
              </button>
            </div>
          ) : (
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault();
                if (!urlOk || events.length === 0) return;
                void create.run(async () => {
                  const h = await client.createWebhook(url.trim(), events, key);
                  setSecret(h.secret ?? null);
                  if (!h.secret) close();
                  hooks.reload();
                });
              }}
            >
              <div>
                <label className="field-label" htmlFor="hook-url">
                  Endpoint URL
                </label>
                <input
                  id="hook-url"
                  className="input"
                  type="url"
                  placeholder="https://example.com/vexa/webhook"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                />
                {url && !urlOk && <p className="field-error">Use an https:// URL.</p>}
              </div>
              <fieldset className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
                <legend className="field-label">Events</legend>
                {WEBHOOK_EVENTS.map((ev) => (
                  <label key={ev} className="checkbox">
                    <input
                      type="checkbox"
                      checked={events.includes(ev)}
                      onChange={(e) =>
                        setEvents(
                          e.target.checked ? [...events, ev] : events.filter((x) => x !== ev),
                        )
                      }
                    />
                    <span className="mono small">{ev}</span>
                  </label>
                ))}
              </fieldset>
              <ProblemNote problem={create.error} />
              <button
                className="btn btn-primary btn-lg"
                disabled={!urlOk || events.length === 0 || create.busy}
                aria-busy={create.busy}
              >
                {create.busy ? 'Creating…' : 'Create webhook'}
              </button>
            </form>
          )}
        </Sheet>
      )}
    </section>
  );
}
