// Binance Signal Engine V5
// Cloudflare Worker
// Closed-candle + Multi-Timeframe Confirmation

const API = "https://api-gcp.binance.com";

const PAIRS = [
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "XRPUSDT",
  "ADAUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "TRXUSDT"
];

const CORS = {
  "content-type": "application/json; charset=UTF-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
  "cache-control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: CORS
  });
}

async function getJSON(path) {
  const r = await fetch(API + path, {
    headers: { Accept: "application/json" }
  });

  if (!r.ok) {
    throw new Error(`Binance HTTP ${r.status}`);
  }

  return r.json();
}

function avg(a) {
  return a.length
    ? a.reduce((x, y) => x + y, 0) / a.length
    : 0;
}

function ema(v, p) {
  if (!v || v.length < p) return null;

  let e = avg(v.slice(0, p));
  const k = 2 / (p + 1);

  for (let i = p; i < v.length; i++) {
    e = v[i] * k + e * (1 - k);
  }

  return e;
}

function emaSeries(v, p) {
  if (!v || v.length < p) return [];

  let e = avg(v.slice(0, p));
  const k = 2 / (p + 1);
  const out = [e];

  for (let i = p; i < v.length; i++) {
    e = v[i] * k + e * (1 - k);
    out.push(e);
  }

  return out;
}

function rsi(v, p = 14) {
  if (!v || v.length <= p) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= p; i++) {
    const d = v[i] - v[i - 1];

    if (d >= 0) gain += d;
    else loss += Math.abs(d);
  }

  let ag = gain / p;
  let al = loss / p;

  for (let i = p + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];

    const g = d > 0 ? d : 0;
    const l = d < 0 ? Math.abs(d) : 0;

    ag = ((ag * (p - 1)) + g) / p;
    al = ((al * (p - 1)) + l) / p;
  }

  if (al === 0) return 100;

  return 100 - (100 / (1 + ag / al));
}

function macd(v) {
  const fast = emaSeries(v, 12);
  const slow = emaSeries(v, 26);

  if (!fast.length || !slow.length) return null;

  const offset = fast.length - slow.length;

  const line = slow.map(
    (x, i) => fast[i + offset] - x
  );

  if (line.length < 9) return null;

  const signal = ema(line, 9);
  const current = line.at(-1);

  return {
    line: current,
    signal,
    histogram: current - signal
  };
}

function atr(rows, p = 14) {
  if (!rows || rows.length < p + 1) return null;

  const tr = [];

  for (let i = 1; i < rows.length; i++) {
    const high = +rows[i][2];
    const low = +rows[i][3];
    const prevClose = +rows[i - 1][4];

    tr.push(
      Math.max(
        high - low,
        Math.abs(high - prevClose),
        Math.abs(low - prevClose)
      )
    );
  }

  return ema(tr, p);
}

function volumeRatio(rows) {
  if (!rows || rows.length < 21) return null;

  const volumes = rows.map(r => +r[5]);

  const current = volumes.at(-1);
  const previous = volumes.slice(-21, -1);

  const average = avg(previous);

  return average > 0
    ? current / average
    : 0;
}

function marketStructure(rows) {
  if (!rows || rows.length < 12) return "RANGE";

  const recent = rows.slice(-12);

  const a = recent.slice(0, 6);
  const b = recent.slice(6);

  const ah = Math.max(...a.map(x => +x[2]));
  const al = Math.min(...a.map(x => +x[3]));

  const bh = Math.max(...b.map(x => +x[2]));
  const bl = Math.min(...b.map(x => +x[3]));

  if (bh > ah && bl > al) return "BULLISH";
  if (bh < ah && bl < al) return "BEARISH";

  return "RANGE";
}

function supportResistance(rows) {
  const x = rows.slice(-50);

  return {
    support: Math.min(...x.map(r => +r[3])),
    resistance: Math.max(...x.map(r => +r[2]))
  };
}

function round(n, d = 8) {
  if (n == null || !Number.isFinite(n)) return null;
  return Number(n.toFixed(d));
}

async function analyze(symbol) {
  symbol = String(symbol || "").toUpperCase().trim();

  if (!PAIRS.includes(symbol)) {
    return {
      ok: false,
      error: "Unsupported symbol",
      supported: PAIRS
    };
  }

  /*
    Only two Binance requests per pair.

    /scan:
    10 pairs × 2 = 20 requests
  */

  const [raw1m, raw5m] = await Promise.all([
    getJSON(
      `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=210`
    ),

    getJSON(
      `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=120`
    )
  ]);

  if (
    !Array.isArray(raw1m) ||
    !Array.isArray(raw5m) ||
    raw1m.length < 201 ||
    raw5m.length < 60
  ) {
    throw new Error("Not enough candle data");
  }

  /*
    IMPORTANT:
    Binance returns the currently-forming candle as the
    final element.

    Remove it before calculating indicators.
  */

  const c1 = raw1m.slice(0, -1);
  const c5 = raw5m.slice(0, -1);

  const close1 = c1.map(x => +x[4]);
  const close5 = c5.map(x => +x[4]);

  const price = close1.at(-1);

  // 1 MINUTE

  const e9 = ema(close1, 9);
  const e21 = ema(close1, 21);
  const e50 = ema(close1, 50);
  const e200 = ema(close1, 200);

  const R = rsi(close1, 14);
  const M = macd(close1);
  const A = atr(c1, 14);
  const VR = volumeRatio(c1);

  const structure = marketStructure(c1);
  const sr = supportResistance(c1);

  // 5 MINUTE

  const e9_5 = ema(close5, 9);
  const e21_5 = ema(close5, 21);
  const e50_5 = ema(close5, 50);

  const rsi5 = rsi(close5, 14);
  const macd5 = macd(close5);

  const trend5 =
    e9_5 > e21_5 && e21_5 > e50_5
      ? "BULLISH"
      : e9_5 < e21_5 && e21_5 < e50_5
      ? "BEARISH"
      : "MIXED";

  let bull = 0;
  let bear = 0;

  const bullish = [];
  const bearish = [];

  function score(bullCondition, bearCondition, points, bText, sText) {
    if (bullCondition) {
      bull += points;
      bullish.push(bText);
    } else if (bearCondition) {
      bear += points;
      bearish.push(sText);
    }
  }

  // 1m EMA short trend — 10
  score(
    e9 > e21,
    e9 < e21,
    10,
    "1m EMA9 > EMA21",
    "1m EMA9 < EMA21"
  );

  // Main EMA trend — 12
  score(
    e50 > e200,
    e50 < e200,
    12,
    "EMA50 > EMA200",
    "EMA50 < EMA200"
  );

  // Price location — 8
  score(
    price > e21 && price > e50,
    price < e21 && price < e50,
    8,
    "Price above EMA21/50",
    "Price below EMA21/50"
  );

  // RSI 1m — 10
  score(
    R >= 52 && R <= 68,
    R <= 48 && R >= 32,
    10,
    "1m RSI bullish",
    "1m RSI bearish"
  );

  // MACD 1m — 10
  if (M) {
    score(
      M.histogram > 0 && M.line > M.signal,
      M.histogram < 0 && M.line < M.signal,
      10,
      "1m MACD bullish",
      "1m MACD bearish"
    );
  }

  // Structure — 10
  score(
    structure === "BULLISH",
    structure === "BEARISH",
    10,
    "Bullish market structure",
    "Bearish market structure"
  );

  // 5m trend — 18
  score(
    trend5 === "BULLISH",
    trend5 === "BEARISH",
    18,
    "5m trend bullish",
    "5m trend bearish"
  );

  // 5m RSI — 8
  score(
    rsi5 >= 52 && rsi5 <= 70,
    rsi5 <= 48 && rsi5 >= 30,
    8,
    "5m RSI bullish",
    "5m RSI bearish"
  );

  // 5m MACD — 8
  if (macd5) {
    score(
      macd5.histogram > 0,
      macd5.histogram < 0,
      8,
      "5m MACD bullish",
      "5m MACD bearish"
    );
  }

  /*
    Volume is confirmation only.
    A low-volume candle must NOT create a directional score.
  */

  if (VR >= 1.1) {
    if (bull > bear) {
      bull += 6;
      bullish.push("Closed-candle volume confirms bullish move");
    } else if (bear > bull) {
      bear += 6;
      bearish.push("Closed-candle volume confirms bearish move");
    }
  }

  bull = Math.min(100, bull);
  bear = Math.min(100, bear);

  const difference = Math.abs(bull - bear);

  /*
    Strong filtering:
    - Score >= 68
    - Difference >= 24
    - 5m cannot oppose the trade
    - RSI cannot be extremely stretched
  */

  const buyAllowed =
    bull >= 68 &&
    bull > bear &&
    difference >= 24 &&
    trend5 !== "BEARISH" &&
    R < 72;

  const sellAllowed =
    bear >= 68 &&
    bear > bull &&
    difference >= 24 &&
    trend5 !== "BULLISH" &&
    R > 28;

  let signal = "WAIT";

  if (buyAllowed) signal = "BUY";
  if (sellAllowed) signal = "SELL";

  /*
    Signal Strength is NOT win probability.
  */

  const signalStrength =
    signal === "BUY"
      ? bull
      : signal === "SELL"
      ? bear
      : Math.min(67, Math.max(bull, bear));

  /*
    ATR-based reference levels.
    These are analysis levels, not guaranteed outcomes.
  */

  let entry = null;
  let tp = null;
  let sl = null;

  if (signal !== "WAIT" && A) {
    entry = price;

    if (signal === "BUY") {
      tp = price + (A * 1.5);
      sl = price - A;
    } else {
      tp = price - (A * 1.5);
      sl = price + A;
    }
  }

  return {
    ok: true,

    engine: "Binance Signal Engine V5",

    symbol,

    signal,

    signalStrength,

    strengthMeaning:
      "Indicator confirmation strength, not win probability",

    timeframe: {
      entry: "1m",
      confirmation: "5m"
    },

    price: round(price),

    trade: {
      entry: round(entry),
      tp: round(tp),
      sl: round(sl)
    },

    scores: {
      bullish: bull,
      bearish: bear,
      difference
    },

    trend: {
      oneMinute:
        e9 > e21 ? "UP" : e9 < e21 ? "DOWN" : "FLAT",

      fiveMinute: trend5,

      main:
        e50 > e200 ? "UP" : e50 < e200 ? "DOWN" : "FLAT",

      marketStructure: structure
    },

    indicators: {
      rsi1m: round(R, 2),
      rsi5m: round(rsi5, 2),

      ema9: round(e9),
      ema21: round(e21),
      ema50: round(e50),
      ema200: round(e200),

      macd1mHistogram:
        M ? round(M.histogram) : null,

      macd5mHistogram:
        macd5 ? round(macd5.histogram) : null,

      atr14: round(A),

      closedCandleVolumeRatio:
        round(VR, 2),

      support: round(sr.support),
      resistance: round(sr.resistance)
    },

    confirmations: {
      bullish,
      bearish
    },

    candle: {
      dataType: "CLOSED_CANDLES_ONLY",

      lastClosed1m:
        new Date(c1.at(-1)[6]).toISOString(),

      lastClosed5m:
        new Date(c5.at(-1)[6]).toISOString()
    },

    generatedAt:
      new Date().toISOString(),

    warning:
      "Market-analysis signal only. Signal strength is not prediction accuracy."
  };
}

async function scan() {
  const results = await Promise.all(
    PAIRS.map(async symbol => {
      try {
        return await analyze(symbol);
      } catch (e) {
        return {
          ok: false,
          symbol,
          signal: "ERROR",
          error: e.message
        };
      }
    })
  );

  const signals = results
    .filter(x => x.signal === "BUY" || x.signal === "SELL")
    .sort((a, b) => b.signalStrength - a.signalStrength);

  return {
    ok: true,
    engine: "Binance Signal Engine V5",
    pairsChecked: PAIRS.length,
    signalsFound: signals.length,
    signals,
    allResults: results,
    generatedAt: new Date().toISOString()
  };
}

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS
      });
    }

    try {
      const url = new URL(request.url);

      const path =
        url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/") {
        return json({
          ok: true,
          engine: "Binance Signal Engine V5",
          endpoints: [
            "/health",
            "/pairs",
            "/signal?symbol=BTCUSDT",
            "/scan"
          ]
        });
      }

      if (path === "/health") {
        const time = await getJSON("/api/v3/time");

        return json({
          ok: true,
          engine: "Binance Signal Engine V5",
          binance: "CONNECTED",
          serverTime: time.serverTime,
          source: API
        });
      }

      if (path === "/pairs") {
        return json({
          ok: true,
          count: PAIRS.length,
          pairs: PAIRS
        });
      }

      if (path === "/signal") {
        const symbol =
          url.searchParams.get("symbol") || "BTCUSDT";

        const result = await analyze(symbol);

        return json(
          result,
          result.ok ? 200 : 400
        );
      }

      if (path === "/scan") {
        return json(await scan());
      }

      return json({
        ok: false,
        error: "Not found",
        path
      }, 404);

    } catch (e) {
      return json({
        ok: false,
        error: e?.message || String(e)
      }, 500);
    }
  }
};
