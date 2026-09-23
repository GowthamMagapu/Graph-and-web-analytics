// Dashboard API: JWT login + GraphQL, scoped per tenant.
import express from 'express';
import cors from 'cors';
import { createSchema, createYoga } from 'graphql-yoga';
import { config } from './config.js';
import { query } from './db/postgres.js';
import { userFromAuthHeader } from './lib/auth.js';
import { loginHandler } from './lib/login.js';
import { resolvers, typeDefs } from './schema.js';

const yoga = createYoga({
  schema: createSchema({ typeDefs, resolvers }),
  context: ({ request }) => ({ user: userFromAuthHeader(request.headers.get('authorization')) }),
  graphiql: process.env.NODE_ENV !== 'production',
  maskedErrors: process.env.NODE_ENV === 'production',
});

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: [/^http:\/\/localhost:\d+$/] }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'api' }));

app.post('/auth/login', express.json(), loginHandler({
  findUserByEmail: async (email) => (await query('SELECT * FROM users WHERE email = $1', [email])).rows[0],
  findTenant: async (id) => (await query('SELECT name, api_key FROM tenants WHERE id = $1', [id])).rows[0],
}));

app.use(yoga.graphqlEndpoint, yoga);

app.use((err, _req, res, _next) => {
  console.error('[api]', err);
  res.status(500).json({ error: 'internal error' });
});

app.listen(config.apiPort, () => {
  console.log(`[api] listening on http://localhost:${config.apiPort}${yoga.graphqlEndpoint}`);
});
