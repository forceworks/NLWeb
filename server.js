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
        'Never invent information. It’s better to ask the user a question or say “I’m not sure” than to guess. ' +
        'At the end of your reply, always include up to 3 short, clickable follow-up suggestions related to the question. Use this EXACT format on a new line: "SUGGESTED: [Option 1] | [Option 2] | [Option 3]" where each option is 2-4 words maximum.';

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

      // IMPROVED CODE:
const result = await completion.json();
const fullReply = result.choices?.[0]?.message?.content || '';

console.log('Full AI reply:', fullReply); // Debug log

// More flexible parsing - try different formats
let replyText = fullReply;
let suggestions = [];

// Try splitting on newline + SUGGESTED: first (original format)
let parts = fullReply.split(/\nSUGGESTED:/);
if (parts.length > 1) {
  replyText = parts[0];
  const suggestionLine = parts[1];
  suggestions = suggestionLine.match(/\[(.*?)\]/g)?.map(s => s.replace(/\[|\]/g, '')) || [];
} else {
  // Try splitting on just SUGGESTED: (without newline)
  parts = fullReply.split(/SUGGESTED:/);
  if (parts.length > 1) {
    replyText = parts[0];
    const suggestionLine = parts[1];
    suggestions = suggestionLine.match(/\[(.*?)\]/g)?.map(s => s.replace(/\[|\]/g, '')) || [];
  }
}

// If still no suggestions found, try alternative parsing
if (suggestions.length === 0) {
  // Look for patterns like "Would you like to know about A, B, or C?"
  const questionMatch = fullReply.match(/(?:interested in|would you like|choose between|specify)\s+(.+?)(?:\?|$)/i);
  if (questionMatch) {
    const optionsText = questionMatch[1];
    // Split on common separators and clean up
    const potentialSuggestions = optionsText
      .split(/,\s*or\s*|,\s*|\s+or\s+/)
      .map(s => s.replace(/^(our\s+)?/, '').replace(/\s+(solution|services?)$/, '').trim())
      .filter(s => s.length > 2 && s.length < 50); // Reasonable length suggestions
    
    if (potentialSuggestions.length > 0 && potentialSuggestions.length <= 5) {
      suggestions = potentialSuggestions;
    }
  }
}

console.log('Parsed reply:', replyText?.trim()); // Debug log
console.log('Parsed suggestions:', suggestions); // Debug log

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
