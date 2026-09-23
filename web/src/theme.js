import { useEffect, useState } from 'react';

// SVG presentation attributes can't use var(), so charts read resolved token values.
const TOKENS = ['--series-1', '--series-2', '--grid', '--axis', '--text-secondary', '--surface-1', '--seq-light', '--border'];

function read() {
  const s = getComputedStyle(document.documentElement);
  return Object.fromEntries(TOKENS.map((t) => [t.slice(2), s.getPropertyValue(t).trim()]));
}

export function useTheme() {
  const [theme, setTheme] = useState(read);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setTheme(read());
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return theme;
}
