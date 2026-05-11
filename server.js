const express = require('express')
const path = require('path')
const fs = require('fs')

const app = express()
const PORT = process.env.PORT || 3000

app.use(express.json({ limit: '2mb' }))
app.use(express.static(path.join(__dirname, 'public')))

// ── Cross-device progress sync ────────────────────────────────────────────────
// Stores progress in a JSON file so all devices (phone, laptop) share the same
// state. Railway keeps this file alive between restarts (just not full redeploys,
// which are rare). Falls back gracefully if the file can't be written.

const DATA_DIR  = path.join(__dirname, 'data')
const PROG_FILE = path.join(DATA_DIR, 'progress.json')

// In-memory cache — primary store (survives restarts, resets only on redeploy)
let _cache = null

function readProgress() {
  // Return memory cache if already loaded
  if (_cache !== null) return _cache
  // Try to restore from file on first boot
  try {
    if (fs.existsSync(PROG_FILE)) {
      _cache = JSON.parse(fs.readFileSync(PROG_FILE, 'utf8'))
      console.log('Progress restored from file')
      return _cache
    }
  } catch (e) {
    console.warn('Could not read progress file:', e.message)
  }
  _cache = {}
  return _cache
}

function writeProgress(data) {
  _cache = data  // always update memory immediately
  // Best-effort file write (may fail on Railway ephemeral FS — that's OK)
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(PROG_FILE, JSON.stringify(data), 'utf8')
  } catch (e) {
    console.warn('Could not write progress file (using memory only):', e.message)
  }
}

// GET  /api/progress  → return saved state object
app.get('/api/progress', (req, res) => {
  res.json(readProgress())
})

// POST /api/progress  → body = full state object, save it
app.post('/api/progress', (req, res) => {
  const body = req.body
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ error: 'Invalid body' })
  }
  writeProgress(body)
  res.json({ ok: true })
})

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null
  const Anthropic = require('@anthropic-ai/sdk')
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
}

// ── AI Feedback on first explanation ──────────────────────────────────────────
app.post('/api/feedback', async (req, res) => {
  const { concept, week, explanation, audience, notes } = req.body

  if (!explanation || explanation.trim().length < 10) {
    return res.status(400).json({ error: 'Please write more before requesting feedback.' })
  }

  const client = getClient()
  if (!client) {
    return res.json({
      score: null,
      feedback: {
        right: '',
        improve: '',
        question: '⚠️ AI feedback is not available — the ANTHROPIC_API_KEY environment variable is not set in your Railway service variables.'
      }
    })
  }

  try {
    const audienceNote = audience ? `\nSidney was asked to explain this to: "${audience}"` : ''
    const thinkingNotes = notes ? `\n\nSidney's pre-writing understanding notes:\n${notes}` : ''

    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 700,
      messages: [{
        role: 'user',
        content: `You are a Socratic tutor helping Sidney improve his ability to understand and articulate complex concepts. He's doing a 35-day program to deepen his thinking and communication skills.

Concept: "${concept}" (Week: ${week})${audienceNote}
${thinkingNotes}

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
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (parseErr) {
      // Claude returned non-JSON — wrap it gracefully
      parsed = { score: null, right: '', improve: '', question: raw }
    }
    res.json({ score: parsed.score || null, feedback: { right: parsed.right || '', improve: parsed.improve || '', question: parsed.question || '' } })
  } catch (err) {
    console.error('Feedback error:', err.message)
    res.status(500).json({ error: 'Could not generate feedback. Try again in a moment.' })
  }
})

// ── Socratic question before final writing ───────────────────────────────────
app.post('/api/tutor-question', async (req, res) => {
  const { concept, description, week, prompt, notes } = req.body

  if (!notes || notes.trim().length < 10) {
    return res.status(400).json({ error: 'Add a few rough notes first.' })
  }

  const client = getClient()
  if (!client) {
    return res.json({
      question: `What is the most important distinction someone must understand before they can use ${concept} well?`,
      hint: 'Answer this before writing the full paragraph.'
    })
  }

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `You are a Socratic tutor helping Sidney understand a concept before he writes a polished explanation.

Concept: "${concept}"
Description: "${description}"
Week: "${week}"
Final writing prompt: "${prompt}"

Sidney's rough notes:
${notes}

Respond with JSON only:
{
  "question": "<one short, specific question that targets the weakest or most interesting part of his notes>",
  "hint": "<one gentle hint that tells him what kind of answer would show real understanding>"
}

Do not grade him yet. Make the question conversational, precise, and answerable in 2-4 sentences.`
      }]
    })

    let raw = message.content[0].text.trim()
    raw = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
    const parsed = JSON.parse(raw)
    res.json({
      question: parsed.question || '',
      hint: parsed.hint || ''
    })
  } catch (err) {
    console.error('Tutor question error:', err.message)
    res.status(500).json({ error: 'Could not generate tutor question. Try again.' })
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

// ── Connection Challenge Feedback ─────────────────────────────────────────────
app.post('/api/connection-feedback', async (req, res) => {
  const { concept, pastConcept, answer } = req.body

  if (!answer || answer.trim().length < 5) {
    return res.status(400).json({ error: 'Write more before getting feedback.' })
  }

  const client = getClient()
  if (!client) {
    return res.json({ feedback: '⚠️ AI unavailable — ANTHROPIC_API_KEY not set.', perfect: '' })
  }

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `Sidney is doing a connection challenge: how does "${concept}" connect to "${pastConcept}"?

His answer: "${answer}"

Respond with a JSON object (no markdown, no code block):
{
  "feedback": "<2-3 sentences: what he got right about the connection, what's still surface-level, and one sharper angle he missed>",
  "perfect": "<the ideal 2-3 sentence answer showing the deepest, most precise connection between the two concepts>"
}

Be direct and specific. The perfect answer should reveal a non-obvious link, not just restate definitions.`
      }]
    })

    let raw = message.content[0].text.trim()
    raw = raw.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()
    const parsed = JSON.parse(raw)
    res.json({ feedback: parsed.feedback || '', perfect: parsed.perfect || '' })
  } catch (err) {
    console.error('Connection feedback error:', err.message)
    res.status(500).json({ error: 'Could not generate feedback. Try again.' })
  }
})

// ── Perfect Answer ────────────────────────────────────────────────────────────
app.post('/api/perfect-answer', async (req, res) => {
  const { concept, description, prompt, audience, week } = req.body

  const client = getClient()
  if (!client) {
    return res.json({ answer: '⚠️ AI unavailable — ANTHROPIC_API_KEY not set.' })
  }

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Write the ideal answer to this learning prompt. Audience: "${audience}". Concept: "${concept}" — ${description}. Week: ${week}.

Prompt: "${prompt}"

Write a response that scores 5/5: clear, specific, uses a vivid real-world example, shows genuine depth, and is perfectly pitched to the audience. Aim for 110–150 words. No preamble — write the answer directly as Sidney would.`
      }]
    })
    res.json({ answer: message.content[0].text.trim() })
  } catch (err) {
    console.error('Perfect answer error:', err.message)
    res.status(500).json({ error: 'Could not generate answer. Try again.' })
  }
})

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`Learning System running on port ${PORT}`)
})
