// ═══════════════════════════════════════════════════════
// QUANT HUNTER — Twitter/X API Proxy
// Deploy: VPS Hostinger
// Porta: 3001
// ═══════════════════════════════════════════════════════

const express    = require('express');
const axios      = require('axios');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3001;

// ── CORS — libera apenas seu domínio ──
app.use(cors({
  origin: [
    'http://localhost:3000',
    'https://SEU_DOMINIO.com', // ← troca aqui
    '*' // remova em produção
  ]
}));

app.use(express.json());

// ── RATE LIMIT — proteção contra abuso ──
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 100,
  message: { error: 'Muitas requisições. Tente em 15 minutos.' }
});
app.use(limiter);

// ── BEARER TOKEN — vem do .env, nunca exposto ──
const BEARER = process.env.TWITTER_BEARER_TOKEN;
if (!BEARER) {
  console.error('❌ TWITTER_BEARER_TOKEN não definido no .env');
  process.exit(1);
}

const twitterHeaders = {
  'Authorization': `Bearer ${BEARER}`,
  'Content-Type': 'application/json'
};

// ══════════════════════════════════════════════════
// ENDPOINT 1 — Busca tweets sobre um ativo
// GET /api/twitter/search?query=bitcoin&max=20
// ══════════════════════════════════════════════════
app.get('/api/twitter/search', async (req, res) => {
  try {
    const { query, max = 15 } = req.query;
    if (!query) return res.status(400).json({ error: 'query obrigatório' });

    const searchQuery = encodeURIComponent(
      `(${query} OR $${query.toUpperCase()}) (lang:pt OR lang:en) -is:retweet`
    );

    const url = `https://api.twitter.com/2/tweets/search/recent` +
      `?query=${searchQuery}` +
      `&max_results=${Math.min(max, 100)}` +
      `&tweet.fields=created_at,public_metrics,author_id,text` +
      `&expansions=author_id` +
      `&user.fields=name,username,verified,public_metrics`;

    const { data } = await axios.get(url, { headers: twitterHeaders });

    // Processa e pontua sentimento básico
    const bullishWords = ['pump','moon','buy','bullish','alta','subindo','rompeu','breakout','acumula','strong'];
    const bearishWords = ['dump','crash','sell','bearish','baixa','caindo','cuidado','short','fuga','weak'];

    const tweets = (data.data || []).map(t => {
      const text = t.text.toLowerCase();
      const bull = bullishWords.filter(w => text.includes(w)).length;
      const bear = bearishWords.filter(w => text.includes(w)).length;
      const sentiment = bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral';
      const user = data.includes?.users?.find(u => u.id === t.author_id);
      return {
        id: t.id,
        text: t.text,
        sentiment,
        score: bull - bear,
        likes: t.public_metrics?.like_count || 0,
        retweets: t.public_metrics?.retweet_count || 0,
        author: user?.username || 'unknown',
        verified: user?.verified || false,
        followers: user?.public_metrics?.followers_count || 0,
        created_at: t.created_at
      };
    });

    // Agrega sentimento geral
    const totalBull = tweets.filter(t => t.sentiment === 'bullish').length;
    const totalBear = tweets.filter(t => t.sentiment === 'bearish').length;
    const overallSentiment = totalBull > totalBear ? 'bullish' : totalBear > totalBull ? 'bearish' : 'neutral';
    const sentimentScore = tweets.length ? Math.round(((totalBull - totalBear) / tweets.length) * 100) : 0;

    res.json({
      query,
      total: tweets.length,
      overallSentiment,
      sentimentScore, // -100 a +100
      bullishCount: totalBull,
      bearishCount: totalBear,
      tweets: tweets.sort((a, b) => (b.likes + b.retweets) - (a.likes + a.retweets))
    });

  } catch (err) {
    const status = err.response?.status || 500;
    console.error('Twitter search error:', err.response?.data || err.message);
    res.status(status).json({
      error: err.response?.data?.detail || err.message,
      status
    });
  }
});

// ══════════════════════════════════════════════════
// ENDPOINT 2 — Trending topics cripto
// GET /api/twitter/trending
// ══════════════════════════════════════════════════
app.get('/api/twitter/trending', async (req, res) => {
  try {
    const cryptoTerms = ['bitcoin','ethereum','crypto','altcoin','binance','defi','web3','blockchain'];
    const query = encodeURIComponent(
      `(${cryptoTerms.join(' OR ')}) lang:en -is:retweet`
    );

    const url = `https://api.twitter.com/2/tweets/search/recent` +
      `?query=${query}` +
      `&max_results=50` +
      `&tweet.fields=created_at,public_metrics,text`;

    const { data } = await axios.get(url, { headers: twitterHeaders });

    // Extrai moedas mencionadas (cashtags)
    const coinMentions = {};
    (data.data || []).forEach(t => {
      const cashtags = t.text.match(/\$[A-Z]{2,8}/g) || [];
      cashtags.forEach(tag => {
        const sym = tag.replace('$', '').toUpperCase();
        if (!coinMentions[sym]) coinMentions[sym] = { count: 0, engagement: 0 };
        coinMentions[sym].count++;
        coinMentions[sym].engagement += (t.public_metrics?.like_count || 0) + (t.public_metrics?.retweet_count || 0);
      });
    });

    const trending = Object.entries(coinMentions)
      .map(([sym, d]) => ({ symbol: sym, mentions: d.count, engagement: d.engagement }))
      .sort((a, b) => b.engagement - a.engagement)
      .slice(0, 15);

    res.json({
      trending,
      totalTweets: data.data?.length || 0,
      generatedAt: new Date().toISOString()
    });

  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════
// ENDPOINT 3 — Sentimento múltiplos ativos de uma vez
// POST /api/twitter/batch
// body: { symbols: ["BTC","ETH","SOL"] }
// ══════════════════════════════════════════════════
app.post('/api/twitter/batch', async (req, res) => {
  try {
    const { symbols = [] } = req.body;
    if (!symbols.length) return res.status(400).json({ error: 'symbols obrigatório' });

    const results = {};

    // Processa até 3 símbolos em paralelo (respeita rate limit)
    const batches = [];
    for (let i = 0; i < Math.min(symbols.length, 6); i += 3) {
      batches.push(symbols.slice(i, i + 3));
    }

    for (const batch of batches) {
      await Promise.all(batch.map(async sym => {
        try {
          const query = encodeURIComponent(`($${sym} OR #${sym}) lang:en -is:retweet`);
          const url = `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=20&tweet.fields=public_metrics,text`;
          const { data } = await axios.get(url, { headers: twitterHeaders });

          const bullishWords = ['pump','moon','buy','bullish','breakout','strong','accumulate','long'];
          const bearishWords = ['dump','crash','sell','bearish','short','weak','rug','scam'];

          let bull = 0, bear = 0, totalEng = 0;
          (data.data || []).forEach(t => {
            const text = t.text.toLowerCase();
            bull += bullishWords.filter(w => text.includes(w)).length;
            bear += bearishWords.filter(w => text.includes(w)).length;
            totalEng += (t.public_metrics?.like_count || 0) + (t.public_metrics?.retweet_count || 0);
          });

          const total = (data.data || []).length;
          results[sym] = {
            symbol: sym,
            tweetCount: total,
            bullishSignals: bull,
            bearishSignals: bear,
            sentiment: bull > bear ? 'bullish' : bear > bull ? 'bearish' : 'neutral',
            sentimentScore: total ? Math.round(((bull - bear) / (bull + bear + 1)) * 100) : 0,
            totalEngagement: totalEng,
            avgEngagement: total ? Math.round(totalEng / total) : 0
          };
        } catch(e) {
          results[sym] = { symbol: sym, error: e.message };
        }
      }));
      // Pausa entre batches para não estourar rate limit
      await new Promise(r => setTimeout(r, 500));
    }

    res.json({ results, generatedAt: new Date().toISOString() });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'QUANT HUNTER Twitter Proxy',
    version: '2.0',
    time: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`✅ QUANT HUNTER Proxy rodando na porta ${PORT}`);
  console.log(`🔑 Bearer Token: ${BEARER ? '✓ carregado' : '❌ FALTANDO'}`);
});
