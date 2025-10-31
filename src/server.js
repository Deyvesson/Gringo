import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
//import cors from 'cors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemma-3-27b-it';
const GEMINI_API_URL = GEMINI_API_KEY
  ? `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`
  : null;

if (!GEMINI_API_KEY) {
  console.warn('Aviso: A variável de ambiente GEMINI_API_KEY não está definida.');
}

function aggregateGeminiText(data) {
  return (
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? '')
      .join('')
      .trim() ?? ''
  );
}

function parseGeminiJsonPayload(text) {
  if (!text) {
    return null;
  }

  let sanitized = text.trim();

  if (!sanitized) {
    return null;
  }

  if (sanitized.startsWith('```')) {
    sanitized = sanitized.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  }

  try {
    return JSON.parse(sanitized);
  } catch (error) {
    const jsonMatch = sanitized.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (nestedError) {
        console.warn('Falha ao interpretar JSON extraído da resposta Gemini:', nestedError);
      }
    }

    console.warn('Não foi possível interpretar resposta JSON da API Gemini:', error);
    return null;
  }
}

function normalizePhraseList(value) {
  const rawList = Array.isArray(value)
    ? value
    : Array.isArray(value?.phrases)
    ? value.phrases
    : [];

  const seen = new Set();
  const normalized = [];

  for (const item of rawList) {
    if (typeof item !== 'string') {
      continue;
    }

    const trimmed = item.trim();
    if (!trimmed) {
      continue;
    }

    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(trimmed);

    if (normalized.length >= 200) {
      break;
    }
  }

  return normalized;
}

async function callGemini(contents) {
  if (!GEMINI_API_URL) {
    const error = new Error('GEMINI_API_KEY não configurada.');
    error.status = 500;
    throw error;
  }

  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ contents }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    const error = new Error('Falha ao se comunicar com a API Gemini.');
    error.status = response.status;
    error.details = errorBody;
    error.isGeminiError = true;
    throw error;
  }

  const data = await response.json();
  const aggregatedText = aggregateGeminiText(data);

  return { data, aggregatedText };
}

//app.use(cors());
app.use(express.json());
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));

app.post('/api/evaluate', async (req, res) => {
  const { prompt, originalPhrase } = req.body;

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'O campo "prompt" é obrigatório e deve ser uma string.' });
  }

  if (!originalPhrase || typeof originalPhrase !== 'string') {
    return res
      .status(400)
      .json({ error: 'O campo "originalPhrase" é obrigatório e deve ser uma string.' });
  }

  try {
    const systemPrompt =
      'Você é um avaliador de traduções de inglês para português. Avalie a tradução fornecida para a frase fornecida e siga estas regras:\n' +
      '- Se a tradução corresponder exatamente à expressão correta (ignorando maiúsculas/minúsculas e acentos), atribua nota 10 e feedback "Tradução perfeita!"\n' +
      '- Se aproximadamente metade das palavras ou do sentido estiver correto, atribua nota 5 e feedback no formato "Não é bem assim. A tradução correta seria: <frase em português correta>"\n' +
      '- Caso contrário, escolha uma nota proporcional (0 a 10) e explique brevemente o motivo, sempre incluindo a tradução correta no feedback.\n' +
      'Responda SOMENTE com JSON válido no seguinte formato: {"score": <inteiro de 0 a 10>, "feedback": "mensagem curta", "correctTranslation": "<tradução correta em português>"}.';

    const { data, aggregatedText } = await callGemini([
      {
        role: 'model',
        parts: [
          {
            text: systemPrompt,
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            text: `Frase original em inglês: "${originalPhrase}"\nTradução informada: ${prompt}`,
          },
        ],
      },
    ]);

    const parsedResult = parseGeminiJsonPayload(aggregatedText);

    const scoreValue = Number(parsedResult?.score);
    const normalizedScore = Number.isFinite(scoreValue)
      ? Math.max(0, Math.min(10, Math.round(scoreValue)))
      : null;
    const feedback = parsedResult?.feedback || aggregatedText || 'Nenhuma resposta recebida.';
    const correctTranslation = parsedResult?.correctTranslation || 'Tradução não informada.';

    return res.json({
      score: normalizedScore,
      feedback,
      correctTranslation,
      raw: data,
    });
  } catch (error) {
    if (error.isGeminiError) {
      console.error('Erro na Google Generative Language API:', error.status, error.details);
      return res.status(502).json({ error: error.message, details: error.details });
    }

    console.error('Erro inesperado ao chamar API Gemini:', error);
    const status = error.status ?? 500;
    return res.status(status).json({ error: error.message || 'Erro interno ao consultar a API Gemini.' });
  }
});

app.post('/api/phrases', async (req, res) => {
  const requestedCount = Number(req.body?.count ?? 100);
  const targetCount = Number.isFinite(requestedCount)
    ? Math.max(1, Math.min(200, Math.round(requestedCount)))
    : 100;

  try {
    const systemPrompt =
      'Você é um gerador de frases curtas em inglês voltadas para estudantes brasileiros praticarem tradução. Gere uma lista de frases diversas, envolvendo cumprimentos, situações cotidianas e perguntas simples.\n' +
      'Retorne SOMENTE JSON válido no formato {"phrases": ["English sentence 1", "English sentence 2", ...]}.\n' +
      'Forneça exatamente ' +
      targetCount +
      ' frases diferentes, sem numeração, sem traduções em português e com no máximo 120 caracteres cada.';

    const { data, aggregatedText } = await callGemini([
      {
        role: 'user',
        parts: [
          {
            text: systemPrompt,
          },
        ],
      },
    ]);

    let parsed = parseGeminiJsonPayload(aggregatedText);
    let phrases = normalizePhraseList(parsed);

    if (!phrases.length && aggregatedText) {
      const fallback = aggregatedText
        .split(/\r?\n/)
        .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
        .filter(Boolean);
      phrases = normalizePhraseList(fallback);
    }

    if (!phrases.length) {
      throw new Error('Não foi possível obter frases válidas da API Gemini.');
    }

    if (phrases.length > targetCount) {
      phrases = phrases.slice(0, targetCount);
    }

    return res.json({ phrases, raw: data });
  } catch (error) {
    if (error.isGeminiError) {
      console.error('Erro na Google Generative Language API:', error.status, error.details);
      return res.status(502).json({ error: error.message, details: error.details });
    }

    console.error('Erro inesperado ao gerar frases com a API Gemini:', error);
    const status = error.status ?? 500;
    return res.status(status).json({ error: error.message || 'Erro interno ao gerar frases.' });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

export default app;
