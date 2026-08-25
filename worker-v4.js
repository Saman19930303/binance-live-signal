// Binance Signal Engine V4
// Cloudflare Worker
// Educational market-analysis engine — not a guaranteed predictor.

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
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: CORS
    }
  );
}

async function getJSON(path) {
  const response = await fetch(API + path, {
    method: "GET",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    const body = await response
      .text()
      .catch(() => "");

    throw new Error(
      `Binance HTTP ${response.status} ${path}` +
      (body ? ` - ${body.slice(0, 120)}` : "")
    );
  }

  return response.json();
}


// -------------------------
// EMA
// -------------------------

function ema(values, period) {

  if (!values || values.length < period) {
    return null;
  }

  let value =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  const multiplier = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    value =
      values[i] * multiplier +
      value * (1 - multiplier);
  }

  return value;
}


// -------------------------
// EMA SERIES
// -------------------------

function emaSeries(values, period) {

  if (!values || values.length < period) {
    return [];
  }

  let value =
    values
      .slice(0, period)
      .reduce((a, b) => a + b, 0) / period;

  const multiplier = 2 / (period + 1);

  const output = [value];

  for (let i = period; i < values.length; i++) {

    value =
      values[i] * multiplier +
      value * (1 - multiplier);

    output.push(value);
  }

  return output;
}


// -------------------------
// RSI
// -------------------------

function rsi(values, period = 14) {

  if (!values || values.length <= period) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {

    const diff =
      values[i] - values[i - 1];

    if (diff >= 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {

    const diff =
      values[i] - values[i - 1];

    const gain =
      diff > 0 ? diff : 0;

    const loss =
      diff < 0 ? Math.abs(diff) : 0;

    avgGain =
      ((avgGain * (period - 1)) + gain) /
      period;

    avgLoss =
      ((avgLoss * (period - 1)) + loss) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs =
    avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}


// -------------------------
// MACD
// -------------------------

function macd(values) {

  if (!values || values.length < 35) {
    return null;
  }

  const fast =
    emaSeries(values, 12);

  const slow =
    emaSeries(values, 26);

  if (!fast.length || !slow.length) {
    return null;
  }

  const offset = 26 - 12;

  const macdLine = [];

  for (let i = 0; i < slow.length; i++) {

    const fastIndex =
      i + offset;

    if (fastIndex < fast.length) {

      macdLine.push(
        fast[fastIndex] - slow[i]
      );
    }
  }

  if (macdLine.length < 9) {
    return null;
  }

  const signal =
    ema(macdLine, 9);

  const line =
    macdLine[macdLine.length - 1];

  return {
    line,
    signal,
    histogram: line - signal
  };
}


// -------------------------
// ATR
// -------------------------

function atr(highs, lows, closes, period = 14) {

  if (closes.length <= period) {
    return null;
  }

  const ranges = [];

  for (let i = 1; i < closes.length; i++) {

    const highLow =
      highs[i] - lows[i];

    const highClose =
      Math.abs(highs[i] - closes[i - 1]);

    const lowClose =
      Math.abs(lows[i] - closes[i - 1]);

    ranges.push(
      Math.max(
        highLow,
        highClose,
        lowClose
      )
    );
  }

  return ema(ranges, period);
}


// -------------------------
// VOLUME ANALYSIS
// -------------------------

function volumeAnalysis(volumes) {

  if (!volumes || volumes.length < 21) {
    return null;
  }

  const current =
    volumes[volumes.length - 1];

  const previous =
    volumes.slice(-21, -1);

  const average =
    previous.reduce((a, b) => a + b, 0) /
    previous.length;

  const ratio =
    average > 0
      ? current / average
      : 0;

  return {
    current,
    average,
    ratio
  };
}


// -------------------------
// ANALYZE SYMBOL
// -------------------------

async function analyze(symbol) {

  symbol =
    String(symbol || "")
      .toUpperCase()
      .trim();

  if (!PAIRS.includes(symbol)) {

    return {
      ok: false,
      error: "Unsupported symbol",
      symbol,
      supported: PAIRS
    };
  }

  const klines =
    await getJSON(
      `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=120`
    );

  if (!Array.isArray(klines) || klines.length < 60) {
    throw new Error("Not enough Binance candle data");
  }

  const highs =
    klines.map(k => Number(k[2]));

  const lows =
    klines.map(k => Number(k[3]));

  const closes =
    klines.map(k => Number(k[4]));

  const volumes =
    klines.map(k => Number(k[5]));

  const price =
    closes[closes.length - 1];

  const ema9 =
    ema(closes, 9);

  const ema21 =
    ema(closes, 21);

  const ema50 =
    ema(closes, 50);

  const RSI =
    rsi(closes, 14);

  const MACD =
    macd(closes);

  const ATR =
    atr(
      highs,
      lows,
      closes,
      14
    );

  const volume =
    volumeAnalysis(volumes);


  // -------------------------
  // SCORE ENGINE
  // -------------------------

  let bullish = 0;
  let bearish = 0;

  const reasons = [];


  // EMA 9 / EMA 21

  if (ema9 > ema21) {

    bullish += 2;

    reasons.push(
      "EMA9 above EMA21"
    );

  } else {

    bearish += 2;

    reasons.push(
      "EMA9 below EMA21"
    );
  }


  // EMA 21 / EMA 50

  if (ema21 > ema50) {

    bullish += 2;

    reasons.push(
      "EMA21 above EMA50"
    );

  } else {

    bearish += 2;

    reasons.push(
      "EMA21 below EMA50"
    );
  }


  // PRICE / EMA21

  if (price > ema21) {

    bullish += 1;

    reasons.push(
      "Price above EMA21"
    );

  } else {

    bearish += 1;

    reasons.push(
      "Price below EMA21"
    );
  }


  // RSI

  if (RSI >= 52 && RSI <= 70) {

    bullish += 2;

    reasons.push(
      "RSI bullish zone"
    );

  } else if (
    RSI <= 48 &&
    RSI >= 30
  ) {

    bearish += 2;

    reasons.push(
      "RSI bearish zone"
    );

  } else {

    reasons.push(
      "RSI neutral/extreme"
    );
  }


  // MACD

  if (MACD) {

    if (
      MACD.line > MACD.signal &&
      MACD.histogram > 0
    ) {

      bullish += 2;

      reasons.push(
        "MACD bullish"
      );

    } else if (
      MACD.line < MACD.signal &&
      MACD.histogram < 0
    ) {

      bearish += 2;

      reasons.push(
        "MACD bearish"
      );
    }
  }


  // Volume confirmation

  if (volume && volume.ratio >= 1.2) {

    if (price >= ema9) {

      bullish += 1;

      reasons.push(
        "Strong volume supports bullish move"
      );

    } else {

      bearish += 1;

      reasons.push(
        "Strong volume supports bearish move"
      );
    }
  }


  // -------------------------
  // FINAL SIGNAL
  // -------------------------

  const difference =
    bullish - bearish;

  let signal = "WAIT";

  if (difference >= 4) {
    signal = "BUY";
  }

  if (difference <= -4) {
    signal = "SELL";
  }


  // Confidence is a heuristic,
  // NOT statistical prediction accuracy.

  const total =
    bullish + bearish;

  let confidence =
    total > 0
      ? Math.round(
          Math.max(bullish, bearish) /
          total *
          100
        )
      : 50;

  if (signal === "WAIT") {
    confidence =
      Math.min(confidence, 60);
  }


  return {

    ok: true,

    engine:
      "Binance Signal Engine V4",

    symbol,

    interval: "1m",

    price,

    signal,

    confidence,

    scores: {
      bullish,
      bearish,
      difference
    },

    indicators: {

      rsi:
        Number(RSI.toFixed(2)),

      ema9:
        Number(ema9.toFixed(8)),

      ema21:
        Number(ema21.toFixed(8)),

      ema50:
        Number(ema50.toFixed(8)),

      macd: MACD
        ? {
            line:
              Number(MACD.line.toFixed(8)),

            signal:
              Number(MACD.signal.toFixed(8)),

            histogram:
              Number(MACD.histogram.toFixed(8))
          }
        : null,

      atr:
        ATR !== null
          ? Number(ATR.toFixed(8))
          : null,

      volumeRatio:
        volume
          ? Number(volume.ratio.toFixed(2))
          : null
    },

    reasons,

    candleCloseTime:
      klines[klines.length - 1][6],

    generatedAt:
      new Date().toISOString(),

    warning:
      "Signal is indicator-based analysis, not a guaranteed future-price prediction."
  };
}


// -------------------------
// WORKER
// -------------------------

export default {

  async fetch(request) {

    if (request.method === "OPTIONS") {

      return new Response(
        null,
        {
          status: 204,
          headers: CORS
        }
      );
    }

    try {

      const url =
        new URL(request.url);

      const path =
        url.pathname.replace(/\/+$/, "") || "/";


      // HOME

      if (path === "/") {

        return json({

          ok: true,

          name:
            "Binance Signal Engine V4",

          endpoints: [

            "/health",

            "/pairs",

            "/signal?symbol=BTCUSDT",

            "/scan"
          ]

        });
      }


      // HEALTH

      if (path === "/health") {

        const server =
          await getJSON(
            "/api/v3/time"
          );

        return json({

          ok: true,

          engine:
            "Binance Signal Engine V4",

          message:
            "Binance connection working",

          source: API,

          serverTime:
            server.serverTime
        });
      }


      // PAIRS

      if (path === "/pairs") {

        return json({

          ok: true,

          count:
            PAIRS.length,

          pairs:
            PAIRS
        });
      }


      // SIGNAL

      if (path === "/signal") {

        const symbol =
          url.searchParams.get("symbol") ||
          "BTCUSDT";

        const result =
          await analyze(symbol);

        return json(
          result,
          result.ok ? 200 : 400
        );
      }


      // SCAN

      if (path === "/scan") {

        const results = [];

        for (const symbol of PAIRS) {

          try {

            const result =
              await analyze(symbol);

            results.push(result);

          } catch (error) {

            results.push({

              ok: false,

              symbol,

              error:
                error.message
            });
          }
        }

        results.sort(
          (a, b) => {

            const aStrength =
              Math.abs(
                a.scores?.difference || 0
              );

            const bStrength =
              Math.abs(
                b.scores?.difference || 0
              );

            return bStrength - aStrength;
          }
        );

        return json({

          ok: true,

          engine:
            "Binance Signal Engine V4",

          count:
            results.length,

          results,

          generatedAt:
            new Date().toISOString()
        });
      }


      return json(
        {
          ok: false,
          error: "Not found",
          path
        },
        404
      );

    } catch (error) {

      return json(
        {
          ok: false,
          error:
            error?.message ||
            String(error)
        },
        500
      );
    }
  }
};
