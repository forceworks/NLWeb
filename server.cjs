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

      // Extract meaningful words from user query and expand with related terms
      const stopWords = ['tell', 'me', 'about', 'what', 'is', 'are', 'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by'];
      let queryWords = userInput.toLowerCase()
        .split(/\s+/)
        .filter(word => word.length > 2 && !stopWords.includes(word));
      
      // Expand query terms with related keywords
      const expansions = {
        'banks': ['banking', 'financial', 'finance', 'credit', 'loan'],
        'bank': ['banking', 'financial', 'finance', 'credit', 'loan'],
        'banking': ['banks', 'bank', 'financial', 'finance'],
        'healthcare': ['health', 'medical', 'medicine', 'hospital', 'clinical'],
        'health': ['healthcare', 'medical', 'medicine', 'hospital'],
        'manufacturing': ['production', 'factory', 'industrial', 'assembly'],
        'insurance': ['coverage', 'policy', 'claims', 'underwriting'],
        'retail': ['commerce', 'shopping', 'store', 'sales'],
        'logistics': ['supply', 'chain', 'shipping', 'distribution'],
        'construction': ['building', 'contractor', 'architecture'],
        'education': ['school', 'university', 'learning', 'academic'],
        'government': ['public', 'municipal', 'federal', 'state'],
        'energy': ['power', 'utility', 'electricity', 'oil', 'gas'],
        'telecommunications': ['telecom', 'network', 'communications']
      };
      
      // Add related terms
      queryWords.forEach(word => {
        if (expansions[word]) {
          queryWords = [...queryWords, ...expansions[word]];
        }
      });
      
      // Remove duplicates
      queryWords = [...new Set(queryWords)];
      
      console.log('Expanded query keywords:', queryWords);
      
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
        ? `If you know the user's name, occasionally refer to them by it to keep the tone personal. The user's name is "${userName}". `
        : '';

      const systemPrompt =
        'You are Digital Labor Factory\'s AI assistant. You MUST ONLY use information from the CONTEXT section below. ' +
        'Always respond in the same language the user uses. Use Markdown for light formatting when appropriate. ' +
        'CRITICAL: If information is not explicitly stated in the CONTEXT, respond with "I don\'t have that specific information in our knowledge base. Please contact us at [digitallaborfactory.ai/contact](https://www.digitallaborfactory.ai/contact)." ' +
        'Never mention Anthropic. You work for Digital Labor Factory. ' +
        'Keep responses to 1-2 sentences maximum. For broad topics, give a brief overview from CONTEXT then ask what specific aspect they want to know about. ' +
        nameLine;

      const claudeStream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-20241022', // Newer model, better instruction following
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
