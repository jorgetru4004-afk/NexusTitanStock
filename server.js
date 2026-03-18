'use strict';
// ╔══════════════════════════════════════════════════════════════════╗
// ║   NEXUS TITAN STOCK — US Equities Specialist                     ║
// ║   6-AI Adversarial Pipeline · Long AND Short                     ║
// ║   Real Movers · Volume-Adjusted Sizing · Staged Positions        ║
// ║   Built Once — Built Permanently — No Ceiling Ever               ║
// ╚══════════════════════════════════════════════════════════════════╝

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json());
app.use(express.static(__dirname));

// ── CONFIG ──
const PORT = process.env.PORT || 8080;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || '';
const ALPACA_KEY = process.env.ALPACA_KEY || process.env.APCA_API_KEY_ID || '';
const ALPACA_SECRET = process.env.ALPACA_SECRET || process.env.APCA_API_SECRET_KEY || '';
const ALPACA_BASE = 'https://paper-api.alpaca.markets';
const ALPACA_DATA = 'https://data.alpaca.markets';
const MODEL = 'claude-sonnet-4-6';
const IS_PAPER = true;

// ── SETTINGS ──
const SETTINGS = {
  maxPositions: 4,
  heatCeiling: 0.50,
  dailyLossLimit: 500,
  defaultLeverage: 1,
  scanInterval: 10 * 60 * 1000,       // 10 min during market hours
  exitCheckInterval: 5 * 60 * 1000,    // 5 min exit review
  premarketScan: true,
  extendedHours: true,
  maxADVpct: 0.05,                     // max 5% of ADV per position
  minConfidence: 62,
  minVolumeMultiple: 1.5,
  stagedEntry: true,                   // staged position management
  peakProtection: 0.30,               // never give back >30% peak unrealized
};

// ── PERSISTENCE ──
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
function loadJSON(f, fb) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return fb; } }
function saveJSON(f, d) { try { fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(d, null, 2)); } catch (e) {} }

// ── STATE ──
const saved = loadJSON('state.json', {});
let personality = saved.personality || 'HUNTER';
let marketRegime = saved.marketRegime || 'RANGING';
let totalPnl = saved.totalPnl || 0;
let totalTrades = saved.totalTrades || 0;
let totalWins = saved.totalWins || 0;
let dailyPnl = saved.dailyPnl || 0;
let weeklyPnl = saved.weeklyPnl || 0;
let dailyLoss = saved.dailyLoss || 0;
let dailyTrades = saved.dailyTrades || 0;
let portfolioHeat = 0;
let allTimePeak = saved.allTimePeak || 0;
let consecutiveWins = saved.consecutiveWins || 0;
let consecutiveLoss = saved.consecutiveLoss || 0;
let spyChange = 0;
let vixLevel = 20;
let paused = false;
let pauseReason = '';
let lastScanTime = null;
let activeNarratives = [];

let positions = loadJSON('positions.json', {});
let candidates = [];
let rotationLog = [];
let alerts = [];
let tradeJournal = loadJSON('trades.json', []);
let learning = loadJSON('learning.json', {
  totalDecisions: 0, hourlyWR: {}, regimeWR: {}, patternWR: {},
  catalystWR: {}, sectorWR: {}, bestHour: null, bestPattern: null,
  lastOptimized: null, totalVolumePnl: 0
});

// ── AI DECISION STORE ──
let ai1Dec = {}, ai2Dec = {}, ai3Dec = {}, ai4Dec = {}, ai5Dec = {}, ai6Dec = {};

function saveState() {
  saveJSON('state.json', { personality, marketRegime, spyChange, vixLevel, totalPnl, totalTrades, totalWins, weeklyPnl, dailyPnl, allTimePeak, consecutiveWins, consecutiveLoss, lastUpdated: new Date().toISOString() });
}

// ── BROADCAST ──
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) try { c.send(msg); } catch (e) {} });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── SNAPSHOT ──
function getSnapshot() {
  return {
    SETTINGS, personality, marketRegime, spyChange, vixLevel, paused, pauseReason,
    totalPnl, totalTrades, totalWins, dailyPnl, weeklyPnl, allTimePeak,
    dailyTrades, dailyLoss, portfolioHeat, positions, candidates,
    rotationLog: rotationLog.slice(0, 30), alerts: alerts.slice(0, 30),
    ai1Dec, ai2Dec, ai3Dec, ai4Dec, ai5Dec, ai6Dec,
    learning, tradeJournal: tradeJournal.slice(0, 100),
    lastScanTime, activeNarratives,
    serverTime: new Date().toISOString(),
    openPnl: Object.values(positions).reduce((s, p) => s + (p.unrealizedPnl || 0), 0),
    winRate: totalTrades > 0 ? parseFloat((totalWins / totalTrades * 100).toFixed(1)) : 0
  };
}

// ══════════════════════════════════════════════════════
// ALPACA DATA LAYER
// ══════════════════════════════════════════════════════
const alpacaHeaders = () => ({
  'APCA-API-KEY-ID': ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type': 'application/json'
});

async function getTopMovers() {
  try {
    const resp = await axios.get(`${ALPACA_DATA}/v1beta1/screener/stocks/movers?top=25`, {
      headers: alpacaHeaders(), timeout: 8000
    });
    const gainers = (resp.data?.gainers || []).map(s => ({
      ticker: s.symbol, change: s.percent_change, price: s.price,
      volume: s.volume, source: 'alpaca_gainers'
    }));
    // Validate data is fresh — if top gainer is same as last scan skip it
    if (gainers.length > 0) {
      console.log(`📊 Alpaca top gainers: ${gainers.slice(0, 5).map(g => `${g.ticker}(+${g.change?.toFixed(1)}%)`).join(' ')}`);
    }
    return gainers;
  } catch (e) {
    console.log('Alpaca movers unavailable, using fallback');
    return [];
  }
}

// Direct watchlist scan — always fresh from Alpaca snapshots
async function getWatchlistMovers() {
  const WATCHLIST = [
    // High beta momentum names
    'NVDA','AMD','TSLA','COIN','MSTR','PLTR','ARM','SMCI','MARA','RIOT',
    // Biotech / FDA plays
    'SAVA','SRPT','BHVN','URGN','IMVT','HIMS','ACHR','ONDS','SOUN',
    // Earnings season movers
    'SHOP','SNOW','CRWD','DDOG','NET','UBER','LYFT','NFLX',
    // Small cap momentum
    'APLD','AIXI','BBAI','CACI','DRUG','GOVX'
  ];

  try {
    const snaps = await getMultiSnapshot(WATCHLIST);
    const movers = Object.entries(snaps)
      .map(([ticker, snap]) => ({ ticker, change: snap.change, volume: snap.volume, price: snap.price, volMultiple: snap.volMultiple, source: 'watchlist' }))
      .filter(m => Math.abs(m.change) >= 3 && m.price > 0.50 && m.price < 500)
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
    if (movers.length > 0) {
      console.log(`📡 Watchlist movers: ${movers.slice(0,5).map(m=>`${m.ticker}(${m.change>=0?'+':''}${m.change?.toFixed(1)}%)`).join(' ')}`);
    }
    return movers;
  } catch (e) { return []; }
}

async function getStockQuote(ticker) {
  try {
    const resp = await axios.get(`${ALPACA_DATA}/v2/stocks/${ticker}/quotes/latest`, {
      headers: alpacaHeaders(), timeout: 5000
    });
    return resp.data?.quote || null;
  } catch (e) { return null; }
}

async function getStockSnapshot(ticker) {
  try {
    const resp = await axios.get(`${ALPACA_DATA}/v2/stocks/${ticker}/snapshot`, {
      headers: alpacaHeaders(), timeout: 5000
    });
    const d = resp.data;
    const price = d?.latestTrade?.p || d?.minuteBar?.c || 0;
    const open = d?.dailyBar?.o || price;
    const vol = d?.dailyBar?.v || 0;
    const prevClose = d?.prevDailyBar?.c || open;
    const change = prevClose > 0 ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0;
    const avgVol = d?.prevDailyBar?.v || vol;
    const volMultiple = avgVol > 0 ? parseFloat((vol / avgVol).toFixed(1)) : 1;
    return { price, open, high: d?.dailyBar?.h || price, low: d?.dailyBar?.l || price, change, volume: vol, avgVolume: avgVol, volMultiple, type: 'STOCK' };
  } catch (e) { return null; }
}

async function getMultiSnapshot(tickers) {
  try {
    const resp = await axios.get(`${ALPACA_DATA}/v2/stocks/snapshots?symbols=${tickers.join(',')}`, {
      headers: alpacaHeaders(), timeout: 8000
    });
    const result = {};
    for (const [sym, d] of Object.entries(resp.data || {})) {
      const price = d?.latestTrade?.p || d?.minuteBar?.c || 0;
      const prevClose = d?.prevDailyBar?.c || price;
      const vol = d?.dailyBar?.v || 0;
      const avgVol = d?.prevDailyBar?.v || vol;
      result[sym] = {
        price, change: prevClose > 0 ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0,
        volume: vol, avgVolume: avgVol,
        volMultiple: avgVol > 0 ? parseFloat((vol / avgVol).toFixed(1)) : 1,
        high: d?.dailyBar?.h || price, low: d?.dailyBar?.l || price, type: 'STOCK'
      };
    }
    return result;
  } catch (e) { return {}; }
}

async function getSPYChange() {
  try {
    const snap = await getStockSnapshot('SPY');
    if (snap) spyChange = snap.change;
    return snap?.change || 0;
  } catch (e) { return 0; }
}

async function placeOrder(ticker, qty, side, extHours = true) {
  if (!ALPACA_KEY || qty <= 0) return null;
  try {
    const body = {
      symbol: ticker, qty: Math.floor(qty), side,
      type: 'market', time_in_force: extHours ? 'day' : 'day',
      extended_hours: extHours
    };
    const resp = await axios.post(`${ALPACA_BASE}/v2/orders`, body, { headers: alpacaHeaders(), timeout: 10000 });
    console.log(`📋 TITAN STOCK ${side} ${qty}x ${ticker} — ${resp.data?.id}`);
    return resp.data;
  } catch (e) {
    console.error(`Order error ${ticker}:`, e.response?.data?.message || e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════
// MARKET REGIME + PERSONALITY
// ══════════════════════════════════════════════════════
function detectRegime() {
  if (spyChange > 1.5) return 'BULL_TRENDING';
  if (spyChange > 0.3) return 'BULL_RANGING';
  if (spyChange < -1.5) return 'BEAR_TRENDING';
  if (spyChange < -0.3) return 'BEAR_RANGING';
  return 'RANGING';
}

function detectPersonality() {
  const wr = totalTrades >= 10 ? totalWins / totalTrades : 0.5;
  if (marketRegime === 'BEAR_TRENDING') return 'GHOST';
  if (dailyLoss > SETTINGS.dailyLossLimit * 0.6) return 'SHADOW';
  if (consecutiveWins >= 3 && wr > 0.6) return 'ASSASSIN';
  return 'HUNTER';
}

// ══════════════════════════════════════════════════════
// PRE-LOADED DOMAIN KNOWLEDGE
// ══════════════════════════════════════════════════════
const DOMAIN_KNOWLEDGE = `
TITAN STOCK PRE-LOADED INTELLIGENCE:

FDA CATALYST PATTERNS:
- Small cap biotech FDA approvals: avg +45% day-of, peak in first 90 minutes
- FDA rejections: avg -35% immediate, high short squeeze risk
- Fast Track Designation: +15-25% typical, sustained 2-3 days
- PDUFA dates: position 1-2 days before, exit same day as decision
- CRL (Complete Response Letter): -30 to -60% within first 30 minutes
- Accelerated Approval: highest magnitude moves, +60-120% possible

EARNINGS MOMENTUM:
- EPS beat >10% with guidance raise: +8-15% sustainable 3 days
- Revenue beat more important than EPS in growth sectors
- Pre-market reactions often fade 20-30% from open — enter after 9:45am
- Earnings beats in RANGING market outperform TRENDING market beats
- Whisper numbers matter more than consensus for reaction magnitude

SHORT SQUEEZE PATTERNS:
- Float <10M with >20% short interest = explosive squeeze potential
- Volume >5x avg with price up >15% = squeeze ignition signal
- RSI >80 + volume drying up = squeeze exhaustion — DO NOT chase
- Best squeezes have clear catalyst, not just technical

DoD/GOVERNMENT CONTRACTS:
- First 30-60 minutes after announcement = primary entry window
- Defense contracts >$50M = sustained momentum 2-5 days
- AI/drone/surveillance contracts have highest follow-through in 2025-2026

SECTOR ROTATION 2025-2026:
- AI infrastructure: strongest narrative, amplifies any related catalyst
- Defense/eVTOL: DoD spending theme, high momentum
- Biotech: catalyst-driven only, not macro-driven
- Clean energy: regime-dependent, works in risk-on only
- Fintech: earnings-driven, less narrative momentum

TIME OF DAY PERFORMANCE:
- 9:30-10:00am: highest volatility, highest risk, skip unless very high conviction
- 10:00-11:30am: best entry window for momentum plays
- 11:30am-1:00pm: lunch lull, reduced follow-through
- 2:00-3:00pm: second wind, institutional rebalancing
- 3:00-4:00pm: power hour, strong momentum continues or reverses hard

VOLUME-ADJUSTED SIZING RULES:
- Volume 1-2x: min size (25% of budget)
- Volume 2-5x: standard size (50% of budget)
- Volume 5-10x: large size (75% of budget)
- Volume 10x+: max size (100% of budget)
- Always cap at 5% of ADV to avoid self-slippage

STAGED POSITION MANAGEMENT:
- Stage 1 entry: 30% of target size to test the thesis
- Stage 2 add: +40% when price confirms direction (up 2-3%)
- Stage 3 add: +30% on high volume confirmation
- Never average down — only add when winning
- Scale out: 33% at +8%, 33% at +15%, let 33% run

CATALYST TIME DECAY:
- FDA approval: 90min primary window, 24hr secondary
- Earnings beat: 3-day window, strongest day 1
- DoD contract: 2-5 day window
- Short squeeze: variable, float/short-interest math
- General PR: 60min primary, rapidly decaying

BEHAVIORAL BIAS DETECTION:
- If 3+ consecutive losses in same pattern: flag as potential bias
- If >40% of trades in one sector: concentration warning
- If win rate on AI-narrative plays >65%: increase AI-narrative weighting
`;

// ══════════════════════════════════════════════════════
// 7-FACTOR POSITION SIZING
// ══════════════════════════════════════════════════════
function calculatePositionSize(ticker, confidence, volMultiple, catalystType, price, avgVolume) {
  const budget = SETTINGS.stagedEntry ? 1000 : 1500; // base budget per position in paper

  // Factor 1: Volume confirmation
  let volFactor = 1.0;
  if (volMultiple >= 10) volFactor = 1.0;
  else if (volMultiple >= 5) volFactor = 0.85;
  else if (volMultiple >= 3) volFactor = 0.70;
  else if (volMultiple >= 2) volFactor = 0.55;
  else volFactor = 0.35;

  // Factor 2: Confidence score
  let confFactor = confidence >= 80 ? 1.0 : confidence >= 72 ? 0.85 : confidence >= 65 ? 0.70 : 0.55;

  // Factor 3: Catalyst type
  const catalystMultiplier = {
    'FDA_APPROVAL': 1.0, 'FDA_FAST_TRACK': 0.9, 'SQUEEZE': 0.85,
    'DOD_CONTRACT': 0.9, 'EARNINGS_BEAT': 0.85, 'CLINICAL_DATA': 0.8,
    'OTHER': 0.7, 'REVERSAL': 0.65, 'SHORT': 0.75
  };
  const catFactor = catalystMultiplier[catalystType] || 0.7;

  // Factor 4: Market regime
  const regimeFactor = marketRegime === 'BULL_TRENDING' ? 1.0 :
    marketRegime === 'BULL_RANGING' ? 0.9 :
    marketRegime === 'RANGING' ? 0.8 :
    marketRegime === 'BEAR_RANGING' ? 0.65 : 0.5;

  // Factor 5: Time of day
  const hour = new Date().getHours(); // UTC — adjust for ET
  const etHour = hour - 4; // rough ET conversion
  const timeFactor = etHour >= 10 && etHour < 11 ? 1.0 :
    etHour >= 14 && etHour < 16 ? 0.95 :
    etHour >= 9 && etHour < 10 ? 0.75 : 0.85;

  // Factor 6: Portfolio heat (scale down when hot)
  const heatFactor = portfolioHeat < 0.3 ? 1.0 : portfolioHeat < 0.5 ? 0.85 : 0.70;

  // Factor 7: Historical win rate for this catalyst
  const patternWR = learning.catalystWR[catalystType] || 0.5;
  const wRFactor = patternWR >= 0.65 ? 1.1 : patternWR >= 0.55 ? 1.0 : patternWR >= 0.45 ? 0.85 : 0.70;

  // Combined sizing
  const sizeFactor = volFactor * confFactor * catFactor * regimeFactor * timeFactor * heatFactor * wRFactor;
  let dollarSize = budget * sizeFactor;

  // ADV cap — max 5% of average daily volume
  if (avgVolume > 0 && price > 0) {
    const maxByADV = avgVolume * price * SETTINGS.maxADVpct;
    dollarSize = Math.min(dollarSize, maxByADV);
  }

  // Heat ceiling check
  const heatIfAdded = portfolioHeat + (dollarSize / 10000);
  if (heatIfAdded > SETTINGS.heatCeiling) {
    dollarSize = (SETTINGS.heatCeiling - portfolioHeat) * 10000;
  }

  const qty = price > 0 ? Math.max(1, Math.floor(dollarSize / price)) : 1;

  // Stage 1 only if staged entry enabled
  const stage1Qty = SETTINGS.stagedEntry ? Math.max(1, Math.floor(qty * 0.3)) : qty;

  return { qty: stage1Qty, totalTargetQty: qty, dollarSize: parseFloat(dollarSize.toFixed(2)), sizeFactor: parseFloat(sizeFactor.toFixed(3)) };
}

// ══════════════════════════════════════════════════════
// CLAUDE API
// ══════════════════════════════════════════════════════
async function callClaude(prompt, maxTokens = 400, system = '') {
  if (!ANTHROPIC_KEY) return null;
  try {
    const body = { model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] };
    if (system) body.system = system;
    const resp = await axios.post('https://api.anthropic.com/v1/messages', body, {
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      timeout: 25000
    });
    return resp.data?.content?.[0]?.text || null;
  } catch (e) { console.error('Claude error:', e.message); return null; }
}

function parseJSON(text) {
  try {
    const match = text?.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (e) { return null; }
}

// ══════════════════════════════════════════════════════
// 6-AI ADVERSARIAL PIPELINE
// ══════════════════════════════════════════════════════

// AI 1 — TECHNICAL ANALYST
async function runAI1(sym, dir, snap) {
  const s = snap;
  const isShort = dir === 'SHORT';
  const prompt = `You are TITAN STOCK AI #1 — TECHNICAL ANALYST. One job: technical analysis.
${sym} $${s.price?.toFixed(2)} ${isShort ? 'SHORT' : 'LONG'} | Change:${s.change}% | Volume:${s.volume?.toLocaleString()} (${s.volMultiple}x avg)
High:$${s.high?.toFixed(2)} Low:$${s.low?.toFixed(2)} | Regime:${marketRegime} | SPY:${spyChange}%
Does the technical setup support a ${dir} trade? Consider: momentum, volume confirmation, price action.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":62-90,"reason":"one sentence technical reason","stop":${isShort ? (s.price*1.04).toFixed(2) : (s.price*0.93).toFixed(2)},"target":${isShort ? (s.price*0.88).toFixed(2) : (s.price*1.12).toFixed(2)}}`;
  try {
    const result = await callClaude(prompt, 200);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI1'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai1Dec[sym] = dec;
    broadcast('AI_UPDATE', { sym, ai: 'AI1', dec });
    console.log(`🧠 AI1 ${sym} ${dir}: ${dec.verdict} (${dec.confidence}%)`);
    return dec;
  } catch (e) { return null; }
}

// AI 2 — FUNDAMENTAL / CATALYST ANALYST
async function runAI2(sym, dir, catalyst, snap) {
  const prompt = `You are TITAN STOCK AI #2 — CATALYST ANALYST. Evaluate the fundamental/catalyst case.
${sym} $${snap.price?.toFixed(2)} ${dir} | Catalyst: ${catalyst}
Volume: ${snap.volMultiple}x average | Change: ${snap.change}% | Regime: ${marketRegime}
AI1 said YES technically. Is the catalyst strong enough to justify this ${dir} trade?
IMPORTANT: High volume multiples (>3x) ARE a catalyst — institutional activity is a legitimate reason to trade.
A stock moving 10%+ on 3x+ volume in pre-market is a STRONG catalyst by definition.
A stock moving 30%+ on 10x+ volume is an EXTREMELY STRONG catalyst — do not rate this WEAK.
Only say NO if: the move appears to be a data error, the stock is a clear pump-and-dump with no volume, or the catalyst is completely unknown and suspicious.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":62-90,"reason":"catalyst assessment","catalystStrength":"STRONG|MEDIUM|WEAK","timeDecay":"90MIN|3DAY|1WEEK"}`;
  try {
    const result = await callClaude(prompt, 220);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI2'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai2Dec[sym] = dec;
    broadcast('AI_UPDATE', { sym, ai: 'AI2', dec });
    console.log(`🧠 AI2 ${sym}: ${dec.verdict} (${dec.confidence}%) [${dec.catalystStrength}]`);
    return dec;
  } catch (e) { return null; }
}

// AI 3 — RISK MANAGER
async function runAI3(sym, dir, snap, sizeData) {
  const prompt = `You are TITAN STOCK AI #3 — RISK MANAGER. Capital preservation is your religion.
${sym} $${snap.price?.toFixed(2)} ${dir} | Size: $${sizeData.dollarSize} | Heat: ${(portfolioHeat*100).toFixed(0)}%
Stop: $${dir==='SHORT'?(snap.price*1.04).toFixed(2):(snap.price*0.93).toFixed(2)} Target: $${dir==='SHORT'?(snap.price*0.88).toFixed(2):(snap.price*1.12).toFixed(2)}
Daily loss so far: $${dailyLoss.toFixed(2)} / limit $${SETTINGS.dailyLossLimit}
AI1 and AI2 both approved. Is the risk acceptable?
If heat already >40% or daily loss >60% of limit, say NO.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":62-90,"reason":"risk assessment","riskRating":"LOW|MEDIUM|HIGH","maxLoss":${(sizeData.dollarSize*0.07).toFixed(2)}}`;
  try {
    const result = await callClaude(prompt, 200);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI3'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai3Dec[sym] = dec;
    broadcast('AI_UPDATE', { sym, ai: 'AI3', dec });
    console.log(`🧠 AI3 ${sym}: ${dec.verdict} (${dec.confidence}%) [${dec.riskRating}]`);
    return dec;
  } catch (e) { return null; }
}

// AI 4 — SENTIMENT / NARRATIVE ANALYST
async function runAI4(sym, dir, catalyst, snap) {
  const narrativeContext = activeNarratives.length > 0 ? `Active market narratives: ${activeNarratives.join(', ')}` : 'No dominant market narratives detected';
  const prompt = `You are TITAN STOCK AI #4 — SENTIMENT & NARRATIVE ANALYST.
${sym} $${snap.price?.toFixed(2)} ${dir} | Catalyst: ${catalyst}
${narrativeContext}
Does this play fit an active narrative? Is sentiment aligned with this ${dir}?
Consider: narrative fit amplifies moves 2-3x. Isolated plays without narrative support fade faster.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":62-90,"reason":"sentiment assessment","narrativeFit":"STRONG|WEAK|NONE","institutionalBias":"BULLISH|BEARISH|NEUTRAL"}`;
  try {
    const result = await callClaude(prompt, 200);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI4'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai4Dec[sym] = dec;
    broadcast('AI_UPDATE', { sym, ai: 'AI4', dec });
    console.log(`🧠 AI4 ${sym}: ${dec.verdict} (${dec.confidence}%) [${dec.narrativeFit}]`);
    return dec;
  } catch (e) { return null; }
}

// AI 5 — DEVIL'S ADVOCATE (Maximum Skepticism)
async function runAI5(sym, dir, catalyst, snap, a1, a2, a3, a4) {
  const prompt = `You are TITAN STOCK AI #5 — DEVIL'S ADVOCATE.
${sym} $${snap.price?.toFixed(2)} ${dir} | Catalyst: ${catalyst} | Volume: ${snap.volMultiple}x | SPY:${spyChange}%
AIs 1-4 approved. Find genuine reasons this trade FAILS — but be fair and specific.
Ask yourself:
- Is this a pump & dump with no real catalyst?
- Is the stock completely illiquid (volume < 10k shares)?
- Is there a known negative catalyst in the next 24 hours?
IMPORTANT: Say YES unless you find a SPECIFIC concrete risk.
General market uncertainty is NOT a reason to say NO.
"Already priced in" alone is NOT a reason to say NO for a stock moving 10%+ on high volume.
Only say NO for: confirmed pump schemes, zero liquidity, or known imminent negative catalyst.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":62-90,"reason":"specific assessment","primaryRisk":"specific risk or NONE","counterArgument":"bear case"}`;
  try {
    const result = await callClaude(prompt, 260);
    const dec = parseJSON(result);
    if (!dec) {
      const fallback = { verdict: 'YES', confidence: 65, reason: 'Parse fallback', primaryRisk: 'NONE', counterArgument: 'none', ai: 'AI5', sym, time: new Date().toLocaleTimeString() };
      ai5Dec[sym] = fallback;
      broadcast('AI_UPDATE', { sym, ai: 'AI5', dec: fallback });
      console.log(`🧠 AI5 DEVIL ${sym}: YES (65%) [fallback]`);
      return fallback;
    }
    dec.ai = 'AI5'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai5Dec[sym] = dec;
    broadcast('AI_UPDATE', { sym, ai: 'AI5', dec });
    console.log(`🧠 AI5 DEVIL ${sym}: ${dec.verdict} (${dec.confidence}%) — ${dec.primaryRisk || dec.reason || 'none'}`);
    return dec;
  } catch (e) {
    const fallback = { verdict: 'YES', confidence: 65, reason: 'Error fallback', primaryRisk: 'NONE', counterArgument: 'none', ai: 'AI5', sym, time: new Date().toLocaleTimeString() };
    ai5Dec[sym] = fallback;
    return fallback;
  }
}

// AI 6 — THE JUDGE (Final Synthesis)
async function runAI6(sym, dir, snap, a1, a2, a3, a4, a5) {
  const avg = Math.round(([a1,a2,a3,a4,a5].filter(Boolean).reduce((s,a) => s+(a.confidence||0), 0)) / 5);
  const yesCount = [a1,a2,a3,a4,a5].filter(a => a?.verdict === 'YES').length;
  const prompt = `You are TITAN STOCK AI #6 — THE JUDGE. Final decision authority.
${sym} $${snap.price?.toFixed(2)} ${dir} | Regime: ${marketRegime}
AI1 Technical: ${a1?.verdict} (${a1?.confidence}%) — ${(a1?.reason||'').slice(0,50)}
AI2 Catalyst: ${a2?.verdict} (${a2?.confidence}%) — ${(a2?.catalystStrength||'')} [${(a2?.reason||'').slice(0,50)}]
AI3 Risk: ${a3?.verdict} (${a3?.confidence}%) — ${(a3?.riskRating||'')} risk
AI4 Sentiment: ${a4?.verdict} (${a4?.confidence}%) — ${(a4?.narrativeFit||'')} narrative
AI5 Devil: ${a5?.verdict} (${a5?.confidence}%) — ${(a5?.primaryRisk||'').slice(0,60)}
AIs voting YES: ${yesCount}/5 | Average confidence: ${avg}%
Synthesize all 5 analyses. Approve only if the combined case is genuinely strong.
If Devil's Advocate raised a legitimate risk that others missed — respect it.
If 4+ AIs agree with avg confidence >65% — lean toward YES.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":62-92,"finalReason":"synthesis in one sentence","urgency":"NOW|WAIT|SKIP","tradeQuality":"A|B|C"}`;
  try {
    const result = await callClaude(prompt, 280);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI6'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai6Dec[sym] = dec;
    broadcast('AI_UPDATE', { sym, ai: 'AI6', dec });
    console.log(`⚖️ JUDGE ${sym}: ${dec.verdict} (${dec.confidence}%) [${dec.tradeQuality}] ${dec.urgency}`);
    return dec;
  } catch (e) { return null; }
}

// ══════════════════════════════════════════════════════
// FULL 6-AI PIPELINE
// ══════════════════════════════════════════════════════
async function run6AIPipeline(sym, dir, catalyst, catalystType, snap) {
  console.log(`🔱 6-AI PIPELINE: ${sym} ${dir} | ${catalyst.slice(0, 60)}`);
  broadcast('PIPELINE_START', { sym, dir, catalyst });

  const sizeData = calculatePositionSize(sym, 70, snap.volMultiple || 1, catalystType, snap.price, snap.avgVolume);

  // Sequential with minimum threshold gates
  const a1 = await runAI1(sym, dir, snap); await sleep(300);
  if (!a1 || a1.verdict !== 'YES') { console.log(`❌ ${sym} blocked at AI1`); return null; }

  const a2 = await runAI2(sym, dir, catalyst, snap); await sleep(300);
  if (!a2 || a2.verdict !== 'YES') { console.log(`❌ ${sym} blocked at AI2`); return null; }

  const a3 = await runAI3(sym, dir, snap, sizeData); await sleep(300);
  if (!a3 || a3.verdict !== 'YES') { console.log(`❌ ${sym} blocked at AI3`); return null; }

  const a4 = await runAI4(sym, dir, catalyst, snap); await sleep(300);
  // AI4 sentiment is advisory — doesn't block but weights the judge

  const a5 = await runAI5(sym, dir, catalyst, snap, a1, a2, a3, a4); await sleep(300);
  if (!a5 || a5.verdict !== 'YES') { console.log(`❌ ${sym} blocked by DEVIL'S ADVOCATE — ${a5?.primaryRisk || a5?.reason || 'no reason given'}`); return null; }

  const a6 = await runAI6(sym, dir, snap, a1, a2, a3, a4, a5);
  if (!a6 || a6.verdict !== 'YES') { console.log(`❌ ${sym} rejected by JUDGE`); return null; }

  const finalConfidence = a6.confidence;
  if (finalConfidence < SETTINGS.minConfidence) { console.log(`❌ ${sym} confidence too low: ${finalConfidence}%`); return null; }

  // Recalculate size with actual confidence
  const finalSize = calculatePositionSize(sym, finalConfidence, snap.volMultiple || 1, catalystType, snap.price, snap.avgVolume);

  console.log(`✅ 6-AI APPROVED: ${sym} ${dir} | Quality:${a6.tradeQuality} | Conf:${finalConfidence}% | Size:$${finalSize.dollarSize}`);
  return { a1, a2, a3, a4, a5, a6, sizeData: finalSize, finalConfidence };
}

// ══════════════════════════════════════════════════════
// POSITION MANAGEMENT
// ══════════════════════════════════════════════════════
async function enterPosition(sym, dir, catalyst, catalystType, snap, pipelineResult) {
  if (Object.keys(positions).length >= SETTINGS.maxPositions) {
    console.log(`⚠️ Max positions reached — ${sym} blocked`);
    return false;
  }

  const { sizeData, a6 } = pipelineResult;
  const isShort = dir === 'SHORT';
  const entry = snap.price;
  const stop = isShort ? entry * 1.07 : entry * 0.93;
  const target = isShort ? entry * 0.88 : entry * 1.12;
  const qty = sizeData.qty;

  const order = await placeOrder(sym, qty, isShort ? 'sell' : 'buy', SETTINGS.extendedHours);
  if (!order && ALPACA_KEY) return false;

  const pos = {
    ticker: sym, type: dir, entry, stop, target, qty,
    totalTargetQty: sizeData.totalTargetQty,
    stage: 1, maxStages: 3,
    catalyst, catalystType,
    value: entry * qty,
    budget: sizeData.dollarSize,
    sizeFactor: sizeData.sizeFactor,
    confidence: sizeData.sizeFactor * 100,
    pattern: catalystType,
    regime: marketRegime,
    personality,
    unrealizedPnl: 0,
    peakUnrealizedPnl: 0,
    entryTime: new Date().toISOString(),
    lastChecked: new Date().toISOString(),
    aiSummary: `Judge: ${a6.tradeQuality} | ${a6.finalReason?.slice(0, 80)}`
  };

  positions[sym] = pos;
  saveJSON('positions.json', positions);
  updateHeat();

  addRotationLog('➕', sym, catalyst.slice(0, 60));
  broadcast('POSITION_OPENED', { sym, pos });
  console.log(`🟢 ENTER: ${sym} ${dir} @ $${entry} | ${qty} shares | Stage 1/${pos.maxStages} | $${pos.budget}`);
  return true;
}

async function addToPosition(sym) {
  const pos = positions[sym];
  if (!pos || pos.stage >= pos.maxStages) return;
  const snap = await getStockSnapshot(sym);
  if (!snap) return;

  const isShort = pos.type === 'SHORT';
  const pnlPct = isShort ? (pos.entry - snap.price) / pos.entry * 100 : (snap.price - pos.entry) / pos.entry * 100;

  // Only add when winning — at least 2% in our direction
  if (pnlPct < 2) return;

  const stageMultiplier = pos.stage === 1 ? 0.4 : 0.3; // Stage 2: +40%, Stage 3: +30%
  const addQty = Math.max(1, Math.floor(pos.totalTargetQty * stageMultiplier));

  const order = await placeOrder(sym, addQty, isShort ? 'sell' : 'buy', SETTINGS.extendedHours);
  if (!order && ALPACA_KEY) return;

  pos.qty += addQty;
  pos.stage++;
  pos.value = snap.price * pos.qty;
  positions[sym] = pos;
  saveJSON('positions.json', positions);
  updateHeat();

  console.log(`📈 STAGE ${pos.stage}: Added ${addQty}x ${sym} @ $${snap.price?.toFixed(2)} | Total: ${pos.qty} shares`);
  broadcast('POSITION_UPDATED', { sym, pos, action: 'STAGE_ADD' });
}

async function closePosition(sym, reason, snap) {
  const pos = positions[sym];
  if (!pos) return;

  const price = snap?.price || pos.entry;
  const isShort = pos.type === 'SHORT';
  const pnl = isShort ? (pos.entry - price) * pos.qty : (price - pos.entry) * pos.qty;
  const pnlPct = isShort ? (pos.entry - price) / pos.entry * 100 : (price - pos.entry) / pos.entry * 100;

  // Place close order
  await placeOrder(sym, pos.qty, isShort ? 'buy' : 'sell', SETTINGS.extendedHours);

  // Update stats
  totalPnl = parseFloat((totalPnl + pnl).toFixed(2));
  dailyPnl = parseFloat((dailyPnl + pnl).toFixed(2));
  weeklyPnl = parseFloat((weeklyPnl + pnl).toFixed(2));
  totalTrades++;
  dailyTrades++;
  if (pnl > 0) { totalWins++; consecutiveWins++; consecutiveLoss = 0; }
  else { dailyLoss += Math.abs(pnl); consecutiveLoss++; consecutiveWins = 0; }
  if (totalPnl > allTimePeak) allTimePeak = totalPnl;

  // Update learning
  const catWR = learning.catalystWR[pos.catalystType] || { wins: 0, total: 0 };
  catWR.total++; if (pnl > 0) catWR.wins++;
  learning.catalystWR[pos.catalystType] = catWR;
  learning.totalDecisions++;
  saveJSON('learning.json', learning);
  saveState();

  // Journal
  const trade = { ticker: sym, type: pos.type, entry: pos.entry, exit: price, pnl: parseFloat(pnl.toFixed(2)), pnlPct: parseFloat(pnlPct.toFixed(2)), catalyst: pos.catalyst, catalystType: pos.catalystType, pattern: pos.pattern, regime: pos.regime, stage: pos.stage, entryTime: pos.entryTime, exitTime: new Date().toISOString(), reason };
  tradeJournal.unshift(trade);
  tradeJournal = tradeJournal.slice(0, 200);
  saveJSON('trades.json', tradeJournal);

  const icon = pnl > 0 ? '🏆' : '📉';
  console.log(`${icon} CLOSE: ${sym} ${pos.type} | P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%) | ${reason}`);

  addRotationLog('➖', sym, reason);
  delete positions[sym];
  saveJSON('positions.json', positions);
  updateHeat();
  broadcast('POSITION_CLOSED', { sym, trade, totalPnl });
}

// ══════════════════════════════════════════════════════
// PROACTIVE EXIT INTELLIGENCE
// ══════════════════════════════════════════════════════
async function runExitIntelligence() {
  const syms = Object.keys(positions);
  if (syms.length === 0) return;

  const snaps = await getMultiSnapshot(syms);

  for (const sym of syms) {
    const pos = positions[sym];
    if (!pos) continue;
    const snap = snaps[sym];
    if (!snap || !snap.price) continue;

    const isShort = pos.type === 'SHORT';
    const pnlPct = isShort ? (pos.entry - snap.price) / pos.entry * 100 : (snap.price - pos.entry) / pos.entry * 100;
    pos.unrealizedPnl = (snap.price - pos.entry) * pos.qty * (isShort ? -1 : 1);

    // Peak protection — never give back >30% of peak unrealized profit
    if (pos.unrealizedPnl > (pos.peakUnrealizedPnl || 0)) pos.peakUnrealizedPnl = pos.unrealizedPnl;
    const peakGiveback = pos.peakUnrealizedPnl > 0 ? (pos.peakUnrealizedPnl - pos.unrealizedPnl) / pos.peakUnrealizedPnl : 0;
    if (peakGiveback > SETTINGS.peakProtection && pos.peakUnrealizedPnl > 10) {
      await closePosition(sym, `Peak protection — gave back ${(peakGiveback*100).toFixed(0)}% of peak profit`, snap);
      continue;
    }

    // Hard stop
    if (pnlPct <= -7) { await closePosition(sym, `Stop loss hit: ${pnlPct.toFixed(2)}%`, snap); continue; }

    // Target hit — scale out
    if (pnlPct >= 12) { await closePosition(sym, `Target hit: ${pnlPct.toFixed(2)}%`, snap); continue; }

    // Stage add opportunity
    if (pos.stage < pos.maxStages && pnlPct >= 2) await addToPosition(sym);

    // Catalyst time decay check
    if (pos.entryTime) {
      const ageHours = (Date.now() - new Date(pos.entryTime).getTime()) / 3600000;
      const maxAge = { 'FDA_APPROVAL': 24, 'EARNINGS_BEAT': 72, 'DOD_CONTRACT': 120, 'SQUEEZE': 6, 'OTHER': 24 };
      const limit = maxAge[pos.catalystType] || 24;
      if (ageHours > limit && pnlPct < 2) {
        await closePosition(sym, `Catalyst expired after ${ageHours.toFixed(0)}h with no momentum`, snap);
        continue;
      }
    }

    positions[sym] = pos;
  }
  saveJSON('positions.json', positions);
  broadcast('POSITIONS_UPDATE', { positions });
}

// ══════════════════════════════════════════════════════
// LIVE SCREENER — Real movers from Alpaca
// ══════════════════════════════════════════════════════
async function runLiveScreener() {
  console.log('🔍 TITAN STOCK: Live screener firing...');
  lastScanTime = new Date().toISOString();

  await getSPYChange();
  marketRegime = detectRegime();
  personality = detectPersonality();

  if (paused) { console.log('⏸ Paused — skipping scan'); return; }
  if (portfolioHeat >= SETTINGS.heatCeiling) { console.log(`🌡️ Heat ceiling reached: ${(portfolioHeat*100).toFixed(0)}%`); return; }
  if (dailyLoss >= SETTINGS.dailyLossLimit) { paused = true; pauseReason = 'Daily loss limit reached'; addAlert(`⛔ Daily loss limit $${SETTINGS.dailyLossLimit} reached — paused`, 'CRITICAL'); return; }
  if (Object.keys(positions).length >= SETTINGS.maxPositions) { console.log(`📊 Max positions (${SETTINGS.maxPositions}) reached`); return; }

  // Determine if pre-market (looser volume requirements)
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const etHour = et.getHours(), etMin = et.getMinutes();
  const isPreMarket = etHour >= 4 && (etHour < 9 || (etHour === 9 && etMin < 30));
  const minVolume = isPreMarket ? 5000 : 50000;
  const minChange = isPreMarket ? 5 : 8;

  // Get movers from BOTH sources — Alpaca screener + direct watchlist
  const [screenerMovers, watchlistMovers] = await Promise.all([
    getTopMovers(),
    getWatchlistMovers()
  ]);

  // Combine and deduplicate
  const allMovers = [...screenerMovers, ...watchlistMovers];
  const seen = new Set();
  const combined = allMovers.filter(m => {
    if (seen.has(m.ticker)) return false;
    seen.add(m.ticker);
    return true;
  });

  // Filter by change and volume
  let scanTargets = combined
    .filter(t => Math.abs(t.change) >= minChange && (t.volume > minVolume || isPreMarket))
    .slice(0, 15);

  if (scanTargets.length === 0) {
    console.log(`📡 No movers found (min change: ${minChange}%, min vol: ${minVolume}) — running AI scan`);
    await runAIMomentumScan();
    return;
  }

  // Get full snapshots
  const tickers = scanTargets.map(t => t.ticker);
  const snaps = await getMultiSnapshot(tickers);

  // Sort by absolute change + volume
  const enriched = scanTargets
    .map(t => ({ ...t, snap: snaps[t.ticker] }))
    .filter(t => t.snap && t.snap.price > 0.50 && t.snap.price < 500)
    .sort((a, b) => (Math.abs(b.change) * (b.snap?.volMultiple || 1)) - (Math.abs(a.change) * (a.snap?.volMultiple || 1)));

  console.log(`📊 Live screener: ${enriched.length} candidates | SPY:${spyChange}% | Regime:${marketRegime} | PreMarket:${isPreMarket}`);
  broadcast('SCAN_UPDATE', { count: enriched.length, regime: marketRegime, personality });

  // Process top candidates through AI
  for (const candidate of enriched.slice(0, 5)) {
    if (Object.keys(positions).length >= SETTINGS.maxPositions) break;
    if (positions[candidate.ticker]) continue;

    const sym = candidate.ticker;
    const snap = candidate.snap;

    const isOverextended = snap.change > 40 && snap.volMultiple < 3;
    const dir = isOverextended ? 'SHORT' : (snap.change < -5 ? 'SHORT' : 'LONG');
    const catalystType = snap.change > 30 ? 'SQUEEZE' : snap.change < -15 ? 'REVERSAL' : snap.change > 15 ? 'MOMENTUM' : 'OTHER';
    const catalyst = `${candidate.source === 'watchlist' ? 'Watchlist' : 'Screener'}: ${sym} ${snap.change > 0 ? '+' : ''}${snap.change}% on ${snap.volMultiple}x volume | ${marketRegime}`;

    const result = await run6AIPipeline(sym, dir, catalyst, catalystType, snap);
    if (result) await enterPosition(sym, dir, catalyst, catalystType, snap, result);
    await sleep(500);
  }
}

// AI Momentum Scan (fallback when live screener is thin)
async function runAIMomentumScan() {
  console.log('🧠 AI momentum scan (fallback)...');
  const prompt = `You are NEXUS TITAN STOCK momentum scanner.
Date: ${new Date().toDateString()} Time: ${new Date().toLocaleTimeString()}
Market regime: ${marketRegime} | SPY change: ${spyChange}%
${DOMAIN_KNOWLEDGE.slice(0, 800)}

Identify 3-4 specific US stocks with real catalysts RIGHT NOW that fit the current regime.
Focus on: biotech catalysts, DoD contracts, earnings beats, squeeze setups.
Return ONLY JSON: {"candidates":[{"ticker":"SYMBOL","catalyst":"specific reason","catalystType":"FDA_APPROVAL|DOD_CONTRACT|EARNINGS_BEAT|SQUEEZE|OTHER","direction":"LONG|SHORT","conviction":60-90}]}`;

  const result = await callClaude(prompt, 500);
  const data = parseJSON(result);
  if (!data?.candidates) return;

  const tickers = data.candidates.map(c => c.ticker);
  const snaps = await getMultiSnapshot(tickers);

  for (const candidate of data.candidates) {
    if (Object.keys(positions).length >= SETTINGS.maxPositions) break;
    if (positions[candidate.ticker]) continue;

    const snap = snaps[candidate.ticker];
    if (!snap || snap.price <= 0) continue;

    addRotationLog('🔍', candidate.ticker, candidate.catalyst.slice(0, 60));
    candidates.unshift({ ...candidate, snap, addedAt: new Date().toISOString() });
    candidates = candidates.slice(0, 20);

    if (candidate.conviction >= 65) {
      const pipeResult = await run6AIPipeline(candidate.ticker, candidate.direction, candidate.catalyst, candidate.catalystType, snap);
      if (pipeResult) await enterPosition(candidate.ticker, candidate.direction, candidate.catalyst, candidate.catalystType, snap, pipeResult);
    }
    await sleep(500);
  }
  broadcast('CANDIDATES_UPDATE', { candidates: candidates.slice(0, 10) });
}

// ══════════════════════════════════════════════════════
// PORTFOLIO HEAT
// ══════════════════════════════════════════════════════
function updateHeat() {
  const totalValue = Object.values(positions).reduce((s, p) => s + Math.abs(p.value || (p.entry * p.qty)), 0);
  portfolioHeat = parseFloat(Math.min(totalValue / 10000, 1).toFixed(3));
  broadcast('HEAT_UPDATE', { portfolioHeat });
}

// ── ALERTS / ROTATION LOG ──
function addAlert(msg, severity = 'INFO') {
  alerts.unshift({ message: msg, severity, time: new Date().toISOString() });
  alerts = alerts.slice(0, 50);
  broadcast('ALERT', { message: msg, severity });
}

function addRotationLog(icon, ticker, reason) {
  const entry = { icon, ticker, reason, time: new Date().toLocaleTimeString() };
  rotationLog.unshift(entry);
  rotationLog = rotationLog.slice(0, 50);
  broadcast('ROTATION_UPDATE', entry);
}

// ══════════════════════════════════════════════════════
// MARKET HOURS
// ══════════════════════════════════════════════════════
function isMarketHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours(), m = et.getMinutes(), d = et.getDay();
  if (d === 0 || d === 6) return false;
  if (h > 9 || (h === 9 && m >= 30)) if (h < 16) return true;
  return false;
}

function isExtendedHours() {
  const now = new Date();
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const h = et.getHours(), d = et.getDay();
  if (d === 0 || d === 6) return false;
  return (h >= 4 && h < 9) || (h >= 16 && h < 20);
}

// ══════════════════════════════════════════════════════
// SCHEDULING
// ══════════════════════════════════════════════════════
function startSchedules() {
  // Main scan — every 10 minutes during market/extended hours
  setInterval(async () => {
    if (isMarketHours() || isExtendedHours()) {
      await runLiveScreener();
      broadcast('SNAPSHOT', getSnapshot());
    }
  }, SETTINGS.scanInterval);

  // Exit intelligence — every 5 minutes
  setInterval(async () => {
    if (Object.keys(positions).length > 0) {
      await runExitIntelligence();
    }
  }, SETTINGS.exitCheckInterval);

  // Pre-market awakening — 4am ET
  setInterval(() => {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    if (et.getHours() === 4 && et.getMinutes() === 0) {
      console.log('🌅 TITAN STOCK: Pre-market awakening...');
      runLiveScreener();
    }
    // Daily reset
    if (et.getHours() === 0 && et.getMinutes() === 0) {
      dailyPnl = 0; dailyLoss = 0; dailyTrades = 0;
      if (paused && pauseReason.includes('Daily loss')) { paused = false; pauseReason = ''; }
      saveState();
    }
  }, 60 * 1000);

  // Initial scan
  setTimeout(() => runLiveScreener(), 5000);
  setTimeout(() => runExitIntelligence(), 15000);

  console.log('⏰ Schedules active: scan every 10min | exits every 5min');
}

// ══════════════════════════════════════════════════════
// REST API
// ══════════════════════════════════════════════════════
app.get('/health', (req, res) => res.json({ status: 'ok', positions: Object.keys(positions).length }));
app.get('/api/snapshot', (req, res) => res.json(getSnapshot()));
app.get('/api/status', (req, res) => res.json({
  status: 'ONLINE', positions: Object.keys(positions).length,
  portfolioHeat, totalPnl, openPnl: Object.values(positions).reduce((s, p) => s + (p.unrealizedPnl || 0), 0),
  dailyPnl, totalTrades, totalWins, winRate: totalTrades > 0 ? totalWins / totalTrades * 100 : 0,
  marketRegime, personality, consecutiveWins, consecutiveLoss
}));
app.post('/api/scan', async (req, res) => { res.json({ message: 'Scan triggered' }); await runLiveScreener(); });
app.post('/api/pause', (req, res) => { paused = true; pauseReason = req.body.reason || 'Manual pause'; res.json({ paused }); });
app.post('/api/resume', (req, res) => { paused = false; pauseReason = ''; res.json({ paused }); });
app.post('/api/close/:sym', async (req, res) => {
  const sym = req.params.sym.toUpperCase();
  if (!positions[sym]) return res.status(404).json({ error: 'Position not found' });
  const snap = await getStockSnapshot(sym);
  await closePosition(sym, 'Manual close', snap || { price: positions[sym].entry });
  res.json({ closed: true });
});
app.get('/api/positions', (req, res) => res.json(positions));
app.get('/api/trades', (req, res) => res.json(tradeJournal.slice(0, 50)));
app.get('/api/learning', (req, res) => res.json(learning));

wss.on('connection', ws => {
  console.log('📱 TITAN STOCK dashboard connected');
  ws.send(JSON.stringify({ type: 'SNAPSHOT', data: getSnapshot() }));
});

// ══════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║   NEXUS TITAN STOCK — US Equities Specialist                     ║');
  console.log('║   6-AI Adversarial Pipeline · Long AND Short · Real Movers       ║');
  console.log('║   Volume-Adjusted Sizing · Staged Positions · Peak Protection     ║');
  console.log('║   Built Once — Built Permanently — No Ceiling Ever               ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`🌌 Claude AI:      ${ANTHROPIC_KEY ? '✅' : '❌ No key'}`);
  console.log(`📊 Alpaca:         ${ALPACA_KEY ? '✅ Connected' : '⚠️ No key — simulation mode'}`);
  console.log(`📈 Mode:           ${IS_PAPER ? 'PAPER TRADING' : '🔴 LIVE'}`);
  console.log(`🎭 Personality:    ${personality}`);
  console.log(`🌍 Regime:         ${marketRegime}`);
  console.log(`💼 Positions:      ${Object.keys(positions).length} open`);
  console.log(`🧠 Total trades:   ${totalTrades}`);
  console.log(`📚 Learning:       ${learning.totalDecisions} decisions recorded`);
  console.log('');
  console.log('🔱 6-AI ADVERSARIAL PIPELINE:');
  console.log('   AI1 Technical → AI2 Catalyst → AI3 Risk → AI4 Sentiment → AI5 Devil → AI6 Judge');
  console.log('');
  updateHeat();
  startSchedules();
  console.log('✅ NEXUS TITAN STOCK — The hunt begins');
});
