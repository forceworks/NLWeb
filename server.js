import express from 'express';
import cors from 'cors';
import { OpenAI } from 'openai';

const app = express();
const port = process.env.PORT || 3000;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors());
app.use(express.json());

app.post('/api/query', async (req, res) => {
  const userQuery = req.body.query;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: userQuery }],
      stream: true,
    });

    for await (const chunk of completion) {
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) res.write(content);
    }

    res.end();
  } catch (err) {
    console.error(err);
    res.write('Error during streaming.');
    res.end();
  }
});

app.listen(port, () => {
  console.log(`NLWeb server running on port ${port}`);
});
