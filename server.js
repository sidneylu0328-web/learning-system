const express = require('express')
const path = require('path')

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json())
app.use(express.static(path.join(__dirname, 'public')))

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null
  const Anthropic = require('@anthropic-ai/sdk')
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

// ── AI Feedback on first explanation ──────────────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  const { concept, week, explanation, audience } = req.body

  if (!explanation || explanation.trim().length < 10) {
    return res.status(400).json({ error: 'Please write more before requesting feedback.' })
  }

  const client = getClient()
  if (!client) {
    return res.json({
      score: null,
      feedback: "Feedback is not available — the ANTHROPIC_API_KEY environment variable is not set."
    })
  }

  try {
    const audienceNote = audience ? `\nSidney was asked to explain this to: "${audience}"` : ''

    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: `You are a Socratic tutor helping Sidney improve his ability to understand and articulate complex concepts. He's doing a 35-day program to deepen his thinking and communication skills.

Concept: "${concept}" (Week: ${week})${audienceNote}

Sidney's explanation:
"${explanation}"

Respond with a JSON object (no markdown, no code block) in exactly this format:
{
  "score": <integer 1-5 where 1=very shallow, 3=decent grasp, 5=excellent depth and clarity>,
  "right": "<what he got right — be specific, 1-2 sentences>",
  "improve": "<what could be deeper or clearer — be direct, not harsh, 1-2 sentences>",
  "question": "<one Socratic question to push him further — make it genuinely challenging>"
}

Score guide: 1=barely scratched surface, 2=some basics but mostly vague, 3=solid understanding with gaps, 4=clear and nuanced, 5=excellent depth, precision, and insight.`
      }]
    })

    let raw = message.content[0].text.trim()
    // Strip markdown code blocks if present
    raw = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
    const parsed = JSON.parse(raw)
    res.json({ score: parsed.score, feedback: parsed })
  } catch (err) {
    console.error('Feedback error:', err.message)
    res.status(500).json({ error: 'Could not generate feedback. Try again in a moment.' })
  }
})

// ── AI Feedback on revised explanation ────────────────────────────────────────
app.post('/api/revision-feedback', async (req, res) => {
  const { concept, original, revision } = req.body

  if (!revision || revision.trim().length < 10) {
    return res.status(400).json({ error: 'Please write your revision before submitting.' })
  }

  const client = getClient()
  if (!client) {
    return res.json({
      score: null,
      feedback: "Feedback unavailable — ANTHROPIC_API_KEY not set."
    })
  }

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are a Socratic tutor. Sidney just revised his explanation of "${concept}" after receiving feedback.

Original explanation:
"${original}"

Revised explanation:
"${revision}"

Respond with a JSON object (no markdown, no code block):
{
  "score": <integer 1-5>,
  "improvement": "<1-2 sentences on what specifically improved>",
  "still_missing": "<1 sentence on what's still weak, or 'Nothing major — this is solid.' if score is 4+>",
  "verdict": "<one punchy sentence: overall assessment of the revision>"
}

Be honest. If the revision isn't much better, say so. If it's significantly better, acknowledge the growth.`
      }]
    })

    let raw = message.content[0].text.trim()
    raw = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
    const parsed = JSON.parse(raw)
    res.json({ score: parsed.score, feedback: parsed })
  } catch (err) {
    console.error('Revision feedback error:', err.message)
    res.status(500).json({ error: 'Could not generate feedback. Try again.' })
  }
})

// ── Weekly Synthesis Feedback ─────────────────────────────────────────────────
app.post('/api/synthesis-feedback', async (req, res) => {
  const { weekLabel, concepts, synthesis } = req.body

  if (!synthesis || synthesis.trim().length < 20) {
    return res.status(400).json({ error: 'Write more before submitting your synthesis.' })
  }

  const client = getClient()
  if (!client) {
    return res.json({ feedback: "Feedback unavailable — ANTHROPIC_API_KEY not set." })
  }

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `You are a Socratic tutor. Sidney just finished Week: "${weekLabel}" and was asked to synthesize all 7 concepts into a coherent paragraph showing how they connect.

The 7 concepts were: ${concepts.join(', ')}

His synthesis:
"${synthesis}"

Respond with a JSON object (no markdown, no code block):
{
  "connections_found": "<what connections he successfully drew between concepts — be specific>",
  "missed_link": "<one important connection or pattern he missed>",
  "insight": "<the deeper insight this week's concepts point to that he may not have seen yet>"
}

Keep each field to 1-2 sentences. Push him to think at the level of underlying principles, not surface descriptions.`
      }]
    })

    let raw = message.content[0].text.trim()
    raw = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
    const parsed = JSON.parse(raw)
    res.json({ feedback: parsed })
  } catch (err) {
    console.error('Synthesis feedback error:', err.message)
    res.status(500).json({ error: 'Could not generate feedback. Try again.' })
  }
})

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`Learning System running on port ${PORT}`)
})
