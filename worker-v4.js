// ======================================================
// BINANCE SIGNAL ENGINE V6
// V5 SIGNAL ENGINE + 20 SIGNAL AUTO TEST + KV STORAGE
// Cloudflare Worker
// ======================================================

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

const TEST_TARGET = 20;
const TEST_PREFIX = "test:";
const TEST_COOLDOWN_MS = 5 * 60 * 1000;

const CORS = {
  "content-type": "application/json; charset=UTF-8",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "*",
  "cache-control": "no-store"
};


// ======================================================
// RESPONSE
// ======================================================

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: CORS
    }
  );
}


// ======================================================
// BINANCE REQUEST
// ======================================================

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


// ======================================================
// HELPERS
// ======================================================

function avg(values) {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : 0;
}

function round(value, digits = 8) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return null;
  }

  return Number(Number(value).toFixed(digits));
}


// ======================================================
// EMA
// ======================================================

function ema(values, period) {
  if (!values || values.length < period) {
    return null;
  }

  let value = avg(values.slice(0, period));

  const multiplier = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    value =
      values[i] * multiplier +
      value * (1 - multiplier);
  }

  return value;
}


// ======================================================
// EMA SERIES
// ======================================================

function emaSeries(values, period) {
  if (!values || values.length < period) {
    return [];
  }

  let value = avg(values.slice(0, period));

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


// ======================================================
// RSI
// ======================================================

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
      diff < 0
        ? Math.abs(diff)
        : 0;

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

  const rs = avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}


// ======================================================
// MACD
// ======================================================

function macd(values) {
  if (!values || values.length < 35) {
    return null;
  }

  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);

  if (!fast.length || !slow.length) {
    return null;
  }

  const offset =
    fast.length - slow.length;

  const lineValues = slow.map(
    (slowValue, index) =>
      fast[index + offset] - slowValue
  );

  if (lineValues.length < 9) {
    return null;
  }

  const signal = ema(lineValues, 9);

  const line =
    lineValues[lineValues.length - 1];

  return {
    line,
    signal,
    histogram: line - signal
  };
}


// ======================================================
// ATR
// ======================================================

function atr(rows, period = 14) {
  if (!rows || rows.length < period + 1) {
    return null;
  }

  const ranges = [];

  for (let i = 1; i < rows.length; i++) {
    const high = Number(rows[i][2]);
    const low = Number(rows[i][3]);
    const previousClose =
      Number(rows[i - 1][4]);

    ranges.push(
      Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose)
      )
    );
  }

  return ema(ranges, period);
}


// ======================================================
// VOLUME
// ======================================================

function volumeRatio(rows) {
  if (!rows || rows.length < 21) {
    return null;
  }

  const volumes =
    rows.map(row => Number(row[5]));

  const current =
    volumes[volumes.length - 1];

  const previous =
    volumes.slice(-21, -1);

  const average = avg(previous);

  return average > 0
    ? current / average
    : 0;
}


// ======================================================
// MARKET STRUCTURE
// ======================================================

function marketStructure(rows) {
  if (!rows || rows.length < 12) {
    return "RANGE";
  }

  const recent = rows.slice(-12);

  const first = recent.slice(0, 6);
  const second = recent.slice(6);

  const firstHigh =
    Math.max(...first.map(x => Number(x[2])));

  const firstLow =
    Math.min(...first.map(x => Number(x[3])));

  const secondHigh =
    Math.max(...second.map(x => Number(x[2])));

  const secondLow =
    Math.min(...second.map(x => Number(x[3])));

  if (
    secondHigh > firstHigh &&
    secondLow > firstLow
  ) {
    return "BULLISH";
  }

  if (
    secondHigh < firstHigh &&
    secondLow < firstLow
  ) {
    return "BEARISH";
  }

  return "RANGE";
}


// ======================================================
// SUPPORT / RESISTANCE
// ======================================================

function supportResistance(rows) {
  const recent = rows.slice(-50);

  return {
    support:
      Math.min(
        ...recent.map(row => Number(row[3]))
      ),

    resistance:
      Math.max(
        ...recent.map(row => Number(row[2]))
      )
  };
}


// ======================================================
// ANALYZE SYMBOL
// ======================================================

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

  const [raw1m, raw5m] =
    await Promise.all([
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
    throw new Error(
      "Not enough Binance candle data"
    );
  }

  // Remove currently forming candles
  const candles1m =
    raw1m.slice(0, -1);

  const candles5m =
    raw5m.slice(0, -1);

  const close1m =
    candles1m.map(x => Number(x[4]));

  const close5m =
    candles5m.map(x => Number(x[4]));

  const price =
    close1m[close1m.length - 1];


  // 1 MINUTE

  const ema9 =
    ema(close1m, 9);

  const ema21 =
    ema(close1m, 21);

  const ema50 =
    ema(close1m, 50);

  const ema200 =
    ema(close1m, 200);

  const RSI =
    rsi(close1m, 14);

  const MACD =
    macd(close1m);

  const ATR =
    atr(candles1m, 14);

  const VR =
    volumeRatio(candles1m);

  const structure =
    marketStructure(candles1m);

  const sr =
    supportResistance(candles1m);


  // 5 MINUTE

  const ema9_5 =
    ema(close5m, 9);

  const ema21_5 =
    ema(close5m, 21);

  const ema50_5 =
    ema(close5m, 50);

  const RSI5 =
    rsi(close5m, 14);

  const MACD5 =
    macd(close5m);

  const trend5 =
    ema9_5 > ema21_5 &&
    ema21_5 > ema50_5
      ? "BULLISH"
      : ema9_5 < ema21_5 &&
        ema21_5 < ema50_5
      ? "BEARISH"
      : "MIXED";


  // ====================================================
  // SCORE ENGINE
  // ====================================================

  let bullishScore = 0;
  let bearishScore = 0;

  const bullish = [];
  const bearish = [];

  function score(
    bullCondition,
    bearCondition,
    points,
    bullText,
    bearText
  ) {
    if (bullCondition) {
      bullishScore += points;
      bullish.push(bullText);
    } else if (bearCondition) {
      bearishScore += points;
      bearish.push(bearText);
    }
  }


  score(
    ema9 > ema21,
    ema9 < ema21,
    10,
    "1m EMA9 > EMA21",
    "1m EMA9 < EMA21"
  );


  score(
    ema50 > ema200,
    ema50 < ema200,
    12,
    "EMA50 > EMA200",
    "EMA50 < EMA200"
  );


  score(
    price > ema21 && price > ema50,
    price < ema21 && price < ema50,
    8,
    "Price above EMA21/50",
    "Price below EMA21/50"
  );


  score(
    RSI >= 52 && RSI <= 68,
    RSI <= 48 && RSI >= 32,
    10,
    "1m RSI bullish",
    "1m RSI bearish"
  );


  if (MACD) {
    score(
      MACD.histogram > 0 &&
      MACD.line > MACD.signal,

      MACD.histogram < 0 &&
      MACD.line < MACD.signal,

      10,

      "1m MACD bullish",

      "1m MACD bearish"
    );
  }


  score(
    structure === "BULLISH",
    structure === "BEARISH",
    10,
    "Bullish market structure",
    "Bearish market structure"
  );


  score(
    trend5 === "BULLISH",
    trend5 === "BEARISH",
    18,
    "5m trend bullish",
    "5m trend bearish"
  );


  score(
    RSI5 >= 52 && RSI5 <= 70,
    RSI5 <= 48 && RSI5 >= 30,
    8,
    "5m RSI bullish",
    "5m RSI bearish"
  );


  if (MACD5) {
    score(
      MACD5.histogram > 0,
      MACD5.histogram < 0,
      8,
      "5m MACD bullish",
      "5m MACD bearish"
    );
  }


  if (VR !== null && VR >= 1.1) {
    if (bullishScore > bearishScore) {
      bullishScore += 6;

      bullish.push(
        "Closed-candle volume confirms bullish move"
      );

    } else if (
      bearishScore > bullishScore
    ) {
      bearishScore += 6;

      bearish.push(
        "Closed-candle volume confirms bearish move"
      );
    }
  }


  bullishScore =
    Math.min(100, bullishScore);

  bearishScore =
    Math.min(100, bearishScore);

  const difference =
    Math.abs(
      bullishScore - bearishScore
    );


  // ====================================================
  // STRICT SIGNAL FILTER
  // ====================================================

  const buyAllowed =
    bullishScore >= 68 &&
    bullishScore > bearishScore &&
    difference >= 24 &&
    trend5 !== "BEARISH" &&
    RSI < 72;

  const sellAllowed =
    bearishScore >= 68 &&
    bearishScore > bullishScore &&
    difference >= 24 &&
    trend5 !== "BULLISH" &&
    RSI > 28;


  let signal = "WAIT";

  if (buyAllowed) {
    signal = "BUY";
  }

  if (sellAllowed) {
    signal = "SELL";
  }


  const signalStrength =
    signal === "BUY"
      ? bullishScore
      : signal === "SELL"
      ? bearishScore
      : Math.min(
          67,
          Math.max(
            bullishScore,
            bearishScore
          )
        );


  // ====================================================
  // ATR TRADE LEVELS
  // ====================================================

  let entry = null;
  let tp = null;
  let sl = null;

  if (
    signal !== "WAIT" &&
    ATR !== null
  ) {
    entry = price;

    if (signal === "BUY") {
      tp =
        price + (ATR * 1.5);

      sl =
        price - ATR;
    }

    if (signal === "SELL") {
      tp =
        price - (ATR * 1.5);

      sl =
        price + ATR;
    }
  }


  return {
    ok: true,

    engine:
      "Binance Signal Engine V6",

    symbol,

    signal,

    signalStrength,

    strengthMeaning:
      "Indicator confirmation strength, not win probability",

    timeframe: {
      entry: "1m",
      confirmation: "5m"
    },

    price:
      round(price),

    trade: {
      entry: round(entry),
      tp: round(tp),
      sl: round(sl)
    },

    scores: {
      bullish:
        bullishScore,

      bearish:
        bearishScore,

      difference
    },

    trend: {
      oneMinute:
        ema9 > ema21
          ? "UP"
          : ema9 < ema21
          ? "DOWN"
          : "FLAT",

      fiveMinute:
        trend5,

      main:
        ema50 > ema200
          ? "UP"
          : ema50 < ema200
          ? "DOWN"
          : "FLAT",

      marketStructure:
        structure
    },

    indicators: {
      rsi1m:
        round(RSI, 2),

      rsi5m:
        round(RSI5, 2),

      ema9:
        round(ema9),

      ema21:
        round(ema21),

      ema50:
        round(ema50),

      ema200:
        round(ema200),

      macd1mHistogram:
        MACD
          ? round(MACD.histogram)
          : null,

      macd5mHistogram:
        MACD5
          ? round(MACD5.histogram)
          : null,

      atr14:
        round(ATR),

      closedCandleVolumeRatio:
        round(VR, 2),

      support:
        round(sr.support),

      resistance:
        round(sr.resistance)
    },

    confirmations: {
      bullish,
      bearish
    },

    candle: {
      dataType:
        "CLOSED_CANDLES_ONLY",

      lastClosed1m:
        new Date(
          candles1m[candles1m.length - 1][6]
        ).toISOString(),

      lastClosed5m:
        new Date(
          candles5m[candles5m.length - 1][6]
        ).toISOString()
    },

    generatedAt:
      new Date().toISOString(),

    warning:
      "Market-analysis signal only. Signal strength is not prediction accuracy."
  };
}


// ======================================================
// SCAN
// ======================================================

async function scan() {
  const results =
    await Promise.all(
      PAIRS.map(async symbol => {
        try {
          return await analyze(symbol);
        } catch (error) {
          return {
            ok: false,
            symbol,
            signal: "ERROR",
            error:
              error?.message ||
              String(error)
          };
        }
      })
    );

  const signals =
    results
      .filter(
        x =>
          x.ok &&
          (
            x.signal === "BUY" ||
            x.signal === "SELL"
          )
      )
      .sort(
        (a, b) =>
          b.signalStrength -
          a.signalStrength
      );

  return {
    ok: true,

    engine:
      "Binance Signal Engine V6",

    pairsChecked:
      PAIRS.length,

    signalsFound:
      signals.length,

    signals,

    allResults:
      results,

    generatedAt:
      new Date().toISOString()
  };
}


// ======================================================
// KV TEST STORAGE
// ======================================================

async function listTests(env) {
  if (!env?.SIGNAL_TEST) {
    throw new Error(
      "SIGNAL_TEST KV binding not found"
    );
  }

  const result =
    await env.SIGNAL_TEST.list({
      prefix: TEST_PREFIX
    });

  const records = [];

  for (const key of result.keys) {
    const value =
      await env.SIGNAL_TEST.get(
        key.name,
        "json"
      );

    if (value) {
      records.push(value);
    }
  }

  records.sort(
    (a, b) =>
      new Date(a.createdAt) -
      new Date(b.createdAt)
  );

  return records;
}


// ======================================================
// SAVE NEW TEST SIGNALS
// ======================================================

async function saveSignalsForTest(
  env,
  signals
) {
  if (!env?.SIGNAL_TEST) {
    return {
      added: 0,
      total: 0
    };
  }

  const existing =
    await listTests(env);

  if (
    existing.length >= TEST_TARGET
  ) {
    return {
      added: 0,
      total:
        existing.length
    };
  }

  let added = 0;

  for (const signal of signals) {
    if (
      existing.length + added >=
      TEST_TARGET
    ) {
      break;
    }

    if (
      !signal ||
      !signal.ok ||
      !["BUY", "SELL"].includes(
        signal.signal
      ) ||
      signal.trade?.entry === null ||
      signal.trade?.tp === null ||
      signal.trade?.sl === null
    ) {
      continue;
    }


    const duplicateOpen =
      existing.some(
        x =>
          x.symbol === signal.symbol &&
          x.signal === signal.signal &&
          x.status === "PENDING"
      );

    if (duplicateOpen) {
      continue;
    }


    const recentSame =
      existing.some(x => {
        if (
          x.symbol !== signal.symbol ||
          x.signal !== signal.signal
        ) {
          return false;
        }

        const age =
          Date.now() -
          new Date(
            x.createdAt
          ).getTime();

        return age <
          TEST_COOLDOWN_MS;
      });

    if (recentSame) {
      continue;
    }


    const id =
      `${TEST_PREFIX}${Date.now()}:${signal.symbol}:${Math.random()
        .toString(36)
        .slice(2, 8)}`;


    const record = {
      testId: id,

      symbol:
        signal.symbol,

      signal:
        signal.signal,

      strength:
        signal.signalStrength,

      entry:
        Number(
          signal.trade.entry
        ),

      tp:
        Number(
          signal.trade.tp
        ),

      sl:
        Number(
          signal.trade.sl
        ),

      status:
        "PENDING",

      result:
        null,

      createdAt:
        new Date().toISOString(),

      resolvedAt:
        null,

      exitPrice:
        null,

      resolution:
        null
    };


    await env.SIGNAL_TEST.put(
      id,
      JSON.stringify(record)
    );

    existing.push(record);

    added++;
  }

  return {
    added,
    total:
      existing.length
  };
}


// ======================================================
// VALIDATE ONE TEST
// ======================================================

async function validateOneTest(
  env,
  record
) {
  if (
    !record ||
    record.status !== "PENDING"
  ) {
    return record;
  }

  const startTime =
    new Date(
      record.createdAt
    ).getTime();

  const rows =
    await getJSON(
      `/api/v3/klines?symbol=${encodeURIComponent(record.symbol)}&interval=1m&startTime=${startTime}&limit=1000`
    );

  if (
    !Array.isArray(rows) ||
    !rows.length
  ) {
    return record;
  }


  for (const row of rows) {
    const high =
      Number(row[2]);

    const low =
      Number(row[3]);

    const close =
      Number(row[4]);

    const candleClose =
      Number(row[6]);


    let tpHit = false;
    let slHit = false;


    if (record.signal === "BUY") {
      tpHit =
        high >= record.tp;

      slHit =
        low <= record.sl;
    }


    if (record.signal === "SELL") {
      tpHit =
        low <= record.tp;

      slHit =
        high >= record.sl;
    }


    // Both hit in same candle:
    // intrabar order is unknown.
    if (tpHit && slHit) {
      record.status =
        "AMBIGUOUS";

      record.result =
        "AMBIGUOUS";

      record.resolution =
        "TP and SL both touched inside the same 1m candle; order cannot be proven.";

      record.exitPrice =
        close;

      record.resolvedAt =
        new Date(
          candleClose
        ).toISOString();

      break;
    }


    if (tpHit) {
      record.status =
        "CLOSED";

      record.result =
        "WIN";

      record.resolution =
        "TP hit before SL";

      record.exitPrice =
        record.tp;

      record.resolvedAt =
        new Date(
          candleClose
        ).toISOString();

      break;
    }


    if (slHit) {
      record.status =
        "CLOSED";

      record.result =
        "LOSS";

      record.resolution =
        "SL hit before TP";

      record.exitPrice =
        record.sl;

      record.resolvedAt =
        new Date(
          candleClose
        ).toISOString();

      break;
    }
  }


  await env.SIGNAL_TEST.put(
    record.testId,
    JSON.stringify(record)
  );

  return record;
}


// ======================================================
// CHECK ALL PENDING TESTS
// ======================================================

async function updateTestResults(env) {
  if (!env?.SIGNAL_TEST) {
    return null;
  }

  const records =
    await listTests(env);

  const pending =
    records.filter(
      x =>
        x.status === "PENDING"
    );


  for (const record of pending) {
    try {
      await validateOneTest(
        env,
        record
      );
    } catch (error) {
      // Keep pending if Binance call temporarily fails
    }
  }

  return getTestReport(env);
}


// ======================================================
// TEST REPORT
// ======================================================

async function getTestReport(env) {
  const records =
    await listTests(env);

  const wins =
    records.filter(
      x => x.result === "WIN"
    );

  const losses =
    records.filter(
      x => x.result === "LOSS"
    );

  const pending =
    records.filter(
      x =>
        x.status === "PENDING"
    );

  const ambiguous =
    records.filter(
      x =>
        x.result === "AMBIGUOUS"
    );


  const validClosed =
    wins.length +
    losses.length;


  const winRate =
    validClosed > 0
      ? Number(
          (
            wins.length /
            validClosed *
            100
          ).toFixed(2)
        )
      : null;


  const buyClosed =
    records.filter(
      x =>
        x.signal === "BUY" &&
        (
          x.result === "WIN" ||
          x.result === "LOSS"
        )
    );

  const buyWins =
    buyClosed.filter(
      x =>
        x.result === "WIN"
    ).length;


  const sellClosed =
    records.filter(
      x =>
        x.signal === "SELL" &&
        (
          x.result === "WIN" ||
          x.result === "LOSS"
        )
    );

  const sellWins =
    sellClosed.filter(
      x =>
        x.result === "WIN"
    ).length;


  const averageStrength =
    records.length
      ? Number(
          (
            records.reduce(
              (sum, x) =>
                sum +
                Number(
                  x.strength || 0
                ),
              0
            ) /
            records.length
          ).toFixed(2)
        )
      : null;


  return {
    ok: true,

    engine:
      "Binance Signal Engine V6 Auto Test",

    target:
      TEST_TARGET,

    collected:
      records.length,

    remaining:
      Math.max(
        0,
        TEST_TARGET -
        records.length
      ),

    collectionComplete:
      records.length >=
      TEST_TARGET,

    pending:
      pending.length,

    completed:
      validClosed,

    wins:
      wins.length,

    losses:
      losses.length,

    ambiguous:
      ambiguous.length,

    historicalWinRate:
      winRate,

    averageSignalStrength:
      averageStrength,

    buyPerformance: {
      completed:
        buyClosed.length,

      wins:
        buyWins,

      losses:
        buyClosed.length -
        buyWins,

      winRate:
        buyClosed.length
          ? Number(
              (
                buyWins /
                buyClosed.length *
                100
              ).toFixed(2)
            )
          : null
    },

    sellPerformance: {
      completed:
        sellClosed.length,

      wins:
        sellWins,

      losses:
        sellClosed.length -
        sellWins,

      winRate:
        sellClosed.length
          ? Number(
              (
                sellWins /
                sellClosed.length *
                100
              ).toFixed(2)
            )
          : null
    },

    note:
      "Historical test results only. They do not guarantee future trading performance.",

    signals:
      records
  };
}


// ======================================================
// RESET TEST
// ======================================================

async function resetTests(env) {
  const records =
    await listTests(env);

  for (const record of records) {
    await env.SIGNAL_TEST.delete(
      record.testId
    );
  }

  return {
    ok: true,
    deleted:
      records.length,
    message:
      "Signal test history reset"
  };
}


// ======================================================
// WORKER
// ======================================================

export default {

  async fetch(request, env) {

    if (
      request.method === "OPTIONS"
    ) {
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
        url.pathname.replace(
          /\/+$/,
          ""
        ) || "/";


      // HOME

      if (path === "/") {
        return json({
          ok: true,

          engine:
            "Binance Signal Engine V6",

          endpoints: [
            "/health",
            "/pairs",
            "/signal?symbol=BTCUSDT",
            "/scan",
            "/test/results",
            "/test/check",
            "/test/reset"
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
            "Binance Signal Engine V6",

          binance:
            "CONNECTED",

          kv:
            env?.SIGNAL_TEST
              ? "CONNECTED"
              : "NOT CONNECTED",

          serverTime:
            server.serverTime,

          source:
            API
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


      // SINGLE SIGNAL

      if (path === "/signal") {
        const symbol =
          url.searchParams.get(
            "symbol"
          ) || "BTCUSDT";

        const result =
          await analyze(symbol);

        return json(
          result,
          result.ok ? 200 : 400
        );
      }


      // ==================================================
      // SCAN + AUTO TEST
      // ==================================================

      if (path === "/scan") {

        // First update existing pending outcomes
        let testReport = null;

        if (env?.SIGNAL_TEST) {
          try {
            testReport =
              await updateTestResults(
                env
              );
          } catch (error) {
            // Do not break scanner
          }
        }


        // Run current market scan
        const result =
          await scan();


        // Save new actionable signals until total reaches 20
        let testStorage = null;

        if (
          env?.SIGNAL_TEST &&
          result?.signals?.length
        ) {
          try {
            testStorage =
              await saveSignalsForTest(
                env,
                result.signals
              );

            testReport =
              await getTestReport(
                env
              );
          } catch (error) {
            testStorage = {
              error:
                error?.message ||
                String(error)
            };
          }
        }


        return json({
          ...result,

          autoTest: {
            target:
              TEST_TARGET,

            storage:
              testStorage,

            report:
              testReport
          }
        });
      }


      // ==================================================
      // TEST RESULTS
      // ==================================================

      if (
        path === "/test/results"
      ) {
        return json(
          await getTestReport(
            env
          )
        );
      }


      // ==================================================
      // FORCE CHECK PENDING
      // ==================================================

      if (
        path === "/test/check"
      ) {
        return json(
          await updateTestResults(
            env
          )
        );
      }


      // ==================================================
      // RESET TEST
      // ==================================================

      if (
        path === "/test/reset"
      ) {
        return json(
          await resetTests(
            env
          )
        );
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
