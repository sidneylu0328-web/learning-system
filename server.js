const express = require('express')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

// AI Feedback endpoint
app.post('/api/feedback', async (req, res) => {
  const { concept, week, explanation } = req.body

  if (!explanation || explanation.trim().length < 10) {
    return res.status(400).json({ error: 'Please write more before requesting feedback.' })
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.json({
      feedback: "Feedback is not available — the ANTHROPIC_API_KEY environment variable is not set. Add it in your Railway service variables to enable AI feedback."
    })
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are a Socratic tutor helping Sidney improve his ability to understand and articulate complex concepts clearly. He's doing a 35-day program to deepen his thinking and communication skills.

Concept: "${concept}" (from week: ${week})

Sidney's explanation:
"${explanation}"

Give him focused, honest feedback in 3 short sections:
1. **What you got right** — be specific about what's accurate and well-articulated
2. **What could be deeper or clearer** — point to gaps, vague language, or missing nuance (be direct, not harsh)
3. **A question to push further** — one Socratic question that makes him think deeper about this concept

Keep the total response under 180 words. Be encouraging but honest. Don't pad with compliments.`
      }]
    })

    res.json({ feedback: message.content[0].text })
  } catch (err) {
    console.error('Feedback error:', err.message)
    res.status(500).json({ error: 'Could not generate feedback. Try again in a moment.' })
  }
})

// SPA fallback
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`Learning System running on port ${PORT}`)
})
