const PAIRS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","TRXUSDT"
];

const API = "https://api-gcp.binance.com";

const CORS = {
  "content-type": "application/json; charset=UTF-8",
  "access-control-allow-origin": "*",
  "cache-control": "no-store"
};

function json(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    { status, headers: CORS }
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
    const body =
      await response
        .text()
        .catch(() => "");

    throw new Error(
      `Binance HTTP ${response.status} ${path}` +
      (body
        ? ` • ${body.slice(0, 120)}`
        : "")
    );
  }

  return response.json();
}

function avg(values) {
  return values.length
    ? values.reduce(
        (a, b) => a + b,
        0
      ) / values.length
    : 0;
}

function ema(values, period) {
  if (
    !values ||
    values.length < period
  ) {
    return null;
  }

  let value =
    avg(
      values.slice(0, period)
    );

  const multiplier =
    2 / (period + 1);

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    value =
      values[i] * multiplier +
      value * (1 - multiplier);
  }

  return value;
}

function emaSeries(
  values,
  period
) {
  if (
    !values ||
    values.length < period
  ) {
    return [];
  }

  let value =
    avg(
      values.slice(0, period)
    );

  const multiplier =
    2 / (period + 1);

  const output =
    [value];

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    value =
      values[i] *
        multiplier +
      value *
        (1 - multiplier);

    output.push(value);
  }

  return output;
}

function rsi(
  values,
  period = 14
) {
  if (
    !values ||
    values.length <= period
  ) {
    return null;
  }

  const gains = [];
  const losses = [];

  for (
    let i = 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] -
      values[i - 1];

    gains.push(
      Math.max(change, 0)
    );

    losses.push(
      Math.max(-change, 0)
    );
  }

  let avgGain =
    avg(
      gains.slice(
        0,
        period
      )
    );

  let avgLoss =
    avg(
      losses.slice(
        0,
        period
      )
    );

  for (
    let i = period;
    i < gains.length;
    i++
  ) {
    avgGain =
      (
        avgGain *
          (period - 1) +
        gains[i]
      ) / period;

    avgLoss =
      (
        avgLoss *
          (period - 1) +
        losses[i]
      ) / period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  return (
    100 -
    100 /
      (
        1 +
        avgGain /
          avgLoss
      )
  );
}

function macdHistogram(
  values
) {
  const fast =
    emaSeries(
      values,
      12
    );

  const slow =
    emaSeries(
      values,
      26
    );

  if (!slow.length) {
    return null;
  }

  const offset =
    fast.length -
    slow.length;

  const line =
    slow.map(
      (value, index) =>
        fast[
          index + offset
        ] - value
    );

  const signal =
    ema(line, 9);

  return signal == null
    ? null
    : line.at(-1) -
        signal;
}

function std(
  values,
  period
) {
  if (
    !values ||
    values.length < period
  ) {
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
          (
            value -
            mean
          ) ** 2
      )
    )
  );
}

function atr(
  candles,
  period = 14
) {
  if (
    !candles ||
    candles.length <
      period + 1
  ) {
    return null;
  }

  const trueRanges = [];

  for (
    let i = 1;
    i < candles.length;
    i++
  ) {
    const high =
      +candles[i][2];

    const low =
      +candles[i][3];

    const previousClose =
      +candles[
        i - 1
      ][4];

    trueRanges.push(
      Math.max(
        high - low,

        Math.abs(
          high -
          previousClose
        ),

        Math.abs(
          low -
          previousClose
        )
      )
    );
  }

  return avg(
    trueRanges.slice(
      -period
    )
  );
}

function vwap(
  candles,
  limit = 60
) {
  let priceVolume = 0;
  let volume = 0;

  for (
    const candle of
    candles.slice(-limit)
  ) {
    const typicalPrice =
      (
        +candle[2] +
        +candle[3] +
        +candle[4]
      ) / 3;

    const candleVolume =
      +candle[5];

    priceVolume +=
      typicalPrice *
      candleVolume;

    volume +=
      candleVolume;
  }

  return volume
    ? priceVolume /
        volume
    : null;
}

function marketStructure(
  candles
) {
  const recent =
    candles.slice(-10);

  if (
    recent.length < 10
  ) {
    return "RANGE";
  }

  const first =
    recent.slice(0, 5);

  const second =
    recent.slice(5);

  const firstHigh =
    Math.max(
      ...first.map(
        candle =>
          +candle[2]
      )
    );

  const firstLow =
    Math.min(
      ...first.map(
        candle =>
          +candle[3]
      )
    );

  const secondHigh =
    Math.max(
      ...second.map(
        candle =>
          +candle[2]
      )
    );

  const secondLow =
    Math.min(
      ...second.map(
        candle =>
          +candle[3]
      )
    );

  if (
    secondHigh >
      firstHigh &&
    secondLow >
      firstLow
  ) {
    return "HH/HL";
  }

  if (
    secondHigh <
      firstHigh &&
    secondLow <
      firstLow
  ) {
    return "LH/LL";
  }

  return "RANGE";
}

function supportResistance(
  candles
) {
  const recent =
    candles.slice(-50);

  return {
    support:
      Math.min(
        ...recent.map(
          candle =>
            +candle[3]
        )
      ),

    resistance:
      Math.max(
        ...recent.map(
          candle =>
            +candle[2]
        )
      )
  };
}

function rsiDivergence(
  candles
) {
  if (
    !candles ||
    candles.length < 35
  ) {
    return "NONE";
  }

  const closes =
    candles.map(
      candle =>
        +candle[4]
    );

  const rsiValues =
    [];

  for (
    let i = 15;
    i <= closes.length;
    i++
  ) {
    rsiValues.push(
      rsi(
        closes.slice(0, i),
        14
      )
    );
  }

  const offset =
    closes.length -
    rsiValues.length;

  const lows = [];
  const highs = [];

  const start =
    Math.max(
      2,
      closes.length - 24
    );

  for (
    let i = start;
    i < closes.length - 2;
    i++
  ) {
    if (
      closes[i] <
        closes[i - 1] &&
      closes[i] <=
        closes[i - 2] &&
      closes[i] <
        closes[i + 1] &&
      closes[i] <=
        closes[i + 2]
    ) {
      lows.push(i);
    }

    if (
      closes[i] >
        closes[i - 1] &&
      closes[i] >=
        closes[i - 2] &&
      closes[i] >
        closes[i + 1] &&
      closes[i] >=
        closes[i + 2]
    ) {
      highs.push(i);
    }
  }

  if (
    lows.length >= 2
  ) {
    const first =
      lows.at(-2);

    const second =
      lows.at(-1);

    const firstRSI =
      rsiValues[
        first - offset
      ];

    const secondRSI =
      rsiValues[
        second - offset
      ];

    if (
      firstRSI != null &&
      secondRSI != null &&
      closes[second] <
        closes[first] &&
      secondRSI >
        firstRSI
    ) {
      return "BULLISH";
    }
  }

  if (
    highs.length >= 2
  ) {
    const first =
      highs.at(-2);

    const second =
      highs.at(-1);

    const firstRSI =
      rsiValues[
        first - offset
      ];

    const secondRSI =
      rsiValues[
        second - offset
      ];

    if (
      firstRSI != null &&
      secondRSI != null &&
      closes[second] >
        closes[first] &&
      secondRSI <
        firstRSI
    ) {
      return "BEARISH";
    }
  }

  return "NONE";
}

function analyzeOrderBook(
  book
) {
  const bids =
    (
      book.bids ||
      []
    ).slice(0, 20);

  const asks =
    (
      book.asks ||
      []
    ).slice(0, 20);

  const bidNotional =
    bids.reduce(
      (sum, row) =>
        sum +
        (+row[0]) *
        (+row[1]),
      0
    );

  const askNotional =
    asks.reduce(
      (sum, row) =>
        sum +
        (+row[0]) *
        (+row[1]),
      0
    );

  const total =
    bidNotional +
    askNotional;

  const imbalance =
    total
      ? (
          (
            bidNotional -
            askNotional
          ) /
          total
        ) * 100
      : 0;

  const bestBid =
    bids.length
      ? +bids[0][0]
      : 0;

  const bestAsk =
    asks.length
      ? +asks[0][0]
      : 0;

  const bidQty =
    bids.length
      ? +bids[0][1]
      : 0;

  const askQty =
    asks.length
      ? +asks[0][1]
      : 0;

  const midpoint =
    bestBid &&
    bestAsk
      ? (
          bestBid +
          bestAsk
        ) / 2
      : 0;

  const microPrice =
    bidQty + askQty
      ? (
          bestAsk *
            bidQty +
          bestBid *
            askQty
        ) /
        (
          bidQty +
          askQty
        )
      : midpoint;

  return {
    imbalance,

    spreadBps:
      midpoint
        ? (
            (
              bestAsk -
              bestBid
            ) /
            midpoint
          ) * 10000
        : 0,

    microBiasBps:
      midpoint
        ? (
            (
              microPrice -
              midpoint
            ) /
            midpoint
          ) * 10000
        : 0
  };
}

function analyzeAggTrades(
  trades
) {
  const now =
    Date.now();

  const recent15 =
    trades.filter(
      trade =>
        now -
          (+trade.T) <=
        15000
    );

  const recent30 =
    trades.filter(
      trade =>
        now -
          (+trade.T) <=
        30000
    );

  let buy15 = 0;
  let sell15 = 0;
  let buy30 = 0;
  let sell30 = 0;

  for (
    const trade of
    recent30
  ) {
    const notional =
      (+trade.p) *
      (+trade.q);

    if (trade.m) {
      sell30 +=
        notional;
    } else {
      buy30 +=
        notional;
    }

    if (
      now -
        (+trade.T) <=
      15000
    ) {
      if (trade.m) {
        sell15 +=
          notional;
      } else {
        buy15 +=
          notional;
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

    recentTrades15:
      recent15.length,

    recentTrades30:
      recent30.length,

    first15Price:
      recent15.length
        ? +recent15[0].p
        : null,

    first30Price:
      recent30.length
        ? +recent30[0].p
        : null
  };
}

async function fetchBTCContext() {

  const [
    candles1m,
    candles5m
  ] =
    await Promise.all([

      getJSON(
        "/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=60"
      ),

      getJSON(
        "/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=60"
      )
    ]);

  const closes1m =
    candles1m
      .slice(0, -1)
      .map(
        candle =>
          +candle[4]
      );

  const closes5m =
    candles5m
      .slice(0, -1)
      .map(
        candle =>
          +candle[4]
      );

  return {
    trend1m:
      ema(
        closes1m,
        9
      ) >
      ema(
        closes1m,
        21
      )
        ? "UP"
        : "DOWN",

    trend5m:
      ema(
        closes5m,
        9
      ) >
      ema(
        closes5m,
        21
      )
        ? "UP"
        : "DOWN"
  };
}

async function buildSignal(
  symbol,
  btcContext = null
) {

  const [
    candles1m,
    candles5m,
    depth,
    trades
  ] =
    await Promise.all([

      getJSON(
        `/api/v3/klines?symbol=${symbol}&interval=1m&limit=210`
      ),

      getJSON(
        `/api/v3/klines?symbol=${symbol}&interval=5m&limit=80`
      ),

      getJSON(
        `/api/v3/depth?symbol=${symbol}&limit=20`
      ),

      getJSON(
        `/api/v3/aggTrades?symbol=${symbol}&limit=500`
      )
    ]);

  const closed1m =
    candles1m.slice(
      0,
      -1
    );

  const closed5m =
    candles5m.slice(
      0,
      -1
    );

  const closes1m =
    closed1m.map(
      candle =>
        +candle[4]
    );

  const closes5m =
    closed5m.map(
      candle =>
        +candle[4]
    );

  const volumes =
    closed1m.map(
      candle =>
        +candle[5]
    );

  const price =
    +candles1m.at(-1)[4];

  const EMA9 =
    ema(
      closes1m,
      9
    );

  const EMA21 =
    ema(
      closes1m,
      21
    );

  const EMA50 =
    ema(
      closes1m,
      50
    );

  const EMA200 =
    ema(
      closes1m,
      200
    );

  const RSI =
    rsi(
      closes1m,
      14
    );

  const MACD =
    macdHistogram(
      closes1m
    );

  const ATR =
    atr(
      closed1m,
      14
    );

  const VWAP =
    vwap(
      closed1m,
      60
    );

  const middle =
    avg(
      closes1m.slice(-20)
    );

  const deviation =
    std(
      closes1m,
      20
    );

  const Bollinger = {
    lower:
      middle -
      2 * deviation,

    middle,

    upper:
      middle +
      2 * deviation
  };

  const structure =
    marketStructure(
      closed1m
    );

  const SR =
    supportResistance(
      closed1m
    );

  const divergence =
    rsiDivergence(
      closed1m
    );

  const trend5m =
    ema(
      closes5m,
      9
    ) >
    ema(
      closes5m,
      21
    )
      ? "UP"
      : "DOWN";

  const averageVolume =
    avg(
      volumes.slice(
        -21,
        -1
      )
    );

  const volumeRatio =
    averageVolume
      ? volumes.at(-1) /
        averageVolume
      : 1;

  const orderBook =
    analyzeOrderBook(
      depth
    );

  const tradeFlow =
    analyzeAggTrades(
      trades
    );

  const price15 =
    tradeFlow
      .first15Price ||
    price;

  const price30 =
    tradeFlow
      .first30Price ||
    price;

  const momentum15 =
    price15
      ? (
          (
            price -
            price15
          ) /
          price15
        ) * 100
      : 0;

  const momentum30 =
    price30
      ? (
          (
            price -
            price30
          ) /
          price30
        ) * 100
      : 0;

  const btcTrend1m =
    symbol === "BTCUSDT"
      ? EMA9 >
        EMA21
        ? "UP"
        : "DOWN"
      : (
          btcContext
            ?.trend1m ||
          "UNKNOWN"
        );

  const btcTrend5m =
    symbol === "BTCUSDT"
      ? trend5m
      : (
          btcContext
            ?.trend5m ||
          "UNKNOWN"
        );

  let longScore = 0;
  let shortScore = 0;

  const longReasons = [];
  const shortReasons = [];

  function add(
    longCondition,
    shortCondition,
    weight,
    longText,
    shortText
  ) {
    if (longCondition) {
      longScore +=
        weight;

      longReasons.push(
        longText
      );
    }

    else if (
      shortCondition
    ) {
      shortScore +=
        weight;

      shortReasons.push(
        shortText
      );
    }
  }

  add(
    EMA9 > EMA21,
    EMA9 < EMA21,
    9,
    "EMA9 > EMA21",
    "EMA9 < EMA21"
  );

  add(
    EMA50 > EMA200,
    EMA50 < EMA200,
    9,
    "EMA50 > EMA200",
    "EMA50 < EMA200"
  );

  add(
    price > EMA50,
    price < EMA50,
    6,
    "Price > EMA50",
    "Price < EMA50"
  );

  add(
    RSI >= 52 &&
      RSI < 70,

    RSI <= 48 &&
      RSI > 30,

    8,

    "RSI bullish",

    "RSI bearish"
  );

  add(
    MACD > 0,
    MACD < 0,
    9,
    "MACD bullish",
    "MACD bearish"
  );

  add(
    price > VWAP,
    price < VWAP,
    8,
    "Above VWAP",
    "Below VWAP"
  );

  add(
    structure ===
      "HH/HL",

    structure ===
      "LH/LL",

    8,

    "HH/HL",

    "LH/LL"
  );

  add(
    trend5m === "UP",
    trend5m === "DOWN",
    6,
    "5m trend UP",
    "5m trend DOWN"
  );

  add(
    divergence ===
      "BULLISH",

    divergence ===
      "BEARISH",

    5,

    "Bullish RSI divergence",

    "Bearish RSI divergence"
  );

  add(
    btcTrend1m === "UP" &&
      btcTrend5m === "UP",

    btcTrend1m === "DOWN" &&
      btcTrend5m === "DOWN",

    6,

    "BTC aligned UP",

    "BTC aligned DOWN"
  );

  add(
    orderBook
      .imbalance >= 8,

    orderBook
      .imbalance <= -8,

    8,

    "Order book bullish",

    "Order book bearish"
  );

  add(
    tradeFlow
      .flow15 >= 10 &&
      tradeFlow
        .flow30 >= 5,

    tradeFlow
      .flow15 <= -10 &&
      tradeFlow
        .flow30 <= -5,

    10,

    "Taker flow bullish",

    "Taker flow bearish"
  );

  add(
    momentum15 >
      0.01 &&
      momentum30 >
        0.015,

    momentum15 <
      -0.01 &&
      momentum30 <
        -0.015,

    5,

    "Short momentum UP",

    "Short momentum DOWN"
  );

  if (
    volumeRatio >= 0.8
  ) {
    if (
      longScore >
      shortScore
    ) {
      longScore += 5;

      longReasons.push(
        "Volume supports long"
      );
    }

    else if (
      shortScore >
      longScore
    ) {
      shortScore += 5;

      shortReasons.push(
        "Volume supports short"
      );
    }
  }

  longScore =
    Math.min(
      100,
      longScore
    );

  shortScore =
    Math.min(
      100,
      shortScore
    );

  const difference =
    Math.abs(
      longScore -
      shortScore
    );

  const marketOK =
    orderBook
      .spreadBps < 3 &&
    volumeRatio >= 0.35 &&
    volumeRatio <= 3.5 &&
    ATR &&
    ATR / price >=
      0.00012;

  const longMicroOK =
    tradeFlow
      .flow15 > 5 &&
    tradeFlow
      .flow30 > 0 &&
    orderBook
      .imbalance > -5 &&
    orderBook
      .microBiasBps >
      -0.05 &&
    momentum15 >
      -0.015;

  const shortMicroOK =
    tradeFlow
      .flow15 < -5 &&
    tradeFlow
      .flow30 < 0 &&
    orderBook
      .imbalance < 5 &&
    orderBook
      .microBiasBps <
      0.05 &&
    momentum15 <
      0.015;

  let signal =
    "WAIT";

  if (
    marketOK &&
    longMicroOK &&
    longScore >= 72 &&
    longScore >
      shortScore &&
    difference >= 22
  ) {
    signal =
      longScore >= 88
        ? "STRONG BUY"
        : "BUY";
  }

  if (
    marketOK &&
    shortMicroOK &&
    shortScore >= 72 &&
    shortScore >
      longScore &&
    difference >= 22
  ) {
    signal =
      shortScore >= 88
        ? "STRONG SELL"
        : "SELL";
  }

  const confirmationScore =
    signal === "WAIT"
      ? Math.min(
          69,
          Math.max(
            longScore,
            shortScore
          )
        )
      : Math.min(
          99,
          Math.max(
            longScore,
            shortScore
          )
        );

  const risk =
    ATR ||
    price * 0.0015;

  const tp =
    signal.includes("BUY")
      ? price +
        risk * 1.5

      : signal.includes("SELL")
      ? price -
        risk * 1.5

      : null;

  const sl =
    signal.includes("BUY")
      ? price -
        risk

      : signal.includes("SELL")
      ? price +
        risk

      : null;

  return {
    symbol,

    signal,

    confirmationScore,

    scoreMeaning:
      "confirmation_score_not_win_probability",

    price,

    longScore,

    shortScore,

    entry:
      signal === "WAIT"
        ? null
        : price,

    tp,

    sl,

    indicators: {
      RSI14:
        RSI,

      RSI_Divergence:
        divergence,

      EMA9,

      EMA21,

      EMA50,

      EMA200,

      MACDHistogram:
        MACD,

      VWAP,

      ATR14:
        ATR,

      Bollinger,

      volumeRatio,

      marketStructure:
        structure,

      trend5m,

      support:
        SR.support,

      resistance:
        SR.resistance,

      BTCTrend1m:
        btcTrend1m,

      BTCTrend5m:
        btcTrend5m,

      momentum15s:
        momentum15,

      momentum30s:
        momentum30
    },

    microstructure: {
      orderBookImbalance:
        orderBook.imbalance,

      micropriceBiasBps:
        orderBook.microBiasBps,

      spreadBps:
        orderBook.spreadBps,

      tradeFlow15s:
        tradeFlow.flow15,

      tradeFlow30s:
        tradeFlow.flow30,

      recentTrades15s:
        tradeFlow
          .recentTrades15,

      recentTrades30s:
        tradeFlow
          .recentTrades30
    },

    confirmation: {
      buy:
        longReasons,

      sell:
        shortReasons
    }
  };
}

async function scanAllPairs() {

  /*
    BTC context:
    2 Binance requests

    10 pairs × 4 requests:
    40 requests

    TOTAL:
    42 external subrequests
  */

  const btcContext =
    await fetchBTCContext();

  const allResults =
    await Promise.all(

      PAIRS.map(
        async symbol => {

          try {
            return await buildSignal(
              symbol,
              btcContext
            );
          }

          catch (error) {
            return {
              symbol,
              signal:
                "ERROR",
              error:
                error.message
            };
          }
        }
      )
    );

  const signals =
    allResults.filter(
      result =>
        result.signal ===
          "BUY" ||

        result.signal ===
          "SELL" ||

        result.signal ===
          "STRONG BUY" ||

        result.signal ===
          "STRONG SELL"
    );

  return {
    ok: true,

    checkedAt:
      new Date()
        .toISOString(),

    source:
      API,

    totalPairs:
      PAIRS.length,

    signalsFound:
      signals.length,

    signals,

    allResults
  };
}

export default {

  async fetch(request) {

    try {

      const url =
        new URL(
          request.url
        );

      if (
        request.method ===
        "OPTIONS"
      ) {

        return new Response(
          null,
          {
            headers: {

              "access-control-allow-origin":
                "*",

              "access-control-allow-methods":
                "GET,OPTIONS",

              "access-control-allow-headers":
                "*"
            }
          }
        );
      }

      if (
        url.pathname ===
        "/"
      ) {

        return new Response(
`Binance Signal Engine V3

/health
/pairs
/signal?symbol=BTCUSDT
/scan`,
          {
            headers: {
              "content-type":
                "text/plain;charset=UTF-8"
            }
          }
        );
      }

      if (
        url.pathname ===
        "/health"
      ) {

        const server =
          await getJSON(
            "/api/v3/time"
          );

        return json({
          ok: true,

          message:
            "Binance connection working",

          source:
            API,

          serverTime:
            server.serverTime
        });
      }

      if (
        url.pathname ===
        "/pairs"
      ) {

        return json({
          ok: true,
          pairs: PAIRS
        });
      }

      if (
        url.pathname ===
        "/signal"
      ) {

        const symbol =
          (
            url.searchParams
              .get("symbol") ||
            "BTCUSDT"
          ).toUpperCase();

        if (
          !PAIRS.includes(
            symbol
          )
        ) {

          return json(
            {
              ok: false,

              error:
                "Unsupported symbol",

              allowedPairs:
                PAIRS
            },
            400
          );
        }

        const btcContext =
          symbol === "BTCUSDT"
            ? null
            : await fetchBTCContext();

        return json(
          await buildSignal(
            symbol,
            btcContext
          )
        );
      }

      if (
        url.pathname ===
        "/scan"
      ) {

        return json(
          await scanAllPairs()
        );
      }

      return json(
        {
          ok: false,
          error:
            "Not found"
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

      scanAllPairs()

        .then(result => {

          console.log(
            "Background scan",

            JSON.stringify({
              checkedAt:
                result.checkedAt,

              signals:
                result.signals
            })
          );
        })

        .catch(error => {

          console.error(
            "Background scan failed",
            error
          );
        })
    );
  }
};
