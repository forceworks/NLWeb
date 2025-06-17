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
      // Optimize filtering and limit context size
      const filtered = embeddedDocs.filter(doc =>
        !industry || doc.tags?.some(tag => tag.toLowerCase().includes(industry.toLowerCase()))
      );

      // Limit context to top 5 most relevant docs to speed things up
      const topChunks = filtered
        .slice(0, 5)
        .map(doc => doc.content)
        .join('\n\n')
        .slice(0, 8000); // Cap context at ~8k chars

      const nameLine = userName
        ? `The user's name is "${userName}" - use it occasionally. `
        : '';

      const systemPrompt =
        'You are a conversational AI assistant for Digital Labor Factory. You can ONLY answer questions using the information provided in the Context section below. ' +
        'You work for Digital Labor Factory - do not mention being created by Anthropic or any other company. You are part of the Digital Labor Factory team. ' +
        'If the answer is not found in the Context, you must say "I don\'t have that information in our knowledge base" and suggest they contact us at [digitallaborfactory.ai/contact](https://www.digitallaborfactory.ai/contact). ' +
        'Never make up information or answer from general knowledge - stick strictly to what\'s in the Context. ' +
        'You speak as part of our team using "we" and "our." Your tone is warm, confident, and human — not robotic. ' +
        nameLine +
        'IMPORTANT: Keep responses SHORT and conversational - 2-3 sentences max unless they ask for details. For broad questions like "tell me about banking services", give a brief overview and ask what specific aspect they want to know more about. ' +
        'If a user asks a broad question, give a quick summary (1-2 sentences) then ask a clarifying question to help them get more targeted information. ' +
        'Be concise and conversational. Use short paragraphs and Markdown formatting when helpful. ' +
        'Always respond in the same language the user uses. ' +
        'Remember: If it\'s not in the Context below, you cannot answer it. Keep it short and ask follow-up questions.';

      const claudeStream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-sonnet-20240229',
          max_tokens: 300, // Reduced from 1000 to force shorter responses
          temperature: 0.3, // Lower temp for faster, more focused responses
          stream: true,
          messages: [
            { 
              role: 'user', 
              content: `CONTEXT:\n${topChunks}\n\n---\n\nQUESTION: ${userInput}` 
            }
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

      // Handle Claude streaming response for Node.js
      if (!claudeStream.body) {
        console.error('No response body from Claude API');
        throw new Error('No response body from Claude API');
      }

      // Process Server-Sent Events from Claude
      let buffer = '';
      
      claudeStream.body.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer
        
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data === '[DONE]') {
              res.end();
              return;
            }
            
            try {
              const parsed = JSON.parse(data);
              if (parsed.delta && parsed.delta.text) {
                res.write(parsed.delta.text);
              }
            } catch (e) {
              // Skip invalid JSON lines
            }
          }
        }
      });

      claudeStream.body.on('end', () => {
        res.end();
      });

      claudeStream.body.on('error', (err) => {
        console.error('Stream error:', err);
        throw err;
      });
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
