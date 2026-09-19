import express, { type Request, type Response, type NextFunction } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { executeDelivery, checkDeliveryStatus } from '../../functions/src/publishing/engine';
import { getRegistry } from '../../functions/src/providers';
import { getDispatcher } from '../../functions/src/tasks/dispatcher';
import { log } from '../../functions/src/utils/logger';

/**
 * publisher-worker (Cloud Run)
 *
 * Receives Cloud Tasks HTTP requests with an OIDC token minted for
 * WORKER_INVOKER_SERVICE_ACCOUNT (audience = WORKER_URL). Runs the exact same
 * idempotent engine as the Cloud Functions task handlers, but with Cloud Run's
 * longer timeouts, for streaming large videos (never loaded fully in memory).
 * Deploy with --no-allow-unauthenticated; the OIDC check below is defence in depth.
 */
const app = express();
app.use(express.json({ limit: '64kb' }));

const audience = process.env.WORKER_URL ?? '';
const invoker = process.env.WORKER_INVOKER_SERVICE_ACCOUNT ?? '';
const oauth = new OAuth2Client();

async function verifyOidc(req: Request, res: Response, next: NextFunction) {
  if (process.env.WORKER_SKIP_AUTH === 'true' && process.env.APP_ENV !== 'production') return next(); // local testing only
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try {
    const ticket = await oauth.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    if (!payload?.email_verified || payload.email !== invoker) throw new Error('unexpected invoker');
    next();
  } catch {
    res.status(401).send('Unauthorized');
  }
}

const payloadSchema = z.object({
  kind: z.enum(['execute', 'status_check']),
  workspaceId: z.string().min(1),
  deliveryId: z.string().min(1),
  scheduleVersion: z.number().int().min(1),
  seq: z.number().int().min(0),
});

const deps = () => ({ registry: getRegistry(), dispatcher: getDispatcher(), leaseMs: 65 * 60 * 1000 });

app.post('/tasks/execute', verifyOidc, async (req, res) => {
  const p = payloadSchema.safeParse(req.body);
  if (!p.success) return void res.status(200).send('ignored'); // never retry malformed payloads
  try {
    const outcome = await executeDelivery(p.data, deps());
    res.status(200).json(outcome);
  } catch (e) {
    log.error('Worker execute failed', { deliveryId: p.data.deliveryId, error: (e as Error).message });
    res.status(500).send('retry'); // infrastructure error → Cloud Tasks retries; the claim prevents duplicates
  }
});

app.post('/tasks/status', verifyOidc, async (req, res) => {
  const p = payloadSchema.safeParse(req.body);
  if (!p.success) return void res.status(200).send('ignored');
  try {
    res.status(200).json(await checkDeliveryStatus(p.data, deps()));
  } catch (e) {
    log.error('Worker status failed', { deliveryId: p.data.deliveryId, error: (e as Error).message });
    res.status(500).send('retry');
  }
});

app.get('/healthz', (_req, res) => void res.status(200).send('ok'));

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => log.info('publisher-worker listening', { port }));
