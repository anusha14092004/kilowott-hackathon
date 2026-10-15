import { createServer } from 'node:http';
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 4173);
const scrypt = promisify(scryptCallback);
const sessions = new Map();
const usersPath = path.join(root, 'auth-users.json');
// Accept both current and earlier setup-guide names so a correctly filled .env keeps working.
let storeUrlRaw = (process.env.WC_STORE_URL || process.env.WOOCOMMERCE_URL || '').trim();
let consumerKey = (process.env.WC_CONSUMER_KEY || process.env.WOOCOMMERCE_CONSUMER_KEY || '').trim();
let consumerSecret = (process.env.WC_CONSUMER_SECRET || process.env.WOOCOMMERCE_CONSUMER_SECRET || '').trim();
const maxCustomerPages = Math.min(20, Math.max(1, Number(process.env.WC_MAX_CUSTOMER_PAGES || 5)));
let currency = (process.env.WC_CURRENCY || 'INR').toUpperCase();
if (!/^[A-Z]{3}$/.test(currency)) throw new Error('WC_CURRENCY must be a three-letter currency code such as INR or USD.');

function getStoreUrl() {
  if (!storeUrlRaw) return null;
  let url;
  try {
    url = new URL(storeUrlRaw);
  } catch {
    throw new Error('WC_STORE_URL must be a valid store URL such as https://example.com or http://beatz.local.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || /\.(local|test|localhost)$/i.test(host);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localHost)) throw new Error('Use HTTPS for a public store. HTTP is supported only for local development hosts such as beatz.local.');
  if (url.username || url.password || url.search || url.hash) throw new Error('WC_STORE_URL must not include credentials, query parameters, or a fragment.');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function configured() {
  return Boolean(storeUrlRaw && consumerKey && consumerSecret);
}

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req, maxBytes = 8192) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Configuration request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function envValue(value) {
  if (/[\r\n]/.test(value)) throw new Error('Configuration values cannot contain line breaks.');
  return value;
}

function isLocalSameOrigin(req) {
  try {
    const origin = new URL(req.headers.origin || '');
    return origin.host === req.headers.host && ['127.0.0.1', 'localhost'].includes(origin.hostname);
  } catch { return false; }
}

function sessionCookie(token, maxAge = 60 * 60 * 24 * 7) {
  return `orbit_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
function getSession(req) {
  const token = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('orbit_session='))?.slice('orbit_session='.length);
  const session = token && sessions.get(token);
  if (!session || session.expires < Date.now()) { if (token) sessions.delete(token); return null; }
  return session;
}
async function readUsers() {
  try { return JSON.parse(await readFile(usersPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
async function writeUsers(users) {
  await writeFile(usersPath, JSON.stringify(users, null, 2), { mode: 0o600 });
}
async function authenticate(req, res) {
  const user = getSession(req);
  if (!user) { json(res, 401, { error: 'Please sign in to continue.' }); return null; }
  return user;
}
async function authRoute(req, res, pathname) {
  if (!isLocalSameOrigin(req)) return json(res, 403, { error: 'Open Orbit on this computer to manage your account.' });
  if (pathname === '/api/auth/session' && req.method === 'GET') {
    const session = getSession(req);
    return json(res, 200, { authenticated: Boolean(session), name: session?.name || null });
  }
  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('orbit_session='))?.slice('orbit_session='.length);
    if (token) sessions.delete(token);
    return json(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (!['/api/auth/signup', '/api/auth/signin'].includes(pathname) || req.method !== 'POST') return false;
  try {
    const body = await readJsonBody(req, 4096);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const name = String(body.name || '').trim().slice(0, 80);
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address.');
    if (password.length < 8 || password.length > 200) throw new Error('Use a password between 8 and 200 characters.');
    const users = await readUsers();
    let account = users.find(item => item.email === email);
    if (pathname.endsWith('/signup')) {
      if (account) throw new Error('An account with this email already exists. Sign in instead.');
      if (!name) throw new Error('Enter your name.');
      const salt = randomBytes(16).toString('hex');
      const hash = (await scrypt(password, salt, 64)).toString('hex');
      account = { email, name, salt, hash };
      users.push(account);
      await writeUsers(users);
    } else {
      const submitted = (await scrypt(password, account?.salt || 'orbit-invalid-user-salt', 64)).toString('hex');
      const valid = account && timingSafeEqual(Buffer.from(submitted, 'hex'), Buffer.from(account.hash, 'hex'));
      if (!valid) throw new Error('Email or password is incorrect.');
    }
    const token = randomBytes(32).toString('hex');
    sessions.set(token, { name: account.name, email, expires: Date.now() + 7 * 86400000 });
    return json(res, 200, { authenticated: true, name: account.name }, { 'Set-Cookie': sessionCookie(token) });
  } catch (error) {
    return json(res, 400, { error: error.message || 'Could not complete account request.' });
  }
}

function redactUpstreamMessage(body, status) {
  const safeMessage = typeof body?.message === 'string' ? body.message.slice(0, 240) : `WooCommerce returned HTTP ${status}.`;
  return safeMessage.replace(/https?:\/\/\S+/gi, '[store URL]');
}

async function fetchWooPage(resource, page, perPage) {
  const base = getStoreUrl();
  const url = new URL(`${base}/wp-json/wc/v3/${resource}`);
  // WooCommerce accepts `orderby=date` for orders, but not for customers.
  // Keep customer requests to universally supported pagination parameters.
  const params = { page: String(page), per_page: String(perPage) };
  if (resource === 'orders') {
    params.orderby = 'date';
    params.order = 'desc';
  }
  let headers = { Accept: 'application/json' };
  if (url.protocol === 'https:') {
    headers.Authorization = `Basic ${Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64')}`;
  } else {
    // WooCommerce requires signed OAuth 1.0a for HTTP; Basic Auth is only for HTTPS.
    const oauth = {
      oauth_consumer_key: consumerKey,
      oauth_nonce: randomBytes(16).toString('hex'),
      oauth_signature_method: 'HMAC-SHA256',
      oauth_timestamp: String(Math.floor(Date.now() / 1000))
    };
    const signingParams = { ...params, ...oauth };
    const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const normalized = Object.keys(signingParams).sort().map(key => `${encode(key)}=${encode(signingParams[key])}`).join('&');
    const baseString = `GET&${encode(url.origin + url.pathname)}&${encode(normalized)}`;
    oauth.oauth_signature = createHmac('sha256', `${encode(consumerSecret)}&`).update(baseString).digest('base64');
    Object.assign(params, oauth);
  }
  url.search = new URLSearchParams(params);
  let response;
  try {
    response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(20000) });
  } catch (error) {
    const message = error.name === 'TimeoutError'
      ? 'WooCommerce did not respond within 20 seconds. Check that the store is online and reachable.'
      : `Could not reach ${new URL(base).hostname}. Check the store URL and confirm the store opens on this computer.`;
    throw new Error(message);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? 'WooCommerce rejected the API key. Check that the key is new, Read-only, and belongs to a user allowed to view customers and orders.'
      : response.status === 404
        ? 'WooCommerce API endpoint was not found. Check the store URL and confirm the REST API is enabled.'
        : redactUpstreamMessage(body, response.status);
    const error = new Error(message);
    error.status = 502;
    throw error;
  }
  if (!Array.isArray(body)) throw new Error(`WooCommerce returned an unexpected response for ${resource}.`);
  return {
    data: body,
    total: Number(response.headers.get('x-wp-total') || body.length),
    pages: Number(response.headers.get('x-wp-totalpages') || 1)
  };
}

async function fetchOverview() {
  if (!configured()) {
    const error = new Error('WooCommerce is not configured yet. Copy .env.example to .env and add a read-only REST API key.');
    error.status = 503;
    throw error;
  }
  const firstCustomers = await fetchWooPage('customers', 1, 100);
  const customerPageCount = Math.min(firstCustomers.pages, maxCustomerPages);
  const customerPages = await Promise.all(Array.from({ length: customerPageCount - 1 }, (_, index) => fetchWooPage('customers', index + 2, 100)));
  const orderPage = await fetchWooPage('orders', 1, 100);
  const customers = [...firstCustomers.data, ...customerPages.flatMap(page => page.data)];
  const orders = orderPage.data;
  const orderGroups = new Map();
  for (const order of orders) {
    const key = String(order.customer_id || order.billing?.email || '').toLowerCase();
    if (!key) continue;
    if (!orderGroups.has(key)) orderGroups.set(key, []);
    orderGroups.get(key).push(order);
  }

  const now = Date.now();
  const mappedCustomers = customers.map(customer => {
    const id = String(customer.id);
    const emailKey = String(customer.email || '').toLowerCase();
    // Match both registered-customer orders and guest orders that share the
    // customer's billing email. Deduplicate orders that match on both fields.
    const customerOrders = [...new Map([
      ...(orderGroups.get(id) || []),
      ...(orderGroups.get(emailKey) || [])
    ].map(order => [String(order.id), order])).values()];
    const fullName = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || customer.username || customer.email || `Customer ${id}`;
    const countedOrders = customerOrders.filter(order => !['cancelled', 'refunded', 'failed', 'trash'].includes(String(order.status || '').toLowerCase()));
    const paidOrders = customerOrders.filter(order => ['processing', 'completed', 'on-hold'].includes(String(order.status || '').toLowerCase()));
    const spend = Math.max(Number(customer.total_spent || 0), paidOrders.reduce((total, order) => total + Number(order.total || 0), 0));
    const orderCount = Math.max(Number(customer.orders_count || 0), countedOrders.length);
    const latest = customerOrders[0];
    const lastDate = latest?.date_created || null;
    const daysSinceOrder = lastDate ? (now - new Date(lastDate).getTime()) / 86400000 : null;
    const segment = orderCount >= 10 || spend >= 30000 ? 'VIP' : daysSinceOrder !== null && daysSinceOrder > 90 && orderCount > 0 ? 'At risk' : orderCount > 1 ? 'Returning' : 'New';
    const billing = customer.billing || {};
    const city = [billing.city, billing.state].filter(Boolean).join(', ');
    const location = [city, billing.country].filter(Boolean).join(', ') || 'Location not provided';
    const initials = fullName.split(/\s+/).slice(0, 2).map(part => part[0]).join('').toUpperCase();
    const recentOrders = customerOrders.slice(0, 5).map(order => ({
      id: order.id,
      date: order.date_created,
      status: order.status,
      total: Number(order.total || 0),
      items: (order.line_items || []).map(item => item.name).filter(Boolean)
    }));
    return {
      id,
      name: fullName,
      email: customer.email || '',
      phone: billing.phone || 'Phone not provided',
      segment,
      orders: orderCount,
      spend,
      date: lastDate ? new Date(lastDate).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' }) : 'No orders yet',
      lastOrderAt: lastDate || null,
      location,
      initials: initials || 'CU',
      color: '#123b58',
      items: recentOrders.flatMap(order => order.items).slice(0, 5),
      recentOrders
    };
  });

  const mappedOrders = orders.map(order => ({
    id: order.id,
    customerId: String(order.customer_id || ''),
    customerEmail: String(order.billing?.email || '').toLowerCase(),
    customerName: [order.billing?.first_name, order.billing?.last_name].filter(Boolean).join(' ').trim() || 'Guest customer',
    total: Number(order.total || 0),
    status: order.status || 'pending',
    date: order.date_created,
    items: (order.line_items || []).map(item => item.name).filter(Boolean)
  }));

  return {
    store: new URL(getStoreUrl()).hostname,
    currency,
    customers: mappedCustomers,
    orders: mappedOrders,
    totals: {
      customers: firstCustomers.total,
      loadedCustomers: mappedCustomers.length,
      orders: orderPage.total,
      loadedOrders: mappedOrders.length,
      customersTruncated: firstCustomers.pages > maxCustomerPages
    }
  };
}

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']]
]);

const server = createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (requestUrl.pathname.startsWith('/api/auth/')) {
    const handled = await authRoute(req, res, requestUrl.pathname);
    if (handled !== false) return;
  }
  if (requestUrl.pathname === '/api/config' && req.method === 'POST') {
    if (!isLocalSameOrigin(req)) return json(res, 403, { error: 'Open Orbit on this computer before saving local store settings.' });
    if (!await authenticate(req, res)) return;
    try {
      const body = await readJsonBody(req);
      const nextUrl = String(body.storeUrl || '').trim();
      const nextKey = String(body.consumerKey || '').trim();
      const nextSecret = String(body.consumerSecret || '').trim();
      const nextCurrency = String(body.currency || currency).trim().toUpperCase();
      if (!nextKey.startsWith('ck_') || !nextSecret.startsWith('cs_')) throw new Error('Check the Consumer key and Consumer secret. WooCommerce keys begin with ck_ and cs_.');
      if (!/^[A-Z]{3}$/.test(nextCurrency)) throw new Error('Currency must be a three-letter code such as INR or USD.');
      const old = { storeUrlRaw, consumerKey, consumerSecret, currency };
      storeUrlRaw = envValue(nextUrl); consumerKey = envValue(nextKey); consumerSecret = envValue(nextSecret); currency = nextCurrency;
      try { getStoreUrl(); }
      catch (error) { ({ storeUrlRaw, consumerKey, consumerSecret, currency } = old); throw error; }
      const envFile = [
        '# Local WooCommerce configuration. Do not upload this file to GitHub.',
        `WC_STORE_URL=${storeUrlRaw}`,
        `WC_CONSUMER_KEY=${consumerKey}`,
        `WC_CONSUMER_SECRET=${consumerSecret}`,
        `PORT=${port}`,
        `WC_MAX_CUSTOMER_PAGES=${maxCustomerPages}`,
        `WC_CURRENCY=${currency}`,
        ''
      ].join('\n');
      let saved = true;
      try {
        await writeFile(path.join(root, '.env'), envFile, { mode: 0o600 });
      } catch {
        // Keep the validated credentials in memory so directory permission
        // restrictions do not prevent syncing during this server session.
        saved = false;
      }
      return json(res, 200, {
        saved,
        sessionOnly: !saved,
        configured: true,
        store: new URL(getStoreUrl()).hostname
      });
    } catch (error) {
      return json(res, 400, { error: error.message || 'Could not save the WooCommerce connection.' });
    }
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'Only GET requests are supported.' });
  if (requestUrl.pathname === '/api/health') {
    let store = null;
    let configError = null;
    try { store = configured() ? new URL(getStoreUrl()).hostname : null; } catch (error) { configError = error.message; }
      return json(res, 200, { configured: configured() && !configError, store, configError, hasKey: Boolean(consumerKey), hasSecret: Boolean(consumerSecret) });
  }
  if (requestUrl.pathname === '/api/overview') {
    if (!await authenticate(req, res)) return;
    try {
      return json(res, 200, await fetchOverview());
    } catch (error) {
      console.error(`[woo] ${error.message}`);
      return json(res, error.status || 502, { error: error.message || 'Could not reach WooCommerce. Check the server configuration.' });
    }
  }
  const file = staticFiles.get(requestUrl.pathname);
  if (!file) return json(res, 404, { error: 'Not found.' });
  try {
    const contents = await readFile(path.join(root, file[0]));
    res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(contents);
  } catch {
    json(res, 500, { error: 'Could not load the app.' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Orbit CRM running at http://127.0.0.1:${port}`);
  if (!configured()) console.log('Demo mode: copy .env.example to .env to configure a WooCommerce store.');
});
