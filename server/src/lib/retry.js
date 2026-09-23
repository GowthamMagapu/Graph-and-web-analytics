/** Retry an async fn until it succeeds - used to wait for infrastructure at startup. */
export async function waitFor(name, fn, { attempts = 30, delayMs = 2000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= attempts) throw err;
      console.log(`[wait] ${name} not ready (${err.message}); retry ${i}/${attempts}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
