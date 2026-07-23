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
    `<h1>Account</h1><p class="welcome-message">Welcome, ${email}!</p><a href="/">Home</a>`,
  );

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  };

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
