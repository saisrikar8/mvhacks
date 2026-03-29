export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' })
    }

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
        return res.status(500).json({
            error: { message: 'Missing OPENAI_API_KEY in Vercel env' },
        })
    }

    try {
        const { messages, tools, tool_choice } = req.body

        const payload = {
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            messages,
        }

        if (tools?.length) payload.tools = tools
        if (tool_choice != null) payload.tool_choice = tool_choice

        const r = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(payload),
        })

        const data = await r.json()
        res.status(r.status).json(data)
    } catch (err) {
        res.status(500).json({ error: { message: err.message } })
    }
}