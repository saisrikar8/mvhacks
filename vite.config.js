import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

/** Proxies OpenAI chat completions in dev so OPENAI_API_KEY stays off the client bundle. */
function openaiProxyPlugin(env) {
  return {
    name: 'openai-proxy',
    configureServer(server) {
      server.middlewares.use('/api/openai/chat', async (req, res, next) => {
        if (req.method !== 'POST') {
          next()
          return
        }
        let body = ''
        for await (const chunk of req) {
          body += chunk
        }
        let parsed
        try {
          parsed = JSON.parse(body)
        } catch {
          res.statusCode = 400
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ error: { message: 'Invalid JSON body' } }))
          return
        }
        const apiKey = env.OPENAI_API_KEY
        if (!apiKey) {
          res.statusCode = 503
          res.setHeader('Content-Type', 'application/json')
          res.end(
            JSON.stringify({
              error: {
                message:
                  'Set OPENAI_API_KEY in .env (loaded by Vite). Restart npm run dev after adding it.',
              },
            }),
          )
          return
        }
        const payload = {
          model: env.OPENAI_MODEL || 'gpt-4o-mini',
          messages: parsed.messages,
        }
        if (parsed.tools?.length) payload.tools = parsed.tools
        if (parsed.tool_choice != null) payload.tool_choice = parsed.tool_choice

        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
        })
        const text = await r.text()
        res.statusCode = r.status
        res.setHeader('Content-Type', 'application/json')
        res.end(text)
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), openaiProxyPlugin(env)],
  }
})
