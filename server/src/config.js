import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const env = (key, fallback) => process.env[key] || fallback;

export const config = {
  ingestPort: Number(env('INGEST_PORT', 4000)),
  apiPort: Number(env('API_PORT', 4001)),
  pgUrl: env('DATABASE_URL', 'postgres://graphpulse:graphpulse@localhost:5433/graphpulse'),
  neo4j: {
    url: env('NEO4J_URL', 'bolt://localhost:7687'),
    user: env('NEO4J_USER', 'neo4j'),
    password: env('NEO4J_PASSWORD', 'graphpulse123'),
  },
  redisUrl: env('REDIS_URL', 'redis://localhost:6379'),
  kafkaBrokers: env('KAFKA_BROKERS', 'localhost:29092').split(','),
  eventsTopic: env('EVENTS_TOPIC', 'gp.events'),
  jwtSecret: env('JWT_SECRET', 'dev-only-change-me'),
  jwtTtl: env('JWT_TTL', '12h'),
  // Public key that the tracking snippet sends; SITE_API_KEY is the name used for real deployments.
  demoApiKey: env('SITE_API_KEY', env('DEMO_API_KEY', 'gp_demo_public_key')),
  smtp: {
    host: env('SMTP_HOST', ''),
    port: Number(env('SMTP_PORT', 587)),
    user: env('SMTP_USER', ''),
    pass: env('SMTP_PASS', ''),
    from: env('ALERT_EMAIL_FROM', 'alerts@graphpulse.local'),
  },
};
