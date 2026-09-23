import bcrypt from 'bcryptjs';
import { signToken } from './auth.js';

/** POST /auth/login handler; storage-agnostic so full and lite mode share it. */
export function loginHandler({ findUserByEmail, findTenant }) {
  return async (req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'email and password are required' });
    }
    const user = await findUserByEmail(email.toLowerCase());
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'invalid email or password' });
    }
    const tenant = await findTenant(user.tenant_id);
    res.json({
      token: signToken(user),
      user: { id: user.id, email: user.email, role: user.role, tenantId: user.tenant_id },
      tenant: { name: tenant.name, apiKey: tenant.api_key },
    });
  };
}
