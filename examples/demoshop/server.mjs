// A tiny two-page app to try the orchestrator against: a home page and a login
// form that really does reject bad credentials. Enough surface for the LLM
// author to write both a happy path and a negative case.
//
//   node examples/demoshop/server.mjs           # http://localhost:4700
//   PORT=5000 node examples/demoshop/server.mjs
import { createServer } from 'node:http';

const USER = { email: 'ada@example.com', password: 'Test1234!' };

const page = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<meta name="description" content="DemoShop — a sample app for test-orchestrator">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui;max-width:32rem;margin:3rem auto">${body}</body></html>`;

const home = page(
  'DemoShop',
  `<h1>DemoShop</h1><p>A sample shop.</p>
   <a href="/login">Sign in</a> · <a href="/about">About</a>`,
);

// A page that fetches its data, so the network is worth watching. One of the
// three calls is deliberately broken: a UI that renders anyway is exactly the
// case a screen-only assertion misses.
const catalogue = page(
  'Catalogue - DemoShop',
  `<h1>Catalogue</h1><ul id="items"><li>loading…</li></ul>
   <script>
     (async () => {
       const list = document.getElementById('items');
       const office = await fetch('/api/products?category=office').then((r) => r.json());
       await fetch('/api/products?category=kitchen');
       await fetch('/api/reviews').catch(() => {});
       list.innerHTML = office.map((p) => '<li class="item">' + p.name + '</li>').join('');
     })();
   </script>`,
);

const about = page('About - DemoShop', '<h1>About</h1><p>We sell samples.</p><a href="/">Home</a>');

const login = (error) =>
  page(
    'Sign in - DemoShop',
    `<h1>Sign in</h1>
     ${error === undefined ? '' : `<p class="error-message" role="alert">${error}</p>`}
     <form action="/login" method="post">
       <label>E-mail <input name="email" type="email" required></label><br>
       <label>Password <input name="password" type="password" required></label><br>
       <label><input name="remember" type="checkbox"> Remember me</label><br>
       <button type="submit">Sign in</button>
     </form>
     <a href="/">Back home</a>`,
  );

const welcome = (email) =>
  page(
    'Account - DemoShop',
    `<h1>Account</h1><p class="welcome-banner">Welcome, ${email}!</p><a href="/">Home</a>`,
  );

// ---- a small JSON API, described by openapi.json next to this file ----
const PRODUCTS = [
  { id: '1', name: 'Blue mug', price: 12.5, category: 'kitchen' },
  { id: '2', name: 'Notebook', price: 4, category: 'office' },
  { id: '3', name: 'Desk lamp', price: 39.9, category: 'office' },
];

// An in-memory collection with a real lifecycle, so a stateful chain
// (POST → GET → DELETE, carrying the created id) has something to run against.
const CARTS = new Map();
let cartSeq = 0;

/** Returns true when it handled the request. `method` and `body` drive writes. */
function api(url, send, method = 'GET', body = undefined) {
  const json = (status, payload) => {
    send(status, JSON.stringify(payload), 'application/json');
    return true;
  };

  if (method === 'POST' && url.pathname === '/api/carts') {
    cartSeq += 1;
    const id = `cart-${cartSeq}`;
    const cart = { id, items: body?.items ?? [] };
    CARTS.set(id, cart);
    return json(201, cart);
  }
  const cartMatch = /^\/api\/carts\/([^/]+)$/.exec(url.pathname);
  if (cartMatch) {
    const id = cartMatch[1];
    if (method === 'GET') {
      return CARTS.has(id) ? json(200, CARTS.get(id)) : json(404, { error: 'no such cart' });
    }
    if (method === 'DELETE') {
      return CARTS.delete(id) ? send(204, '', 'application/json') || true : json(404, { error: 'no such cart' });
    }
  }

  if (url.pathname === '/api/health') {
    return json(200, { status: 'up' });
  }
  if (url.pathname === '/api/products') {
    const category = url.searchParams.get('category');
    // The spec says category is required, and this endpoint enforces it.
    if (category === null) {
      return json(400, { error: 'category is required' });
    }
    return json(200, PRODUCTS.filter((p) => p.category === category));
  }
  if (url.pathname === '/api/reviews') {
    // Stands in for the endpoint that is quietly broken in production.
    return json(500, { error: 'reviews service unavailable' });
  }
  const match = /^\/api\/products\/([^/]+)$/.exec(url.pathname);
  if (match) {
    const found = PRODUCTS.find((p) => p.id === match[1]);
    return found ? json(200, found) : json(404, { error: 'no such product' });
  }
  return false;
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (status, body, type = 'text/html; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };

  if (url.pathname.startsWith('/api/')) {
    // A real server does not die on a bad request; it returns 500. Without this
    // an unhandled throw would take the whole process down.
    if (req.method === 'GET' || req.method === 'DELETE') {
      try {
        if (api(url, send, req.method)) {
          return;
        }
      } catch (err) {
        return send(500, JSON.stringify({ error: String(err) }), 'application/json');
      }
      return send(404, JSON.stringify({ error: 'not found' }), 'application/json');
    }
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        let parsed;
        try {
          parsed = raw === '' ? {} : JSON.parse(raw);
        } catch {
          return send(400, JSON.stringify({ error: 'invalid JSON' }), 'application/json');
        }
        if (!api(url, send, 'POST', parsed)) {
          send(404, JSON.stringify({ error: 'not found' }), 'application/json');
        }
      });
      return;
    }
  }

  if (req.method === 'POST' && url.pathname === '/login') {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const form = new URLSearchParams(raw);
      const ok =
        form.get('email') === USER.email && form.get('password') === USER.password;
      send(ok ? 200 : 401, ok ? welcome(USER.email) : login('Invalid email or password.'));
    });
    return;
  }

  switch (url.pathname) {
    case '/':
      return send(200, home);
    case '/about':
      return send(200, about);
    case '/catalogue':
      return send(200, catalogue);
    case '/login':
      return send(200, login(undefined));
    default:
      return send(404, page('Not found', '<h1>404</h1>'));
  }
});

const port = Number(process.env.PORT ?? 4700);
server.listen(port, () => {
  console.log(`DemoShop on http://localhost:${port}  (${USER.email} / ${USER.password})`);
});
