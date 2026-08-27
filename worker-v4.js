// Binance Signal Engine V8
// Strict multi-timeframe signal engine + clean 20-signal auto test

const API = "https://api-gcp.binance.com";

const PAIRS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","TRXUSDT"
];

const TEST_TARGET = 20;
const TEST_PREFIX = "v8:test:";
const TEST_BUCKET_MS = 15 * 60 * 1000;
const MIN_SIGNAL_STRENGTH = 80;
const MAX_AUTO_VALIDATIONS_PER_CYCLE = 4;
const SIGNAL_RR = 1.2;

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

function avg(values) {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : 0;
}

function round(value, digits = 8) {
  if (value === null || value === undefined) return null;

  const n = Number(value);

  return Number.isFinite(n)
    ? Number(n.toFixed(digits))
    : null;
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

function ema(values, period) {
  if (!values || values.length < period) {
    return null;
  }

  let value =
    avg(values.slice(0, period));

  const k =
    2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    value =
      values[i] * k +
      value * (1 - k);
  }

  return value;
}

function emaSeries(values, period) {
  if (!values || values.length < period) {
    return [];
  }

  let value =
    avg(values.slice(0, period));

  const k =
    2 / (period + 1);

  const output =
    [value];

  for (let i = period; i < values.length; i++) {
    value =
      values[i] * k +
      value * (1 - k);

    output.push(value);
  }

  return output;
}

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

  let avgGain =
    gains / period;

  let avgLoss =
    losses / period;

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

  const rs =
    avgGain / avgLoss;

  return 100 - (100 / (1 + rs));
}

function macd(values) {
  const fast =
    emaSeries(values, 12);

  const slow =
    emaSeries(values, 26);

  if (!fast.length || !slow.length) {
    return null;
  }

  const offset =
    fast.length - slow.length;

  const lineValues =
    slow.map(
      (value, index) =>
        fast[index + offset] - value
    );

  if (lineValues.length < 9) {
    return null;
  }

  const signal =
    ema(lineValues, 9);

  const line =
    lineValues.at(-1);

  return {
    line,
    signal,
    histogram:
      line - signal
  };
}

function atr(rows, period = 14) {
  if (!rows || rows.length < period + 1) {
    return null;
  }

  const ranges = [];

  for (let i = 1; i < rows.length; i++) {
    const high =
      Number(rows[i][2]);

    const low =
      Number(rows[i][3]);

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

function volumeRatio(rows) {
  if (!rows || rows.length < 21) {
    return null;
  }

  const volumes =
    rows.map(
      row => Number(row[5])
    );

  const current =
    volumes.at(-1);

  const base =
    avg(
      volumes.slice(-21, -1)
    );

  return base > 0
    ? current / base
    : 0;
}

function vwap(rows, count = 60) {
  let priceVolume = 0;
  let volume = 0;

  for (const row of rows.slice(-count)) {
    const typical =
      (
        Number(row[2]) +
        Number(row[3]) +
        Number(row[4])
      ) / 3;

    const candleVolume =
      Number(row[5]);

    priceVolume +=
      typical * candleVolume;

    volume +=
      candleVolume;
  }

  return volume
    ? priceVolume / volume
    : null;
}

function std(values, period = 20) {
  if (!values || values.length < period) {
    return null;
  }

  const sample =
    values.slice(-period);

  const mean =
    avg(sample);

  return Math.sqrt(
    avg(
      sample.map(
        value =>
          (value - mean) ** 2
      )
    )
  );
}

function marketStructure(rows) {
  if (!rows || rows.length < 12) {
    return "RANGE";
  }

  const recent =
    rows.slice(-12);

  const first =
    recent.slice(0, 6);

  const second =
    recent.slice(6);

  const firstHigh =
    Math.max(
      ...first.map(
        row => Number(row[2])
      )
    );

  const firstLow =
    Math.min(
      ...first.map(
        row => Number(row[3])
      )
    );

  const secondHigh =
    Math.max(
      ...second.map(
        row => Number(row[2])
      )
    );

  const secondLow =
    Math.min(
      ...second.map(
        row => Number(row[3])
      )
    );

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

function supportResistance(rows) {
  const recent =
    rows.slice(-50);

  return {
    support:
      Math.min(
        ...recent.map(
          row => Number(row[3])
        )
      ),

    resistance:
      Math.max(
        ...recent.map(
          row => Number(row[2])
        )
      )
  };
}

function analyzeOrderBook(book) {
  const bids =
    (book.bids || []).slice(0, 20);

  const asks =
    (book.asks || []).slice(0, 20);

  if (!bids.length || !asks.length) {
    return {
      imbalance: 0,
      spreadBps: 999,
      microBiasBps: 0
    };
  }

  const bidNotional =
    bids.reduce(
      (sum, row) =>
        sum +
        Number(row[0]) *
        Number(row[1]),
      0
    );

  const askNotional =
    asks.reduce(
      (sum, row) =>
        sum +
        Number(row[0]) *
        Number(row[1]),
      0
    );

  const bestBid =
    Number(bids[0][0]);

  const bestAsk =
    Number(asks[0][0]);

  const bidQty =
    Number(bids[0][1]);

  const askQty =
    Number(asks[0][1]);

  const mid =
    (bestBid + bestAsk) / 2;

  const microPrice =
    (
      bestAsk * bidQty +
      bestBid * askQty
    ) /
    (bidQty + askQty || 1);

  return {
    imbalance:
      bidNotional + askNotional
        ? (
            (
              bidNotional -
              askNotional
            ) /
            (
              bidNotional +
              askNotional
            )
          ) * 100
        : 0,

    spreadBps:
      mid
        ? (
            (
              bestAsk -
              bestBid
            ) /
            mid
          ) * 10000
        : 999,

    microBiasBps:
      mid
        ? (
            (
              microPrice -
              mid
            ) /
            mid
          ) * 10000
        : 0
  };
}

function analyzeTradeFlow(trades) {
  const now =
    Date.now();

  let buy15 = 0;
  let sell15 = 0;

  let buy30 = 0;
  let sell30 = 0;

  let count15 = 0;
  let count30 = 0;

  for (const trade of trades) {
    const age =
      now - Number(trade.T);

    if (age > 30000) {
      continue;
    }

    const notional =
      Number(trade.p) *
      Number(trade.q);

    count30++;

    if (trade.m) {
      sell30 += notional;
    } else {
      buy30 += notional;
    }

    if (age <= 15000) {
      count15++;

      if (trade.m) {
        sell15 += notional;
      } else {
        buy15 += notional;
      }
    }
  }

  const total15 =
    buy15 + sell15;

  const total30 =
    buy30 + sell30;

  return {
    flow15:
      total15
        ? (
            (
              buy15 -
              sell15
            ) /
            total15
          ) * 100
        : 0,

    flow30:
      total30
        ? (
            (
              buy30 -
              sell30
            ) /
            total30
          ) * 100
        : 0,

    count15,
    count30
  };
}

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
        `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=1m&limit=205`
      ),

      getJSON(
        `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=80`
      )
    ]);

  if (
    !Array.isArray(raw1m) ||
    !Array.isArray(raw5m) ||
    raw1m.length < 201 ||
    raw5m.length < 55
  ) {
    throw new Error(
      "Not enough Binance candle data"
    );
  }

  // Indicators only use closed candles.
  const candles1m =
    raw1m.slice(0, -1);

  const candles5m =
    raw5m.slice(0, -1);

  const closes1m =
    candles1m.map(
      row => Number(row[4])
    );

  const closes5m =
    candles5m.map(
      row => Number(row[4])
    );

  // Current kline close is only used as live entry reference.
  const livePrice =
    Number(raw1m.at(-1)[4]);

  const closedPrice =
    closes1m.at(-1);

  const EMA9 =
    ema(closes1m, 9);

  const EMA21 =
    ema(closes1m, 21);

  const EMA50 =
    ema(closes1m, 50);

  const EMA200 =
    ema(closes1m, 200);

  const RSI1 =
    rsi(closes1m, 14);

  const MACD1 =
    macd(closes1m);

  const ATR =
    atr(candles1m, 14);

  const VR =
    volumeRatio(candles1m);

  const VWAP =
    vwap(candles1m, 60);

  const structure =
    marketStructure(candles1m);

  const SR =
    supportResistance(candles1m);

  const BBMiddle =
    avg(
      closes1m.slice(-20)
    );

  const BBDeviation =
    std(closes1m, 20);

  const Bollinger = {
    lower:
      BBMiddle -
      2 * BBDeviation,

    middle:
      BBMiddle,

    upper:
      BBMiddle +
      2 * BBDeviation
  };

  const EMA9_5 =
    ema(closes5m, 9);

  const EMA21_5 =
    ema(closes5m, 21);

  const EMA50_5 =
    ema(closes5m, 50);

  const RSI5 =
    rsi(closes5m, 14);

  const MACD5 =
    macd(closes5m);

  const trend5 =
    EMA9_5 > EMA21_5 &&
    EMA21_5 > EMA50_5

      ? "BULLISH"

      : EMA9_5 < EMA21_5 &&
        EMA21_5 < EMA50_5

      ? "BEARISH"

      : "MIXED";

  let bullishScore = 0;
  let bearishScore = 0;

  const bullish = [];
  const bearish = [];

  function score(
    bullishCondition,
    bearishCondition,
    points,
    bullishText,
    bearishText
  ) {
    if (bullishCondition) {
      bullishScore += points;
      bullish.push(bullishText);
    }

    else if (bearishCondition) {
      bearishScore += points;
      bearish.push(bearishText);
    }
  }

  score(
    EMA9 > EMA21,
    EMA9 < EMA21,
    10,
    "1m EMA9 > EMA21",
    "1m EMA9 < EMA21"
  );

  score(
    EMA50 > EMA200,
    EMA50 < EMA200,
    12,
    "EMA50 > EMA200",
    "EMA50 < EMA200"
  );

  score(
    livePrice > EMA21 &&
    livePrice > EMA50,

    livePrice < EMA21 &&
    livePrice < EMA50,

    8,

    "Price above EMA21/50",

    "Price below EMA21/50"
  );

  score(
    RSI1 >= 52 &&
    RSI1 <= 67,

    RSI1 <= 48 &&
    RSI1 >= 33,

    10,

    "1m RSI bullish",

    "1m RSI bearish"
  );

  if (MACD1) {
    score(
      MACD1.histogram > 0 &&
      MACD1.line > MACD1.signal,

      MACD1.histogram < 0 &&
      MACD1.line < MACD1.signal,

      10,

      "1m MACD bullish",

      "1m MACD bearish"
    );
  }

  score(
    livePrice > VWAP,
    livePrice < VWAP,
    6,
    "Price above VWAP",
    "Price below VWAP"
  );

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
    RSI5 >= 52 &&
    RSI5 <= 69,

    RSI5 <= 48 &&
    RSI5 >= 31,

    8,

    "5m RSI bullish",

    "5m RSI bearish"
  );

  if (MACD5) {
    score(
      MACD5.histogram > 0,
      MACD5.histogram < 0,
      10,
      "5m MACD bullish",
      "5m MACD bearish"
    );
  }

  score(
    livePrice > Bollinger.middle,
    livePrice < Bollinger.middle,
    4,
    "Above Bollinger mid",
    "Below Bollinger mid"
  );

  if (
    VR !== null &&
    VR >= 0.9 &&
    VR <= 3.5
  ) {
    if (
      bullishScore >
      bearishScore
    ) {
      bullishScore += 6;

      bullish.push(
        "Volume supports bullish move"
      );
    }

    else if (
      bearishScore >
      bullishScore
    ) {
      bearishScore += 6;

      bearish.push(
        "Volume supports bearish move"
      );
    }
  }

  bullishScore =
    Math.min(
      100,
      bullishScore
    );

  bearishScore =
    Math.min(
      100,
      bearishScore
    );

  const mainUp =
    EMA50 > EMA200;

  const mainDown =
    EMA50 < EMA200;

  const volumeOK =
    VR !== null &&
    VR >= 0.55 &&
    VR <= 4.0;

  const volatilityOK =
    Boolean(ATR) &&
    ATR / livePrice >= 0.00010;

  const roomToResistanceATR =
    ATR
      ? (
          SR.resistance -
          livePrice
        ) / ATR
      : null;

  const roomToSupportATR =
    ATR
      ? (
          livePrice -
          SR.support
        ) / ATR
      : null;

  const preBuy =
    bullishScore >= 76 &&

    bullishScore >=
      bearishScore + 28 &&

    mainUp &&

    trend5 === "BULLISH" &&

    RSI1 >= 52 &&
    RSI1 <= 67 &&

    MACD1?.histogram > 0 &&

    MACD5?.histogram > 0 &&

    structure !== "BEARISH" &&

    livePrice > VWAP &&

    livePrice >
      Bollinger.middle &&

    volumeOK &&

    volatilityOK &&

    roomToResistanceATR !== null &&
    roomToResistanceATR >= 1.4;

  const preSell =
    bearishScore >= 76 &&

    bearishScore >=
      bullishScore + 28 &&

    mainDown &&

    trend5 === "BEARISH" &&

    RSI1 <= 48 &&
    RSI1 >= 33 &&

    MACD1?.histogram < 0 &&

    MACD5?.histogram < 0 &&

    structure !== "BULLISH" &&

    livePrice < VWAP &&

    livePrice <
      Bollinger.middle &&

    volumeOK &&

    volatilityOK &&

    roomToSupportATR !== null &&
    roomToSupportATR >= 1.4;

  let orderBookData = null;
  let tradeFlowData = null;

  let signal =
    "WAIT";

  /*
    Extra depth/trade requests happen only after
    candle-based prequalification.
  */
  if (
    preBuy ||
    preSell
  ) {
    const [
      depth,
      trades
    ] =
      await Promise.all([
        getJSON(
          `/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=20`
        ),

        getJSON(
          `/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=500`
        )
      ]);

    orderBookData =
      analyzeOrderBook(depth);

    tradeFlowData =
      analyzeTradeFlow(trades);

    if (
      preBuy &&

      orderBookData.spreadBps < 3 &&

      orderBookData.imbalance > -12 &&

      orderBookData.microBiasBps > -0.08 &&

      tradeFlowData.flow15 > 0 &&

      tradeFlowData.flow30 > -5
    ) {
      signal =
        "BUY";

      if (
        orderBookData.imbalance >= 8
      ) {
        bullishScore += 4;
      }

      if (
        tradeFlowData.flow15 >= 10 &&
        tradeFlowData.flow30 >= 5
      ) {
        bullishScore += 6;
      }
    }

    if (
      preSell &&

      orderBookData.spreadBps < 3 &&

      orderBookData.imbalance < 12 &&

      orderBookData.microBiasBps < 0.08 &&

      tradeFlowData.flow15 < 0 &&

      tradeFlowData.flow30 < 5
    ) {
      signal =
        "SELL";

      if (
        orderBookData.imbalance <= -8
      ) {
        bearishScore += 4;
      }

      if (
        tradeFlowData.flow15 <= -10 &&
        tradeFlowData.flow30 <= -5
      ) {
        bearishScore += 6;
      }
    }
  }

  bullishScore =
    Math.min(
      100,
      bullishScore
    );

  bearishScore =
    Math.min(
      100,
      bearishScore
    );

  const signalStrength =
    signal === "BUY"

      ? bullishScore

      : signal === "SELL"

      ? bearishScore

      : Math.min(
          79,
          Math.max(
            bullishScore,
            bearishScore
          )
        );

  let entry = null;
  let tp = null;
  let sl = null;

  if (
    signal !== "WAIT" &&
    ATR
  ) {
    entry =
      livePrice;

    if (
      signal === "BUY"
    ) {
      tp =
        entry +
        ATR * SIGNAL_RR;

      sl =
        entry -
        ATR;
    }

    else {
      tp =
        entry -
        ATR * SIGNAL_RR;

      sl =
        entry +
        ATR;
    }
  }

  const blockers = [];

  if (!volumeOK) {
    blockers.push(
      "Volume filter failed"
    );
  }

  if (!volatilityOK) {
    blockers.push(
      "Volatility filter failed"
    );
  }

  if (
    signal === "WAIT" &&
    trend5 === "MIXED"
  ) {
    blockers.push(
      "5m trend mixed"
    );
  }

  if (
    signal === "WAIT" &&
    roomToResistanceATR !== null &&
    roomToResistanceATR < 1.4 &&
    bullishScore > bearishScore
  ) {
    blockers.push(
      "Not enough room to resistance"
    );
  }

  if (
    signal === "WAIT" &&
    roomToSupportATR !== null &&
    roomToSupportATR < 1.4 &&
    bearishScore > bullishScore
  ) {
    blockers.push(
      "Not enough room to support"
    );
  }

  if (
    signal === "WAIT" &&
    (
      preBuy ||
      preSell
    ) &&
    orderBookData &&
    tradeFlowData
  ) {
    blockers.push(
      "Microstructure confirmation failed"
    );
  }

  return {
    ok: true,

    engine:
      "Binance Signal Engine V8",

    symbol,

    signal,

    signalStrength,

    strengthMeaning:
      "Indicator confirmation strength, not win probability",

    timeframe: {
      entry:
        "live/1m",

      confirmation:
        "5m"
    },

    price:
      round(livePrice),

    closedPrice:
      round(closedPrice),

    trade: {
      entry:
        round(entry),

      tp:
        round(tp),

      sl:
        round(sl),

      riskReward:
        signal === "WAIT"
          ? null
          : SIGNAL_RR
    },

    scores: {
      bullish:
        bullishScore,

      bearish:
        bearishScore,

      difference:
        Math.abs(
          bullishScore -
          bearishScore
        )
    },

    trend: {
      oneMinute:
        EMA9 > EMA21
          ? "UP"
          : EMA9 < EMA21
          ? "DOWN"
          : "FLAT",

      fiveMinute:
        trend5,

      main:
        mainUp
          ? "UP"
          : mainDown
          ? "DOWN"
          : "FLAT",

      marketStructure:
        structure
    },

    indicators: {
      rsi1m:
        round(RSI1, 2),

      rsi5m:
        round(RSI5, 2),

      ema9:
        round(EMA9),

      ema21:
        round(EMA21),

      ema50:
        round(EMA50),

      ema200:
        round(EMA200),

      macd1mHistogram:
        MACD1
          ? round(
              MACD1.histogram
            )
          : null,

      macd5mHistogram:
        MACD5
          ? round(
              MACD5.histogram
            )
          : null,

      atr14:
        round(ATR),

      closedCandleVolumeRatio:
        round(VR, 2),

      vwap:
        round(VWAP),

      bollinger: {
        lower:
          round(
            Bollinger.lower
          ),

        middle:
          round(
            Bollinger.middle
          ),

        upper:
          round(
            Bollinger.upper
          )
      },

      support:
        round(
          SR.support
        ),

      resistance:
        round(
          SR.resistance
        ),

      roomToResistanceATR:
        round(
          roomToResistanceATR,
          2
        ),

      roomToSupportATR:
        round(
          roomToSupportATR,
          2
        )
    },

    microstructure:
      orderBookData &&
      tradeFlowData

        ? {
            orderBookImbalance:
              round(
                orderBookData.imbalance,
                2
              ),

            spreadBps:
              round(
                orderBookData.spreadBps,
                4
              ),

            micropriceBiasBps:
              round(
                orderBookData.microBiasBps,
                4
              ),

            tradeFlow15s:
              round(
                tradeFlowData.flow15,
                2
              ),

            tradeFlow30s:
              round(
                tradeFlowData.flow30,
                2
              ),

            recentTrades15s:
              tradeFlowData.count15,

            recentTrades30s:
              tradeFlowData.count30
          }

        : null,

    confirmations: {
      bullish,
      bearish
    },

    gates: {
      volumeOK,
      volatilityOK,
      preBuy,
      preSell
    },

    blockers,

    candle: {
      dataType:
        "CLOSED_CANDLES_FOR_INDICATORS",

      lastClosed1m:
        new Date(
          Number(
            candles1m.at(-1)[6]
          )
        ).toISOString(),

      lastClosed5m:
        new Date(
          Number(
            candles5m.at(-1)[6]
          )
        ).toISOString()
    },

    generatedAt:
      new Date().toISOString(),

    warning:
      "Market-analysis signal only. Test results do not guarantee future trading performance."
  };
}

async function scan() {
  const results = [];

  /*
    3 symbols per batch.
    3 × 2 initial requests = maximum 6 simultaneous
    outgoing connections.
  */
  for (
    let i = 0;
    i < PAIRS.length;
    i += 3
  ) {
    const batch =
      PAIRS.slice(
        i,
        i + 3
      );

    const batchResults =
      await Promise.all(
        batch.map(
          async symbol => {
            try {
              return await analyze(
                symbol
              );
            }

            catch (error) {
              return {
                ok: false,

                symbol,

                signal:
                  "ERROR",

                error:
                  error?.message ||
                  String(error)
              };
            }
          }
        )
      );

    results.push(
      ...batchResults
    );
  }

  const signals =
    results
      .filter(
        result =>
          result.ok &&

          (
            result.signal ===
              "BUY" ||

            result.signal ===
              "SELL"
          ) &&

          result.signalStrength >=
            MIN_SIGNAL_STRENGTH
      )

      .sort(
        (a, b) =>
          b.signalStrength -
          a.signalStrength
      );

  return {
    ok: true,

    engine:
      "Binance Signal Engine V8",

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

async function listTests(env) {
  if (!env?.SIGNAL_TEST) {
    throw new Error(
      "SIGNAL_TEST KV binding not found"
    );
  }

  const listing =
    await env.SIGNAL_TEST.list({
      prefix:
        TEST_PREFIX
    });

  const records = [];

  for (
    const key of
    listing.keys.slice(
      0,
      TEST_TARGET + 10
    )
  ) {
    const record =
      await env.SIGNAL_TEST.get(
        key.name,
        "json"
      );

    if (record) {
      records.push(record);
    }
  }

  records.sort(
    (a, b) =>
      new Date(a.createdAt) -
      new Date(b.createdAt)
  );

  return records;
}

function makeTestId(signal) {
  const candleMs =
    new Date(
      signal.candle
        .lastClosed1m
    ).getTime();

  const bucket =
    Math.floor(
      candleMs /
      TEST_BUCKET_MS
    );

  return (
    `${TEST_PREFIX}` +
    `${signal.symbol}:` +
    `${signal.signal}:` +
    `${bucket}`
  );
}

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
    existing.length >=
    TEST_TARGET
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
      existing.length +
      added >=
      TEST_TARGET
    ) {
      break;
    }

    if (
      !signal?.ok ||

      ![
        "BUY",
        "SELL"
      ].includes(
        signal.signal
      ) ||

      signal.signalStrength <
        MIN_SIGNAL_STRENGTH
    ) {
      continue;
    }

    const activeSameSymbol =
      existing.some(
        record =>
          record.symbol ===
            signal.symbol &&

          [
            "ARMED",
            "PENDING"
          ].includes(
            record.status
          )
      );

    if (activeSameSymbol) {
      continue;
    }

    const testId =
      makeTestId(signal);

    if (
      existing.some(
        record =>
          record.testId ===
          testId
      )
    ) {
      continue;
    }

    const createdMs =
      Date.now();

    /*
      Test begins at the NEXT complete 1m candle.
      This removes pre-signal intraminute contamination.
    */
    const armTime =
      Math.ceil(
        createdMs /
        60000
      ) * 60000;

    const record = {
      testId,

      symbol:
        signal.symbol,

      signal:
        signal.signal,

      strength:
        signal.signalStrength,

      atrAtSignal:
        Number(
          signal.indicators
            .atr14
        ),

      suggestedEntry:
        Number(
          signal.trade.entry
        ),

      suggestedTp:
        Number(
          signal.trade.tp
        ),

      suggestedSl:
        Number(
          signal.trade.sl
        ),

      entry: null,
      tp: null,
      sl: null,

      riskReward:
        SIGNAL_RR,

      status:
        "ARMED",

      result:
        null,

      createdAt:
        new Date(
          createdMs
        ).toISOString(),

      armTime:
        new Date(
          armTime
        ).toISOString(),

      resolvedAt:
        null,

      exitPrice:
        null,

      resolution:
        null
    };

    await env.SIGNAL_TEST.put(
      testId,
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

async function validateRecord(
  env,
  record
) {
  if (
    ![
      "ARMED",
      "PENDING"
    ].includes(
      record.status
    )
  ) {
    return false;
  }

  const armMs =
    new Date(
      record.armTime
    ).getTime();

  if (
    Date.now() <
    armMs + 1000
  ) {
    return false;
  }

  const rows =
    await getJSON(
      `/api/v3/klines?symbol=${encodeURIComponent(record.symbol)}&interval=1m&startTime=${armMs}&limit=1000`
    );

  if (
    !Array.isArray(rows) ||
    !rows.length
  ) {
    return false;
  }

  let changed =
    false;

  if (
    record.status ===
    "ARMED"
  ) {
    const firstOpen =
      Number(
        rows[0][1]
      );

    const atrValue =
      Number(
        record.atrAtSignal
      );

    if (
      !Number.isFinite(
        firstOpen
      ) ||

      !Number.isFinite(
        atrValue
      ) ||

      atrValue <= 0
    ) {
      return false;
    }

    record.entry =
      firstOpen;

    if (
      record.signal ===
      "BUY"
    ) {
      record.tp =
        firstOpen +
        atrValue *
        SIGNAL_RR;

      record.sl =
        firstOpen -
        atrValue;
    }

    else {
      record.tp =
        firstOpen -
        atrValue *
        SIGNAL_RR;

      record.sl =
        firstOpen +
        atrValue;
    }

    record.status =
      "PENDING";

    changed =
      true;
  }

  for (const row of rows) {
    const openTime =
      Number(row[0]);

    if (
      openTime <
      armMs
    ) {
      continue;
    }

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

    if (
      record.signal ===
      "BUY"
    ) {
      tpHit =
        high >=
        record.tp;

      slHit =
        low <=
        record.sl;
    }

    else {
      tpHit =
        low <=
        record.tp;

      slHit =
        high >=
        record.sl;
    }

    if (
      tpHit &&
      slHit
    ) {
      record.status =
        "AMBIGUOUS";

      record.result =
        "AMBIGUOUS";

      record.exitPrice =
        close;

      record.resolvedAt =
        new Date(
          candleClose
        ).toISOString();

      record.resolution =
        "TP and SL touched in the same 1m candle; intrabar order is unknown.";

      changed =
        true;

      break;
    }

    if (tpHit) {
      record.status =
        "CLOSED";

      record.result =
        "WIN";

      record.exitPrice =
        record.tp;

      record.resolvedAt =
        new Date(
          candleClose
        ).toISOString();

      record.resolution =
        "TP hit before SL";

      changed =
        true;

      break;
    }

    if (slHit) {
      record.status =
        "CLOSED";

      record.result =
        "LOSS";

      record.exitPrice =
        record.sl;

      record.resolvedAt =
        new Date(
          candleClose
        ).toISOString();

      record.resolution =
        "SL hit before TP";

      changed =
        true;

      break;
    }
  }

  if (changed) {
    await env.SIGNAL_TEST.put(
      record.testId,
      JSON.stringify(record)
    );
  }

  return changed;
}

async function validatePending(
  env,
  maxCount = 20
) {
  const records =
    await listTests(env);

  let checked = 0;
  let changed = 0;

  for (const record of records) {
    if (
      ![
        "ARMED",
        "PENDING"
      ].includes(
        record.status
      )
    ) {
      continue;
    }

    if (
      checked >=
      maxCount
    ) {
      break;
    }

    checked++;

    try {
      if (
        await validateRecord(
          env,
          record
        )
      ) {
        changed++;
      }
    }

    catch (_) {
      // Temporary Binance failure:
      // keep the test unchanged.
    }
  }

  return {
    checked,
    changed
  };
}

function buildReport(records) {
  const wins =
    records.filter(
      record =>
        record.result ===
        "WIN"
    );

  const losses =
    records.filter(
      record =>
        record.result ===
        "LOSS"
    );

  const armed =
    records.filter(
      record =>
        record.status ===
        "ARMED"
    );

  const pending =
    records.filter(
      record =>
        record.status ===
        "PENDING"
    );

  const ambiguous =
    records.filter(
      record =>
        record.result ===
        "AMBIGUOUS"
    );

  const completed =
    wins.length +
    losses.length;

  function performance(side) {
    const closed =
      records.filter(
        record =>
          record.signal ===
            side &&

          (
            record.result ===
              "WIN" ||

            record.result ===
              "LOSS"
          )
      );

    const sideWins =
      closed.filter(
        record =>
          record.result ===
          "WIN"
      ).length;

    return {
      completed:
        closed.length,

      wins:
        sideWins,

      losses:
        closed.length -
        sideWins,

      winRate:
        closed.length
          ? round(
              sideWins /
              closed.length *
              100,
              2
            )
          : null
    };
  }

  return {
    ok: true,

    engine:
      "Binance Signal Engine V8 Auto Test",

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

    armed:
      armed.length,

    pending:
      pending.length,

    completed,

    wins:
      wins.length,

    losses:
      losses.length,

    ambiguous:
      ambiguous.length,

    historicalWinRate:
      completed
        ? round(
            wins.length /
            completed *
            100,
            2
          )
        : null,

    averageSignalStrength:
      records.length
        ? round(
            avg(
              records.map(
                record =>
                  Number(
                    record.strength
                  ) || 0
              )
            ),
            2
          )
        : null,

    buyPerformance:
      performance("BUY"),

    sellPerformance:
      performance("SELL"),

    note:
      "Historical test results only. Ambiguous candles are excluded from win rate. Results do not guarantee future performance.",

    signals:
      records
  };
}

async function getTestReport(env) {
  return buildReport(
    await listTests(env)
  );
}

async function resetTests(env) {
  if (!env?.SIGNAL_TEST) {
    throw new Error(
      "SIGNAL_TEST KV binding not found"
    );
  }

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
      "V8 test history reset"
  };
}

async function runCycle(env) {
  /*
    Worst case external requests:
    Base scan = 20
    Microstructure max = 20
    Validation max = 4
    Total = 44
  */

  await validatePending(
    env,
    MAX_AUTO_VALIDATIONS_PER_CYCLE
  );

  const market =
    await scan();

  const storage =
    await saveSignalsForTest(
      env,
      market.signals || []
    );

  const report =
    await getTestReport(
      env
    );

  return {
    ...market,

    autoTest: {
      target:
        TEST_TARGET,

      storage,

      report
    }
  };
}

export default {

  async fetch(
    request,
    env
  ) {
    if (
      request.method ===
      "OPTIONS"
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
        new URL(
          request.url
        );

      const path =
        url.pathname.replace(
          /\/+$/,
          ""
        ) || "/";

      if (
        path === "/"
      ) {
        return json({
          ok: true,

          engine:
            "Binance Signal Engine V8",

          endpoints: [
            "/health",
            "/pairs",
            "/signal?symbol=BTCUSDT",
            "/scan",
            "/cycle",
            "/test/results",
            "/test/check",
            "/test/reset"
          ]
        });
      }

      if (
        path ===
        "/health"
      ) {
        const server =
          await getJSON(
            "/api/v3/time"
          );

        return json({
          ok: true,

          engine:
            "Binance Signal Engine V8",

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

      if (
        path ===
        "/pairs"
      ) {
        return json({
          ok: true,

          count:
            PAIRS.length,

          pairs:
            PAIRS
        });
      }

      if (
        path ===
        "/signal"
      ) {
        const symbol =
          url.searchParams.get(
            "symbol"
          ) ||
          "BTCUSDT";

        const result =
          await analyze(
            symbol
          );

        return json(
          result,
          result.ok
            ? 200
            : 400
        );
      }

      if (
        path ===
        "/scan"
      ) {
        return json(
          await scan()
        );
      }

      if (
        path ===
        "/cycle"
      ) {
        return json(
          await runCycle(
            env
          )
        );
      }

      if (
        path ===
        "/test/results"
      ) {
        return json(
          await getTestReport(
            env
          )
        );
      }

      if (
        path ===
        "/test/check"
      ) {
        await validatePending(
          env,
          20
        );

        return json(
          await getTestReport(
            env
          )
        );
      }

      if (
        path ===
        "/test/reset"
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

          error:
            "Not found",

          path
        },
        404
      );
    }

    catch (error) {
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
  },

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      runCycle(env)

        .then(result => {
          console.log(
            "V8 cycle",

            JSON.stringify({
              signalsFound:
                result.signalsFound,

              collected:
                result.autoTest
                  ?.report
                  ?.collected,

              completed:
                result.autoTest
                  ?.report
                  ?.completed,

              wins:
                result.autoTest
                  ?.report
                  ?.wins,

              losses:
                result.autoTest
                  ?.report
                  ?.losses
            })
          );
        })

        .catch(error => {
          console.error(
            "V8 scheduled cycle failed",
            error
          );
        })
    );
  }
};
