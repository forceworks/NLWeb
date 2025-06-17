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
      // Debug: Check what we're working with
      console.log('Total embedded docs:', embeddedDocs.length);
      console.log('Industry filter:', industry);
      console.log('User input:', userInput);

      // Smart filtering based on query content
      let filtered = embeddedDocs;
      
      if (industry) {
        filtered = filtered.filter(doc =>
          doc.tags?.some(tag => tag.toLowerCase().includes(industry.toLowerCase()))
        );
      }

      // Extract meaningful words from user query (remove common words)
      const stopWords = ['tell', 'me', 'about', 'what', 'is', 'are', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'];
      const queryWords = userInput.toLowerCase()
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.includes(word));
      
      console.log('Query keywords:', queryWords);
      
      if (queryWords.length > 0) {
        // Score docs by relevance
        const scoredDocs = filtered.map(doc => {
          let score = 0;
          
          // Check tags for exact matches (higher weight)
          doc.tags?.forEach(tag => {
            queryWords.forEach(word => {
              if (tag.toLowerCase().includes(word)) {
                score += 10;
              }
            });
          });
          
          // Check content for matches (lower weight)
          const content = doc.content?.toLowerCase() || '';
          queryWords.forEach(word => {
            const matches = (content.match(new RegExp(word, 'g')) || []).length;
            score += matches * 2;
          });
          
          return { doc, score };
        });
        
        // Sort by relevance score and filter out zero scores
        const relevantDocs = scoredDocs
          .filter(item => item.score > 0)
          .sort((a, b) => b.score - a.score)
          .map(item => item.doc);
        
        console.log('Relevant docs found:', relevantDocs.length);
        console.log('Top scores:', scoredDocs.slice(0, 3).map(item => ({ score: item.score, tags: item.doc.tags })));
        
        if (relevantDocs.length > 0) {
          filtered = relevantDocs;
        }
      }

      console.log('Final filtered docs:', filtered.length);

      // Limit context to top 5 most relevant docs
      const topChunks = filtered
        .slice(0, 5)
        .map(doc => doc.content)
        .join('\n\n')
        .slice(0, 8000); // Cap context at ~8k chars

      console.log('Final context length:', topChunks.length);

      const nameLine = userName
        ? `The user's name is "${userName}" - use it occasionally. `
        : '';

      const systemPrompt =
        'You are a conversational AI assistant for Digital Labor Factory. You can ONLY answer using the exact information in the Context below - do not add details, examples, or specifics not explicitly mentioned. ' +
        'You work for Digital Labor Factory. Never mention being created by Anthropic. ' +
        'For broad questions, give ONE sentence overview from the Context, then ask what specific aspect they want to know about. ' +
        'If information is not in the Context, say "I don\'t have that information" and suggest contacting [digitallaborfactory.ai/contact](https://www.digitallaborfactory.ai/contact). ' +
        'Never list specific companies, systems, or details unless they are explicitly mentioned in the Context. ' +
        nameLine +
        'Keep responses to 1-2 sentences maximum. Always end broad questions with a follow-up question. ' +
        'Use "we" and "our" when referring to Digital Labor Factory.';

      const claudeStream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-sonnet-20240229',
          max_tokens: 150, // Even shorter to force brevity
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
