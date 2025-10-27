import express from 'express';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.warn('Aviso: A variável de ambiente OPENROUTER_API_KEY não está definida.');
}

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.post('/api/evaluate', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'O campo "prompt" é obrigatório e deve ser uma string.' });
  }

  if (!OPENROUTER_API_KEY) {
    return res.status(500).json({ error: 'OPENROUTER_API_KEY não configurada no servidor.' });
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'tngtech/deepseek-r1t2-chimera:free',
        messages: [
          {
            role: 'system',
            content: "dê uma nota de 0 a 10 para a tradução do usuário da frase em inglês 'How Are you?'",
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Erro na OpenRouter API:', response.status, errorBody);
      return res.status(502).json({
        error: 'Falha ao se comunicar com a OpenRouter API.',
        details: errorBody,
      });
    }

    const data = await response.json();
    return res.json(data);
  } catch (error) {
    console.error('Erro inesperado ao chamar OpenRouter API:', error);
    return res.status(500).json({ error: 'Erro interno ao consultar a OpenRouter API.' });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
