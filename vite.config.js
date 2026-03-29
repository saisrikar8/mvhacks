import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api/openai/chat': {
          target: 'https://api.openai.com/v1/chat/completions',
          changeOrigin: true,
          rewrite: (path) => '',
          configure: (proxy, options) => {
            proxy.on('proxyReq', (proxyReq, req, res) => {
              proxyReq.setHeader('Authorization', `Bearer ${env.OPENAI_API_KEY}`);
            });
          },
        },
      },
    },
  };
})
