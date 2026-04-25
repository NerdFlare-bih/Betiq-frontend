require('dotenv').config();
const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const path = require('path');

const app = express();
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } }); // 10MB limit

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
  const limit = profile.plan === 'pro' ? 999 : profile.plan === 'sharp' ? 9999 : 3;
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

// ── ANALYZE ENDPOINT ──
app.post('/api/analyze', requireAuth, checkAndDeductCredit, upload.single('image'), async (req, res) => {
  try {
    const { sport, context, betText, manualLegs, inputMode } = req.body;
    const imageFile = req.file;

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

    // Call Anthropic API
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

    // Deduct one credit
    await supabase
      .from('profiles')
      .update({ analyses_today: req.profile.analyses_today + 1 })
      .eq('id', req.user.id);

    // Save analysis to history
    await supabase.from('analyses').insert({
      user_id: req.user.id,
      sport,
      result,
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

  const limits = { free: 3, pro: 999, sharp: 9999 };
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

Grade scale: A=65%+, B=50-64%, C=35-49%, D=20-34%, F=below 20%.
For single bets, combined_probability equals that bet's probability.
EV: if model probability > sportsbook implied probability → +EV, else -EV.
Use specific, real current-season stats. Be data-driven and trust-building.`;
}

// Catch-all: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BetIQ server running on port ${PORT}`));
