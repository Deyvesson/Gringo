import express from 'express';
//import cors from 'cors';

const app = express();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.warn('Aviso: A variável de ambiente GEMINI_API_KEY não está definida.');
}

//app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.post('/api/evaluate', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'O campo "prompt" é obrigatório e deve ser uma string.' });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({ error: 'GEMINI_API_KEY não configurada no servidor.' });
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemma-3-27b-it:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'model',
              parts: [
                {
                  text:
                    'Você é um avaliador de traduções de inglês para português. Avalie a tradução fornecida para a frase "How are you?" e siga estas regras:\n- Se a tradução corresponder exatamente à expressão correta (ignorando maiúsculas/minúsculas e acentos), atribua nota 10 e feedback "Tradução perfeita!"\n- Se aproximadamente metade das palavras ou do sentido estiver correto, atribua nota 5 e feedback no formato "Não é bem assim. A tradução correta seria: Como você está?"\n- Caso contrário, escolha uma nota proporcional (0 a 10) e explique brevemente o motivo, sempre incluindo a tradução correta no feedback.\nResponda SOMENTE com JSON válido no seguinte formato: {"score": <inteiro de 0 a 10>, "feedback": "mensagem curta", "correctTranslation": "Como você está?"}.',
                },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  text: `Frase original: "How are you?"\nTradução informada: ${prompt}`,
                },
              ],
            },
          ],
        }),
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      console.error('Erro na Google Generative Language API:', response.status, errorBody);
      return res.status(502).json({
        error: 'Falha ao se comunicar com a API Gemini.',
        details: errorBody,
      });
    }

    const data = await response.json();
    const aggregatedText = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('')
      .trim();

    let parsedResult;
    if (aggregatedText) {
      let sanitizedText = aggregatedText.trim();

      if (sanitizedText.startsWith('```')) {
        sanitizedText = sanitizedText.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
      }

      try {
        parsedResult = JSON.parse(sanitizedText);
      } catch (parseError) {
        const jsonMatch = sanitizedText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            parsedResult = JSON.parse(jsonMatch[0]);
          } catch (nestedError) {
            console.warn('Falha ao interpretar JSON extraído da API Gemini:', nestedError);
          }
        }

        if (!parsedResult) {
          console.warn('Não foi possível interpretar resposta JSON da API Gemini:', parseError);
        }
      }
    }

    const scoreValue = Number(parsedResult?.score);
    const normalizedScore = Number.isFinite(scoreValue) ? Math.max(0, Math.min(10, Math.round(scoreValue))) : null;
    const feedback = parsedResult?.feedback || aggregatedText || 'Nenhuma resposta recebida.';
    const correctTranslation = parsedResult?.correctTranslation || 'Como você está?';

    return res.json({
      score: normalizedScore,
      feedback,
      correctTranslation,
      raw: data,
    });
  } catch (error) {
    console.error('Erro inesperado ao chamar API Gemini:', error);
    return res.status(500).json({ error: 'Erro interno ao consultar a API Gemini.' });
  }
});

export default app;
