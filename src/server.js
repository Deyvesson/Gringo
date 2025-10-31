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

async function callGemini(contents, config = {}) {
  if (!GEMINI_API_URL) {
    const error = new Error('GEMINI_API_KEY não configurada.');
    error.status = 500;
    throw error;
  }

  const requestBody = {
    contents,
    generationConfig: {
      temperature: config.temperature ?? 1.0,
      topK: config.topK ?? 40,
      topP: config.topP ?? 0.95,
      maxOutputTokens: config.maxOutputTokens ?? 8192,
    },
  };

  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
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
  
  const level = req.body?.level || 'easy';

  try {
    const timestamp = Date.now();
    const randomSeed = Math.floor(Math.random() * 10000);
    const topics = [
      'cumprimentos e apresentações',
      'situações cotidianas e rotina',
      'perguntas sobre sentimentos e estados',
      'conversas sobre comida e bebida',
      'diálogos sobre trabalho e estudos',
      'frases sobre tempo e clima',
      'expressões sobre família e amigos',
      'conversas sobre hobbies e lazer'
    ];
    const randomTopic = topics[Math.floor(Math.random() * topics.length)];

    // Configurações por nível
    const levelConfig = {
      easy: {
        description: 'FÁCIL (iniciante)',
        instructions: 'Frases simples e curtas (5-8 palavras), usando presente simples, vocabulário básico e estruturas gramaticais elementares.',
        maxLength: 60,
        examples: 'Ex: "I like coffee", "She is happy", "We go to school"'
      },
      medium: {
        description: 'MÉDIO (intermediário)',
        instructions: 'Frases de complexidade moderada (8-12 palavras), usando tempos verbais variados, vocabulário intermediário e estruturas mais elaboradas.',
        maxLength: 100,
        examples: 'Ex: "I have been studying English for two years", "She would like to travel next month"'
      },
      hard: {
        description: 'DIFÍCIL (avançado)',
        instructions: 'Frases complexas e longas (12-20 palavras), usando tempos verbais avançados, phrasal verbs, expressões idiomáticas, vocabulário sofisticado e estruturas gramaticais complexas.',
        maxLength: 150,
        examples: 'Ex: "Had I known about the consequences, I would have made a different decision", "Despite having studied thoroughly, she found the exam quite challenging"'
      }
    };

    const config = levelConfig[level] || levelConfig.easy;

    const systemPrompt =
      `Você é um gerador de frases em inglês voltadas para estudantes brasileiros praticarem tradução.\n` +
      `NÍVEL: ${config.description}\n` +
      `INSTRUÇÕES: ${config.instructions}\n` +
      `Exemplos do nível: ${config.examples}\n\n` +
      `Gere uma lista de frases ÚNICAS e VARIADAS, focando principalmente em: ${randomTopic}.\n` +
      `Importante: Use criatividade e evite frases genéricas. Cada frase deve ser diferente e interessante.\n` +
      `Contexto único desta requisição: ${randomSeed}\n` +
      `Retorne SOMENTE JSON válido no formato {"phrases": ["English sentence 1", "English sentence 2", ...]}.\n` +
      `Forneça exatamente ${targetCount} frases diferentes, sem numeração, sem traduções em português e com no máximo ${config.maxLength} caracteres cada.`;

    const { data, aggregatedText } = await callGemini([
      {
        role: 'user',
        parts: [
          {
            text: systemPrompt,
          },
        ],
      },
    ], {
      temperature: 1.2,
      topK: 50,
      topP: 0.98
    });

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
