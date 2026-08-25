// Binance Signal Engine V7 — strict signal engine + 20 unique auto-tests

const API = "https://api-gcp.binance.com";

const PAIRS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","TRXUSDT"
];

const TEST_TARGET = 20;
const TEST_STATE_KEY = "signal_test_v7_state";
const TEST_COOLDOWN_MS = 5 * 60 * 1000;
const MIN_SIGNAL_STRENGTH = 78;
const MAX_AUTO_VALIDATIONS_PER_CYCLE = 6;

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

function avg(v) {
  return v.length ? v.reduce((a,b)=>a+b,0) / v.length : 0;
}

function round(v, d = 8) {
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
}

async function getJSON(path) {
  const r = await fetch(API + path, {
    method: "GET",
    headers: { Accept: "application/json" }
  });

  if (!r.ok) {
    const body = await r.text().catch(() => "");

    throw new Error(
      `Binance HTTP ${r.status} ${path}` +
      (body ? ` - ${body.slice(0,120)}` : "")
    );
  }

  return r.json();
}

function ema(v, p) {
  if (!v || v.length < p) return null;

  let e = avg(v.slice(0,p));
  const k = 2 / (p + 1);

  for (let i = p; i < v.length; i++) {
    e = v[i] * k + e * (1-k);
  }

  return e;
}

function emaSeries(v, p) {
  if (!v || v.length < p) return [];

  let e = avg(v.slice(0,p));
  const k = 2 / (p + 1);

  const out = [e];

  for (let i = p; i < v.length; i++) {
    e = v[i] * k + e * (1-k);
    out.push(e);
  }

  return out;
}

function rsi(v, p = 14) {
  if (!v || v.length <= p) return null;

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= p; i++) {
    const d = v[i] - v[i-1];

    if (d >= 0) gain += d;
    else loss += Math.abs(d);
  }

  let ag = gain / p;
  let al = loss / p;

  for (let i = p + 1; i < v.length; i++) {
    const d = v[i] - v[i-1];

    const g = d > 0 ? d : 0;
    const l = d < 0 ? Math.abs(d) : 0;

    ag = (ag * (p-1) + g) / p;
    al = (al * (p-1) + l) / p;
  }

  return al === 0
    ? 100
    : 100 - (100 / (1 + ag/al));
}

function macd(v) {
  const fast = emaSeries(v, 12);
  const slow = emaSeries(v, 26);

  if (!fast.length || !slow.length) return null;

  const offset = fast.length - slow.length;

  const line = slow.map(
    (x,i) => fast[i + offset] - x
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
    const h = +rows[i][2];
    const l = +rows[i][3];
    const prevClose = +rows[i-1][4];

    tr.push(
      Math.max(
        h-l,
        Math.abs(h-prevClose),
        Math.abs(l-prevClose)
      )
    );
  }

  return ema(tr, p);
}

function volumeRatio(rows) {
  if (!rows || rows.length < 21) return null;

  const volumes = rows.map(r => +r[5]);

  const current = volumes.at(-1);
  const base = avg(volumes.slice(-21,-1));

  return base > 0
    ? current / base
    : 0;
}

function vwap(rows, n = 60) {
  let priceVolume = 0;
  let volume = 0;

  for (const r of rows.slice(-n)) {
    const typical =
      (+r[2] + +r[3] + +r[4]) / 3;

    const vol = +r[5];

    priceVolume += typical * vol;
    volume += vol;
  }

  return volume
    ? priceVolume / volume
    : null;
}

function std(v, p = 20) {
  if (!v || v.length < p) return null;

  const x = v.slice(-p);
  const mean = avg(x);

  return Math.sqrt(
    avg(
      x.map(n => (n - mean) ** 2)
    )
  );
}

function marketStructure(rows) {
  if (!rows || rows.length < 12) {
    return "RANGE";
  }

  const recent = rows.slice(-12);

  const first = recent.slice(0,6);
  const second = recent.slice(6);

  const firstHigh =
    Math.max(...first.map(r => +r[2]));

  const firstLow =
    Math.min(...first.map(r => +r[3]));

  const secondHigh =
    Math.max(...second.map(r => +r[2]));

  const secondLow =
    Math.min(...second.map(r => +r[3]));

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
  const recent = rows.slice(-50);

  return {
    support:
      Math.min(...recent.map(r => +r[3])),

    resistance:
      Math.max(...recent.map(r => +r[2]))
  };
}

function orderBook(book) {
  const bids =
    (book.bids || []).slice(0,20);

  const asks =
    (book.asks || []).slice(0,20);

  if (!bids.length || !asks.length) {
    return {
      imbalance: 0,
      spreadBps: 999,
      microBiasBps: 0
    };
  }

  const bidNotional =
    bids.reduce(
      (sum,r) =>
        sum + (+r[0]) * (+r[1]),
      0
    );

  const askNotional =
    asks.reduce(
      (sum,r) =>
        sum + (+r[0]) * (+r[1]),
      0
    );

  const bestBid = +bids[0][0];
  const bestAsk = +asks[0][0];

  const bidQty = +bids[0][1];
  const askQty = +asks[0][1];

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
            (bidNotional - askNotional) /
            (bidNotional + askNotional)
          ) * 100
        : 0,

    spreadBps:
      mid
        ? ((bestAsk - bestBid) / mid) * 10000
        : 999,

    microBiasBps:
      mid
        ? ((microPrice - mid) / mid) * 10000
        : 0
  };
}

function tradeFlow(trades) {
  const now = Date.now();

  let buy15 = 0;
  let sell15 = 0;

  let buy30 = 0;
  let sell30 = 0;

  let count15 = 0;
  let count30 = 0;

  for (const t of trades) {
    const age =
      now - Number(t.T);

    if (age > 30000) continue;

    const notional =
      Number(t.p) *
      Number(t.q);

    count30++;

    if (t.m) sell30 += notional;
    else buy30 += notional;

    if (age <= 15000) {
      count15++;

      if (t.m) sell15 += notional;
      else buy15 += notional;
    }
  }

  const total15 =
    buy15 + sell15;

  const total30 =
    buy30 + sell30;

  return {
    flow15:
      total15
        ? ((buy15 - sell15) / total15) * 100
        : 0,

    flow30:
      total30
        ? ((buy30 - sell30) / total30) * 100
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

  // Closed candles for indicators
  const candles1m =
    raw1m.slice(0,-1);

  const candles5m =
    raw5m.slice(0,-1);

  const closes1m =
    candles1m.map(r => +r[4]);

  const closes5m =
    candles5m.map(r => +r[4]);

  // Current forming-candle price used as entry reference
  const livePrice =
    +raw1m.at(-1)[4];

  const closedPrice =
    closes1m.at(-1);

  const lastClosed1m =
    +candles1m.at(-1)[6];

  const lastClosed5m =
    +candles5m.at(-1)[6];


  const EMA9 =
    ema(closes1m, 9);

  const EMA21 =
    ema(closes1m, 21);

  const EMA50 =
    ema(closes1m, 50);

  const EMA200 =
    ema(closes1m, 200);

  const RSI =
    rsi(closes1m, 14);

  const MACD =
    macd(closes1m);

  const ATR =
    atr(candles1m, 14);

  const VR =
    volumeRatio(candles1m);

  const VWAP =
    vwap(candles1m, 60);

  const middle =
    avg(closes1m.slice(-20));

  const deviation =
    std(closes1m, 20);

  const Bollinger = {
    lower:
      middle - 2 * deviation,

    middle,

    upper:
      middle + 2 * deviation
  };

  const structure =
    marketStructure(candles1m);

  const SR =
    supportResistance(candles1m);


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
    bullCondition,
    bearCondition,
    points,
    bullText,
    bearText
  ) {
    if (bullCondition) {
      bullishScore += points;
      bullish.push(bullText);
    }

    else if (bearCondition) {
      bearishScore += points;
      bearish.push(bearText);
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
    RSI >= 52 &&
      RSI <= 66,

    RSI <= 48 &&
      RSI >= 34,

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
      RSI5 <= 68,

    RSI5 <= 48 &&
      RSI5 >= 32,

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


  if (VR >= 1) {
    if (
      bullishScore >
      bearishScore
    ) {
      bullishScore += 6;

      bullish.push(
        "Closed-candle volume confirms bullish move"
      );
    }

    else if (
      bearishScore >
      bullishScore
    ) {
      bearishScore += 6;

      bearish.push(
        "Closed-candle volume confirms bearish move"
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


  const roomToResistanceATR =
    ATR
      ? (
          SR.resistance -
          livePrice
        ) / ATR
      : 0;


  const roomToSupportATR =
    ATR
      ? (
          livePrice -
          SR.support
        ) / ATR
      : 0;


  const volatilityOK =
    Boolean(ATR) &&
    ATR / livePrice >= 0.00012;


  /*
    Major fix:
    TRX/DOGE/ADA weak-volume entries seen in V6
    will be rejected below this threshold.
  */

  const volumeOK =
    VR >= 0.60 &&
    VR <= 3.5;


  const preBuy =
    bullishScore >= 74 &&

    bullishScore >=
      bearishScore + 30 &&

    mainUp &&

    trend5 === "BULLISH" &&

    RSI >= 52 &&
    RSI <= 66 &&

    MACD?.histogram > 0 &&

    MACD5?.histogram > 0 &&

    structure !== "BEARISH" &&

    livePrice > VWAP &&

    livePrice >
      Bollinger.middle &&

    volumeOK &&

    volatilityOK &&

    roomToResistanceATR >= 1.7;


  const preSell =
    bearishScore >= 74 &&

    bearishScore >=
      bullishScore + 30 &&

    mainDown &&

    trend5 === "BEARISH" &&

    RSI <= 48 &&
    RSI >= 34 &&

    MACD?.histogram < 0 &&

    MACD5?.histogram < 0 &&

    structure !== "BULLISH" &&

    livePrice < VWAP &&

    livePrice <
      Bollinger.middle &&

    volumeOK &&

    volatilityOK &&

    roomToSupportATR >= 1.7;


  let OB = null;
  let TF = null;

  let signal =
    "WAIT";


  /*
    Microstructure requests are made ONLY after
    candle-based prequalification.

    This keeps /scan under the Cloudflare Free
    external-subrequest ceiling.
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


    OB =
      orderBook(depth);

    TF =
      tradeFlow(trades);


    if (
      preBuy &&

      OB.spreadBps < 3 &&

      OB.imbalance > -15 &&

      OB.microBiasBps >
        -0.08 &&

      TF.flow15 > 0 &&

      TF.flow30 > -5
    ) {
      signal =
        "BUY";

      if (
        OB.imbalance >= 8
      ) {
        bullishScore += 4;
      }

      if (
        TF.flow15 >= 10 &&
        TF.flow30 >= 5
      ) {
        bullishScore += 6;
      }
    }


    if (
      preSell &&

      OB.spreadBps < 3 &&

      OB.imbalance < 15 &&

      OB.microBiasBps <
        0.08 &&

      TF.flow15 < 0 &&

      TF.flow30 < 5
    ) {
      signal =
        "SELL";

      if (
        OB.imbalance <= -8
      ) {
        bearishScore += 4;
      }

      if (
        TF.flow15 <= -10 &&
        TF.flow30 <= -5
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
          77,
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


    /*
      1.2R target used for initial clean test.
      We will tune this only AFTER actual data.
    */

    if (
      signal === "BUY"
    ) {
      tp =
        entry +
        ATR * 1.2;

      sl =
        entry -
        ATR;
    }


    if (
      signal === "SELL"
    ) {
      tp =
        entry -
        ATR * 1.2;

      sl =
        entry +
        ATR;
    }
  }


  return {
    ok: true,

    engine:
      "Binance Signal Engine V7",

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
          : 1.2
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
        round(RSI,2),

      rsi5m:
        round(RSI5,2),

      ema9:
        round(EMA9),

      ema21:
        round(EMA21),

      ema50:
        round(EMA50),

      ema200:
        round(EMA200),

      macd1mHistogram:
        MACD
          ? round(
              MACD.histogram
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
        round(VR,2),

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
      OB && TF
        ? {
            orderBookImbalance:
              round(
                OB.imbalance,
                2
              ),

            spreadBps:
              round(
                OB.spreadBps,
                4
              ),

            micropriceBiasBps:
              round(
                OB.microBiasBps,
                4
              ),

            tradeFlow15s:
              round(
                TF.flow15,
                2
              ),

            tradeFlow30s:
              round(
                TF.flow30,
                2
              ),

            recentTrades15s:
              TF.count15,

            recentTrades30s:
              TF.count30
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

    candle: {
      dataType:
        "CLOSED_CANDLES_FOR_INDICATORS",

      lastClosed1m:
        new Date(
          lastClosed1m
        ).toISOString(),

      lastClosed5m:
        new Date(
          lastClosed5m
        ).toISOString()
    },

    generatedAt:
      new Date()
        .toISOString(),

    warning:
      "Market-analysis signal only. Test results do not guarantee future trading performance."
  };
}


// ======================================================
// MARKET SCAN
// ======================================================

async function scan() {
  const results =
    await Promise.all(
      PAIRS.map(
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
              signal: "ERROR",
              error:
                error?.message ||
                String(error)
            };
          }
        }
      )
    );


  const signals =
    results
      .filter(
        x =>
          x.ok &&

          (
            x.signal ===
              "BUY" ||

            x.signal ===
              "SELL"
          ) &&

          x.signalStrength >=
            MIN_SIGNAL_STRENGTH
      )

      .sort(
        (a,b) =>
          b.signalStrength -
          a.signalStrength
      );


  return {
    ok: true,

    engine:
      "Binance Signal Engine V7",

    pairsChecked:
      PAIRS.length,

    signalsFound:
      signals.length,

    signals,

    allResults:
      results,

    generatedAt:
      new Date()
        .toISOString()
  };
}


// ======================================================
// V7 TEST STATE
// ======================================================

function emptyState() {
  return {
    version: 7,

    target:
      TEST_TARGET,

    records: [],

    createdAt:
      new Date()
        .toISOString(),

    updatedAt:
      new Date()
        .toISOString()
  };
}


async function loadState(env) {
  if (!env?.SIGNAL_TEST) {
    throw new Error(
      "SIGNAL_TEST KV binding not found"
    );
  }


  const state =
    await env.SIGNAL_TEST.get(
      TEST_STATE_KEY,
      "json"
    );


  if (
    !state ||
    state.version !== 7 ||
    !Array.isArray(
      state.records
    )
  ) {
    return emptyState();
  }


  return state;
}


async function saveState(
  env,
  state
) {
  state.updatedAt =
    new Date()
      .toISOString();


  await env.SIGNAL_TEST.put(
    TEST_STATE_KEY,
    JSON.stringify(state)
  );
}


// ======================================================
// UNIQUE TEST COLLECTION
// ======================================================

function addSignalsToState(
  state,
  signals
) {
  if (
    state.records.length >=
    TEST_TARGET
  ) {
    return 0;
  }


  let added = 0;


  for (
    const signal of
    signals
  ) {
    if (
      state.records.length >=
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
        MIN_SIGNAL_STRENGTH ||

      signal.trade?.entry ==
        null ||

      signal.trade?.tp ==
        null ||

      signal.trade?.sl ==
        null
    ) {
      continue;
    }


    /*
      One active setup per pair.
    */

    const activeSameSymbol =
      state.records.some(
        record =>
          record.symbol ===
            signal.symbol &&

          record.status ===
            "PENDING"
      );


    if (
      activeSameSymbol
    ) {
      continue;
    }


    /*
      Deterministic 5-minute bucket.

      Even if two Worker invocations happen
      close together, the same symbol/direction/
      time bucket cannot become two test IDs.
    */

    const candleTime =
      new Date(
        signal.candle
          .lastClosed1m
      ).getTime();


    const bucket =
      Math.floor(
        candleTime /
        TEST_COOLDOWN_MS
      );


    const testId =
      `v7:${signal.symbol}:${signal.signal}:${bucket}`;


    if (
      state.records.some(
        record =>
          record.testId ===
          testId
      )
    ) {
      continue;
    }


    const recentSame =
      state.records.some(
        record => {

          if (
            record.symbol !==
              signal.symbol ||

            record.signal !==
              signal.signal
          ) {
            return false;
          }


          const age =
            Date.now() -
            new Date(
              record.createdAt
            ).getTime();


          return (
            age <
            TEST_COOLDOWN_MS
          );
        }
      );


    if (
      recentSame
    ) {
      continue;
    }


    state.records.push({
      testId,

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

      sourceCandleClose:
        signal.candle
          .lastClosed1m,

      status:
        "PENDING",

      result:
        null,

      createdAt:
        new Date()
          .toISOString(),

      resolvedAt:
        null,

      exitPrice:
        null,

      resolution:
        null
    });


    added++;
  }


  return added;
}


// ======================================================
// TEST VALIDATION
// ======================================================

async function validateRecord(
  record
) {
  if (
    record.status !==
    "PENDING"
  ) {
    return false;
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
    return false;
  }


  for (
    const row of
    rows
  ) {
    const high =
      Number(row[2]);

    const low =
      Number(row[3]);

    const close =
      Number(row[4]);

    const candleClose =
      Number(row[6]);


    let tpHit =
      false;

    let slHit =
      false;


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

      return true;
    }


    if (
      tpHit
    ) {
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

      return true;
    }


    if (
      slHit
    ) {
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

      return true;
    }
  }


  return false;
}


async function validatePending(
  state,
  maxCount = 20
) {
  let changed =
    false;

  let checked =
    0;


  for (
    const record of
    state.records
  ) {
    if (
      record.status !==
      "PENDING"
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
          record
        )
      ) {
        changed =
          true;
      }
    }

    catch (error) {
      /*
        Temporary Binance failure:
        leave the record pending.
      */
    }
  }


  return {
    changed,
    checked
  };
}


// ======================================================
// REPORT
// ======================================================

function reportFromState(
  state
) {
  const records =
    state.records;


  const wins =
    records.filter(
      r =>
        r.result ===
        "WIN"
    );


  const losses =
    records.filter(
      r =>
        r.result ===
        "LOSS"
    );


  const pending =
    records.filter(
      r =>
        r.status ===
        "PENDING"
    );


  const ambiguous =
    records.filter(
      r =>
        r.result ===
        "AMBIGUOUS"
    );


  const completed =
    wins.length +
    losses.length;


  function performance(
    side
  ) {
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
      "Binance Signal Engine V7 Auto Test",

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
                r =>
                  Number(
                    r.strength
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


// ======================================================
// ONE COMPLETE BACKGROUND CYCLE
// ======================================================

async function runCycle(
  env
) {
  const state =
    await loadState(env);


  /*
    Validate only 6 pending entries during the
    automatic cycle.

    Worst case:
      20 kline requests
      + max 20 candidate microstructure requests
      + 6 validation requests
      = 46 external requests

    This stays below Workers Free 50/request.
  */

  const validation =
    await validatePending(
      state,
      MAX_AUTO_VALIDATIONS_PER_CYCLE
    );


  const market =
    await scan();


  const added =
    addSignalsToState(
      state,
      market.signals ||
        []
    );


  if (
    validation.changed ||
    added > 0
  ) {
    await saveState(
      env,
      state
    );
  }


  return {
    ...market,

    autoTest: {
      target:
        TEST_TARGET,

      addedNow:
        added,

      validatedNow:
        validation.checked,

      report:
        reportFromState(
          state
        )
    }
  };
}


// ======================================================
// WORKER
// ======================================================

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
            "Binance Signal Engine V7",

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
            "Binance Signal Engine V7",

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
          url.searchParams
            .get("symbol") ||
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


      /*
        Read-only market scan.
        Does NOT write test records.
      */

      if (
        path ===
        "/scan"
      ) {
        return json(
          await scan()
        );
      }


      /*
        Full auto-test cycle:
        validate + scan + save.
      */

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
        const state =
          await loadState(
            env
          );

        return json(
          reportFromState(
            state
          )
        );
      }


      if (
        path ===
        "/test/check"
      ) {
        const state =
          await loadState(
            env
          );


        const validation =
          await validatePending(
            state,
            20
          );


        if (
          validation.changed
        ) {
          await saveState(
            env,
            state
          );
        }


        return json(
          reportFromState(
            state
          )
        );
      }


      if (
        path ===
        "/test/reset"
      ) {
        const state =
          emptyState();


        await saveState(
          env,
          state
        );


        return json({
          ok: true,

          message:
            "V7 test state reset",

          target:
            TEST_TARGET
        });
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


  /*
    Works after a Cloudflare Cron Trigger is attached.
  */

  async scheduled(
    event,
    env,
    ctx
  ) {
    ctx.waitUntil(
      runCycle(env)

        .then(result => {
          console.log(
            "V7 cycle",
            JSON.stringify({
              signalsFound:
                result.signalsFound,

              test:
                result.autoTest
                  ?.report
            })
          );
        })

        .catch(error => {
          console.error(
            "V7 scheduled cycle failed",
            error
          );
        })
    );
  }
};
