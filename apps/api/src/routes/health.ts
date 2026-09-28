import { Hono } from 'hono';
import type { AppBindings } from '../context.js';

/**
 * /health is liveness: the process is up and serving HTTP. Railway's
 * healthcheck hits it on every deploy.
 *
 * /health/ready is readiness: dependencies are reachable too. It returns 503
 * while the database is down, so a load balancer can route around the instance.
 */
export const health = new Hono<AppBindings>()
  .get('/', (c) => {
    const { env, version } = c.get('deps');
    return c.json({
      status: 'ok',
      version,
      cluster: env.SOLANA_CLUSTER,
      environment: env.API_ENVIRONMENT,
    });
  })
  .get('/ready', async (c) => {
    const { store } = c.get('deps');
    try {
      await store.ping();
      return c.json({ status: 'ready', checks: { database: 'ok' } });
    } catch (err) {
      c.get('logger').warn({ err }, 'readiness check failed');
      return c.json({ status: 'unavailable', checks: { database: 'error' } }, 503);
    }
  });
