import pg from 'pg';
import { config } from '../config.js';

export const pool = new pg.Pool({ connectionString: config.pgUrl, max: 10 });

export const query = (text, params) => pool.query(text, params);
