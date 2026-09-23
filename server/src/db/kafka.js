import { Kafka, logLevel } from 'kafkajs';
import { config } from '../config.js';

export const kafka = new Kafka({
  clientId: 'graphpulse',
  brokers: config.kafkaBrokers,
  logLevel: logLevel.WARN,
});
