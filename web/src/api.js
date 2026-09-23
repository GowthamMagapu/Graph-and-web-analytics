import { useCallback, useEffect, useRef, useState } from 'react';

const SESSION_KEY = 'graphpulse.session';

export function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

export function saveSession(session) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage unavailable - session lasts for this tab only */
  }
}

export async function login(email, password) {
  const res = await fetch('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Login failed (${res.status})`);
  return body;
}

export class AuthError extends Error {}

export async function gql(query, variables = {}) {
  const token = loadSession()?.token;
  const res = await fetch('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (body.errors?.length) {
    const [err] = body.errors;
    if (err.extensions?.code === 'UNAUTHENTICATED') throw new AuthError(err.message);
    throw new Error(err.message);
  }
  return body.data;
}

/** Fetch a GraphQL query, optionally polling, and refetch when variables change. */
export function useQuery(query, variables = {}, { pollMs, skip = false } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: !skip });
  const varsKey = JSON.stringify(variables);
  const alive = useRef(true);

  const run = useCallback(async () => {
    try {
      const data = await gql(query, JSON.parse(varsKey));
      if (alive.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (error instanceof AuthError) window.dispatchEvent(new Event('graphpulse:logout'));
      if (alive.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, [query, varsKey]);

  useEffect(() => {
    alive.current = true;
    if (skip) return undefined;
    setState((s) => ({ ...s, loading: true }));
    run();
    const id = pollMs ? setInterval(run, pollMs) : null;
    return () => {
      alive.current = false;
      if (id) clearInterval(id);
    };
  }, [run, pollMs, skip]);

  return { ...state, refetch: run };
}
