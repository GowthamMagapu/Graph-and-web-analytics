import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.API_URL || 'http://localhost:4001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/graphql': api,
      '/auth': api,
    },
  },
});
