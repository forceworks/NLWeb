import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { appendFile } from 'fs/promises';
import { OpenAI } from 'openai';

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FEEDBACK_LOG_PATH = path.join(__dirname, 'feedback-log.jsonl');

// Load embedded vectors
const embeddedDocs = JSON.parse(await fs.readFile('./embedded_content.json', 'utf8'));

// Cosine similarity
function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (normA * normB);
}

// POST /api/query — multi-turn RAG + GPT-4
app.post('/api/query', async (req, res) => {
  const { messages, industry } = req.body;
  const userInput = messages?.slice(-1)[0]?.content;

  if (!messages || !Array.isArray(messages) || !userInput) {
    return res.status(400).send('Invalid request: missing messages');
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  try {
    const embeddedQuery = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: userInput,
    });

    const queryVector = embeddedQuery.data[0].embedding;

    const scored = embeddedDocs
      .filter(doc => !industry || doc.tags?.map(t => t.toLowerCase()).includes(industry.toLowerCase()))
      .map(doc => ({
        ...doc,
        score: cosineSimilarity(doc.vector, queryVector),
      }));

    let topRelevant = scored
      .filter(doc => doc.score > 0.4)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    if (topRelevant.length === 0) {
      topRelevant = scored.sort((a, b) => b.score - a.score).slice(0, 2);
    }

    const topChunks = topRelevant.map(doc => doc.content).join('\n\n');

    const systemPrompt =
      'You are a helpful AI agent representing our company, Digital Labor Factory. You speak on our behalf using the first person plural (“we,” “our”) as part of the team. ' +
      'Your role is to assist website visitors in exploring our services and understanding what we do. Always answer using only the provided context. ' +
      'Be concise, confident, and professional. Use short paragraphs or bullet points (3–5 max) to make responses easy to scan. Avoid filler, repetition, or general statements. ' +
      'Always respond in the same language the user uses. ' +
      'Format responses using Markdown when helpful (e.g., bullet points, bold service names, links). ' +
      'If the context provides only a partial answer, explain what is known and clearly note what is missing. ' +
      'If the user's question references a broad topic (e.g., \"banking\" or \"AI\"), ask a clarifying question before giving an answer. For example, ask: “Are you interested in retail, commercial, or digital banking? ' +
      'If the answer is not found in the context, say so clearly and suggest they contact us at [digitallaborfactory.ai/contact](https://www.digitallaborfactory.ai/contact). If the answer is present, do not mention the contact link. ' +
      'Never make up information. Maintain a confident, modern, human tone. Avoid corporate jargon or robotic phrasing.';

    const augmentedMessages = [
      { role: 'system', content: 'This is an initial question. Always ask a clarifying question before answering.' },
      { role: 'user', content: `Context:\n${topChunks}` },
      ...messages
    ];

    const stream = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: augmentedMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) res.write(content);
    }

    res.end();
  } catch (err) {
    console.error('Query processing error:', err);
    res.write('Error processing request.');
    res.end();
  }
});

// POST /api/feedback — log feedback to file
app.post('/api/feedback', async (req, res) => {
  const { query, response, vote } = req.body;

  if (!query || !response || !['up', 'down'].includes(vote)) {
    return res.status(400).send('Invalid feedback format');
  }

  const entry = {
    timestamp: new Date().toISOString(),
    vote,
    query,
    response,
  };

  try {
    await appendFile(FEEDBACK_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
    console.log(`Feedback saved: ${vote.toUpperCase()} for query: "${query.slice(0, 80)}..."`);
    res.sendStatus(200);
  } catch (err) {
    console.error('Failed to save feedback:', err);
    res.sendStatus(500);
  }
});

app.listen(port, () => {
  console.log(`NLWeb server running on port ${port}`);
});
