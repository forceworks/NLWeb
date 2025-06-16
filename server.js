import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import { OpenAI } from 'openai';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Load embedded vectors from file
const embeddedDocs = JSON.parse(await fs.readFile('./embedded_content.json', 'utf-8'));

// Simple cosine similarity
function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (normA * normB);
}

app.post('/api/query', async (req, res) => {
  const query = req.body.query;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');

  try {
    const embeddedQuery = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: query,
    });

    const queryVector = embeddedQuery.data[0].embedding;

    const scored = embeddedDocs.map((doc) => ({
      ...doc,
      score: cosineSimilarity(doc.vector, queryVector),
    }));

    const topRelevant = scored
      .filter((doc) => doc.score > 0.75)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    if (topRelevant.length === 0) {
      res.write(
        `I'm sorry, I couldn’t find any relevant information about that in our site content.\n\n` +
        `Please feel free to [contact us here](https://www.digitallaborfactory.ai/contact) and we’d be happy to help.`
      );
      return res.end();
    }

    const topChunks = topRelevant.map((doc) => doc.content).join('\n\n');

    const messages = [
      {
        role: 'system',
        content:
          'You are a helpful AI agent representing our company. You always answer in the first person plural and speak as if you are part of the Digital Labor Factory team. ' +
          'You must answer using only the provided context. If the context does not contain the answer, say so clearly and suggest contacting us.',
      },
      {
        role: 'user',
        content: `Context:\n${topChunks}\n\nQuestion: ${query}`,
      },
    ];

    const stream = await openai.chat.completions.create({
      model: 'gpt-4',
      messages,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) res.write(content);
    }

    res.end();
  } catch (err) {
    console.error(err);
    res.write('Error processing request.');
    res.end();
  }
});

app.listen(port, () => {
  console.log(`NLWeb server running on port ${port}`);
});
