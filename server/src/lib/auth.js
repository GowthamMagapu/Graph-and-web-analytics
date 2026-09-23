import jwt from 'jsonwebtoken';
import { GraphQLError } from 'graphql';
import { config } from '../config.js';

export const ROLES = ['viewer', 'analyst', 'admin'];
const rank = (role) => ROLES.indexOf(role);

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, tid: user.tenant_id, role: user.role, email: user.email },
    config.jwtSecret,
    { expiresIn: config.jwtTtl },
  );
}

/** Decode "Bearer <jwt>" into the request's user, or null. */
export function userFromAuthHeader(header) {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return null;
  try {
    const p = jwt.verify(token, config.jwtSecret);
    return { id: p.sub, tenantId: p.tid, role: p.role, email: p.email };
  } catch {
    return null;
  }
}

/**
 * Every resolver goes through this. The tenant always comes from the signed
 * token - never from query arguments - which is what keeps tenants isolated.
 */
export function requireRole(ctx, minRole = 'viewer') {
  if (!ctx.user) throw new GraphQLError('Not authenticated', { extensions: { code: 'UNAUTHENTICATED' } });
  if (rank(ctx.user.role) < rank(minRole)) {
    throw new GraphQLError(`Requires ${minRole} role`, { extensions: { code: 'FORBIDDEN' } });
  }
  return ctx.user;
}
