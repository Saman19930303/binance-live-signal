// Binance Signal Engine V9
// Evidence-tuned BUY/SELL logic + 100-trade clean auto test
// Cloudflare Worker

const API = "https://api-gcp.binance.com";

const PAIRS = [
  "BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT",
  "ADAUSDT","DOGEUSDT","AVAXUSDT","LINKUSDT","TRXUSDT"
];

const TEST_TARGET = 100;
const TEST_PREFIX = "v9:test:";
const TEST_BUCKET_MS = 15 * 60 * 1000;
const MAX_AUTO_VALIDATIONS_PER_CYCLE = 4;
const MIN_SIGNAL_STRENGTH = 82;
const SIGNAL_RR_BUY = 1.15;
const SIGNAL_RR_SELL = 1.20;
const MAX_ENTRY_GAP_ATR = 0.35;

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
  return Number.isFinite(n) ? Number(n.toFixed(digits)) : null;
}

async function getJSON(path) {
  const response = await fetch(API + path, {
    method: "GET",
    headers: { Accept: "application/json" }
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Binance HTTP ${response.status} ${path}` +
      (body ? ` - ${body.slice(0, 120)}` : "")
    );
  }

  return response.json();
}

function ema(values, period) {
  if (!values || values.length < period) return null;

  let value = avg(values.slice(0, period));
  const k = 2 / (period + 1);

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
  }

  return value;
}

function emaSeries(values, period) {
  if (!values || values.length < period) return [];

  let value = avg(values.slice(0, period));
  const k = 2 / (period + 1);
  const out = [value];

  for (let i = period; i < values.length; i++) {
    value = values[i] * k + value * (1 - k);
    out.push(value);
  }

  return out;
}

function rsi(values, period = 14) {
  if (!values || values.length <= period) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;

    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }

  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function macd(values) {
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);

  if (!fast.length || !slow.length) return null;

  const offset = fast.length - slow.length;
  const lineValues = slow.map(
    (value, index) => fast[index + offset] - value
  );

  if (lineValues.length < 9) return null;

  const signal = ema(lineValues, 9);
  const line = lineValues.at(-1);

  return {
    line,
    signal,
    histogram: line - signal
  };
}

function atr(rows, period = 14) {
  if (!rows || rows.length < period + 1) return null;

  const ranges = [];

  for (let i = 1; i < rows.length; i++) {
    const high = Number(rows[i][2]);
    const low = Number(rows[i][3]);
    const previousClose = Number(rows[i - 1][4]);

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
  if (!rows || rows.length < 21) return null;

  const volumes = rows.map(row => Number(row[5]));
  const current = volumes.at(-1);
  const base = avg(volumes.slice(-21, -1));

  return base > 0 ? current / base : 0;
}

function vwap(rows, count = 60) {
  let priceVolume = 0;
  let volume = 0;

  for (const row of rows.slice(-count)) {
    const typical =
      (Number(row[2]) + Number(row[3]) + Number(row[4])) / 3;

    const candleVolume = Number(row[5]);

    priceVolume += typical * candleVolume;
    volume += candleVolume;
  }

  return volume ? priceVolume / volume : null;
}

function std(values, period = 20) {
  if (!values || values.length < period) return null;

  const sample = values.slice(-period);
  const mean = avg(sample);

  return Math.sqrt(
    avg(sample.map(value => (value - mean) ** 2))
  );
}

function marketStructure(rows) {
  if (!rows || rows.length < 12) return "RANGE";

  const recent = rows.slice(-12);
  const first = recent.slice(0, 6);
  const second = recent.slice(6);

  const firstHigh = Math.max(...first.map(row => Number(row[2])));
  const firstLow = Math.min(...first.map(row => Number(row[3])));
  const secondHigh = Math.max(...second.map(row => Number(row[2])));
  const secondLow = Math.min(...second.map(row => Number(row[3])));

  if (secondHigh > firstHigh && secondLow > firstLow) {
    return "BULLISH";
  }

  if (secondHigh < firstHigh && secondLow < firstLow) {
    return "BEARISH";
  }

  return "RANGE";
}

function supportResistance(rows) {
  const recent = rows.slice(-50);

  return {
    support: Math.min(...recent.map(row => Number(row[3]))),
    resistance: Math.max(...recent.map(row => Number(row[2])))
  };
}

function analyzeOrderBook(book) {
  const bids = (book.bids || []).slice(0, 20);
  const asks = (book.asks || []).slice(0, 20);

  if (!bids.length || !asks.length) {
    return {
      imbalance: 0,
      spreadBps: 999,
      microBiasBps: 0
    };
  }

  const bidNotional = bids.reduce(
    (sum, row) => sum + Number(row[0]) * Number(row[1]),
    0
  );

  const askNotional = asks.reduce(
    (sum, row) => sum + Number(row[0]) * Number(row[1]),
    0
  );

  const bestBid = Number(bids[0][0]);
  const bestAsk = Number(asks[0][0]);
  const bidQty = Number(bids[0][1]);
  const askQty = Number(asks[0][1]);

  const mid = (bestBid + bestAsk) / 2;

  const microPrice =
    (bestAsk * bidQty + bestBid * askQty) /
    (bidQty + askQty || 1);

  return {
    imbalance:
      bidNotional + askNotional
        ? ((bidNotional - askNotional) /
            (bidNotional + askNotional)) * 100
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

function analyzeTradeFlow(trades) {
  const now = Date.now();

  let buy15 = 0;
  let sell15 = 0;
  let buy30 = 0;
  let sell30 = 0;

  let count15 = 0;
  let count30 = 0;

  for (const trade of trades) {
    const age = now - Number(trade.T);

    if (age > 30000) continue;

    const notional =
      Number(trade.p) * Number(trade.q);

    count30++;

    if (trade.m) sell30 += notional;
    else buy30 += notional;

    if (age <= 15000) {
      count15++;

      if (trade.m) sell15 += notional;
      else buy15 += notional;
    }
  }

  const total15 = buy15 + sell15;
  const total30 = buy30 + sell30;

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

function calcStrength(
  direction,
  bull,
  bear,
  gatePassed,
  gateTotal,
  microBonus = 0
) {
  const directional =
    direction === "BUY" ? bull : bear;

  const opposition =
    direction === "BUY" ? bear : bull;

  const total = directional + opposition;

  const dominance =
    total > 0
      ? (directional / total) * 100
      : 50;

  const gateScore =
    gateTotal > 0
      ? (gatePassed / gateTotal) * 100
      : 0;

  return Math.min(
    99,
    Math.round(
      dominance * 0.55 +
      gateScore * 0.35 +
      microBonus * 0.10
    )
  );
}
async function analyzeSymbol(symbol) {
  try {
    // Base analysis = only 2 Binance requests.
    // Microstructure requests are made only after prequalification.
    const [raw1m, raw5m] = await Promise.all([
      getJSON(`/api/v3/klines?symbol=${symbol}&interval=1m&limit=230`),
      getJSON(`/api/v3/klines?symbol=${symbol}&interval=5m&limit=230`)
    ]);

    if (!Array.isArray(raw1m) || raw1m.length < 210) {
      throw new Error("Not enough 1m candle data");
    }

    if (!Array.isArray(raw5m) || raw5m.length < 210) {
      throw new Error("Not enough 5m candle data");
    }

    // Binance normally returns the currently-forming candle as the final row.
    // Closed candles are used for indicator decisions to reduce repainting.
    const closed1m = raw1m.slice(0, -1);
    const closed5m = raw5m.slice(0, -1);

    const live1m = raw1m.at(-1);

    const closes1 = closed1m.map(row => Number(row[4]));
    const closes5 = closed5m.map(row => Number(row[4]));

    const closedPrice = closes1.at(-1);
    const livePrice = Number(live1m[4]);

    const ema9 = ema(closes1, 9);
    const ema21 = ema(closes1, 21);
    const ema50 = ema(closes1, 50);
    const ema200 = ema(closes1, 200);

    const ema9_5 = ema(closes5, 9);
    const ema21_5 = ema(closes5, 21);
    const ema50_5 = ema(closes5, 50);
    const ema200_5 = ema(closes5, 200);

    const rsi1 = rsi(closes1, 14);
    const rsi5 = rsi(closes5, 14);

    const macd1 = macd(closes1);
    const macd5 = macd(closes5);

    const atr1 = atr(closed1m, 14);
    const atr5 = atr(closed5m, 14);

    const vw = vwap(closed1m, 60);
    const volume = volumeRatio(closed1m);

    const bbMiddle = avg(closes1.slice(-20));
    const bbStd = std(closes1, 20);

    const bbUpper =
      bbStd !== null ? bbMiddle + bbStd * 2 : null;

    const bbLower =
      bbStd !== null ? bbMiddle - bbStd * 2 : null;

    const structure = marketStructure(closed1m);
    const sr = supportResistance(closed1m);

    if (
      !Number.isFinite(closedPrice) ||
      !Number.isFinite(livePrice) ||
      !Number.isFinite(atr1) ||
      atr1 <= 0 ||
      !macd1 ||
      !macd5
    ) {
      throw new Error("Indicator calculation failed");
    }

    const trend1 =
      ema9 > ema21 && ema21 > ema50
        ? "UP"
        : ema9 < ema21 && ema21 < ema50
          ? "DOWN"
          : "MIXED";

    const trend5 =
      ema9_5 > ema21_5 && ema21_5 > ema50_5
        ? "BULLISH"
        : ema9_5 < ema21_5 && ema21_5 < ema50_5
          ? "BEARISH"
          : "MIXED";

    const mainTrend =
      ema50 > ema200
        ? "UP"
        : ema50 < ema200
          ? "DOWN"
          : "FLAT";

    const mainTrend5 =
      ema50_5 > ema200_5
        ? "UP"
        : ema50_5 < ema200_5
          ? "DOWN"
          : "FLAT";

    const roomToResistanceATR =
      (sr.resistance - closedPrice) / atr1;

    const roomToSupportATR =
      (closedPrice - sr.support) / atr1;

    let bull = 0;
    let bear = 0;

    // Directional evidence scoring.
    if (ema9 > ema21) bull += 10;
    else bear += 10;

    if (ema21 > ema50) bull += 10;
    else bear += 10;

    if (ema50 > ema200) bull += 10;
    else bear += 10;

    if (ema9_5 > ema21_5) bull += 10;
    else bear += 10;

    if (ema21_5 > ema50_5) bull += 10;
    else bear += 10;

    if (ema50_5 > ema200_5) bull += 10;
    else bear += 10;

    if (closedPrice > vw) bull += 7;
    else bear += 7;

    if (macd1.histogram > 0) bull += 8;
    else bear += 8;

    if (macd5.histogram > 0) bull += 8;
    else bear += 8;

    if (rsi1 >= 52) bull += 5;
    else if (rsi1 <= 48) bear += 5;

    if (rsi5 >= 52) bull += 5;
    else if (rsi5 <= 48) bear += 5;

    if (structure === "BULLISH") bull += 7;
    if (structure === "BEARISH") bear += 7;

    // BUY was the weak side in V8.
    // V9 therefore requires stronger alignment before even requesting
    // order-book/trade-flow data.
    const buyGates = {
      emaStack1m:
        ema9 > ema21 &&
        ema21 > ema50,

      emaStack5m:
        ema9_5 > ema21_5 &&
        ema21_5 > ema50_5,

      mainTrend1m:
        mainTrend === "UP",

      mainTrend5m:
        mainTrend5 === "UP",

      structure:
        structure === "BULLISH",

      rsi1:
        rsi1 >= 54 &&
        rsi1 <= 70,

      rsi5:
        rsi5 >= 52 &&
        rsi5 <= 68,

      macd1:
        macd1.histogram > 0 &&
        macd1.line > macd1.signal,

      macd5:
        macd5.histogram > 0 &&
        macd5.line > macd5.signal,

      vwap:
        closedPrice > vw,

      bollinger:
        bbUpper !== null &&
        closedPrice < bbUpper,

      volume:
        volume !== null &&
        volume >= 0.80,

      room:
        roomToResistanceATR >= 1.35
    };

    // SELL side performed better in V8, so preserve it without making it
    // unnecessarily restrictive.
    const sellGates = {
      emaStack1m:
        ema9 < ema21 &&
        ema21 < ema50,

      emaStack5m:
        ema9_5 < ema21_5 &&
        ema21_5 < ema50_5,

      mainTrend1m:
        mainTrend === "DOWN",

      mainTrend5m:
        mainTrend5 === "DOWN",

      structure:
        structure !== "BULLISH",

      rsi1:
        rsi1 >= 30 &&
        rsi1 <= 47,

      rsi5:
        rsi5 >= 32 &&
        rsi5 <= 49,

      macd1:
        macd1.histogram < 0 &&
        macd1.line < macd1.signal,

      macd5:
        macd5.histogram < 0 &&
        macd5.line < macd5.signal,

      vwap:
        closedPrice < vw,

      bollinger:
        bbLower !== null &&
        closedPrice > bbLower,

      volume:
        volume !== null &&
        volume >= 0.70,

      room:
        roomToSupportATR >= 1.25
    };

    const buyGateValues = Object.values(buyGates);
    const sellGateValues = Object.values(sellGates);

    const buyGatePassed =
      buyGateValues.filter(Boolean).length;

    const sellGatePassed =
      sellGateValues.filter(Boolean).length;

    const buyPrequalified =
      buyGatePassed === buyGateValues.length &&
      bull >= 80 &&
      bull > bear * 1.6;

    const sellPrequalified =
      sellGatePassed === sellGateValues.length &&
      bear >= 76 &&
      bear > bull * 1.45;

    let micro = {
      checked: false,
      imbalance: null,
      spreadBps: null,
      microBiasBps: null,
      flow15: null,
      flow30: null,
      count15: null,
      count30: null
    };

    let buyMicroPass = false;
    let sellMicroPass = false;

    if (buyPrequalified || sellPrequalified) {
      const [book, trades] = await Promise.all([
        getJSON(
          `/api/v3/depth?symbol=${symbol}&limit=20`
        ),
        getJSON(
          `/api/v3/aggTrades?symbol=${symbol}&limit=300`
        )
      ]);

      const orderBook = analyzeOrderBook(book);
      const flow = analyzeTradeFlow(trades);

      micro = {
        checked: true,
        imbalance: round(orderBook.imbalance, 2),
        spreadBps: round(orderBook.spreadBps, 3),
        microBiasBps: round(orderBook.microBiasBps, 3),
        flow15: round(flow.flow15, 2),
        flow30: round(flow.flow30, 2),
        count15: flow.count15,
        count30: flow.count30
      };

      buyMicroPass =
        orderBook.spreadBps <= 4 &&
        orderBook.imbalance >= -5 &&
        orderBook.microBiasBps >= -0.5 &&
        flow.flow30 >= -8;

      sellMicroPass =
        orderBook.spreadBps <= 4 &&
        orderBook.imbalance <= 5 &&
        orderBook.microBiasBps <= 0.5 &&
        flow.flow30 <= 8;
    }

    const buyMicroScore =
      micro.checked
        ? Math.max(
            0,
            Math.min(
              100,
              50 +
              Number(micro.imbalance || 0) * 1.5 +
              Number(micro.flow30 || 0) * 0.7
            )
          )
        : 0;

    const sellMicroScore =
      micro.checked
        ? Math.max(
            0,
            Math.min(
              100,
              50 -
              Number(micro.imbalance || 0) * 1.5 -
              Number(micro.flow30 || 0) * 0.7
            )
          )
        : 0;

    const buyStrength = calcStrength(
      "BUY",
      bull,
      bear,
      buyGatePassed,
      buyGateValues.length,
      buyMicroScore
    );

    const sellStrength = calcStrength(
      "SELL",
      bull,
      bear,
      sellGatePassed,
      sellGateValues.length,
      sellMicroScore
    );

    let signal = "WAIT";
    let strength = null;

    if (
      buyPrequalified &&
      buyMicroPass &&
      buyStrength >= MIN_SIGNAL_STRENGTH
    ) {
      signal = "BUY";
      strength = buyStrength;
    } else if (
      sellPrequalified &&
      sellMicroPass &&
      sellStrength >= MIN_SIGNAL_STRENGTH
    ) {
      signal = "SELL";
      strength = sellStrength;
    }

    const blockers = [];

    if (signal === "WAIT") {
      if (
        buyPrequalified &&
        !buyMicroPass
      ) {
        blockers.push(
          "BUY microstructure confirmation failed"
        );
      }

      if (
        sellPrequalified &&
        !sellMicroPass
      ) {
        blockers.push(
          "SELL microstructure confirmation failed"
        );
      }

      if (
        !buyPrequalified &&
        !sellPrequalified
      ) {
        if (
          volume !== null &&
          volume < 0.70
        ) {
          blockers.push("Volume filter failed");
        }

        if (
          roomToResistanceATR < 1.35 &&
          bull > bear
        ) {
          blockers.push(
            "Not enough room to resistance"
          );
        }

        if (
          roomToSupportATR < 1.25 &&
          bear > bull
        ) {
          blockers.push(
            "Not enough room to support"
          );
        }

        if (
          trend1 === "MIXED" ||
          trend5 === "MIXED"
        ) {
          blockers.push(
            "Trend alignment incomplete"
          );
        }

        if (!blockers.length) {
          blockers.push(
            "Confirmation threshold not reached"
          );
        }
      }
    }

    let trade = {
      entry: null,
      tp: null,
      sl: null,
      riskReward: null
    };

    if (signal === "BUY") {
      const entry = livePrice;
      const sl = entry - atr1;
      const tp =
        entry + atr1 * SIGNAL_RR_BUY;

      trade = {
        entry: round(entry),
        tp: round(tp),
        sl: round(sl),
        riskReward: SIGNAL_RR_BUY
      };
    }

    if (signal === "SELL") {
      const entry = livePrice;
      const sl = entry + atr1;
      const tp =
        entry - atr1 * SIGNAL_RR_SELL;

      trade = {
        entry: round(entry),
        tp: round(tp),
        sl: round(sl),
        riskReward: SIGNAL_RR_SELL
      };
    }

    return {
      ok: true,
      symbol,
      signal,

      // V9 intentionally does not show a fake "confidence" for WAIT.
      signalStrength:
        signal === "WAIT"
          ? null
          : strength,

      biasStrength: {
        bullish: buyStrength,
        bearish: sellStrength
      },

      note:
        "Signal strength is an indicator-confirmation score, not a guaranteed win probability.",

      price: {
        closed1m: round(closedPrice),
        live: round(livePrice)
      },

      trade,

      indicators: {
        ema9: round(ema9),
        ema21: round(ema21),
        ema50: round(ema50),
        ema200: round(ema200),

        ema9_5m: round(ema9_5),
        ema21_5m: round(ema21_5),
        ema50_5m: round(ema50_5),
        ema200_5m: round(ema200_5),

        rsi1m: round(rsi1, 2),
        rsi5m: round(rsi5, 2),

        macd1m: {
          line: round(macd1.line),
          signal: round(macd1.signal),
          histogram: round(macd1.histogram)
        },

        macd5m: {
          line: round(macd5.line),
          signal: round(macd5.signal),
          histogram: round(macd5.histogram)
        },

        atr1m: round(atr1),
        atr5m: round(atr5),

        vwap: round(vw),

        bollinger: {
          upper: round(bbUpper),
          middle: round(bbMiddle),
          lower: round(bbLower)
        },

        volumeRatio: round(volume, 2),

        trend1m: trend1,
        trend5m: trend5,
        mainTrend,
        mainTrend5m,

        marketStructure: structure,

        support: round(sr.support),
        resistance: round(sr.resistance),

        roomToResistanceATR:
          round(roomToResistanceATR, 2),

        roomToSupportATR:
          round(roomToSupportATR, 2)
      },

      confirmations: {
        buy: buyGates,
        sell: sellGates,

        buyPassed:
          `${buyGatePassed}/${buyGateValues.length}`,

        sellPassed:
          `${sellGatePassed}/${sellGateValues.length}`,

        micro
      },

      directionalScore: {
        bullish: bull,
        bearish: bear
      },

      blockers,

      generatedAt:
        new Date().toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      symbol,
      signal: "WAIT",
      signalStrength: null,
      trade: {
        entry: null,
        tp: null,
        sl: null,
        riskReward: null
      },
      error:
        error instanceof Error
          ? error.message
          : String(error)
    };
  }
}

async function scanMarket() {
  const results = [];

  // Process sequentially so the Worker does not exceed the simultaneous
  // outgoing-connection limit. Most pairs use only two requests.
  for (const symbol of PAIRS) {
    results.push(
      await analyzeSymbol(symbol)
    );
  }

  const signals = results.filter(
    item =>
      item.ok &&
      (item.signal === "BUY" ||
        item.signal === "SELL")
  );

  return {
    ok: true,
    engine: "Binance Signal Engine V9",
    version: 9,
    pairsChecked: results.length,
    signalsFound: signals.length,
    generatedAt:
      new Date().toISOString(),
    signals,
    results
  };
}

function testKey(testId) {
  return `${TEST_PREFIX}${testId}`;
}

function createTestId(signal) {
  const bucket =
    Math.floor(Date.now() / TEST_BUCKET_MS);

  return `${signal.symbol}:${signal.signal}:${bucket}`;
}

async function listTests(env) {
  if (!env.SIGNAL_TEST) return [];

  const all = [];
  let cursor;

  do {
    const page =
      await env.SIGNAL_TEST.list({
        prefix: TEST_PREFIX,
        cursor
      });

    for (const key of page.keys) {
      const item =
        await env.SIGNAL_TEST.get(
          key.name,
          "json"
        );

      if (item) all.push(item);
    }

    cursor =
      page.list_complete
        ? undefined
        : page.cursor;
  } while (cursor);

  all.sort(
    (a, b) =>
      new Date(a.createdAt).getTime() -
      new Date(b.createdAt).getTime()
  );

  return all;
}

async function putTest(env, test) {
  if (!env.SIGNAL_TEST) {
    throw new Error(
      "SIGNAL_TEST KV binding is missing"
    );
  }

  await env.SIGNAL_TEST.put(
    testKey(test.testId),
    JSON.stringify(test)
  );
}

async function collectSignals(env, scan) {
  if (!env.SIGNAL_TEST) {
    return {
      added: 0,
      reason:
        "SIGNAL_TEST KV binding is missing"
    };
  }

  const existing = await listTests(env);

  if (existing.length >= TEST_TARGET) {
    return {
      added: 0,
      reason:
        "V9 test target already collected"
    };
  }

  const existingIds =
    new Set(
      existing.map(item => item.testId)
    );

  const existingOpenSymbols =
    new Set(
      existing
        .filter(
          item =>
            item.status === "ARMED" ||
            item.status === "PENDING"
        )
        .map(item => item.symbol)
    );

  let added = 0;

  for (const signal of scan.signals) {
    if (
      existing.length + added >=
      TEST_TARGET
    ) {
      break;
    }

    if (
      existingOpenSymbols.has(
        signal.symbol
      )
    ) {
      continue;
    }

    const id = createTestId(signal);

    if (existingIds.has(id)) {
      continue;
    }

    const now = Date.now();

    const nextMinute =
      Math.floor(now / 60000) *
        60000 +
      60000;

    const test = {
      testId: id,
      engineVersion: 9,
      symbol: signal.symbol,
      signal: signal.signal,

      strength:
        signal.signalStrength,

      atrAtSignal:
        signal.indicators.atr1m,

      suggestedEntry:
        signal.trade.entry,

      suggestedTp:
        signal.trade.tp,

      suggestedSl:
        signal.trade.sl,

      entry: null,
      tp: null,
      sl: null,

      riskReward:
        signal.trade.riskReward,

      status: "ARMED",
      result: null,

      createdAt:
        new Date(now).toISOString(),

      armTime:
        new Date(nextMinute).toISOString(),

      resolvedAt: null,
      exitPrice: null,
      resolution: null,

      entryGapATR: null
    };

    await putTest(env, test);

    existingIds.add(id);
    existingOpenSymbols.add(
      signal.symbol
    );

    added++;
  }

  return {
    added,
    reason:
      added
        ? "Fresh V9 signals collected"
        : "No new qualifying V9 signals"
  };
}
async function armReadyTests(env) {
  const tests = await listTests(env);

  const armed = tests.filter(
    item => item.status === "ARMED"
  );

  let updated = 0;

  for (
    const test of armed.slice(
      0,
      MAX_AUTO_VALIDATIONS_PER_CYCLE
    )
  ) {
    const armTime =
      new Date(test.armTime).getTime();

    if (Date.now() < armTime + 60000) {
      continue;
    }

    try {
      const rows = await getJSON(
        `/api/v3/klines?symbol=${test.symbol}&interval=1m&startTime=${armTime}&limit=2`
      );

      if (
        !Array.isArray(rows) ||
        !rows.length
      ) {
        continue;
      }

      const entry =
        Number(rows[0][1]);

      if (
        !Number.isFinite(entry) ||
        entry <= 0
      ) {
        continue;
      }

      const atrValue =
        Number(test.atrAtSignal);

      if (
        !Number.isFinite(atrValue) ||
        atrValue <= 0
      ) {
        test.status = "REJECTED";
        test.result = null;
        test.resolution =
          "Invalid ATR snapshot";

        await putTest(env, test);
        updated++;
        continue;
      }

      const suggestedEntry =
        Number(test.suggestedEntry);

      const entryGapATR =
        Math.abs(
          entry - suggestedEntry
        ) / atrValue;

      test.entryGapATR =
        round(entryGapATR, 3);

      if (
        entryGapATR >
        MAX_ENTRY_GAP_ATR
      ) {
        test.status = "REJECTED";
        test.result = null;

        test.resolution =
          `Entry gap too large (${round(
            entryGapATR,
            2
          )} ATR)`;

        await putTest(env, test);
        updated++;
        continue;
      }

      test.entry = round(entry);

      if (test.signal === "BUY") {
        test.sl =
          round(
            entry - atrValue
          );

        test.tp =
          round(
            entry +
              atrValue *
                SIGNAL_RR_BUY
          );
      } else {
        test.sl =
          round(
            entry + atrValue
          );

        test.tp =
          round(
            entry -
              atrValue *
                SIGNAL_RR_SELL
          );
      }

      test.status = "PENDING";

      await putTest(env, test);

      updated++;
    } catch (error) {
      // Leave ARMED so another cycle can retry.
    }
  }

  return updated;
}

function resolveCandle(
  test,
  high,
  low
) {
  const tp = Number(test.tp);
  const sl = Number(test.sl);

  if (test.signal === "BUY") {
    const hitTp = high >= tp;
    const hitSl = low <= sl;

    if (hitTp && hitSl) {
      return {
        result: "AMBIGUOUS",
        exitPrice: null,
        resolution:
          "TP and SL touched in same 1m candle"
      };
    }

    if (hitTp) {
      return {
        result: "WIN",
        exitPrice: tp,
        resolution:
          "TP hit before SL"
      };
    }

    if (hitSl) {
      return {
        result: "LOSS",
        exitPrice: sl,
        resolution:
          "SL hit before TP"
      };
    }
  }

  if (test.signal === "SELL") {
    const hitTp = low <= tp;
    const hitSl = high >= sl;

    if (hitTp && hitSl) {
      return {
        result: "AMBIGUOUS",
        exitPrice: null,
        resolution:
          "TP and SL touched in same 1m candle"
      };
    }

    if (hitTp) {
      return {
        result: "WIN",
        exitPrice: tp,
        resolution:
          "TP hit before SL"
      };
    }

    if (hitSl) {
      return {
        result: "LOSS",
        exitPrice: sl,
        resolution:
          "SL hit before TP"
      };
    }
  }

  return null;
}

async function validatePendingTests(
  env
) {
  const tests =
    await listTests(env);

  const pending =
    tests.filter(
      item =>
        item.status === "PENDING"
    );

  let updated = 0;

  for (
    const test of pending.slice(
      0,
      MAX_AUTO_VALIDATIONS_PER_CYCLE
    )
  ) {
    try {
      const armTime =
        new Date(
          test.armTime
        ).getTime();

      const now = Date.now();

      const rows =
        await getJSON(
          `/api/v3/klines?symbol=${test.symbol}&interval=1m&startTime=${armTime}&endTime=${now}&limit=1000`
        );

      if (
        !Array.isArray(rows) ||
        !rows.length
      ) {
        continue;
      }

      let resolution = null;
      let resolvedAt = null;

      for (const row of rows) {
        const high =
          Number(row[2]);

        const low =
          Number(row[3]);

        const candleCloseTime =
          Number(row[6]);

        resolution =
          resolveCandle(
            test,
            high,
            low
          );

        if (resolution) {
          resolvedAt =
            new Date(
              candleCloseTime
            ).toISOString();

          break;
        }
      }

      if (!resolution) {
        continue;
      }

      test.status = "CLOSED";
      test.result =
        resolution.result;

      test.exitPrice =
        resolution.exitPrice;

      test.resolution =
        resolution.resolution;

      test.resolvedAt =
        resolvedAt;

      await putTest(env, test);

      updated++;
    } catch (error) {
      // Keep pending and retry next cycle.
    }
  }

  return updated;
}

function calculateStats(tests) {
  const valid =
    tests.filter(
      item =>
        item.status === "CLOSED"
    );

  const wins =
    valid.filter(
      item =>
        item.result === "WIN"
    );

  const losses =
    valid.filter(
      item =>
        item.result === "LOSS"
    );

  const ambiguous =
    valid.filter(
      item =>
        item.result ===
        "AMBIGUOUS"
    );

  const counted =
    wins.length +
    losses.length;

  const winRate =
    counted
      ? round(
          (wins.length /
            counted) *
            100,
          2
        )
      : null;

  const buy =
    valid.filter(
      item =>
        item.signal === "BUY" &&
        (
          item.result === "WIN" ||
          item.result === "LOSS"
        )
    );

  const sell =
    valid.filter(
      item =>
        item.signal === "SELL" &&
        (
          item.result === "WIN" ||
          item.result === "LOSS"
        )
    );

  const buildSide =
    items => {
      const sideWins =
        items.filter(
          item =>
            item.result ===
            "WIN"
        ).length;

      const sideLosses =
        items.filter(
          item =>
            item.result ===
            "LOSS"
        ).length;

      return {
        completed:
          items.length,

        wins:
          sideWins,

        losses:
          sideLosses,

        winRate:
          items.length
            ? round(
                (sideWins /
                  items.length) *
                  100,
                2
              )
            : null
      };
    };

  let netR = 0;

  for (const item of valid) {
    if (
      item.result === "WIN"
    ) {
      netR +=
        Number(
          item.riskReward ||
            0
        );
    }

    if (
      item.result === "LOSS"
    ) {
      netR -= 1;
    }
  }

  const expectancy =
    counted
      ? netR / counted
      : null;

  const strengthValues =
    tests
      .map(
        item =>
          Number(
            item.strength
          )
      )
      .filter(
        value =>
          Number.isFinite(
            value
          )
      );

  return {
    completed:
      valid.length,

    wins:
      wins.length,

    losses:
      losses.length,

    ambiguous:
      ambiguous.length,

    historicalWinRate:
      winRate,

    averageSignalStrength:
      strengthValues.length
        ? round(
            avg(
              strengthValues
            ),
            2
          )
        : null,

    netR:
      round(
        netR,
        3
      ),

    expectancyRPerCompleted:
      expectancy !== null
        ? round(
            expectancy,
            4
          )
        : null,

    buyPerformance:
      buildSide(buy),

    sellPerformance:
      buildSide(sell)
  };
}

async function getTestReport(env) {
  const tests =
    await listTests(env);

  const collected =
    tests.length;

  const armed =
    tests.filter(
      item =>
        item.status ===
        "ARMED"
    ).length;

  const pending =
    tests.filter(
      item =>
        item.status ===
        "PENDING"
    ).length;

  const rejected =
    tests.filter(
      item =>
        item.status ===
        "REJECTED"
    ).length;

  const stats =
    calculateStats(tests);

  return {
    ok: true,

    engine:
      "Binance Signal Engine V9 Auto Test",

    target:
      TEST_TARGET,

    collected,

    remaining:
      Math.max(
        0,
        TEST_TARGET -
          collected
      ),

    collectionComplete:
      collected >=
      TEST_TARGET,

    armed,
    pending,
    rejected,

    completed:
      stats.completed,

    wins:
      stats.wins,

    losses:
      stats.losses,

    ambiguous:
      stats.ambiguous,

    historicalWinRate:
      stats.historicalWinRate,

    averageSignalStrength:
      stats.averageSignalStrength,

    netR:
      stats.netR,

    expectancyRPerCompleted:
      stats.expectancyRPerCompleted,

    buyPerformance:
      stats.buyPerformance,

    sellPerformance:
      stats.sellPerformance,

    note:
      "Fresh V9 forward-test results only. Rejected entry gaps and ambiguous candles are excluded from win rate. Historical results do not guarantee future performance.",

    signals:
      tests
  };
}

async function cycle(env) {
  const armedUpdated =
    await armReadyTests(env);

  const pendingUpdated =
    await validatePendingTests(
      env
    );

  const reportBefore =
    await getTestReport(env);

  let scan = null;
  let collection = {
    added: 0,
    reason:
      "Collection already complete"
  };

  if (
    reportBefore.collected <
    TEST_TARGET
  ) {
    scan =
      await scanMarket();

    collection =
      await collectSignals(
        env,
        scan
      );
  }

  const reportAfter =
    await getTestReport(env);

  return {
    ok: true,

    engine:
      "Binance Signal Engine V9",

    cycleTime:
      new Date().toISOString(),

    armedUpdated,
    pendingUpdated,

    collection,

    scan:
      scan
        ? {
            pairsChecked:
              scan.pairsChecked,

            signalsFound:
              scan.signalsFound,

            signals:
              scan.signals.map(
                item => ({
                  symbol:
                    item.symbol,

                  signal:
                    item.signal,

                  strength:
                    item.signalStrength
                })
              )
          }
        : null,

    test:
      reportAfter
  };
}

async function health(env) {
  let binance =
    "UNKNOWN";

  let kv =
    env.SIGNAL_TEST
      ? "CONNECTED"
      : "NOT CONNECTED";

  try {
    const ping =
      await fetch(
        `${API}/api/v3/ping`
      );

    binance =
      ping.ok
        ? "CONNECTED"
        : `HTTP ${ping.status}`;
  } catch (error) {
    binance =
      "ERROR";
  }

  return {
    ok:
      binance ===
      "CONNECTED",

    engine:
      "Binance Signal Engine V9",

    version: 9,

    binance,

    kv,

    source:
      API,

    pairs:
      PAIRS,

    testTarget:
      TEST_TARGET,

    generatedAt:
      new Date().toISOString()
  };
}

async function resetV9Tests(env) {
  if (!env.SIGNAL_TEST) {
    return {
      ok: false,
      error:
        "SIGNAL_TEST KV binding is missing"
    };
  }

  const pageSize = 1000;

  let deleted = 0;
  let cursor;

  do {
    const page =
      await env.SIGNAL_TEST.list({
        prefix:
          TEST_PREFIX,

        limit:
          pageSize,

        cursor
      });

    for (const key of page.keys) {
      await env.SIGNAL_TEST.delete(
        key.name
      );

      deleted++;
    }

    cursor =
      page.list_complete
        ? undefined
        : page.cursor;
  } while (cursor);

  return {
    ok: true,
    engine:
      "Binance Signal Engine V9",
    deleted,
    note:
      "Only V9 test keys were deleted."
  };
}

async function handleRequest(
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

  const url =
    new URL(
      request.url
    );

  const path =
    url.pathname;

  if (
    request.method !==
    "GET"
  ) {
    return json(
      {
        ok: false,
        error:
          "Only GET is supported"
      },
      405
    );
  }

  if (
    path === "/" ||
    path === "/health"
  ) {
    return json(
      await health(env)
    );
  }

  if (
    path === "/pairs"
  ) {
    return json({
      ok: true,
      engine:
        "Binance Signal Engine V9",
      pairs:
        PAIRS
    });
  }

  if (
    path === "/signal"
  ) {
    const symbol =
      (
        url.searchParams.get(
          "symbol"
        ) || ""
      )
        .trim()
        .toUpperCase();

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
          supported:
            PAIRS
        },
        400
      );
    }

    return json(
      await analyzeSymbol(
        symbol
      )
    );
  }

  if (
    path === "/scan"
  ) {
    return json(
      await scanMarket()
    );
  }

  if (
    path === "/cycle"
  ) {
    return json(
      await cycle(env)
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
    const armedUpdated =
      await armReadyTests(
        env
      );

    const pendingUpdated =
      await validatePendingTests(
        env
      );

    return json({
      ok: true,
      armedUpdated,
      pendingUpdated,
      report:
        await getTestReport(
          env
        )
    });
  }

  if (
    path ===
    "/test/reset"
  ) {
    return json(
      await resetV9Tests(
        env
      )
    );
  }

  return json(
    {
      ok: false,
      error:
        "Not found",
      path,

      routes: [
        "/health",
        "/pairs",
        "/signal?symbol=BTCUSDT",
        "/scan",
        "/cycle",
        "/test/results",
        "/test/check",
        "/test/reset"
      ]
    },
    404
  );
}

export default {
  async fetch(
    request,
    env,
    ctx
  ) {
    try {
      return await handleRequest(
        request,
        env
      );
    } catch (error) {
      return json(
        {
          ok: false,
          engine:
            "Binance Signal Engine V9",

          error:
            error instanceof
            Error
              ? error.message
              : String(error)
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
      cycle(env)
    );
  }
};
