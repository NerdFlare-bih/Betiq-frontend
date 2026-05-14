require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

// ── ANALYSIS CACHE ──
// Keyed by SHA-256 hash of (image bytes + sport + context).
// Same slip submitted again returns the identical result instantly — no AI call, no credit used.
const analysisCache = new Map();

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ── MIDDLEWARE ──
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5173'
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
      callback(null, true);
    } else {
      callback(null, true); // allow all for now — restrict after testing
    }
  },
  credentials: true
}));
app.use(express.json());

// Serve frontend in production
app.use(express.static(path.join(__dirname, '../frontend/public')));

// ── AUTH MIDDLEWARE ──
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  req.user = user;
  next();
}

// ── CHECK + DEDUCT CREDITS ──
async function checkAndDeductCredit(req, res, next) {
  const userId = req.user.id;

  // Get user record
  let { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();

  // Create profile if first time
  if (!profile) {
    const { data: newProfile } = await supabase
      .from('profiles')
      .insert({ id: userId, plan: 'free', analyses_today: 0, analyses_reset_date: new Date().toISOString().split('T')[0] })
      .select()
      .single();
    profile = newProfile;
  }

  // Reset daily count if new day
  const today = new Date().toISOString().split('T')[0];
  if (profile.analyses_reset_date !== today) {
    await supabase.from('profiles').update({ analyses_today: 0, analyses_reset_date: today }).eq('id', userId);
    profile.analyses_today = 0;
  }

  // Check limits
  const limit = profile.plan === 'pro' ? 10 : profile.plan === 'sharp' ? 9999 : 1;
  if (profile.analyses_today >= limit) {
    return res.status(429).json({
      error: 'Daily limit reached',
      plan: profile.plan,
      limit,
      upgrade_url: `${process.env.FRONTEND_URL}/pricing`
    });
  }

  req.profile = profile;
  next();
}

// ── PASS 1: EXTRACT PLAYER NAMES + BET LINES FROM IMAGE ──
// Uses fast/cheap Haiku so total latency stays low.
async function extractLegsFromContent(content) {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        temperature: 0,
        messages: [{ role: 'user', content: [
          ...content,
          { type: 'text', text: 'List every bet leg on this slip. Return ONLY a raw JSON array, no markdown:\n[{"player":"Full Name","line":"Over 25.5 Points","team":"MIN","sport":"NBA"}]' }
        ]}]
      })
    });
    const data = await res.json();
    const raw = data.content?.[0]?.text?.trim() || '[]';
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start === -1) return [];
    return JSON.parse(raw.slice(start, end + 1));
  } catch { return []; }
}

// ── NBA REAL STATS: BallDontLie API ──
async function fetchNBAStats(playerName) {
  const apiKey = process.env.BALLDONTLIE_API_KEY;
  if (!apiKey) return null;
  try {
    const searchRes = await fetch(
      `https://api.balldontlie.io/v1/players?search=${encodeURIComponent(playerName)}&per_page=5`,
      { headers: { 'Authorization': apiKey } }
    );
    const searchData = await searchRes.json();
    if (!searchData.data?.length) return null;
    const player = searchData.data[0];

    const avgRes = await fetch(
      `https://api.balldontlie.io/v1/season_averages?season=2024&player_ids[]=${player.id}`,
      { headers: { 'Authorization': apiKey } }
    );
    const avgData = await avgRes.json();
    const avg = avgData.data?.[0];
    if (!avg) return null;

    return {
      player: `${player.first_name} ${player.last_name}`,
      team: player.team?.abbreviation || '',
      pts: avg.pts, reb: avg.reb, ast: avg.ast,
      games_played: avg.games_played, min: avg.min,
      fg_pct: avg.fg_pct ? (avg.fg_pct * 100).toFixed(1) + '%' : null,
      fg3_pct: avg.fg3_pct ? (avg.fg3_pct * 100).toFixed(1) + '%' : null,
    };
  } catch { return null; }
}

// ── MLB REAL STATS: Official MLB Stats API (no key required) ──
async function fetchMLBStats(playerName) {
  try {
    const searchRes = await fetch(
      `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(playerName)}&sportId=1`
    );
    const searchData = await searchRes.json();
    const person = searchData.people?.[0];
    if (!person) return null;

    const statsRes = await fetch(
      `https://statsapi.mlb.com/api/v1/people/${person.id}/stats?stats=season&season=2025&group=hitting`
    );
    const statsData = await statsRes.json();
    const s = statsData.stats?.[0]?.splits?.[0]?.stat;
    if (!s) return null;

    return {
      player: person.fullName,
      avg: s.avg, hr: s.homeRuns, rbi: s.rbi,
      hits: s.hits, atBats: s.atBats, ops: s.ops,
      strikeOuts: s.strikeOuts, games_played: s.gamesPlayed
    };
  } catch { return null; }
}

// ── NHL REAL STATS: Official NHL API (no key required) ──
async function fetchNHLStats(playerName) {
  try {
    const searchRes = await fetch(
      `https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=5&q=${encodeURIComponent(playerName)}&active=true`
    );
    const players = await searchRes.json();
    if (!players?.length) return null;
    const p = players[0];

    const statsRes = await fetch(`https://api-web.nhle.com/v1/player/${p.playerId}/landing`);
    const data = await statsRes.json();
    const season = data.seasonTotals?.find(s => s.season === 20242025 && s.leagueAbbrev === 'NHL');
    if (!season) return null;

    return {
      player: `${p.name}`,
      team: p.teamAbbrev,
      goals: season.goals, assists: season.assists,
      points: season.points, games_played: season.gamesPlayed,
      plusMinus: season.plusMinus, shots: season.shots
    };
  } catch { return null; }
}

// ── BUILD STATS CONTEXT STRING FOR CLAUDE PROMPT ──
function buildStatsContext(enrichedLegs) {
  const lines = enrichedLegs.filter(l => l.realStats).map(l => {
    const s = l.realStats;
    const statStr = Object.entries(s)
      .filter(([k]) => !['player','team'].includes(k))
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    return `${s.player}${s.team ? ' (' + s.team + ')' : ''}: ${statStr}`;
  });
  if (!lines.length) return '';
  return `\n\nVERIFIED LIVE ${new Date().getFullYear()} SEASON STATS — use these EXACT numbers in your analysis, do not override or estimate:\n${lines.join('\n')}`;
}

// ── ANALYZE ENDPOINT ──
app.post('/api/analyze', requireAuth, checkAndDeductCredit, upload.single('image'), async (req, res) => {
  try {
    const { sport, context, betText, manualLegs, inputMode } = req.body;
    const imageFile = req.file;

    // ── CACHE CHECK ──
    // Hash the raw input so identical submissions always return the same result.
    const hashInput = [
      imageFile ? imageFile.buffer : Buffer.from(betText || manualLegs || ''),
      sport || '',
      context || ''
    ];
    const cacheKey = crypto.createHash('sha256')
      .update(Buffer.concat(hashInput.map(i => Buffer.isBuffer(i) ? i : Buffer.from(String(i)))))
      .digest('hex');

    // 1. Check in-memory cache (fastest — same server session)
    if (analysisCache.has(cacheKey)) {
      return res.json({ success: true, data: analysisCache.get(cacheKey), cached: true });
    }

    // 2. Check persistent DB cache (survives server restarts — global, not per-user)
    const { data: dbCached } = await supabase
      .from('analyses')
      .select('result')
      .filter('result->>_cache_key', 'eq', cacheKey)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (dbCached?.result) {
      const { _cache_key, ...cleanResult } = dbCached.result;
      analysisCache.set(cacheKey, cleanResult); // warm memory cache too
      return res.json({ success: true, data: cleanResult, cached: true });
    }

    // Build message content for Claude
    const content = [];

    if (inputMode === 'upload' && imageFile) {
      const base64 = imageFile.buffer.toString('base64');
      const mediaType = imageFile.mimetype || 'image/jpeg';
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
      content.push({ type: 'text', text: `Sport: ${sport || 'Unknown'}.\n${context ? 'Context: ' + context : ''}\nRead all bets from this slip image and analyze each one. Return ONLY raw JSON, no markdown.` });
    } else if (inputMode === 'text' && betText) {
      content.push({ type: 'text', text: `Sport: ${sport}\n${context ? 'Context: ' + context + '\n' : ''}Bet slip:\n${betText}\nAnalyze each bet. Return ONLY raw JSON, no markdown.` });
    } else if (inputMode === 'manual' && manualLegs) {
      const legs = JSON.parse(manualLegs);
      content.push({ type: 'text', text: `Sport: ${sport}\n${context ? 'Context: ' + context + '\n' : ''}Manual bet legs:\n${legs.join('\n')}\nAnalyze each bet. Return ONLY raw JSON, no markdown.` });
    } else {
      return res.status(400).json({ error: 'No bet data provided' });
    }

    // ── PASS 1: Extract legs + fetch real stats ──
    // Run extraction + all stat fetches in parallel so latency is minimal.
    const isNBA = /nba|basketball/i.test(sport || '');
    const isMLB = /mlb|baseball/i.test(sport || '');
    const isNHL = /nhl|hockey/i.test(sport || '');

    let statsContext = '';
    try {
      const legs = await extractLegsFromContent(content);
      if (legs.length) {
        const enriched = await Promise.all(legs.map(async leg => {
          let realStats = null;
          if (isNBA || leg.sport === 'NBA') realStats = await fetchNBAStats(leg.player);
          else if (isMLB || leg.sport === 'MLB') realStats = await fetchMLBStats(leg.player);
          else if (isNHL || leg.sport === 'NHL') realStats = await fetchNHLStats(leg.player);
          return { ...leg, realStats };
        }));
        statsContext = buildStatsContext(enriched);
      }
    } catch { /* stats enrichment is best-effort — never block analysis */ }

    // Append verified stats to the last content text block
    if (statsContext) {
      const lastText = content.findLast(c => c.type === 'text');
      if (lastText) lastText.text += statsContext;
    }

    // ── PASS 2: Full analysis with real stats injected ──
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 4000,
        temperature: 0,
        system: getSystemPrompt(),
        messages: [{ role: 'user', content }]
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    // Parse JSON from Claude response
    const raw = data.content.map(i => i.text || '').join('').trim();
    const clean = raw
      .replace(/^```json\s*/m, '').replace(/^```\s*/m, '').replace(/\s*```$/m, '').trim();
    const firstBrace = clean.indexOf('{');
    const lastBrace = clean.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) throw new Error('No JSON found in AI response');
    const jsonStr = clean.slice(firstBrace, lastBrace + 1);
    let result;
    try {
      result = JSON.parse(jsonStr);
    } catch (parseErr) {
      // Attempt to fix common JSON issues (unescaped newlines in strings)
      const fixed = jsonStr
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
        .replace(/([^\\])\\n/g, '$1 ')
        .replace(/([^\\])\\t/g, '$1 ');
      result = JSON.parse(fixed);
    }

    // Store clean result in memory cache
    analysisCache.set(cacheKey, result);

    // Deduct one credit
    await supabase
      .from('profiles')
      .update({ analyses_today: req.profile.analyses_today + 1 })
      .eq('id', req.user.id);

    // Save to history with cache key embedded so DB lookups work after restarts
    await supabase.from('analyses').insert({
      user_id: req.user.id,
      sport,
      result: { ...result, _cache_key: cacheKey },
      created_at: new Date().toISOString()
    });

    res.json({ success: true, data: result });

  } catch (err) {
    console.error('Analysis error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed' });
  }
});

// ── STRIPE: CREATE CHECKOUT SESSION ──
app.post('/api/subscribe', requireAuth, async (req, res) => {
  const { plan } = req.body;

  const prices = {
    pro: process.env.STRIPE_PRO_PRICE_ID,
    sharp: process.env.STRIPE_SHARP_PRICE_ID
  };

  if (!prices[plan]) return res.status(400).json({ error: 'Invalid plan' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: prices[plan], quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}/dashboard?upgraded=true`,
      cancel_url: `${process.env.FRONTEND_URL}/pricing`,
      metadata: { user_id: req.user.id, plan }
    });

    res.json({ url: session.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── STRIPE: WEBHOOK (update plan after payment) ──
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { user_id, plan } = session.metadata;

    await supabase
      .from('profiles')
      .update({ plan, stripe_customer_id: session.customer, stripe_subscription_id: session.subscription })
      .eq('id', user_id);
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    await supabase
      .from('profiles')
      .update({ plan: 'free' })
      .eq('stripe_subscription_id', sub.id);
  }

  res.json({ received: true });
});

// ── GET USER PROFILE + CREDITS ──
app.get('/api/me', requireAuth, async (req, res) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', req.user.id)
    .single();

  const limits = { free: 1, pro: 10, sharp: 9999 };
  const plan = profile?.plan || 'free';
  const used = profile?.analyses_today || 0;
  const limit = limits[plan];

  res.json({
    user: req.user,
    plan,
    analyses_used: used,
    analyses_limit: limit,
    analyses_remaining: Math.max(0, limit - used)
  });
});

// ── GET ANALYSIS HISTORY ──
app.get('/api/history', requireAuth, async (req, res) => {
  const { data } = await supabase
    .from('analyses')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  res.json({ history: data || [] });
});

// ── SAVE BET TO TRACKER ──
app.post('/api/tracker', requireAuth, async (req, res) => {
  const { title, sport, grade, probability, bet_line } = req.body;
  const { data } = await supabase.from('tracker').insert({
    user_id: req.user.id,
    title,
    sport,
    grade,
    probability,
    bet_line,
    outcome: 'pending',
    created_at: new Date().toISOString()
  }).select().single();
  res.json({ saved: data });
});

// ── UPDATE BET OUTCOME ──
app.patch('/api/tracker/:id', requireAuth, async (req, res) => {
  const { outcome } = req.body;
  await supabase.from('tracker').update({ outcome }).eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ updated: true });
});

// ── GET TRACKER ──
app.get('/api/tracker', requireAuth, async (req, res) => {
  const { data } = await supabase.from('tracker').select('*').eq('user_id', req.user.id).order('created_at', { ascending: false });
  res.json({ bets: data || [] });
});

// ── AI SYSTEM PROMPT ──
function getSystemPrompt() {
  return `You are BetIQ Pro, an expert AI sports betting analyst with deep knowledge of current player stats across NBA, NFL, MLB, NHL, Soccer, UFC, and Tennis.

Analyze the given bet slip with expert statistical modeling. Use your knowledge of current/recent player performance, season averages, matchup data, and trends.

CRITICAL: Respond ONLY with a raw JSON object. No markdown. No backticks. No explanation. Just the JSON.

Required schema:
{
  "grade": "A",
  "grade_title": "Strong Parlay",
  "overall_verdict": "2-3 sentence summary of overall bet quality",
  "overall_probability": 58,
  "risk_level": "Medium",
  "ev_summary": "+EV",
  "ev_label": "Brief EV explanation",
  "bets": [
    {
      "player_name": "Full Name",
      "team": "TEAM",
      "bet_line": "Over 24.5 Points (-115)",
      "probability": 72,
      "confidence": "High",
      "ev": "+EV",
      "insight": "2-sentence stat-backed explanation of why this hits or misses",
      "stats": [
        {"label": "Season avg", "value": "27.1 PPG"},
        {"label": "Last 5 games", "value": "29.4 avg"},
        {"label": "Hit rate", "value": "70%"},
        {"label": "vs opponent", "value": "28.4 avg"}
      ],
      "factors": [
        {"type": "pos", "text": "Positive factor with real data"},
        {"type": "neg", "text": "Risk or concern"},
        {"type": "neu", "text": "Neutral context"}
      ]
    }
  ],
  "parlay": {
    "combined_probability": 58,
    "strongest_leg": "Player Name — 72%",
    "weakest_leg": "Player Name — 38%",
    "correlation_warning": null,
    "risk_note": "Brief parlay risk assessment"
  }
}

PROBABILITY METHODOLOGY — follow this exactly every time:
1. Start with the player's hit rate over their last 10 games for this specific stat line (weight: 55%)
2. Blend with season-long hit rate for this line (weight: 25%)
3. Adjust for matchup — opponent's defensive rank vs this stat (weight: 20%)
4. Round every individual probability to the nearest 5% (e.g. 63% → 65%, 71% → 70%)
5. Combined parlay probability = multiply all individual probabilities together, then round to nearest 5%

Grade scale (based on combined_probability):
A = 65%+, B = 50–64%, C = 35–49%, D = 20–34%, F = below 20%

EV rule: if your calculated probability > sportsbook implied probability → +EV, else -EV
Sportsbook implied probability = 100 / (American odds + 100) for positive odds, or |odds| / (|odds| + 100) for negative odds.

CONSISTENCY RULES:
- Always apply the same formula above — do not deviate
- If you are uncertain about a stat, default to league-average hit rate for that line
- Never adjust probabilities based on "feel" — only the formula
- Use specific current-season stats. Be data-driven.`;
}

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BetIQ server running on port ${PORT}`));
