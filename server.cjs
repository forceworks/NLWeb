const express = require('express');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const { appendFile } = require('fs').promises;
const fetch = require('node-fetch');

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

(async () => {
  const FEEDBACK_LOG_PATH = path.join(__dirname, 'feedback-log.jsonl');
  const embeddedDocs = JSON.parse(await fs.readFile('./embedded_content.json', 'utf8'));

  app.post('/api/query', async (req, res) => {
    const { messages, industry, userName } = req.body;
    const userInput = messages?.slice(-1)[0]?.content;

    if (!messages || !Array.isArray(messages) || !userInput) {
      return res.status(400).send('Invalid request: missing messages');
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');

    try {
      const filtered = embeddedDocs.filter(doc =>
        !industry || doc.tags?.map(t => t.toLowerCase()).includes(industry.toLowerCase())
      );

      const topChunks = filtered.map(doc => doc.content).join('\n\n');

      const nameLine = userName
        ? `If you know the user's name, occasionally refer to them by it to keep the tone personal. The user's name is "${userName}". `
        : '';

      const systemPrompt =
        'You are a conversational AI assistant for Digital Labor Factory. You speak as part of our team using "we" and "our." Your tone is warm, confident, and human — not robotic. ' +
        nameLine +
        'You do not try to answer everything immediately. If a user asks a broad question (e.g., "banking", "AI", or "services"), ask a brief clarifying question first — and wait for their answer. ' +
        'Be concise. Your replies should feel like smart chat messages, not long emails. Use short paragraphs or bullet points when helpful. Avoid repeating yourself or stating the obvious. ' +
        'Always respond in the same language the user uses. Use Markdown for light formatting when appropriate. ' +
        'If the context provides only a partial answer, explain what is known and clearly note what is missing. ' +
        'If the answer is not found in the context, say so clearly and suggest they contact us at [digitallaborfactory.ai/contact](https://www.digitallaborfactory.ai/contact). ' +
        'Never invent information. It\'s better to ask the user a question or say "I\'m not sure" than to guess.';

      const claudeStream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-sonnet-20240229',
          max_tokens: 1000,
          temperature: 0.7,
          stream: true,
          messages: [
            { role: 'user', content: `Context:\n${topChunks}\n\n${userInput}` }
          ],
          system: systemPrompt
        })
      });

      // Check if the response is ok first
      if (!claudeStream.ok) {
        const errorText = await claudeStream.text();
        console.error('Claude API error:', claudeStream.status, claudeStream.statusText, errorText);
        throw new Error(`Claude API returned ${claudeStream.status}: ${claudeStream.statusText}`);
      }

      // Check if we have a valid stream body
      if (!claudeStream.body || typeof claudeStream.body.getReader !== 'function') {
        console.error('Invalid stream response:', claudeStream.status, claudeStream.statusText);
        throw new Error('Invalid stream response from Claude API');
      }

      const reader = claudeStream.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value);
        res.write(chunk);
      }

      res.end();
    } catch (err) {
      console.error('Query processing error:', err);
      
      // Make sure we haven't already started writing to the response
      if (!res.headersSent) {
        res.status(500).json({ error: 'Error processing request', details: err.message });
      } else {
        res.write('\n\nError: Request processing failed.');
        res.end();
      }
    }
  });

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
})();
