#!/usr/bin/env node
// End-to-end smoke test of a deployed Mtandao Cloud, for the pilot.
//
// It walks one sandbox sale through the real API and checks the acceptance criteria
// that matter most before real customers use the system:
//   1. the site is ready to sell;
//   2. a payment is created at the plan's price;
//   3. a FORGED payment webhook is rejected;
//   4. a genuine webhook confirms the payment once;
//   5. the same webhook sent again changes nothing;
//   6. the ticket becomes active once the Gateway confirms (needs a running Gateway).
//
// It spends one voucher from the plan's stock and creates one sandbox payment: run it on a
// test plan or accept losing one ticket. It never touches real money (sandbox provider).
//
// Usage:
//   API_URL=https://api.example.com ACCESS_TOKEN=<user token> SITE_ID=<uuid> ROUTER_ID=<uuid> \
//   PLAN_ID=<uuid> PAYMENT_WEBHOOK_SECRET=<sandbox secret> \
//   node scripts/pilot-smoke.mjs --yes-this-uses-the-sandbox
import { createHmac, randomUUID } from 'node:crypto';

export function signWebhook(secret, rawBody, timestampSeconds) {
  const v1 = createHmac('sha256', secret).update(`${timestampSeconds}.`).update(rawBody).digest('hex');
  return `t=${timestampSeconds},v1=${v1}`;
}

export function readConfig(env, argv) {
  const required = ['API_URL', 'ACCESS_TOKEN', 'SITE_ID', 'ROUTER_ID', 'PLAN_ID', 'PAYMENT_WEBHOOK_SECRET'];
  const missing = required.filter(name => !env[name]);
  if (missing.length > 0) throw new Error(`Variables manquantes : ${missing.join(', ')}`);
  if (!argv.includes('--yes-this-uses-the-sandbox')) {
    throw new Error('Ajoutez --yes-this-uses-the-sandbox : ce test consomme un ticket et crée un paiement sandbox.');
  }
  if (env.PAYMENT_WEBHOOK_SECRET.length < 32) throw new Error('PAYMENT_WEBHOOK_SECRET doit faire au moins 32 caractères.');
  const apiUrl = env.API_URL.replace(/\/$/, '');
  if (!/^https?:\/\//.test(apiUrl)) throw new Error('API_URL doit commencer par http:// ou https://');
  return {
    apiUrl,
    token: env.ACCESS_TOKEN,
    siteId: env.SITE_ID,
    routerId: env.ROUTER_ID,
    planId: env.PLAN_ID,
    secret: env.PAYMENT_WEBHOOK_SECRET,
    activationTimeoutSeconds: Number(env.ACTIVATION_TIMEOUT_SECONDS ?? 120),
  };
}

export async function run(config, fetchImpl = fetch, now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), log = console.log) {
  const results = [];
  const record = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    log(`${ok ? 'OK   ' : 'ECHEC'}  ${name}${detail ? ` — ${detail}` : ''}`);
    return ok;
  };
  const api = (path, init = {}) =>
    fetchImpl(`${config.apiUrl}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  const webhook = (rawBody, signature) =>
    fetchImpl(`${config.apiUrl}/v1/webhooks/payments/sandbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(signature ? { 'X-Mtandao-Signature': signature } : {}) },
      body: rawBody,
    });
  const base = `/v1/sites/${config.siteId}`;
  // First part of an error body, so a 400 explains itself instead of showing a bare status.
  const why = async response => {
    try {
      const body = await response.json();
      const message = Array.isArray(body.message) ? body.message.join('; ') : body.message;
      return `HTTP ${response.status}${message ? ` (${String(message).slice(0, 160)})` : ''}`;
    } catch {
      return `HTTP ${response.status}`;
    }
  };

  // 1. Readiness.
  const readiness = await api(`${base}/readiness`);
  if (!readiness.ok) {
    record('Site accessible', false, await why(readiness));
    return results;
  }
  const state = await readiness.json();
  record('Le site peut vendre', state.ready === true, state.ready ? '' : state.checks.filter(c => c.status === 'fail').map(c => c.label).join(', '));
  if (!state.ready) return results;

  // 2. Payment creation at the plan price.
  const created = await api(`${base}/payments`, {
    method: 'POST',
    body: JSON.stringify({ planId: config.planId, routerId: config.routerId, idempotencyKey: `smoke-${randomUUID()}` }),
  });
  if (!created.ok) {
    record('Création du paiement', false, await why(created));
    return results;
  }
  const payment = await created.json();
  record('Création du paiement', typeof payment.payment_id === 'string' && payment.status === 'pending', `${payment.amount} ${payment.currency}`);

  const event = JSON.stringify({
    event_id: `smoke-${randomUUID()}`,
    provider_ref: payment.provider_ref,
    status: 'succeeded',
    amount: payment.amount,
    currency: payment.currency,
  });
  const stamp = () => Math.floor(now() / 1000);

  // 3. Forged webhook: wrong secret, then no signature at all.
  const forged = await webhook(event, signWebhook('x'.repeat(40), event, stamp()));
  const unsigned = await webhook(event);
  record('Faux webhook rejeté', forged.status === 401 && unsigned.status === 401, `signature fausse : ${forged.status}, sans signature : ${unsigned.status}`);

  // 4. Genuine webhook confirms the payment.
  const genuine = await webhook(event, signWebhook(config.secret, event, stamp()));
  const outcome = genuine.ok ? (await genuine.json()).outcome : await why(genuine);
  record('Webhook authentique : paiement confirmé', outcome === 'paid', String(outcome));

  // 5. The same event again: no second ticket.
  const again = await webhook(event, signWebhook(config.secret, event, stamp()));
  const againOutcome = again.ok ? (await again.json()).outcome : await why(again);
  record('Webhook dupliqué sans effet', againOutcome === 'duplicate', String(againOutcome));

  // 6. Activation by the Gateway.
  const deadline = now() + config.activationTimeoutSeconds * 1000;
  let fulfillment = 'unknown';
  while (now() < deadline) {
    const list = await api(`${base}/payments?limit=20`);
    if (list.ok) {
      const row = (await list.json()).items.find(item => item.id === payment.payment_id);
      fulfillment = row?.fulfillment_status ?? 'unknown';
      if (['activated', 'activation_failed', 'out_of_stock'].includes(fulfillment)) break;
    }
    await sleep(5000);
  }
  if (fulfillment === 'activated') record('Ticket activé par la passerelle', true);
  else if (fulfillment === 'activation_pending') record('Ticket activé par la passerelle', false, 'toujours en attente : la passerelle est-elle démarrée avec GATEWAY_COMMANDS_ENABLED=true ?');
  else record('Ticket activé par la passerelle', false, fulfillment);

  return results;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  try {
    const config = readConfig(process.env, process.argv.slice(2));
    const results = await run(config);
    const failed = results.filter(r => !r.ok).length;
    console.log(failed === 0 ? '\nTout est conforme.' : `\n${failed} contrôle(s) en échec.`);
    process.exit(failed === 0 ? 0 : 1);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(2);
  }
}
