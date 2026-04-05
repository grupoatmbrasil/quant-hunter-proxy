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

app.use(express.static('public'));

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

// ── ANTHROPIC API KEY ──
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_KEY) {
  console.warn('⚠️  ANTHROPIC_API_KEY não definido — endpoint /api/claude desativado');
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
      `&max_results=${Math.min(Math.max(Number(max), 10), 100)}` +
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
// ENDPOINT 4 — Proxy Claude API (evita CORS + esconde chave)
// POST /api/claude
// body: { model, max_tokens, messages }
// ══════════════════════════════════════════════════
app.post('/api/claude', async (req, res) => {
  if (!ANTHROPIC_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY não configurada no servidor.' });
  }

  try {
    const { model, max_tokens, messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'Campo messages obrigatório.' });
    }

    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: model || 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 5000,
        messages
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        timeout: 120000 // 2 min — respostas longas
      }
    );

    res.json(data);

  } catch (err) {
    const status  = err.response?.status || 500;
    const message = err.response?.data?.error?.message || err.message;
    console.error('Claude API error:', status, message);
    res.status(status).json({ error: message, status });
  }
});

// ══════════════════════════════════════════════════
// BINANCE — base URL pública (sem auth)
// ══════════════════════════════════════════════════
const BINANCE = 'https://api.binance.com/api/v3';

// ── ENDPOINT 5 — Ticker 24h de um ou vários símbolos
// GET /api/binance/ticker?symbol=BTCUSDT
// GET /api/binance/ticker  (retorna top movers)
// ══════════════════════════════════════════════════
app.get('/api/binance/ticker', async (req, res) => {
  try {
    const { symbol } = req.query;

    if (symbol) {
      const { data } = await axios.get(`${BINANCE}/ticker/24hr`, {
        params: { symbol: symbol.toUpperCase() }
      });
      return res.json({
        symbol: data.symbol,
        price: parseFloat(data.lastPrice),
        change24h: parseFloat(data.priceChangePercent),
        high24h: parseFloat(data.highPrice),
        low24h: parseFloat(data.lowPrice),
        volume24h: parseFloat(data.volume),
        quoteVolume: parseFloat(data.quoteVolume),
        trades: data.count
      });
    }

    // Sem symbol → top 20 gainers e losers em USDT
    const { data } = await axios.get(`${BINANCE}/ticker/24hr`);
    const usdt = data.filter(t => t.symbol.endsWith('USDT'));
    const sorted = usdt.sort((a, b) => parseFloat(b.priceChangePercent) - parseFloat(a.priceChangePercent));
    const gainers = sorted.slice(0, 10).map(t => ({
      symbol: t.symbol, price: parseFloat(t.lastPrice),
      change24h: parseFloat(t.priceChangePercent), quoteVolume: parseFloat(t.quoteVolume)
    }));
    const losers = sorted.slice(-10).reverse().map(t => ({
      symbol: t.symbol, price: parseFloat(t.lastPrice),
      change24h: parseFloat(t.priceChangePercent), quoteVolume: parseFloat(t.quoteVolume)
    }));
    res.json({ gainers, losers, generatedAt: new Date().toISOString() });

  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.msg || err.message });
  }
});

// ── ENDPOINT 6 — Klines (candles)
// GET /api/binance/klines?symbol=BTCUSDT&interval=1h&limit=100
// intervals: 1m 5m 15m 1h 4h 1d 1w
// ══════════════════════════════════════════════════
app.get('/api/binance/klines', async (req, res) => {
  try {
    const { symbol, interval = '1h', limit = 100 } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

    const { data } = await axios.get(`${BINANCE}/klines`, {
      params: {
        symbol: symbol.toUpperCase(),
        interval,
        limit: Math.min(Number(limit), 1000)
      }
    });

    const candles = data.map(k => ({
      openTime: k[0],
      open:  parseFloat(k[1]),
      high:  parseFloat(k[2]),
      low:   parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
      closeTime: k[6],
      trades: k[8]
    }));

    res.json({ symbol: symbol.toUpperCase(), interval, candles });

  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.msg || err.message });
  }
});

// ── ENDPOINT 7 — Order Book (profundidade)
// GET /api/binance/orderbook?symbol=BTCUSDT&limit=20
// ══════════════════════════════════════════════════
app.get('/api/binance/orderbook', async (req, res) => {
  try {
    const { symbol, limit = 20 } = req.query;
    if (!symbol) return res.status(400).json({ error: 'symbol obrigatório' });

    const { data } = await axios.get(`${BINANCE}/depth`, {
      params: { symbol: symbol.toUpperCase(), limit: Math.min(Number(limit), 100) }
    });

    const parse = arr => arr.map(([price, qty]) => ({
      price: parseFloat(price), qty: parseFloat(qty)
    }));

    const bids = parse(data.bids);
    const asks = parse(data.asks);

    const totalBidVol = bids.reduce((s, b) => s + b.qty, 0);
    const totalAskVol = asks.reduce((s, a) => s + a.qty, 0);
    const pressure = totalBidVol + totalAskVol > 0
      ? Math.round((totalBidVol / (totalBidVol + totalAskVol)) * 100)
      : 50;

    res.json({
      symbol: symbol.toUpperCase(),
      bids, asks,
      bidVolume: totalBidVol,
      askVolume: totalAskVol,
      buyPressure: pressure, // % de compra (>50 = mais compradores)
      lastUpdateId: data.lastUpdateId
    });

  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.msg || err.message });
  }
});

// ── ENDPOINT 8 — Preço spot simples (múltiplos símbolos)
// GET /api/binance/prices?symbols=BTC,ETH,SOL,BNB
// ══════════════════════════════════════════════════
app.get('/api/binance/prices', async (req, res) => {
  try {
    const { symbols } = req.query;

    if (symbols) {
      const syms = symbols.split(',').map(s => `"${s.trim().toUpperCase()}USDT"`);
      const { data } = await axios.get(`${BINANCE}/ticker/price`, {
        params: { symbols: `[${syms.join(',')}]` }
      });
      const result = {};
      data.forEach(t => { result[t.symbol] = parseFloat(t.price); });
      return res.json(result);
    }

    const { data } = await axios.get(`${BINANCE}/ticker/price`);
    const result = {};
    data.filter(t => t.symbol.endsWith('USDT'))
        .forEach(t => { result[t.symbol] = parseFloat(t.price); });
    res.json(result);

  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.msg || err.message });
  }
});

// ══════════════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'QUANT HUNTER Proxy',
    version: '2.2',
    twitter: BEARER ? '✓' : '❌',
    claude: ANTHROPIC_KEY ? '✓' : '❌',
    binance: '✓',
    time: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`✅ QUANT HUNTER Proxy rodando na porta ${PORT}`);
  console.log(`🔑 Bearer Token: ${BEARER ? '✓ carregado' : '❌ FALTANDO'}`);
});
