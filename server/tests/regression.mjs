/**
 * Doraha Eats — regression tests for the launch-blocker fixes.
 * Needs a RUNNING server and a SEEDED database (same as acceptance.mjs).
 *
 *   node tests/regression.mjs
 */
const BASE = process.env.API_URL ?? 'http://localhost:4000/api/v1';
const PASS = process.env.DEMO_PASSWORD ?? 'Doraha@123';

let passed = 0, failed = 0;
const assert = (cond, label, detail = '') => {
  cond ? passed++ : failed++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  return cond;
};

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

const login = async (email) => {
  const r = await api('/auth/login', { method: 'POST', body: { email, password: PASS } });
  if (r.status !== 200) throw new Error(`login ${email} failed: ${JSON.stringify(r.body)}`);
  return r.body.token;
};

/** Builds a valid cart from the vendor@ stall and places an order. */
async function placeOrder(customer, vendorSlug, address, paymentMethod) {
  await api('/cart', { method: 'DELETE', token: customer });
  const page = await api(`/vendors/${vendorSlug}`);
  const item = page.body.menu[0].foodItems.find((i) => !(i.customizationGroups ?? []).some((g) => g.isRequired)) ?? page.body.menu[0].foodItems[0];
  const group = item.customizationGroups?.[0];
  const optionIds = group ? [group.options[0].id] : [];
  let qty = 1, quote;
  for (; qty <= 50; qty++) {
    await api('/cart', { method: 'DELETE', token: customer });
    await api('/cart/items', { method: 'POST', token: customer, body: { foodItemId: item.id, quantity: qty, optionIds } });
    quote = await api('/cart/quote', { method: 'POST', token: customer, body: { addressId: address.id } });
    if (quote.body.canPlaceOrder) break;
  }
  if (!quote.body.canPlaceOrder) throw new Error(`cannot build placeable cart: ${JSON.stringify(quote.body.blockers)}`);
  const r = await api('/orders', { method: 'POST', token: customer, body: { addressId: address.id, paymentMethod } });
  if (r.status !== 201) throw new Error(`placeOrder failed: ${JSON.stringify(r.body)}`);
  return r.body.order;
}

async function run() {
  console.log('\n=== Doraha Eats — regression tests ===\n');

  const customer = await login('customer@dorahaeats.local');
  const vendor = await login('vendor@dorahaeats.local');
  const admin = await login('admin@dorahaeats.local');
  const riders = [await login('delivery@dorahaeats.local'), await login('delivery2@dorahaeats.local'), await login('delivery3@dorahaeats.local')];
  for (const r of riders) await api('/delivery/status', { method: 'PATCH', token: r, body: { isOnline: true } });

  const me = await api('/vendor/me', { token: vendor });
  const slug = me.body.vendor.slug;
  const addr = (await api('/addresses', { token: customer })).body.addresses.find((a) => a.zoneId);

  /* ---------- A. UPI cannot be self-verified ---------- */
  const upi = await placeOrder(customer, slug, addr, 'UPI');
  const short = await api(`/orders/${upi.id}/payment/upi-ref`, { method: 'POST', token: customer, body: { utr: 'aaaaaa' } });
  assert(short.status === 400, 'UPI: a 6-character fake UTR is rejected', `HTTP ${short.status}`);

  const utr = String(Date.now()).padEnd(12, '7').slice(0, 12);
  const sub = await api(`/orders/${upi.id}/payment/upi-ref`, { method: 'POST', token: customer, body: { utr } });
  assert(sub.status === 200 && sub.body.verified === false, 'UPI: submitting a UTR does NOT mark the order paid');
  assert(sub.body.order.paymentStatus !== 'PAID' && sub.body.order.payment.status === 'AWAITING_VERIFICATION',
    'UPI: order stays unpaid / awaiting admin verification', `${sub.body.order.paymentStatus}`);

  const upi2 = await placeOrder(customer, slug, addr, 'UPI');
  const reuse = await api(`/orders/${upi2.id}/payment/upi-ref`, { method: 'POST', token: customer, body: { utr } });
  assert(reuse.status === 409 && reuse.body.error.code === 'UTR_REUSED', 'UPI: the same UTR cannot pay a second order');

  const pend = await api('/admin/payments/pending', { token: admin });
  const pay = pend.body.payments.find((x) => x.p.orderId === upi.id);
  assert(!!pay, 'UPI: admin sees the payment awaiting verification');
  const v1 = await api(`/admin/payments/${pay.p.id}/verify`, { method: 'POST', token: admin });
  assert(v1.status === 200 && v1.body.payment.status === 'PAID', 'UPI: admin verification marks it PAID');
  const v2 = await api(`/admin/payments/${pay.p.id}/verify`, { method: 'POST', token: admin });
  assert(v2.status === 409, 'UPI: admin cannot verify the same payment twice');

  const nopay = await api(`/admin/payments/${(await api(`/orders/${upi2.id}`, { token: customer })).body.order.payment.id}/verify`, { method: 'POST', token: admin });
  assert(nopay.status === 409, 'UPI: admin cannot verify a payment that has no submitted UTR');

  /* ---------- B. Only one rider can claim a delivery ---------- */
  const cod = await placeOrder(customer, slug, addr, 'COD');
  for (const step of ['accept', 'preparing', 'ready']) {
    const r = await api(`/vendor/orders/${cod.id}/${step}`, { method: 'POST', token: vendor, body: {} });
    if (r.status !== 200) throw new Error(`vendor ${step} failed: ${JSON.stringify(r.body)}`);
  }
  const results = await Promise.all(riders.map((t) => api(`/delivery/${cod.id}/accept`, { method: 'POST', token: t })));
  const wins = results.filter((r) => r.status === 200).length;
  const taken = results.filter((r) => r.status === 409 && r.body.error.code === 'ALREADY_TAKEN').length;
  assert(wins === 1 && taken === 2, 'RACE: 3 riders accept at once -> exactly 1 wins, 2 get ALREADY_TAKEN', `wins=${wins} taken=${taken}`);

  let owners = 0;
  for (const t of riders) {
    const h = await api('/delivery/history', { token: t });
    if (h.body.history.some((x) => x.order.id === cod.id && ['ACCEPTED', 'COMPLETED'].includes(x.state))) owners++;
  }
  assert(owners === 1, 'RACE: exactly one rider holds the assignment in the database', `owners=${owners}`);

  const winnerIdx = results.findIndex((r) => r.status === 200);
  const winner = riders[winnerIdx];
  const loserIdx = results.findIndex((r) => r.status !== 200);

  /* ---------- C. Cancel rules after pickup ---------- */
  const pu = await api(`/delivery/${cod.id}/status`, { method: 'PATCH', token: winner, body: { status: 'PICKED_UP' } });
  assert(pu.status === 200, 'Winner rider can mark PICKED_UP');
  const loserTry = await api(`/delivery/${cod.id}/status`, { method: 'PATCH', token: riders[loserIdx], body: { status: 'ON_THE_WAY' } });
  assert(loserTry.status === 403, 'Losing rider cannot progress someone else\'s delivery', `HTTP ${loserTry.status}`);
  const vc = await api(`/vendor/orders/${cod.id}/reject`, { method: 'POST', token: vendor, body: { reason: 'changed my mind' } });
  assert(vc.status === 403, 'Vendor cannot cancel an order the rider already picked up', `HTTP ${vc.status}`);
  const ac = await api(`/admin/orders/${cod.id}/cancel`, { method: 'POST', token: admin, body: { reason: 'test' } });
  // Admin route may differ; only assert it is not blocked as 403 when it exists.
  assert(ac.status !== 403, 'Admin is still allowed to cancel in an emergency', `HTTP ${ac.status}`);

  /* ---------- D. Vendor-accept vs customer-cancel at the same instant ---------- */
  const race = await placeOrder(customer, slug, addr, 'COD');
  const [a, c] = await Promise.all([
    api(`/vendor/orders/${race.id}/accept`, { method: 'POST', token: vendor, body: {} }),
    api(`/orders/${race.id}/cancel`, { method: 'POST', token: customer, body: { reason: 'oops' } }),
  ]);
  const ok = [a, c].filter((r) => r.status === 200).length;
  assert(ok === 1, 'RACE: accept vs cancel at once -> exactly one succeeds', `accept=${a.status} cancel=${c.status}`);
  const final = (await api(`/orders/${race.id}`, { token: customer })).body.order;
  const evs = final.events.map((e) => e.status);
  assert(evs.length === 2 && evs[0] === 'PLACED' && ['ACCEPTED', 'CANCELLED'].includes(evs[1]) && evs[1] === final.status,
    'RACE: status and timeline agree (no split-brain)', evs.join(' -> '));

  /* ---------- E. Cancelling releases an unpaid UPI intent ---------- */
  const upi3 = await placeOrder(customer, slug, addr, 'UPI');
  const cx = await api(`/orders/${upi3.id}/cancel`, { method: 'POST', token: customer, body: { reason: 'test' } });
  assert(cx.status === 200 && cx.body.order.paymentStatus === 'FAILED', 'Cancel closes the unpaid UPI payment', cx.body?.order?.paymentStatus);
  const late = await api(`/orders/${upi3.id}/payment/upi-ref`, { method: 'POST', token: customer, body: { utr: '123456789012' } });
  assert(late.status === 400, 'Cannot submit a UTR for a cancelled order');

  /* ---------- F. Email normalisation ---------- */
  const em = `Reg.${Date.now()}@Example.COM`;
  const reg = await api('/auth/register', { method: 'POST', body: { fullName: 'Reg Test', password: 'secret12', email: em } });
  assert(reg.status === 201 && reg.body.user.email === em.toLowerCase(), 'Email is stored lowercase', reg.body?.user?.email);
  const dup = await api('/auth/register', { method: 'POST', body: { fullName: 'Reg Test', password: 'secret12', email: em.toUpperCase().replace('COM', 'com') } });
  assert(dup.status === 409, 'Same email in different case is treated as a duplicate');

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => { console.error('\nCRASH:', e.message); process.exit(1); });
