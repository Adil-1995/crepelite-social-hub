import { onRequest } from 'firebase-functions/v2/https';
import { statusCheckTaskId, type Delivery } from '@shared/index';
import { ALL_SECRETS, REGION } from '../config/env';
import { getRegistry } from '../providers';
import { getDispatcher } from '../tasks/dispatcher';
import { FieldValue, db, paths } from '../utils/firestore';
import { log } from '../utils/logger';

/**
 * POST /webhooks/{provider}
 * - Signature verification is delegated to the provider's WebhookHandler and
 *   is mandatory: unverifiable events are rejected with 401.
 * - Each event id is stored in `webhookEvents` (create = atomic dedupe).
 * - Events never change state directly: they trigger an immediate status
 *   check, which re-reads the truth from the provider API.
 */
export const webhooks = onRequest({ region: REGION, secrets: ALL_SECRETS }, async (req, res) => {
  const m = /\/([a-z0-9_-]+)\/?$/.exec(req.path);
  const providerId = m?.[1] ?? '';
  const registry = getRegistry();
  if (!registry.has(providerId) || !registry.get(providerId).webhook) {
    res.status(404).send('Unknown webhook');
    return;
  }
  const handler = registry.get(providerId).webhook!;

  if (req.method === 'GET') {
    const challenge = handler.verifyHandshake?.(Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)])));
    if (challenge == null) res.status(403).send('Forbidden');
    else res.status(200).send(challenge);
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  let events;
  try {
    events = handler.verifyAndParse({ rawBody: req.rawBody, headers: req.headers });
  } catch (e) {
    log.warn('Rejected webhook', { provider: providerId, reason: (e as Error).message });
    res.status(401).send('Invalid signature');
    return;
  }

  for (const ev of events) {
    const id = `${providerId}_${ev.eventId}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 400);
    try {
      await db().doc(paths.webhookEvent(id)).create({ provider: providerId, type: ev.type, receivedAt: FieldValue.serverTimestamp() });
    } catch {
      continue; // already processed
    }
    const matches = await db().collectionGroup('deliveries').where(ev.lookup.field, '==', ev.lookup.value).where('status', '==', 'processing').limit(5).get();
    for (const doc of matches.docs) {
      const d = { id: doc.id, ...doc.data() } as Delivery;
      const seq = 2_000_000 + ((d.statusCheckCount ?? 0) + 1);
      await getDispatcher().enqueue(
        'functions',
        { kind: 'status_check', workspaceId: d.workspaceId, deliveryId: d.id, scheduleVersion: d.scheduleVersion, seq },
        { id: statusCheckTaskId(d.id, d.scheduleVersion, seq), scheduleAt: new Date() },
      );
    }
  }
  res.status(200).send('ok');
});
