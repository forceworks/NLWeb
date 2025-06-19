import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';

const app = express();
const port = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

(async () => {
  const FEEDBACK_LOG_PATH = path.join(process.cwd(), 'feedback-log.jsonl');
  const embeddedDocs = JSON.parse(await fs.readFile('./embedded_content.json', 'utf8'));

  function cosineSimilarity(a, b) {
    const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
    const normA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
    const normB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
    return dot / (normA * normB);
  }

  app.post('/api/query', async (req, res) => {
    const { messages, industry, userName } = req.body;
    const userInput = messages?.slice(-1)[0]?.content;

    if (!messages || !Array.isArray(messages) || !userInput) {
      return res.status(400).send('Invalid request: missing messages');
    }

    res.setHeader('Content-Type', 'application/json');

    try {
      const embeddedQuery = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: userInput
        })
      });

      const embeddingResult = await embeddedQuery.json();
      const queryVector = embeddingResult.data[0].embedding;

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

      const nameLine = userName
        ? `If you know the user's name, integrate it into the conversation to personalize the interaction, but ensure you do not use it consecutively. The user's name is "${userName}". `
        : '';

      const systemPrompt =
        'You are a conversational AI assistant at the Digital Labor Factory, engaging in dialogue as a member of our team. Your tone should be warm, confident, and human-like rather than robotic. ' +
        nameLine +
        'If presented with a broad query, such as "banking," "AI," or "services," always respond first with a brief clarifying question and await the user's reply. ' +
        'Be concise. Your replies should feel like smart chat messages, not long emails. Construct your answers to feel like smart chat messages rather than extended emails; use concise paragraphs or bullet points where beneficial. Avoid redundancy and stating the obvious. ' +
        'Maintain language consistency by replying in the same language used by the user. When applicable, employ Markdown for subtle formatting. Ensure responses relate to Digital Labor Factory services and solutions rather than general topics. Explain what is known if context is partial and indicate what is missing clearly. If unable to provide an answer from the context, be forthright and suggest contacting us at [digitallaborfactory.ai/contact](https://www.digitallaborfactory.ai/contact). ' +
        'Never fabricate information; it's preferable to ask the user a further question or admit uncertainty ("I'm not sure") than to guess.' +
        'Complete each reply with up to three short, clickable follow-up suggestions relevant to the query. Always use this format on a new line: "SUGGESTED: [Option 1] | [Option 2] | [Option 3]" where each option contains a maximum of four words.';

      const completion = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'gpt-4',
          stream: false,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Context:\n${topChunks}\n\n${userInput}` }
          ]
        })
      });

      const result = await completion.json();
      const fullReply = result.choices?.[0]?.message?.content || '';

      console.log('Full AI reply:', fullReply); // Debug log

      // Universal suggestion parsing
      let replyText = fullReply;
      let suggestions = [];

      // Method 1: Try the standard SUGGESTED: format first
      let parts = fullReply.split(/\n?SUGGESTED:\s*/i);
      if (parts.length > 1) {
        replyText = parts[0].trim();
        const suggestionLine = parts[1];
        suggestions = suggestionLine.match(/\[(.*?)\]/g)?.map(s => s.replace(/\[|\]/g, '').trim()) || [];
      }

      // Method 2: Universal fallback - extract any list-like patterns from the text
      if (suggestions.length === 0) {
        // Find sentences that contain multiple items separated by commas and/or "or"
        const sentences = fullReply.split(/[.!?]+/).filter(s => s.trim().length > 0);
        
        for (const sentence of sentences) {
          // Look for any sentence with multiple comma-separated items
          if (sentence.includes(',') && (sentence.includes(' or ') || sentence.includes('?'))) {
            // Extract the part that contains the list
            const listMatch = sentence.match(/([^,]+(?:,\s*[^,]+)+(?:\s*,?\s*or\s+[^,]+)?)/i);
            if (listMatch) {
              const listText = listMatch[1];
              
              // Split and clean the options
              const options = listText
                .split(/,\s*(?:or\s+)?|\s+or\s+/i)
                .map(option => option.trim())
                .map(option => {
                  // Remove common prefixes and suffixes
                  return option
                    .replace(/^(?:its?\s+|the\s+|on\s+|in\s+|about\s+|like\s+|such\s+as\s+|including\s+|things\s+like\s+)/i, '')
                    .replace(/\s+(?:operations?|services?|solutions?|systems?|processes?|insurance|banking)$/i, '')
                    .trim();
                })
                .filter(option => {
                  // Keep only meaningful options
                  return option.length > 2 && 
                         option.length < 40 && 
                         !/^(?:and|or|the|a|an|is|are|you|your|for|to|of|in|on|at|by|with|even)$/i.test(option);
                })
                .slice(0, 3) // Max 3 suggestions
                .map(option => {
                  // Capitalize properly for button display
                  return option.split(' ')
                    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                    .join(' ');
                });
              
              if (options.length >= 2) {
                suggestions = options;
                break;
              }
            }
          }
        }
      }

      console.log('Parsed reply:', replyText?.trim());
      console.log('Parsed suggestions:', suggestions);

      res.send({ reply: replyText?.trim(), suggestions });

    } catch (err) {
      console.error('Query processing error:', err);
      res.status(500).send({ reply: 'Error processing request.', suggestions: [] });
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
      await fs.appendFile(FEEDBACK_LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
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
