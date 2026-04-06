"""
A股/美股/加密货币 统一分析服务器
================================
数据源:
  A股  → akshare (主) | OpenBB HTTP API (akshare 失败时的 fallback)
  美股/加密货币 → OpenBB Python Package (主)
  缓存: akshare 内置 TTL

冲突接口 (/quote /kline /full) → 返回双格式字段，兼容新旧前端
"""

import sys, io

# Fix Windows GBK console encoding for all print() calls
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

from flask import Flask, jsonify, send_from_directory, request
from flask_cors import CORS
import random, re, json, os, time, hashlib, subprocess
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

# Shared thread pool for OpenBB calls
executor = ThreadPoolExecutor(max_workers=4)

def _ob_call(fn, timeout=10):
    """Run an OpenBB call in thread pool with timeout, return (data, error)."""
    fut = executor.submit(fn)
    try:
        return fut.result(timeout=timeout), None
    except Exception as e:
        return None, str(e)

# ============================================================
# App Init
# ============================================================
app = Flask(__name__)
CORS(app)

# ============================================================
# 配置加载
# ============================================================
DASHSCOPE_API_KEY = None
DASHSCOPE_MODEL = "qwen-turbo"

def _load_dotenv():
    try:
        env_path = os.path.join(os.path.dirname(__file__), ".env")
        if not os.path.exists(env_path):
            return
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                key, val = k.strip(), v.strip().strip('"').strip("'")
                if key and val:
                    os.environ[key] = val
    except:
        pass

_load_dotenv()

try:
    import config
    DASHSCOPE_API_KEY = getattr(config, "DASHSCOPE_API_KEY", None)
    DASHSCOPE_MODEL  = getattr(config, "DASHSCOPE_MODEL",  "qwen-turbo")
    if DASHSCOPE_API_KEY and DASHSCOPE_API_KEY != "your-api-key-here":
        print("[OK] 通义千问已配置")
except ImportError:
    pass

OPENBB_API_BASE = os.environ.get("OPENBB_API_BASE_URL", "http://127.0.0.1:6900").rstrip("/")

# ============================================================
# 缓存
# ============================================================
AKSHARE_CACHE       = {}
AKSHARE_CACHE_TTL   = 120          # seconds
OPENBB_CACHE        = {}
OPENBB_TTL          = {"equity_historical": 600, "equity_quote": 20, "crypto_historical": 600}
TA_REPORT_CACHE     = {}
TA_REPORT_TTL       = 3600

def _ta_cache_get(key):
    item = TA_REPORT_CACHE.get(key)
    if item and (time.time() - item["ts"]) < TA_REPORT_TTL:
        return item["data"]
    return None

def _ta_cache_set(key, data):
    TA_REPORT_CACHE[key] = {"ts": time.time(), "data": data}

def _ob_cache_get(key, ttl):
    item = OPENBB_CACHE.get(key)
    if item and (time.time() - item["ts"]) < ttl:
        return item["data"]
    return None

def _ob_cache_set(key, data):
    OPENBB_CACHE[key] = {"ts": time.time(), "data": data}

# ============================================================
# 辅助函数
# ============================================================
def format_symbol(symbol):
    """统一股票代码格式"""
    symbol = symbol.upper()
    if symbol.isdigit():
        return f"{symbol}.SS" if symbol.startswith("6") else f"{symbol}.SZ"
    return symbol

def to_float(val):
    if val is None:
        return None
    try:
        import numpy as np
        f = float(val)
        return f if np.isfinite(f) else None
    except:
        return None

def to_float_2(val):
    f = to_float(val)
    return round(f, 2) if f is not None else None

def _normalize_date(value):
    if not value:
        return None
    s = str(value)
    return s.split("T")[0] if "T" in s else (s.split(" ")[0] if " " in s else s)

def _fmt(v):
    """Format value: None/NaN → None, else float"""
    if v is None:
        return None
    try:
        import numpy as np
        f = float(v)
        return None if np.isnan(f) or np.isinf(f) else f
    except:
        return None

def _sanitize_secret(text):
    if not text:
        return text
    return re.sub(r"sk-[A-Za-z0-9_-]{10,}", "sk-***", str(text))

def _read_dotenv(key):
    try:
        path = os.path.join(os.path.dirname(__file__), ".env")
        if not os.path.exists(path):
            return None
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                s = line.strip()
                if not s or s.startswith("#") or "=" not in s:
                    continue
                k, v = s.split("=", 1)
                if k.strip() == key:
                    return v.strip().strip('"').strip("'") or None
    except:
        pass
    return None

def _fingerprint_secret(value):
    if not value:
        return None
    try:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]
    except:
        return None

# ============================================================
# 通义千问 API
# ============================================================
def call_qwen_api(prompt, system_prompt="你是一位专业的金融分析师。"):
    if not DASHSCOPE_API_KEY or DASHSCOPE_API_KEY == "your-api-key-here":
        return None
    try:
        import dashscope
        dashscope.api_key = DASHSCOPE_API_KEY
        messages = [{"role": "system", "content": system_prompt},
                    {"role": "user",    "content": prompt}]
        resp = dashscope.Generation.call(model=DASHSCOPE_MODEL,
                                          messages=messages,
                                          result_format="message")
        if resp.status_code == 200:
            return resp.output.choices[0].message.content
    except Exception as e:
        print(f"❌ 通义千问调用失败: {e}")
    return None

# ============================================================
# 记忆存储 (AI 聊天)
# ============================================================
MEMORY_FILE     = "user_memory.json"
STRATEGY_FILE   = "investment_strategies.json"

def load_memory():
    if os.path.exists(MEMORY_FILE):
        try:
            with open(MEMORY_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except:
            pass
    return {"chat_history": [], "user_id": "default_user"}

def save_memory(m):
    with open(MEMORY_FILE, "w", encoding="utf-8") as f:
        json.dump(m, f, ensure_ascii=False, indent=2)

def load_strategies():
    if os.path.exists(STRATEGY_FILE):
        try:
            with open(STRATEGY_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except:
            pass
    return {"strategies": []}

def save_strategies(s):
    with open(STRATEGY_FILE, "w", encoding="utf-8") as f:
        json.dump(s, f, ensure_ascii=False, indent=2)

def get_memory_summary():
    mem  = load_memory()
    strat = load_strategies()
    parts = []
    if mem.get("chat_history"):
        for chat in mem["chat_history"][-10:]:
            parts.append(f"- {chat.get('role','')}: {chat.get('content','')[:100]}")
    if strat.get("strategies"):
        for s in strat["strategies"]:
            parts.append(f"- {s.get('title','')}: {s.get('content','')[:100]}")
    return "\n".join(parts) if parts else "暂无历史记录"

# ============================================================
# A股数据获取 (akshare 为主，OpenBB HTTP 为 fallback)
# ============================================================
def get_stock_name(stock_code):
    """获取股票名称"""
    try:
        import akshare as ak, time
        for sym in (f"SH{stock_code}", f"SZ{stock_code}"):
            try:
                time.sleep(0.2)
                df = ak.stock_individual_spot_xq(symbol=sym)
                if df is not None and len(df) > 0:
                    d = dict(zip(df["item"], df["value"]))
                    name = d.get("名称")
                    if name and name != stock_code:
                        return name
            except:
                pass
        try:
            time.sleep(0.2)
            df = ak.stock_individual_info_em(symbol=stock_code)
            if df is not None:
                row = df[df["item"] == "股票简称"]
                if len(row) > 0:
                    return str(row.iloc[0]["value"])
        except:
            pass
    except Exception as e:
        print(f"[!] 获取股票名称失败: {e}")
    return stock_code

def _openbb_get(path, params, ttl_key=None):
    url = f"{OPENBB_API_BASE}{path}"
    cache_key = (path, tuple(sorted((params or {}).items())))
    if ttl_key:
        cached = _ob_cache_get(cache_key, OPENBB_TTL.get(ttl_key, 0))
        if cached is not None:
            return cached
    try:
        import requests as _req
        resp = _req.get(url, params=params, timeout=15)
        if resp.status_code == 204:
            return None
        resp.raise_for_status()
        # Always decode as UTF-8 to avoid GBK/latin-1 charset issues
        raw = resp.content.decode("utf-8", errors="replace")
        raw = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", raw)
        data = json.loads(raw)
        if ttl_key:
            _ob_cache_set(cache_key, data)
        return data
    except Exception as e:
        print(f"[!] OpenBB HTTP failed: {e}")
        return None

def _openbb_with_fallback(path, base_params, providers, ttl_key):
    errors = []
    for provider in providers:
        try:
            params = dict(base_params or {})
            params["provider"] = provider
            data = _openbb_get(path, params, ttl_key=ttl_key)
            if not data:
                errors.append((provider, "no content"))
                continue
            results = data.get("results")
            if isinstance(results, list) and len(results) > 0:
                return data, provider
        except Exception as e:
            errors.append((provider, str(e)))
            continue
    if errors:
        # Strip non-ASCII chars from error messages to avoid GBK issues
        clean_errors = []
        for p, m in errors[:6]:
            clean_m = str(m).encode('ascii', 'replace').decode('ascii')
            clean_errors.append((p, clean_m))
        raise Exception(f"All data sources failed: {'; '.join(f'{p}: {m}' for p, m in clean_errors)}")
    return None, None

def get_complete_akshare_data(stock_code, days=365):
    """A股完整数据: akshare 为主，OpenBB HTTP 为 fallback"""
    import akshare as ak

    now_ts = time.time()
    cached = AKSHARE_CACHE.get(stock_code)
    if cached and (now_ts - cached.get("ts", 0)) < AKSHARE_CACHE_TTL:
        cd = cached.get("data")
        if cd:
            result = dict(cd)
            full_kline = cd.get("data", [])
            result["data"] = full_kline[-days:] if isinstance(days, int) and days > 0 else full_kline
            return result

    stock_name = get_stock_name(stock_code)
    symbol = f"sh{stock_code}" if stock_code.startswith("6") else f"sz{stock_code}"

    # ---- akshare 主力 ----
    try:
        df_hist = ak.stock_zh_a_daily(symbol=symbol, adjust="")
        if df_hist is not None and len(df_hist) > 0:
            df_hist = df_hist.copy()
            last = df_hist.iloc[-1]
            current_price = float(last["close"])
            pre_close     = float(df_hist.iloc[-2]["close"]) if len(df_hist) > 1 else current_price
            open_price    = float(last.get("open", current_price))
            high_price    = float(last.get("high", current_price))
            low_price     = float(last.get("low",  current_price))
            volume        = int(last.get("volume", 0))
            amount        = float(last.get("amount", 0))
            change        = round(current_price - pre_close, 2)
            change_pct    = round(change / pre_close * 100, 2) if pre_close else 0

            kline_data = []
            for _, row in df_hist.iterrows():
                kline_data.append({
                    "date":  str(row.get("date", "")),
                    "open":   round(float(row.get("open",   0)), 2),
                    "high":   round(float(row.get("high",   0)), 2),
                    "low":    round(float(row.get("low",    0)), 2),
                    "close":  round(float(row.get("close",  0)), 2),
                    "volume": int(row.get("volume", 0)),
                    "amount": round(float(row.get("amount", 0)), 2),
                })

            result = {
                "name":         stock_name,
                "code":         stock_code,
                "price":        current_price,
                "change":       change,
                "changePercent": change_pct,
                "open":         open_price,
                "high":         high_price,
                "low":          low_price,
                "volume":       volume,
                "amount":       amount,
                "preClose":     pre_close,
                "pe":           None,
                "pb":           None,
                "data":         kline_data,
                "_source":      "akshare",
            }
            AKSHARE_CACHE[stock_code] = {"ts": now_ts, "data": result}
            if isinstance(days, int) and days > 0:
                result = dict(result)
                result["data"] = result["data"][-days:]
            return result
    except Exception as e:
        print(f"[!] akshare {stock_code} 失败: {e}")

    # ---- OpenBB HTTP fallback ----
    try:
        ob_data = _openbb_equity_data(stock_code, market="cn", days=days)
        if ob_data:
            ob_data["_source"] = "openbb"
            return ob_data
    except Exception as e:
        print(f"[!] OpenBB fallback {stock_code} 失败: {e}")

    return None

# ============================================================
# OpenBB Package 数据 (美股 / 加密货币)
# ============================================================
def _openbb_equity_data(symbol, market, days):
    """通过 OpenBB HTTP API 获取美股 equity 数据"""
    symbol = str(symbol).strip().upper()
    providers_hist = ["cboe", "yfinance", "fmp", "tiingo", "polygon"] if market == "us" \
                      else ["yfinance", "fmp", "polygon"]
    providers_quote = ["cboe", "yfinance", "fmp", "intrinio"] if market == "us" \
                      else ["yfinance", "fmp"]

    hist, hist_p = _openbb_with_fallback(
        "/api/v1/equity/price/historical",
        {"symbol": symbol, "interval": "1d", "sort": "asc",
         "limit": int(days) if int(days) > 0 else 365},
        providers_hist, ttl_key="equity_historical")

    quote, quote_p = _openbb_with_fallback(
        "/api/v1/equity/price/quote",
        {"symbol": symbol, "use_cache": True},
        providers_quote, ttl_key="equity_quote")

    quote_row = (quote or {}).get("results", [{}])[0] if quote else {}
    hist_rows = (hist or {}).get("results", []) if hist else []

    kline = []
    for row in hist_rows:
        d = _normalize_date(row.get("date"))
        close = row.get("close")
        if d is None or close is None:
            continue
        kline.append({
            "date":   d,
            "open":   row.get("open")   if row.get("open")   is not None else close,
            "high":   row.get("high")   if row.get("high")   is not None else close,
            "low":    row.get("low")    if row.get("low")    is not None else close,
            "close":  close,
            "volume": row.get("volume") if row.get("volume") is not None else 0,
        })

    if int(days) > 0 and len(kline) > int(days):
        kline = kline[-int(days):]

    last  = kline[-1] if kline else None
    price = quote_row.get("last_price") or quote_row.get("close") or \
            (last["close"] if last else None)
    pre_close = quote_row.get("prev_close")
    if pre_close is None and len(kline) >= 2:
        pre_close = kline[-2]["close"]
    if pre_close is None:
        pre_close = price
    change = quote_row.get("change")
    if change is None and price is not None and pre_close is not None:
        try:
            change = float(price) - float(pre_close)
        except:
            change = None
    volume = quote_row.get("volume") or (last["volume"] if last else 0)
    amount = None
    if volume is not None and price is not None:
        try:
            amount = float(volume) * float(price)
        except:
            amount = None

    return {
        "market":   market,
        "provider": quote_p or hist_p,
        "name":     quote_row.get("name") or symbol,
        "symbol":   symbol,
        "price":    price,
        "preClose": pre_close,
        "change":   change,
        "open":     quote_row.get("open",  last["open"]  if last else price),
        "high":     quote_row.get("high",  last["high"]  if last else price),
        "low":      quote_row.get("low",   last["low"]   if last else price),
        "volume":   volume,
        "amount":   amount,
        "bid":      quote_row.get("bid"),
        "ask":      quote_row.get("ask"),
        "yearHigh": quote_row.get("year_high"),
        "yearLow":  quote_row.get("year_low"),
        "currency": quote_row.get("currency"),
        "timestamp": quote_row.get("last_timestamp"),
        "data":     kline,
    }

def _openbb_crypto_data(symbol, days):
    """通过 OpenBB HTTP API 获取加密货币数据"""
    symbol = str(symbol).strip().upper()
    hist, provider = _openbb_with_fallback(
        "/api/v1/crypto/price/historical",
        {"symbol": symbol, "interval": "1d", "sort": "asc",
         "limit": int(days) if int(days) > 0 else 365},
        ["yfinance", "fmp", "polygon"], ttl_key="crypto_historical")

    hist_rows = (hist or {}).get("results", []) if hist else []
    kline = []
    for row in hist_rows:
        d = _normalize_date(row.get("date"))
        close = row.get("close")
        if d is None or close is None:
            continue
        kline.append({
            "date":   d,
            "open":   row.get("open")  if row.get("open")  is not None else close,
            "high":   row.get("high")  if row.get("high")  is not None else close,
            "low":    row.get("low")   if row.get("low")   is not None else close,
            "close":  close,
            "volume": row.get("volume") if row.get("volume") is not None else 0,
        })

    if int(days) > 0 and len(kline) > int(days):
        kline = kline[-int(days):]

    last  = kline[-1] if kline else None
    price = last["close"] if last else None
    pre_close = kline[-2]["close"] if len(kline) >= 2 else price
    change = None
    if price is not None and pre_close is not None:
        try:
            change = float(price) - float(pre_close)
        except:
            pass
    volume = last["volume"] if last else 0
    amount = None
    if volume is not None and price is not None:
        try:
            amount = float(volume) * float(price)
        except:
            pass

    return {
        "market":    "crypto",
        "provider":  provider,
        "name":      symbol,
        "symbol":    symbol,
        "price":     price,
        "preClose":  pre_close,
        "change":    change,
        "open":      last["open"]  if last else price,
        "high":      last["high"]  if last else price,
        "low":       last["low"]   if last else price,
        "volume":    volume,
        "amount":    amount,
        "currency":  None,
        "timestamp": last["date"]  if last else None,
        "data":      kline,
    }

# ============================================================
# OpenBB Package (美股实时 / 技术指标 / 管理层 / 财务)
# 直接 import obb，冗余路径兜底 OpenBB HTTP
# ============================================================
_obb = None
def _get_obb():
    global _obb
    if _obb is None:
        try:
            from openbb import obb as _o
            try:
                import openbb.package.equity
            except Exception as e:
                print(f"[!] OpenBB package 不可用（extensions/build 可能损坏）: {e}")
                return None
            _obb = _o
        except Exception as e:
            print(f"[!] OpenBB package 导入失败: {e}")
    return _obb

def _ob_equity_quote_df(obb, symbol):
    try:
        return obb.equity.price.quote(symbol, provider="yfinance").to_dataframe()
    except TypeError:
        return obb.equity.price.quote(symbol).to_dataframe()

def _ob_equity_hist_df(obb, symbol, interval):
    try:
        return obb.equity.price.historical(symbol, interval=interval, provider="yfinance").to_dataframe()
    except TypeError:
        return obb.equity.price.historical(symbol, interval=interval).to_dataframe()

def _http_get_json(url, timeout=10):
    try:
        from curl_cffi import requests as creq
        r = creq.get(url, timeout=timeout, impersonate="chrome")
        if getattr(r, "status_code", 0) >= 400:
            return None, f"HTTP {getattr(r, 'status_code', 'unknown')}"
        return r.json(), None
    except Exception as e:
        try:
            import requests
            r = requests.get(url, timeout=timeout)
            r.raise_for_status()
            return r.json(), None
        except Exception as e2:
            return None, str(e2 or e)

def _yahoo_quote_and_kline(stock_code, days=365):
    sym = (stock_code or "").strip()
    if not sym:
        return None, None, "empty symbol"

    q_url = f"https://query1.finance.yahoo.com/v7/finance/quote?symbols={sym}"
    qj, qerr = _http_get_json(q_url, timeout=10)
    if qerr:
        return None, None, qerr

    qr = (((qj or {}).get("quoteResponse") or {}).get("result") or [])
    q0 = qr[0] if qr else {}

    range_str = "1y" if int(days or 365) <= 365 else "5y"
    c_url = f"https://query2.finance.yahoo.com/v8/finance/chart/{sym}?range={range_str}&interval=1d&includePrePost=false&events=div%2Csplits"
    cj, cerr = _http_get_json(c_url, timeout=12)
    if cerr:
        return None, None, cerr

    cr = (((cj or {}).get("chart") or {}).get("result") or [])
    c0 = cr[0] if cr else {}
    ts = c0.get("timestamp") or []
    ind = (((c0.get("indicators") or {}).get("quote") or []) or [])
    qarr = ind[0] if ind else {}

    opens = qarr.get("open") or []
    highs = qarr.get("high") or []
    lows = qarr.get("low") or []
    closes = qarr.get("close") or []
    vols = qarr.get("volume") or []

    kline = []
    for i in range(min(len(ts), len(closes))):
        t = ts[i]
        if t is None:
            continue
        dt = datetime.fromtimestamp(int(t)).strftime("%Y-%m-%d")
        kline.append({
            "date": dt,
            "open": to_float_2(opens[i] if i < len(opens) else None),
            "high": to_float_2(highs[i] if i < len(highs) else None),
            "low": to_float_2(lows[i] if i < len(lows) else None),
            "close": to_float_2(closes[i] if i < len(closes) else None),
            "volume": int(to_float(vols[i] if i < len(vols) else None) or 0),
        })
    if kline:
        kline = kline[-int(days or 365):]

    price = to_float_2(q0.get("regularMarketPrice") or q0.get("postMarketPrice") or q0.get("preMarketPrice"))
    pre_c = to_float_2(q0.get("regularMarketPreviousClose"))
    chg = to_float_2(q0.get("regularMarketChange"))
    pct = to_float_2(q0.get("regularMarketChangePercent"))

    quote = {
        "name": q0.get("shortName") or q0.get("longName") or sym,
        "code": stock_code,
        "price": price,
        "change": chg,
        "changePercent": pct,
        "open": to_float_2(q0.get("regularMarketOpen")),
        "high": to_float_2(q0.get("regularMarketDayHigh")),
        "low": to_float_2(q0.get("regularMarketDayLow")),
        "volume": int(to_float(q0.get("regularMarketVolume")) or 0),
        "prev_close": pre_c,
        "preClose": pre_c,
        "last_price": price,
        "change_percent": (pct / 100) if pct is not None else 0,
        "bid": to_float_2(q0.get("bid")),
        "ask": to_float_2(q0.get("ask")),
        "yearHigh": to_float_2(q0.get("fiftyTwoWeekHigh")),
        "yearLow": to_float_2(q0.get("fiftyTwoWeekLow")),
        "peRatio": to_float_2(q0.get("trailingPE")),
        "eps": to_float_2(q0.get("epsTrailingTwelveMonths")),
        "marketCap": to_float_2(q0.get("marketCap")),
        "dividendYield": to_float_2(q0.get("trailingAnnualDividendYield")),
        "beta": to_float_2(q0.get("beta")),
        "provider": "yahoo",
        "_source": "yahoo",
    }

    if price is None and kline:
        quote["price"] = kline[-1].get("close")
        quote["last_price"] = quote["price"]
    return quote, kline, None

def _yf_quote_and_kline(stock_code, days=365):
    q, k, e = _yahoo_quote_and_kline(stock_code, days=days)
    if not e and q is not None and k is not None:
        return q, k, None
    try:
        import yfinance as yf
    except Exception as e:
        return None, None, str(e)

    sym = (stock_code or "").strip()
    ticker = yf.Ticker(sym)

    hist_days = max(int(days or 365), 10)
    hist, herr = _ob_call(lambda: ticker.history(period=f"{hist_days}d", interval="1d", auto_adjust=False), timeout=12)
    if herr or hist is None:
        return None, None, herr or "No yfinance history"
    if getattr(hist, "empty", True):
        return None, None, "No yfinance history"

    try:
        hist = hist.dropna(subset=["Close"])
    except Exception:
        pass
    if getattr(hist, "empty", True):
        return None, None, "No yfinance close data"

    last = hist.iloc[-1]
    prev = hist.iloc[-2] if len(hist) > 1 else last

    def _v(x):
        try:
            return float(x)
        except:
            return None

    price = to_float_2(_v(last.get("Close")))
    pre_c = to_float_2(_v(prev.get("Close")))
    chg = round(price - pre_c, 2) if price is not None and pre_c is not None else 0
    pct = round(chg / pre_c * 100, 2) if pre_c else 0

    info, ierr = _ob_call(lambda: getattr(ticker, "info", {}) or {}, timeout=8)
    if ierr or not isinstance(info, dict):
        info = {}

    quote = {
        "name": info.get("shortName") or info.get("longName") or sym,
        "code": stock_code,
        "price": price,
        "change": chg,
        "changePercent": pct,
        "open": to_float_2(_v(last.get("Open"))),
        "high": to_float_2(_v(last.get("High"))),
        "low": to_float_2(_v(last.get("Low"))),
        "volume": int(to_float(_v(last.get("Volume"))) or 0),
        "prev_close": pre_c,
        "preClose": pre_c,
        "last_price": price,
        "change_percent": pct / 100 if pct else 0,
        "bid": to_float_2(info.get("bid")),
        "ask": to_float_2(info.get("ask")),
        "yearHigh": to_float_2(info.get("fiftyTwoWeekHigh")),
        "yearLow": to_float_2(info.get("fiftyTwoWeekLow")),
        "peRatio": to_float_2(info.get("trailingPE")),
        "eps": to_float_2(info.get("trailingEps")),
        "marketCap": to_float_2(info.get("marketCap")),
        "dividendYield": to_float_2(info.get("dividendYield")),
        "beta": to_float_2(info.get("beta")),
        "provider": "yfinance",
        "_source": "yfinance",
    }

    kline = []
    try:
        tail_df = hist.tail(int(days or 365))
    except Exception:
        tail_df = hist
    for idx, row in tail_df.iterrows():
        kline.append({
            "date": idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx),
            "open": to_float_2(_v(row.get("Open"))),
            "high": to_float_2(_v(row.get("High"))),
            "low": to_float_2(_v(row.get("Low"))),
            "close": to_float_2(_v(row.get("Close"))),
            "volume": int(to_float(_v(row.get("Volume"))) or 0),
        })

    return quote, kline, None

# ============================================================
# 冲突接口 → 返回双格式字段
# quote / kline / full 均同时带 server_openBB 字段和 server.py 字段
# ============================================================

@app.route("/api/stock/quote")
def get_stock_quote():
    """行情接口 — 双格式兼容，支持A股(6位)和美股/加密货币代码"""
    import os; print(f"[DEBUG] get_stock_quote called, pid={os.getpid()}, file=server.py")
    stock_code = request.args.get("code")
    market     = (request.args.get("market") or "").strip().lower()

    if not stock_code:
        return jsonify({"error": "请提供股票代码"}), 400

    # ---- A股路径 ----
    if stock_code.isdigit() and len(stock_code) == 6:
        ak_data = get_complete_akshare_data(stock_code, days=60)
        if ak_data and ak_data.get("price") is not None:
            d = ak_data
            return jsonify({
                # server.py 格式
                "name":          d["name"],
                "code":          stock_code,
                "price":         d["price"],
                "change":        d["change"],
                "changePercent": d["changePercent"],
                "open":          d.get("open"),
                "high":          d.get("high"),
                "low":           d.get("low"),
                "volume":        d.get("volume"),
                "amount":        d.get("amount"),
                "preClose":      d.get("preClose"),
                # server_openBB 格式
                "last_price":    d["price"],
                "prev_close":    d.get("preClose"),
                "change_percent": d["changePercent"] / 100 if d.get("changePercent") else 0,
                "year_high":     d.get("yearHigh"),
                "year_low":      d.get("yearLow"),
                "bid":           d.get("bid"),
                "ask":           d.get("ask"),
                "_source":       d.get("_source", "akshare"),
            })

    # ---- US / Crypto via OpenBB Package (timeout protected) ----
    obb = _get_obb()
    if obb and not stock_code.isdigit():
        try:
            sym = format_symbol(stock_code)
            qt_df, err = _ob_call(lambda: _ob_equity_quote_df(obb, sym), timeout=15)
            if err or qt_df is None:
                print(f"[!] US quote failed for {sym}: {err}")
                qt_df = None
            has_df = hasattr(qt_df, 'iloc') and len(qt_df) > 0
            if has_df:
                row = qt_df.iloc[0]
                price = to_float_2(row.get('last_price') or row.get('price'))
                prev  = to_float_2(row.get('prev_close') or row.get('previous_close'))
                chg   = to_float_2(row.get('change'))
                if chg is None and price and prev:
                    chg = round(price - prev, 2)
                pct = to_float_2((row.get('change_percent') or 0) * 100)
                if pct is None and price and prev:
                    pct = round((price - prev) / prev * 100, 2) if prev else 0
                return jsonify({
                    "name":          str(row.get('name', stock_code)),
                    "code":          stock_code,
                    "price":         price,
                    "change":        chg,
                    "changePercent": pct,
                    "open":          to_float_2(row.get('open')),
                    "high":          to_float_2(row.get('high')),
                    "low":           to_float_2(row.get('low')),
                    "volume":        int(to_float(row.get('volume')) or 0),
                    "prev_close":    prev,
                    "preClose":      prev,
                    "last_price":    price,
                    "change_percent": pct / 100 if pct else 0,
                    "bid":           to_float_2(row.get('bid')),
                    "ask":           to_float_2(row.get('ask')),
                    "yearHigh":      to_float_2(row.get('year_high')),
                    "yearLow":       to_float_2(row.get('year_low')),
                    "_source":       "openbb",
                })
            qt_df = None
        except Exception as e:
            print(f"[!] US stock quote exception: {e}")

    if not stock_code.isdigit():
        quote, _, err = _yf_quote_and_kline(stock_code, days=60)
        if err or quote is None:
            return jsonify({"error": f"获取数据失败：{err or 'no data'}"}), 502
        return jsonify(quote)

    return jsonify({"error": "仅支持A股6位代码或美股代码"}), 404


@app.route("/api/stock/kline")
def get_stock_kline():
    """K线接口 — 双格式兼容"""
    stock_code = request.args.get("code")
    days       = int(request.args.get("days", 120))
    interval   = request.args.get("interval", "1d")
    market     = (request.args.get("market") or "").strip().lower()

    if not stock_code:
        return jsonify({"error": "请提供股票代码"}), 400

    # ---- A股 ----
    if stock_code.isdigit() and len(stock_code) == 6:
        ak_data = get_complete_akshare_data(stock_code, days=days)
        if ak_data and ak_data.get("data"):
            kline = ak_data["data"]
            # 计算 RSI (简单版)
            closes = [k["close"] for k in kline]
            rsi = _calc_rsi(closes, 14) if len(closes) >= 15 else None
            enriched = []
            for i, k in enumerate(kline):
                item = {
                    # server_openBB 格式
                    "date":   k["date"],
                    "open":   k["open"],
                    "high":   k["high"],
                    "low":    k["low"],
                    "close":  k["close"],
                    "volume": k["volume"],
                    "rsi":    rsi[i] if rsi and i < len(rsi) else None,
                    # server.py 兼容
                    "RSI":    rsi[i] if rsi and i < len(rsi) else None,
                }
                enriched.append(item)
            return jsonify({
                "code":     stock_code,
                "interval": interval,
                "kline":    enriched,
                # server_openBB 额外字段
                "symbol":   stock_code,
                "interval": interval,
                # server.py 兼容
                "data":     enriched,
            })

    # ---- 美股 / 加密货币 via OpenBB Package (timeout protected) ----
    obb = _get_obb()
    if obb:
        if market in ["us", "hk", ""] or not stock_code.isdigit():
            try:
                sym  = format_symbol(stock_code)
                intrv = {'1d': '1d', '1w': '1W', '1M': '1M'}.get(interval, '1d')
                fetch_d = 365 if intrv in ['1W', '1M'] else days * 2
                df, err = _ob_call(
                    lambda: _ob_equity_hist_df(obb, sym, intrv),
                    timeout=20)
                if not err and df is not None and hasattr(df, 'empty') and not df.empty:
                    closes = df['close'].tolist()
                    rsi_list = _calc_rsi(closes, 14)
                    kline = []
                    for i, (idx, row) in enumerate(df.tail(days).iterrows()):
                        kline.append({
                            "date":   idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx),
                            "open":   to_float_2(row.get('open')),
                            "high":   to_float_2(row.get('high')),
                            "low":    to_float_2(row.get('low')),
                            "close":  to_float_2(row.get('close')),
                            "volume": int(to_float(row.get('volume')) or 0),
                            "rsi":    rsi_list[i] if i < len(rsi_list) else None,
                            "RSI":    rsi_list[i] if i < len(rsi_list) else None,
                        })
                    last = df.iloc[-1]; pre_col = df.iloc[-2]['close'] if len(df) > 1 else None
                    price = to_float_2(last.get('close')); pre_c = to_float_2(pre_col)
                    chg = round(price - pre_c, 2) if price and pre_c else 0
                    pct = round(chg / pre_c * 100, 2) if pre_c else 0
                    return jsonify({
                        "code":     stock_code, "interval": interval,
                        "kline":    kline, "data": kline,
                        "name":     str(last.get('name', stock_code)),
                        "symbol":   stock_code, "price": price,
                        "change":   chg, "changePercent": pct,
                        "volume":   int(to_float(last.get('volume')) or 0),
                    })
                if err:
                    print(f"[!] US kline failed for {sym}: {err}")
            except Exception as e:
                return jsonify({"error": f"OpenBB kline failed: {e}"}), 502

        if market == "crypto":
            try:
                sym = format_symbol(stock_code)
                intrv = {'1d': '1d', '1w': '1W', '1M': '1M'}.get(interval, '1d')
                df, err = _ob_call(
                    lambda: obb.crypto.price.historical(sym, interval=intrv).to_dataframe(),
                    timeout=20)
                if err or df is None:
                    return jsonify({"error": f"Crypto kline timeout: {err}"}), 504
                if hasattr(df, 'empty') and df.empty:
                    return jsonify({"error": "No crypto data"}), 404
                kline = []
                for idx, row in df.tail(days).iterrows():
                    kline.append({
                        "date":   idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx),
                        "open":   to_float_2(row.get('open')),
                        "high":   to_float_2(row.get('high')),
                        "low":    to_float_2(row.get('low')),
                        "close":  to_float_2(row.get('close')),
                        "volume": int(to_float(row.get('volume')) or 0),
                    })
                return jsonify({"code": stock_code, "interval": interval,
                                 "kline": kline, "data": kline})
            except Exception as e:
                return jsonify({"error": f"Crypto kline failed: {e}"}), 502

    if not stock_code.isdigit():
        _, kline, err = _yf_quote_and_kline(stock_code, days=days)
        if err or kline is None:
            return jsonify({"error": f"获取数据失败：{err or 'no data'}"}), 502
        closes = [k["close"] for k in kline if k.get("close") is not None]
        rsi = _calc_rsi(closes, 14) if len(closes) >= 15 else None
        enriched = []
        rsi_i = 0
        for k in kline:
            rsi_v = None
            if rsi and k.get("close") is not None and rsi_i < len(rsi):
                rsi_v = rsi[rsi_i]
                rsi_i += 1
            enriched.append({**k, "rsi": rsi_v, "RSI": rsi_v})
        return jsonify({
            "code": stock_code,
            "interval": interval,
            "kline": enriched,
            "symbol": stock_code,
            "data": enriched,
        })

    return jsonify({"error": "数据获取失败"}), 404


@app.route("/api/stock/full")
def get_stock_full():
    """完整数据接口 — 双格式兼容"""
    print("[FULL] CALLED code=" + str(request.args.get("code")) + " market=" + str(request.args.get("market")))
    stock_code = request.args.get("code")
    days = int(request.args.get("days", 365))
    market = (request.args.get("market") or "").strip().lower()

    if not stock_code:
        return jsonify({"error": "请提供股票代码"}), 400

    if stock_code.isdigit() and len(stock_code) == 6:
        ak_data = get_complete_akshare_data(stock_code, days=days)
        if ak_data:
            d = ak_data
            # 补充获取 A股 PE/PB（从雪球实时数据）
            pe_val, pb_val = d.get("pe"), d.get("pb")
            if pe_val is None or pb_val is None:
                try:
                    import akshare as ak, time
                    xq_sym = f"SH{stock_code}" if stock_code.startswith("6") else f"SZ{stock_code}"
                    time.sleep(0.2)
                    spot = ak.stock_individual_spot_xq(symbol=xq_sym)
                    if spot is not None and len(spot) > 0:
                        sd = dict(zip(spot["item"], spot["value"]))
                        pe_str = sd.get("市盈率")
                        pb_str = sd.get("市净率")
                        if pe_val is None and pe_str:
                            try: pe_val = float(pe_str)
                            except: pass
                        if pb_val is None and pb_str:
                            try: pb_val = float(pb_str)
                            except: pass
                except Exception as e:
                    print(f"[!] A股 PE/PB fetch failed: {e}")

            quote = {
                # server_openBB 格式
                "last_price":    d["price"],
                "prev_close":   d.get("preClose"),
                "open":          d.get("open"),
                "high":          d.get("high"),
                "low":           d.get("low"),
                "volume":        d.get("volume"),
                "amount":        d.get("amount"),
                "change":        d["change"],
                "changePercent": d["changePercent"],
                "bid":           d.get("bid"),
                "ask":           d.get("ask"),
                "yearHigh":      d.get("yearHigh"),
                "yearLow":       d.get("yearLow"),
                # server.py 格式 (冗余)
                "price":         d["price"],
                "preClose":      d.get("preClose"),
                "change_percent": d["changePercent"] / 100 if d.get("changePercent") else 0,
                "pe":            pe_val,
                "pb":            pb_val,
                "peRatio":       pe_val,
            }
            return jsonify(quote)

    # ---- US stocks via OpenBB Package directly ----
    if not stock_code.isdigit():
        obb = _get_obb()
        if obb:
            try:
                sym = format_symbol(stock_code)
                # Use timeout to prevent Flask from hanging
                qt_df, qerr = _ob_call(lambda: _ob_equity_quote_df(obb, sym), timeout=15)
                df, herr = _ob_call(lambda: _ob_equity_hist_df(obb, sym, '1d'), timeout=15)
                if qerr or qt_df is None or herr or df is None or (hasattr(df, 'empty') and df.empty):
                    print(f"[!] OpenBB full failed for {sym}: quote_err={qerr} history_err={herr}")
                else:
                    # Handle both DataFrame and OBBject responses
                    if hasattr(df, 'iloc'):
                        last = df.iloc[-1]; prev = df.iloc[-2] if len(df) > 1 else last
                    else:
                        last = prev = {}
                    price = to_float_2(last.get('close') if isinstance(last, dict) else last.get('close'))
                    pre_c = to_float_2(prev.get('close') if isinstance(prev, dict) else prev.get('close'))
                    chg   = round(price - pre_c, 2) if price and pre_c else 0
                    pct   = round(chg / pre_c * 100, 2) if pre_c else 0
                    kline = []
                    for idx, row in df.tail(days).iterrows():
                        kline.append({
                            "date":   idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx),
                            "open":   to_float_2(row.get('open')),
                            "high":   to_float_2(row.get('high')),
                            "low":    to_float_2(row.get('low')),
                            "close":  to_float_2(row.get('close')),
                            "volume": int(to_float(row.get('volume')) or 0),
                        })
                    qt_name = stock_code
                    if hasattr(qt_df, 'iloc') and len(qt_df) > 0:
                        qt_name = qt_df.iloc[0].get('name', stock_code)
                    elif hasattr(qt_df, '__data__'):
                        qt_name = qt_df.__data__.get('name', stock_code)
                    quote = {
                        "name":          qt_name,
                        "code":          stock_code,
                        "price":         price,
                        "change":        chg,
                        "changePercent": pct,
                        "open":          to_float_2(last.get('open') if isinstance(last, dict) else last.get('open')),
                        "high":          to_float_2(last.get('high') if isinstance(last, dict) else last.get('high')),
                        "low":           to_float_2(last.get('low')  if isinstance(last, dict) else last.get('low')),
                        "volume":        int(to_float(last.get('volume') if isinstance(last, dict) else last.get('volume')) or 0),
                        "prev_close":    pre_c,
                        "preClose":      pre_c,
                        "last_price":    price,
                        "change_percent": pct / 100 if pct else 0,
                    }
                    # 获取估值指标 (PE, EPS, MarketCap)
                    m_df, merr = _ob_call(
                        lambda: obb.equity.fundamental.metrics(sym, provider='yfinance', limit=1).to_dataframe(),
                        timeout=15)
                    if m_df is not None and hasattr(m_df, 'iloc') and len(m_df) > 0:
                        mr = m_df.iloc[0]
                        quote.update({
                            "peRatio":      to_float_2(mr.get('pe_ratio')),
                            "eps":          to_float_2(mr.get('eps_ttm')),
                            "marketCap":    to_float_2(mr.get('market_cap')),
                            "dividendYield": to_float_2(mr.get('dividend_yield')),
                            "beta":         to_float_2(mr.get('beta')),
                        })
                    if hasattr(qt_df, 'iloc') and len(qt_df) > 0:
                        r = qt_df.iloc[0]
                        quote.update({
                            "bid":      to_float_2(r.get('bid')),
                            "ask":      to_float_2(r.get('ask')),
                            "yearHigh": to_float_2(r.get('year_high')),
                            "yearLow":  to_float_2(r.get('year_low')),
                            "provider":  "yfinance",
                        })
                    return jsonify(quote)
            except Exception as e:
                return jsonify({"error": f"OpenBB failed for {stock_code}: {e}"}), 502
        quote, kline, err = _yf_quote_and_kline(stock_code, days=days)
        if err or quote is None or kline is None:
            return jsonify({"error": f"获取数据失败：{err or 'no data'}"}), 502
        return jsonify(quote)

    # ---- Crypto via OpenBB Package ----
    if market == "crypto":
        obb = _get_obb()
        if obb:
            try:
                sym  = format_symbol(stock_code)
                df   = obb.crypto.price.historical(sym, interval='1d').to_dataframe()
                if df.empty:
                    return jsonify({"error": "No crypto data"}), 404
                last = df.iloc[-1]
                pre_c = to_float_2(df.iloc[-2].get('close')) if len(df) > 1 else None
                price = to_float_2(last.get('close'))
                chg   = round(price - pre_c, 2) if price and pre_c else 0
                pct   = round(chg / pre_c * 100, 2) if pre_c else 0
                kline = []
                for idx, row in df.tail(days).iterrows():
                    kline.append({
                        "date":   idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx),
                        "open":   to_float_2(row.get('open')),
                        "high":   to_float_2(row.get('high')),
                        "low":    to_float_2(row.get('low')),
                        "close":  to_float_2(row.get('close')),
                        "volume": int(to_float(row.get('volume')) or 0),
                    })
                return jsonify({"quote": {"name": stock_code, "price": price,
                                           "change": chg, "changePercent": pct,
                                           "volume": int(to_float(last.get('volume')) or 0)},
                                "kline": kline})
            except Exception as e:
                return jsonify({"error": f"Crypto data failed: {e}"}), 502

    return jsonify({"error": "仅支持A股6位代码或美股代码"}), 404


@app.route("/api/stock/data")
def get_stock_data():
    """兼容旧端点 → 重定向到 /api/stock/full"""
    return get_stock_full()


# ============================================================
# RSI 计算辅助
# ============================================================
def _calc_rsi(closes, period=14):
    if len(closes) < period + 1:
        return [None] * len(closes)
    deltas = [closes[i] - closes[i-1] for i in range(1, len(closes))]
    gains = [d if d > 0 else 0 for d in deltas]
    losses = [-d if d < 0 else 0 for d in deltas]
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    rsi = [None] * period
    for i in range(period, len(closes)):
        avg_gain = (avg_gain * (period - 1) + gains[i-1]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i-1]) / period
        rs = avg_gain / avg_loss if avg_loss != 0 else 0
        rsi.append(round(100 - 100 / (1 + rs), 2))
    return rsi

# ============================================================
# 新闻
# ============================================================
def deduplicate_news(news_list):
    seen = set()
    unique = []
    for n in news_list:
        title = n.get("title", "")
        key = title[:15] if len(title) > 15 else title
        if key not in seen:
            seen.add(key)
            unique.append(n)
    return unique

def generate_financial_news():
    try:
        import yfinance as yf
        from datetime import datetime as _dt
        symbols = ["AAPL", "GOOGL", "MSFT", "TSLA", "AMZN", "BABA", "JD", "PDD"]
        all_news = []
        for sym in symbols:
            try:
                stock = yf.Ticker(sym)
                news, nerr = _ob_call(lambda: stock.news or [], timeout=4)
                if nerr or not news:
                    continue
                for item in news[:3]:
                    title = item.get("title", "")
                    if not title:
                        continue
                    ts = item.get("providerPublishTime", 0)
                    diff = (_dt.now() - _dt.fromtimestamp(ts)).seconds if ts else 0
                    if diff < 3600:
                        t = f"{diff//60}分钟前" if diff < 3600 else f"{diff//3600}小时前"
                    else:
                        t = "刚刚"
                    cat = "market"
                    if any(k in title.lower() for k in ["fed", "rate", "policy"]):
                        cat = "policy"
                    all_news.append({
                        "id":       random.randint(1000, 9999),
                        "title":    title,
                        "category": cat,
                        "time":     t,
                        "impact":   "neutral",
                        "source":   item.get("publisher", "Yahoo Finance"),
                    })
            except:
                pass
        if all_news:
            return deduplicate_news(all_news)[:10]
    except Exception as e:
        print(f"[!] Yahoo Finance 新闻失败: {e}")

    defaults = [
        {"title": "Stock Market Updates: Major Indices Mixed",
         "category": "market", "time": "刚刚", "impact": "neutral", "source": "Market Watch"},
        {"title": "Fed Policy Decision Awaited by Investors",
         "category": "policy", "time": "30分钟前", "impact": "neutral", "source": "Financial Times"},
    ]
    for n in defaults:
        n["id"] = random.randint(1000, 9999)
    return defaults

@app.route("/api/news")
def get_news():
    market = (request.args.get("market") or "cn").strip().lower()
    q = (request.args.get("q") or "").strip()
    page = int(request.args.get("page", 1))
    page_size = int(request.args.get("pageSize", 30))
    page = max(page, 1)
    page_size = max(min(page_size, 100), 1)

    if market == "cn":
        news = []
        try:
            import akshare as ak
            from datetime import datetime as _dt

            today = _dt.now().strftime("%Y-%m-%d")

            def _append_em(df):
                if df is None or len(df) <= 0:
                    return
                for _, row in df.iterrows():
                    title = str(row.get("新闻标题", "") or "").strip()
                    if not title:
                        continue
                    ts = str(row.get("发布时间", "") or "").strip()
                    if ts and not str(ts).startswith(today):
                        continue
                    url = str(row.get("新闻链接", "") or "").strip()
                    src = str(row.get("文章来源", "") or "").strip() or "东方财富"
                    detail = str(row.get("新闻内容", "") or "").strip()
                    news.append({
                        "id": random.randint(1000, 9999),
                        "title": title,
                        "category": "market",
                        "time": ts or "今天",
                        "impact": "neutral",
                        "source": src,
                        "detail": detail,
                        "url": url,
                    })

            base_keywords = ["A股", "市场", "全部"]
            for kw in base_keywords:
                try:
                    _append_em(ak.stock_news_em(symbol=kw))
                except Exception:
                    pass

            if q:
                try:
                    _append_em(ak.stock_news_em(symbol=q))
                except Exception:
                    pass

            try:
                cx_df = ak.stock_news_main_cx()
                if cx_df is not None and len(cx_df) > 0:
                    for _, row in cx_df.iterrows():
                        url = str(row.get("url", "") or "").strip()
                        title = str(row.get("summary", "") or "").strip()
                        tag = str(row.get("tag", "") or "").strip()
                        if not title:
                            continue
                        if today not in url:
                            continue
                        news.append({
                            "id": random.randint(1000, 9999),
                            "title": title,
                            "category": "market",
                            "time": today,
                            "impact": "neutral",
                            "source": tag or "财新",
                            "detail": "",
                            "url": url,
                        })
            except Exception:
                pass
        except Exception as e:
            print(f"[!] CN news failed: {e}")

        if not news:
            news = generate_financial_news()
    else:
        news = generate_financial_news()

    if news:
        uniq = {}
        for it in news:
            key = (it.get("url") or it.get("title") or "").strip()
            if not key:
                continue
            if key in uniq:
                continue
            uniq[key] = it
        news = list(uniq.values())

    if q:
        ql = q.lower()
        news = [
            n for n in news
            if ql in (str(n.get("title", "")) + " " + str(n.get("detail", "")) + " " + str(n.get("source", ""))).lower()
        ]
    total = len(news)
    start = (page - 1) * page_size
    end = start + page_size
    return jsonify({
        "success": True,
        "data": news[start:end],
        "total": total,
        "page": page,
        "pageSize": page_size,
        "updateTime": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    })


@app.route("/api/news/us")
def get_news_us():
    q = (request.args.get("q") or "").strip()
    page = int(request.args.get("page", 1))
    page_size = int(request.args.get("pageSize", 30))
    page = max(page, 1)
    page_size = max(min(page_size, 50), 1)

    symbols = [
        "AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "JPM",
        "AMD", "NFLX", "INTC", "ORCL", "COIN", "BAC", "WMT"
    ]

    obb = _get_obb()
    source_used = "openbb"
    if not obb:
        source_used = "fallback"

    items = []
    if q:
        q_sym = q.strip().upper()
        if q_sym and q_sym not in symbols and len(q_sym) <= 10 and all(c.isalnum() or c in "-._" for c in q_sym):
            symbols = [q_sym] + symbols

    if obb:
        for sym in symbols:
            try:
                ob_news, nerr = _ob_call(lambda: obb.news.company(symbol=sym, limit=30, provider="yfinance"), timeout=12)
                if nerr or not ob_news or not getattr(ob_news, "results", None):
                    continue
                for r in ob_news.results:
                    d = r.model_dump() if hasattr(r, "model_dump") else {}
                    date_raw = d.get("date")
                    time_str = "刚刚"
                    published_ts = 0
                    try:
                        if date_raw:
                            dt = datetime.fromisoformat(str(date_raw).replace("Z", "+00:00"))
                            published_ts = int(dt.timestamp())
                            age = datetime.now(dt.tzinfo) - dt
                            mins = int(age.total_seconds() // 60)
                            if mins < 60:
                                time_str = f"{mins}分钟前" if mins > 0 else "刚刚"
                            elif mins < 24 * 60:
                                time_str = f"{mins // 60}小时前"
                            else:
                                time_str = f"{mins // (24 * 60)}天前"
                    except:
                        time_str = str(date_raw) if date_raw else "刚刚"

                    url = d.get("url") or ""
                    title = d.get("title") or ""
                    if not title:
                        continue
                    items.append({
                        "id": d.get("id") or random.randint(10000, 99999),
                        "title": title,
                        "source": d.get("source") or "OpenBB",
                        "category": "news",
                        "impact": "neutral",
                        "time": time_str,
                        "detail": d.get("summary") or d.get("excerpt") or d.get("text") or "",
                        "url": url,
                        "_ts": published_ts,
                        "_date": str(date_raw) if date_raw else "",
                    })
            except Exception as e:
                print(f"[!] OpenBB US news failed for {sym}: {e}")
    else:
        source_used = "fallback"

    uniq = {}
    for it in items:
        key = (it.get("url") or it.get("title") or "").strip()
        if not key:
            continue
        if key in uniq:
            continue
        uniq[key] = it
    items = list(uniq.values())

    items.sort(key=lambda x: int(x.get("_ts") or 0), reverse=True)

    today_items = []
    today = datetime.now().date()
    for it in items:
        ds = (it.get("_date") or "").strip()
        if not ds:
            continue
        try:
            dt = datetime.fromisoformat(ds.replace("Z", "+00:00"))
            if dt.astimezone().date() == today:
                today_items.append(it)
        except:
            continue
    if today_items:
        items = today_items

    if q:
        ql = q.lower()
        items = [it for it in items if ql in (str(it.get("title","")) + " " + str(it.get("detail","")) + " " + str(it.get("source",""))).lower()]

    if not items:
        source_used = "fallback"
        try:
            from curl_cffi import requests as creq
            import xml.etree.ElementTree as ET
            from email.utils import parsedate_to_datetime

            for sym in symbols[:10]:
                r = creq.get(
                    f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={sym}&region=US&lang=en-US",
                    timeout=10,
                    impersonate="chrome",
                )
                if getattr(r, "status_code", 0) >= 400:
                    continue
                root = ET.fromstring(r.text or "")
                for item in root.findall(".//item"):
                    title = (item.findtext("title") or "").strip()
                    link = (item.findtext("link") or "").strip()
                    pub = (item.findtext("pubDate") or "").strip()
                    src = (item.findtext("source") or "").strip() or "Yahoo Finance"
                    if not title or not link:
                        continue
                    time_str = "刚刚"
                    try:
                        dt = parsedate_to_datetime(pub) if pub else None
                        if dt:
                            age = datetime.now(dt.tzinfo) - dt
                            mins = int(age.total_seconds() // 60)
                            if mins < 60:
                                time_str = f"{mins}分钟前" if mins > 0 else "刚刚"
                            elif mins < 24 * 60:
                                time_str = f"{mins // 60}小时前"
                            else:
                                time_str = f"{mins // (24 * 60)}天前"
                    except Exception:
                        time_str = pub or "刚刚"
                    items.append({
                        "id": random.randint(10000, 99999),
                        "title": title,
                        "source": src,
                        "category": "news",
                        "impact": "neutral",
                        "time": time_str,
                        "detail": "",
                        "url": link,
                    })
                    if len(items) >= 400:
                        break
                if len(items) >= 400:
                    break

            if q:
                ql = q.lower()
                items = [it for it in items if ql in (str(it.get("title","")) + " " + str(it.get("source",""))).lower()]
        except Exception as e:
            print(f"[!] US news rss fallback failed: {e}")

    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    return jsonify({
        "success": True,
        "data": [{k: v for k, v in it.items() if not str(k).startswith("_")} for it in items[start:end]],
        "total": total,
        "page": page,
        "pageSize": page_size,
        "source": source_used,
        "updateTime": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
    })


# ============================================================
# 个股相关新闻 (akshare)
# ============================================================
def get_related_news(stock_code, stock_name, market="cn"):
    # ---- A股：akshare ----
    if market == "cn" and stock_code.isdigit() and len(stock_code) == 6:
        try:
            import akshare as ak, time
            time.sleep(0.2)
            df = ak.stock_news_em(symbol=stock_code)
            if df is not None and len(df) > 0:
                news_list = []
                for _, row in df.head(8).iterrows():
                    news_list.append({
                        "id":     random.randint(10000, 99999),
                        "title":  str(row.get("新闻标题", "")),
                        "source": str(row.get("新闻来源", "东方财富")),
                        "type":   "新闻",
                        "time":   str(row.get("发布时间", "刚刚")),
                        "detail": f"关于「{stock_name}」的新闻报道。",
                    })
                return news_list
        except Exception as e:
            print(f"[!] A股新闻失败: {e}")
        return [{"id": 1, "title": f"{stock_name} 相关新闻暂无数据", "source": "系统",
                 "type": "新闻", "time": "刚刚", "detail": "暂无数据"}]

    def _yahoo_rss_items(symbol, limit=5):
        try:
            from curl_cffi import requests as creq
            r = creq.get(
                f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={symbol}&region=US&lang=en-US",
                timeout=10,
                impersonate="chrome",
            )
            if getattr(r, "status_code", 0) >= 400:
                return []
            xml_text = r.text or ""
        except Exception:
            try:
                import requests
                r = requests.get(
                    f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={symbol}&region=US&lang=en-US",
                    timeout=10,
                )
                r.raise_for_status()
                xml_text = r.text or ""
            except Exception:
                return []

        try:
            import xml.etree.ElementTree as ET
            from email.utils import parsedate_to_datetime

            root = ET.fromstring(xml_text)
            out = []
            for item in root.findall(".//item"):
                title = (item.findtext("title") or "").strip()
                link = (item.findtext("link") or "").strip()
                pub = (item.findtext("pubDate") or "").strip()
                src = (item.findtext("source") or "").strip() or "Yahoo Finance"
                if not title or not link:
                    continue
                time_str = "刚刚"
                try:
                    dt = parsedate_to_datetime(pub) if pub else None
                    if dt:
                        age = datetime.now(dt.tzinfo) - dt
                        mins = int(age.total_seconds() // 60)
                        if mins < 60:
                            time_str = f"{mins}分钟前" if mins > 0 else "刚刚"
                        elif mins < 24 * 60:
                            time_str = f"{mins // 60}小时前"
                        else:
                            time_str = f"{mins // (24 * 60)}天前"
                except Exception:
                    time_str = pub or "刚刚"

                out.append({
                    "id": random.randint(10000, 99999),
                    "title": title,
                    "source": src,
                    "type": "新闻",
                    "time": time_str,
                    "detail": "",
                    "url": link,
                })
                if len(out) >= int(limit or 5):
                    break
            return out
        except Exception:
            return []

    if market == "us":
        obb = _get_obb()
        if obb:
            try:
                sym = format_symbol(stock_code)
                ob_news, nerr = _ob_call(lambda: obb.news.company(symbol=sym, limit=5, provider="yfinance"), timeout=12)
                items = []
                if not nerr and ob_news and getattr(ob_news, "results", None):
                    for r in ob_news.results[:5]:
                        d = r.model_dump() if hasattr(r, "model_dump") else {}
                        date_raw = d.get("date")
                        time_str = "刚刚"
                        try:
                            if date_raw:
                                dt = datetime.fromisoformat(str(date_raw).replace("Z", "+00:00"))
                                age = datetime.now(dt.tzinfo) - dt
                                mins = int(age.total_seconds() // 60)
                                if mins < 60:
                                    time_str = f"{mins}分钟前" if mins > 0 else "刚刚"
                                elif mins < 24 * 60:
                                    time_str = f"{mins // 60}小时前"
                                else:
                                    time_str = f"{mins // (24 * 60)}天前"
                        except:
                            time_str = str(date_raw) if date_raw else "刚刚"
                        items.append({
                            "id": d.get("id") or random.randint(10000, 99999),
                            "title": d.get("title") or "",
                            "source": d.get("source") or "OpenBB",
                            "type": "新闻",
                            "time": time_str,
                            "detail": d.get("summary") or d.get("excerpt") or d.get("text") or "",
                            "url": d.get("url") or "",
                        })
                if items:
                    return items
            except Exception as e:
                print(f"[!] OpenBB US related news failed for {stock_code}: {e}")
        rss_items = _yahoo_rss_items(stock_code, limit=5)
        if rss_items:
            return rss_items

    # ---- 美股 / 港股 / 加密货币：yfinance ----
    try:
        import yfinance as yf
        ticker_sym = stock_code
        # yfinance 需要 .OB 后缀用于美股粉单
        ticker = yf.Ticker(ticker_sym)
        news_items = ticker.news or []
        if news_items:
            news_list = []
            for item in news_items[:8]:
                t = item.get("title", "")
                if not t:
                    continue
                from datetime import datetime as _dt
                ts = item.get("providerPublishTime", 0)
                age = _dt.now() - _dt.fromtimestamp(ts) if ts else None
                time_str = "刚刚"
                if age:
                    if age.seconds < 3600:
                        time_str = f"{age.seconds // 60}分钟前"
                    elif age.days < 1:
                        time_str = f"{age.seconds // 3600}小时前"
                    else:
                        time_str = f"{age.days}天前"
                news_list.append({
                    "id":     item.get("uuid", random.randint(10000, 99999)),
                    "title":  t,
                    "source": item.get("publisher", "Yahoo Finance"),
                    "type":   "新闻",
                    "time":   time_str,
                    "detail": f"关于「{stock_name}」({stock_code})的市场新闻。",
                    "url":    item.get("link", ""),
                })
            return news_list
    except Exception as e:
        print(f"[!] US stock news failed for {stock_code}: {e}")
    if market == "us":
        rss_items = _yahoo_rss_items(stock_code, limit=5)
        if rss_items:
            return rss_items
    return [{"id": 1, "title": f"{stock_name}({stock_code}) 相关新闻暂无数据", "source": "系统",
             "type": "新闻", "time": "刚刚", "detail": "暂无数据"}]

@app.route("/api/stock/related-news")
def api_related_news():
    code   = request.args.get("code")
    market = request.args.get("market", "cn").strip().lower()
    name   = request.args.get("name", code or "")
    if not code:
        return jsonify({"error": "请提供股票代码"}), 400
    data = get_related_news(code, name, market)
    if not data:
        if market == "us":
            q = str(code).strip().upper()
            url = f"https://finance.yahoo.com/quote/{q}/news"
            data = [
                {"id": i + 1, "title": f"{q} 相关新闻（数据源暂不可用）", "source": "系统",
                 "type": "新闻", "time": "刚刚", "detail": "请稍后重试或点击查看 Yahoo Finance 新闻页。", "url": url}
                for i in range(5)
            ]
        else:
            data = [{"id": 1, "title": f"{name}({code}) 相关新闻暂无数据", "source": "系统",
                     "type": "新闻", "time": "刚刚", "detail": "暂无数据"}]
    return jsonify({"success": True, "data": data,
                    "updateTime": datetime.now().strftime("%Y-%m-%d %H:%M:%S")})


# ============================================================
# 财务报表 (akshare EM)
# ============================================================
INCOME_FIELDS  = ["period_ending","fiscal_period","operating_revenue","total_revenue",
                  "cost_of_revenue","gross_profit","operating_income","ebitda",
                  "total_pre_tax_income","tax_provision","net_income",
                  "basic_earnings_per_share","diluted_earnings_per_share"]
BALANCE_FIELDS = ["period_ending","fiscal_period","cash_and_cash_equivalents",
                  "short_term_investments","total_current_assets","plant_property_equipment_net",
                  "total_assets","accounts_payable","total_current_liabilities",
                  "long_term_debt","total_liabilities_net_minority_interest","total_equity"]
CASH_FIELDS    = ["period_ending","fiscal_period","net_income_from_continuing_operations",
                  "depreciation_and_amortization","cash_flow_from_continuing_operating_activities",
                  "net_investment_purchase_and_sale","cash_flow_from_continuing_financing_activities",
                  "net_change_in_cash_and_equivalents","free_cash_flow"]

def _row_dict(row, fields):
    d = row if isinstance(row, dict) else (row.model_dump() if hasattr(row, "model_dump") else {})
    return {f: _fmt(d.get(f)) for f in fields}

@app.route("/api/stock/financial/income")
def get_income():
    symbol = request.args.get("code", "").strip()
    period = request.args.get("period", "annual")
    limit  = min(int(request.args.get("limit", 5)), 5)
    if not symbol:
        return jsonify({"error": "Missing code"}), 400
    obb = _get_obb()
    if obb:
        try:
            sym = format_symbol(symbol)
            data = obb.equity.fundamental.income(sym, period=period, limit=limit)
            rows = [_row_dict(r, INCOME_FIELDS) for r in data.results]
            return jsonify({"success": True, "symbol": sym, "period": period, "data": rows})
        except Exception as e:
            print(f"[!] Income Error: {e}")
    return jsonify({"success": False, "error": "OpenBB 不可用"}), 500

@app.route("/api/stock/financial/balance")
def get_balance():
    symbol = request.args.get("code", "").strip()
    period = request.args.get("period", "annual")
    limit  = min(int(request.args.get("limit", 5)), 5)
    if not symbol:
        return jsonify({"error": "Missing code"}), 400
    obb = _get_obb()
    if obb:
        try:
            sym = format_symbol(symbol)
            data = obb.equity.fundamental.balance(sym, period=period, limit=limit)
            rows = [_row_dict(r, BALANCE_FIELDS) for r in data.results]
            return jsonify({"success": True, "symbol": sym, "period": period, "data": rows})
        except Exception as e:
            print(f"[!] Balance Error: {e}")
    return jsonify({"success": False, "error": "OpenBB 不可用"}), 500

@app.route("/api/stock/financial/cash")
def get_cash():
    symbol = request.args.get("code", "").strip()
    period = request.args.get("period", "annual")
    limit  = min(int(request.args.get("limit", 5)), 5)
    if not symbol:
        return jsonify({"error": "Missing code"}), 400
    obb = _get_obb()
    if obb:
        try:
            sym = format_symbol(symbol)
            data = obb.equity.fundamental.cash(sym, period=period, limit=limit)
            rows = [_row_dict(r, CASH_FIELDS) for r in data.results]
            return jsonify({"success": True, "symbol": sym, "period": period, "data": rows})
        except Exception as e:
            print(f"[!] Cash Error: {e}")
    return jsonify({"success": False, "error": "OpenBB 不可用"}), 500

@app.route("/api/stock/financial")
def get_financial():
    """兼容旧端点 → 统一走 /api/stock/financial/income"""
    code   = request.args.get("code")
    period = request.args.get("period", "annual")
    if not code:
        return jsonify({"error": "请提供股票代码"}), 400
    return get_income()


# ============================================================
# 估值指标 / 管理层 (OpenBB Package)
# ============================================================
@app.route("/api/stock/metrics")
def get_stock_metrics():
    stock_code = request.args.get("code")
    if not stock_code:
        return jsonify({"error": "Missing code"}), 400
    obb = _get_obb()
    if not obb:
        return jsonify({"pe_ratio": None}), 500
    try:
        sym = format_symbol(stock_code)
        m = obb.equity.fundamental.metrics(sym, provider="yfinance", limit=1)
        if m.results:
            r = m.results[0].model_dump()
            return jsonify({
                "pe_ratio":         to_float_2(r.get("pe_ratio")),
                "eps_ttm":          to_float_2(r.get("eps_ttm")),
                "dividend_yield":   to_float_2(r.get("dividend_yield")),
                "forward_pe":       to_float_2(r.get("forward_pe")),
                "market_cap":       to_float_2(r.get("market_cap")),
                "beta":             to_float_2(r.get("beta")),
            })
    except Exception as e:
        print(f"Metrics Error: {e}")
    return jsonify({"pe_ratio": None}), 404

@app.route("/api/stock/management")
def get_management():
    stock_code = request.args.get("code")
    if not stock_code:
        return jsonify({"error": "Missing code"}), 400
    obb = _get_obb()
    if not obb:
        return jsonify({"error": "OpenBB 不可用"}), 500
    try:
        sym  = format_symbol(stock_code)
        df   = obb.equity.fundamental.management(sym).to_dataframe()
        if df.empty:
            return jsonify({"error": "No management data"}), 404
        import pandas as pd
        rows = []
        for _, row in df.iterrows():
            rows.append({
                "title":          str(row.get("title", "")),
                "name":           str(row.get("name", "")),
                "pay":            to_float(row.get("pay", 0)),
                "year_born":      int(row["year_born"]) if pd.notna(row.get("year_born")) else None,
                "age":            int(row["age"])       if pd.notna(row.get("age"))       else None,
                "exercised_value": to_float(row.get("exercised_value", 0)),
                "unexercised_value": to_float(row.get("unexercised_value", 0)),
                "fiscal_year":    str(row.get("fiscal_year", "")),
            })
        return jsonify({"code": stock_code, "data": rows})
    except Exception as e:
        print(f"Management Error: {e}")
        return jsonify({"error": str(e)}), 500


# ============================================================
# 技术指标仪表盘 (OpenBB Package)
# ============================================================
@app.route("/api/technical/dashboard")
def get_technical_dashboard():
    stock_code = request.args.get("code")
    if not stock_code:
        return jsonify({"error": "Missing code"}), 400
    obb = _get_obb()
    if not obb:
        return jsonify({"error": "OpenBB 不可用"}), 500
    try:
        sym = format_symbol(stock_code)
        df  = obb.equity.price.historical(sym, provider="yfinance").to_dataframe()
        if df.empty:
            return jsonify({"error": "No data"}), 404
        import numpy as np
        result = {
            "code": stock_code,
            "quote": {
                "last_price":    to_float(df["close"].iloc[-1]),
                "change":        to_float(df["close"].iloc[-1] - df["close"].iloc[-2]) if len(df) > 1 else 0,
                "change_percent": to_float((df["close"].iloc[-1] - df["close"].iloc[-2]) /
                                             df["close"].iloc[-2] * 100) if len(df) > 1 else 0,
            }
        }
        # RSI
        try:
            rsi_df = obb.technical.rsi(data=df).to_dataframe()
            v = to_float(rsi_df["rsi_14"].iloc[-1])
            result["rsi"] = {"value": v,
                             "signal": "overbought" if v and v > 70 else
                                       "oversold"  if v and v < 30 else "neutral"}
        except Exception as e:
            print(f"RSI Error: {e}")
            result["rsi"] = {"value": 0, "signal": "unknown"}

        # MACD
        try:
            macd_df = obb.technical.macd(data=df).to_dataframe()
            hv = to_float(macd_df["close_MACDh_12_26_9"].iloc[-1])
            result["macd"] = {
                "macd":     to_float(macd_df["close_MACD_12_26_9"].iloc[-1]),
                "signal":   to_float(macd_df["close_MACDs_12_26_9"].iloc[-1]),
                "histogram": hv,
                "trend":    "bullish" if hv and hv > 0 else "bearish"
            }
        except Exception as e:
            print(f"MACD Error: {e}")
            result["macd"] = {"macd": 0, "signal": 0, "histogram": 0, "trend": "unknown"}

        # KDJ / Stoch
        try:
            kdj_df = obb.technical.stoch(data=df).to_dataframe()
            jv = to_float(kdj_df["close_STOCHj_14_3_3"].iloc[-1])
            result["kdj"] = {
                "k":      to_float(kdj_df["close_STOCHk_14_3_3"].iloc[-1]),
                "d":      to_float(kdj_df["close_STOCHd_14_3_3"].iloc[-1]),
                "j":      jv,
                "signal": "overbought" if jv and jv > 80 else "oversold" if jv and jv < 20 else "neutral"
            }
        except Exception as e:
            print(f"KDJ Error: {e}")
            result["kdj"] = {"k": 0, "d": 0, "j": 0, "signal": "unknown"}

        # Bollinger Bands
        try:
            bb_df = obb.technical.bbands(data=df).to_dataframe()
            upper = to_float(bb_df["close_BBANDS_u_20_2"].iloc[-1])
            lower = to_float(bb_df["close_BBANDS_l_20_2"].iloc[-1])
            mid   = to_float(bb_df["close_BBANDS_m_20_2"].iloc[-1])
            pos   = 50
            if upper and lower and upper != lower:
                pos = round((to_float(df["close"].iloc[-1]) - lower) / (upper - lower) * 100, 2)
            result["bbands"] = {"upper": upper, "middle": mid, "lower": lower, "position": pos}
        except Exception as e:
            print(f"BBANDS Error: {e}")
            result["bbands"] = {"upper": 0, "middle": 0, "lower": 0, "position": 50}

        # ADX
        try:
            adx_df = obb.technical.adx(data=df).to_dataframe()
            adv = to_float(adx_df["close_ADX_14"].iloc[-1])
            result["adx"] = {"value": adv,
                             "trend_strength": "strong" if adv and adv > 25 else "weak"}
        except Exception as e:
            print(f"ADX Error: {e}")
            result["adx"] = {"value": 0, "trend_strength": "unknown"}

        # EMA
        try:
            ema_df = obb.technical.ema(data=df).to_dataframe()
            result["ema"] = {
                "ema20": to_float(ema_df["close_EMA_20"].iloc[-1]) if "close_EMA_20" in ema_df.columns else 0,
                "ema60": to_float(ema_df["close_EMA_60"].iloc[-1]) if "close_EMA_60" in ema_df.columns else 0,
            }
        except Exception as e:
            print(f"EMA Error: {e}")
            result["ema"] = {"ema20": 0, "ema60": 0}

        # K线 (最近30天)
        kline = []
        for idx, row in df.tail(30).iterrows():
            kline.append({
                "date":  idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx),
                "close": to_float(row["close"]),
            })
        result["kline"] = kline

        # ---- 支撑位与压力位 ----
        try:
            close_cur = to_float(df["close"].iloc[-1])
            fib_df = obb.technical.fib(data=df, target="close").to_dataframe()
            fib_levels = []
            for _, row in fib_df.iterrows():
                lvl = str(row.get("Level", ""))
                price = to_float(row.get("Price"))
                if price:
                    is_resistance = bool(close_cur and close_cur < price)
                    fib_levels.append({
                        "level":    lvl.replace("%",""),
                        "price":    price,
                        "type":     "resistance" if is_resistance else "support",
                        "distance": round((close_cur - price) / close_cur * 100, 2) if close_cur else 0
                    })

            atr_df = obb.technical.atr(data=df, window=14).to_dataframe()
            atr_val = to_float(atr_df.iloc[-1].get("ATRr_14")) if len(atr_df) else 0
            atr_levels = {}
            if atr_val:
                atr_levels = {
                    "atr":        round(atr_val, 2),
                    "resistance1": round(close_cur + 1.5 * atr_val, 2),
                    "resistance2": round(close_cur + 2.0 * atr_val, 2),
                    "support1":   round(close_cur - 1.5 * atr_val, 2),
                    "support2":   round(close_cur - 2.0 * atr_val, 2),
                }

            dc_df = obb.technical.donchian(data=df).to_dataframe()
            dc_lower = [c for c in dc_df.columns if c.startswith('DCL')]
            dc_mid   = [c for c in dc_df.columns if c.startswith('DCM')]
            dc_upper = [c for c in dc_df.columns if c.startswith('DCU')]
            donchian = {}
            if dc_lower and dc_mid and dc_upper:
                donchian = {
                    "lower":   to_float(dc_df[dc_lower[0]].iloc[-1]),
                    "middle":  to_float(dc_df[dc_mid[0]].iloc[-1]),
                    "upper":   to_float(dc_df[dc_upper[0]].iloc[-1]),
                }

            result["support_resistance"] = {
                "fib":      fib_levels,
                "atr":      atr_levels,
                "donchian": donchian,
            }
        except Exception as e:
            print(f"Support/Resistance Error: {e}")
            result["support_resistance"] = {"fib": [], "atr": {}, "donchian": {}}

        return jsonify(result)
    except Exception as e:
        print(f"Dashboard Error: {e}")
        return jsonify({"error": str(e)}), 500


# ============================================================
# AI 分析 (通义千问 + 规则降级)
# ============================================================
def _calc_enhanced_analysis(kline_data, pe=None, pb=None, holdings=None):
    analysis = {
        "support_resistance": {"supports": [], "resistances": [], "reasons": []},
        "gaps":               {"gaps": [],       "reasons": []},
        "prediction":         {"predictions": [], "trend": "neutral",
                               "confidence": 50, "recommendation": "", "reasons": []},
    }
    if not kline_data or len(kline_data) < 20:
        return analysis
    data = kline_data[-60:]
    latest = data[-1]
    closes = [d["close"] for d in data]
    volumes = [d["volume"] for d in data]

    # 均线
    ma5  = sum(closes[-5:])  / 5  if len(closes) >= 5  else latest["close"]
    ma10 = sum(closes[-10:]) / 10 if len(closes) >= 10 else latest["close"]
    ma20 = sum(closes[-20:]) / 20 if len(closes) >= 20 else latest["close"]

    # 量能
    avg_vol = sum(volumes[-20:]) / 20 if len(volumes) >= 20 else volumes[-1]
    cur_vol = volumes[-1]

    trend = "neutral"
    conf  = 50
    reasons = []
    if latest["close"] > ma5 > ma10 > ma20:
        trend = "bullish"; conf += 15
        reasons.append("均线多头排列，中期向上")
    elif latest["close"] < ma5 < ma10 < ma20:
        trend = "bearish"; conf += 15
        reasons.append("均线空头排列，中期向下")
    else:
        reasons.append("均线交织，方向不明")

    if cur_vol > avg_vol * 1.5:
        if latest["close"] > data[-2]["close"]:
            conf += 10
            reasons.append(f"成交量放大{cur_vol/avg_vol:.1f}倍，配合上涨，资金流入")
        else:
            conf -= 10
            reasons.append(f"成交量放大{cur_vol/avg_vol:.1f}倍，但价格下跌，资金流出")
    elif cur_vol < avg_vol * 0.5:
        reasons.append(f"成交量萎缩，市场观望")

    if pe:
        if 0 < pe < 20:   conf += 10; reasons.append(f"PE={pe:.1f}偏低，估值有安全边际")
        elif pe > 50:     conf -= 10; reasons.append(f"PE={pe:.1f}偏高，估值偏高")
    if pb:
        if 0 < pb < 2:    conf += 5;  reasons.append(f"PB={pb:.1f}较低，资产质量好")
        elif pb > 5:      conf -= 5;  reasons.append(f"PB={pb:.1f}偏高")

    conf = max(20, min(85, conf))
    predictions = []
    cur = latest["close"]
    for i in range(1, 4):
        d = (datetime.now() + timedelta(days=i)).strftime("%Y-%m-%d")
        vol = 0.02 if trend == "bullish" else -0.02 if trend == "bearish" \
              else (random.random() - 0.5) * 0.02
        cur += cur * vol * (0.5 + random.random() * 0.5)
        predictions.append({
            "date":            d,
            "predictedPrice":  round(cur, 2),
            "change":          round((cur - latest["close"]) / latest["close"] * 100, 2),
        })

    rec = ("建议增持" if conf >= 70 and trend == "bullish" else
           "建议持有" if conf >= 60 and trend == "bullish" else
           "建议减仓" if conf <= 40 and trend == "bearish" else "建议观望")

    analysis["prediction"] = {
        "predictions":   predictions,
        "trend":        trend,
        "confidence":   conf,
        "recommendation": rec,
        "reasons":      reasons,
    }
    return analysis

@app.route("/api/ai/analyze")
def ai_analyze():
    stock_code = request.args.get("code")
    if not stock_code:
        return jsonify({"error": "Missing code"}), 400
    sym = format_symbol(stock_code)
    obb  = _get_obb()
    ctx  = {}
    if obb:
        try:
            info = obb.equity.profile(sym, provider="yfinance").to_dataframe()
            if not info.empty:
                ctx["profile"] = info.iloc[0].to_dict()
        except:
            pass
        try:
            df = obb.equity.price.historical(sym, provider="yfinance").to_dataframe()
            if not df.empty:
                ctx["recent_performance"] = df.tail(5).to_dict()
        except:
            pass
    prompt  = f"请分析股票 {stock_code}。背景: {ctx}。请给出投资建议。"
    result  = call_qwen_api(prompt)
    if not result:
        result = "AI 分析暂时不可用，请稍后重试。"
    return jsonify({"analysis": result})

@app.route("/api/ai/analysis", methods=["GET", "POST"])
def ai_analysis():
    if request.method == "POST":
        data     = request.json or {}
        code     = data.get("code")
        market   = data.get("market", "cn").strip().lower()
        holdings = data.get("holdings", [])
    else:
        code   = request.args.get("code")
        market = request.args.get("market", "cn").strip().lower()
        holdings = []

    if not code:
        return jsonify({"error": "请提供股票代码"}), 400

    # ---- A股路径 ----
    if market == "cn" and code.isdigit() and len(code) == 6:
        try:
            ak = get_complete_akshare_data(code)
            if not ak:
                return jsonify({"error": "获取数据失败"}), 500
            en = _calc_enhanced_analysis(ak["data"], pe=ak.get("pe"), pb=ak.get("pb"),
                                          holdings=holdings)
            return jsonify({
                "success": True,
                "stock": {"name": ak["name"], "code": code,
                          "price": ak["price"], "change": ak["change"],
                          "changePercent": ak["changePercent"],
                          "pe": ak.get("pe"), "pb": ak.get("pb"),
                          "volume": ak["volume"]},
                "analysis": en,
                "updateTime": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            })
        except Exception as e:
            print(f"[!] A股 AI Analysis Error: {e}")
            return jsonify({"error": f"AI 分析失败: {e}"}), 500

    # ---- 美股 / 港股 / 加密货币 路径（via OpenBB Package）----
    obb = _get_obb()
    if not obb:
        return jsonify({"error": "OpenBB 不可用"}), 503

    try:
        sym = format_symbol(code)
        # 并行获取历史价格和估值指标（超时保护）
        df_hist, herr = _ob_call(
            lambda: obb.equity.price.historical(sym, interval="1d", provider="yfinance").to_dataframe(),
            timeout=20)
        m_data, merr = _ob_call(
            lambda: obb.equity.fundamental.metrics(sym, provider="yfinance", limit=1),
            timeout=15)

        if df_hist is None or (hasattr(df_hist, 'empty') and df_hist.empty):
            return jsonify({"error": f"无法获取 {code} 的历史数据: {herr or 'no data'}"}), 502

        pe_val, pb_val = None, None
        if m_data and hasattr(m_data, 'results') and m_data.results:
            r = m_data.results[0].model_dump()
            pe_val = to_float_2(r.get('pe_ratio'))
            pb_val = to_float_2(r.get('price_to_book'))

        # 转换为 kline 格式（list of dicts）
        kline_data = []
        for idx, row in df_hist.tail(365).iterrows():
            kline_data.append({
                "date":   idx.strftime("%Y-%m-%d") if hasattr(idx, "strftime") else str(idx),
                "open":   to_float_2(row.get('open')),
                "high":   to_float_2(row.get('high')),
                "low":    to_float_2(row.get('low')),
                "close":  to_float_2(row.get('close')),
                "volume": int(to_float(row.get('volume')) or 0),
            })

        en = _calc_enhanced_analysis(kline_data, pe=pe_val, pb=pb_val, holdings=holdings)

        # ---- OpenBB 技术分析：支撑位与压力位 ----
        try:
            close_cur = to_float_2(df_hist["close"].iloc[-1])
            fib_df = obb.technical.fib(data=df_hist, target="close").to_dataframe()
            fib_levels = []
            for _, row in fib_df.iterrows():
                lvl = str(row.get("Level", ""))
                price = to_float_2(row.get("Price"))
                if price:
                    # 当前价在区间上方时，level 下方是支撑；当前价在区间下方时，level 上方是压力
                    is_resistance = bool(close_cur and close_cur < price)
                    fib_levels.append({
                        "level":    lvl.replace("%",""),
                        "price":    price,
                        "type":     "resistance" if is_resistance else "support",
                        "distance": round((close_cur - price) / close_cur * 100, 2) if close_cur else 0
                    })

            atr_df = obb.technical.atr(data=df_hist, window=14).to_dataframe()
            atr_val = to_float_2(atr_df.iloc[-1].get("ATRr_14")) if len(atr_df) else 0
            atr_levels = {}
            if atr_val:
                atr_levels = {
                    "atr":        round(atr_val, 2),
                    "resistance1": round(close_cur + 1.5 * atr_val, 2),
                    "resistance2": round(close_cur + 2.0 * atr_val, 2),
                    "support1":   round(close_cur - 1.5 * atr_val, 2),
                    "support2":   round(close_cur - 2.0 * atr_val, 2),
                }

            dc_df = obb.technical.donchian(data=df_hist).to_dataframe()
            # 列名如 DCL_20_20, DCM_20_20, DCU_20_20
            dc_lower = [c for c in dc_df.columns if c.startswith('DCL')]
            dc_mid   = [c for c in dc_df.columns if c.startswith('DCM')]
            dc_upper = [c for c in dc_df.columns if c.startswith('DCU')]
            donchian = {}
            if dc_lower and dc_mid and dc_upper:
                donchian = {
                    "lower":  to_float_2(dc_df[dc_lower[0]].iloc[-1]),
                    "middle": to_float_2(dc_df[dc_mid[0]].iloc[-1]),
                    "upper":  to_float_2(dc_df[dc_upper[0]].iloc[-1]),
                }

            en["support_resistance"]["openbb"] = {
                "fib":      fib_levels,
                "atr":      atr_levels,
                "donchian": donchian,
            }
            en["support_resistance"]["currentPrice"] = close_cur
        except Exception as e:
            print(f"OpenBB SR Error: {e}")

        # 获取最新报价
        last = df_hist.iloc[-1]
        prev = df_hist.iloc[-2] if len(df_hist) > 1 else last
        price = to_float_2(last.get('close'))
        pre_c = to_float_2(prev.get('close'))
        chg   = round(price - pre_c, 2) if price and pre_c else 0
        pct   = round(chg / pre_c * 100, 2) if pre_c else 0

        qt_name = sym
        try:
            qt_df = obb.equity.price.quote(sym).to_dataframe()
            if not qt_df.empty:
                qt_name = qt_df.iloc[0].get('name', sym)
        except:
            pass

        return jsonify({
            "success": True,
            "stock": {
                "name":          qt_name,
                "code":          code,
                "price":         price,
                "change":        chg,
                "changePercent": pct,
                "pe":            pe_val,
                "pb":            pb_val,
                "volume":        int(to_float(last.get('volume')) or 0),
            },
            "analysis": en,
            "updateTime": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        })
    except Exception as e:
        print(f"[!] US Stock AI Analysis Error: {e}")
        return jsonify({"error": f"AI 分析失败: {e}"}), 500

@app.route("/api/enhanced/analysis", methods=["GET", "POST"])
def enhanced_analysis():
    return ai_analysis()   # 合并后统一走 ai_analysis 路径

@app.route("/api/ai/chat", methods=["POST"])
def ai_chat():
    try:
        msg  = (request.json or {}).get("message", "")
        mem  = load_memory()
        summ = get_memory_summary()
        sys_p = f"""你是一个专业的股票投资助手。
参考用户历史: {summ}
保持友好、专业，回答简洁。"""
        messages = [{"role": "system", "content": sys_p}]
        for h in mem.get("chat_history", [])[-20:]:
            messages.append(h)
        messages.append({"role": "user", "content": msg})
        reply = call_qwen_api(msg, system_prompt=sys_p)
        if reply:
            mem["chat_history"].append({"role": "user",   "content": msg,
                                        "timestamp": datetime.now().isoformat()})
            mem["chat_history"].append({"role": "assistant", "content": reply,
                                        "timestamp": datetime.now().isoformat()})
            save_memory(mem)
            return jsonify({"success": True, "reply": reply, "has_memory": True})
        return jsonify({"success": True,
                        "reply": "AI 暂时不可用，请检查通义千问配置。",
                        "has_memory": False})
    except Exception as e:
        return jsonify({"error": f"聊天失败: {e}"}), 500


# ============================================================
# TradingAgents 研报
# ============================================================
@app.route("/api/ai/tradingagents/report", methods=["POST"])
def ta_report():
    try:
        data = request.json or {}
        symbol  = (data.get("symbol") or data.get("code") or "").strip().upper()
        tdate   = (data.get("date")   or "").strip()
        lang    = (data.get("language") or "Chinese").strip()
        oai_key = (data.get("openai_api_key") or "").strip()
        oai_url = (data.get("openai_base_url") or "").strip()
        deep    = (data.get("deep_model") or "").strip()
        quick   = (data.get("quick_model") or "").strip()
        max_deb = data.get("max_debate_rounds")
        max_rsk = data.get("max_risk_discuss_rounds")
        mode    = (data.get("mode") or "fast").strip()
        analysts= (data.get("analysts") or "").strip()

        if not symbol:
            return jsonify({"error": "请提供股票代码"}), 400
        if not os.environ.get("OPENAI_API_KEY") and not oai_key:
            return jsonify({"error": "未配置 OPENAI_API_KEY"}), 400

        venv_py = os.path.join(os.path.dirname(__file__), ".venv_tradingagents", "bin", "python")
        runner  = os.path.join(os.path.dirname(__file__), "tradingagents_runner.py")
        if not os.path.exists(venv_py):
            return jsonify({"error": "TradingAgents 未安装"}), 500
        if not os.path.exists(runner):
            return jsonify({"error": "runner 脚本缺失"}), 500

        ck = (symbol, tdate, lang, oai_url, deep, quick,
              str(max_deb), str(max_rsk), mode, analysts)
        cached = _ta_cache_get(ck)
        if cached:
            return jsonify({"success": True, "data": cached, "cached": True})

        cmd = [venv_py, runner, "--symbol", symbol]
        if tdate:    cmd += ["--date", tdate]
        if lang:    cmd += ["--language", lang]
        if oai_url: cmd += ["--base_url", oai_url]
        if deep:    cmd += ["--deep_model", deep]
        if quick:   cmd += ["--quick_model", quick]
        if str(max_deb).strip():  cmd += ["--max_debate_rounds",       str(max_deb)]
        if str(max_rsk).strip():  cmd += ["--max_risk_discuss_rounds",  str(max_rsk)]
        if mode:    cmd += ["--mode", mode]
        if analysts: cmd += ["--analysts", analysts]

        env = os.environ.copy()
        if oai_key and "OPENAI_API_KEY" not in env:
            env["OPENAI_API_KEY"] = oai_key
        try:
            port = request.host.split(":")[1] if ":" in request.host else "3000"
        except:
            port = "3000"
        env["TA_DATA_BASE_URL"] = f"http://127.0.0.1:{port}"

        proc = subprocess.run(cmd, cwd=os.path.dirname(__file__),
                             capture_output=True, text=True,
                             encoding="utf-8", errors="replace",
                             env=env, timeout=180)
        stdout = (proc.stdout or "").strip()
        try:
            payload = json.loads(stdout) if stdout else None
        except:
            payload = None
        if proc.returncode == 0 and payload and payload.get("ok"):
            _ta_cache_set(ck, payload)
            return jsonify({"success": True, "data": payload})
        if payload and payload.get("error"):
            return jsonify({"error": _sanitize_secret(payload.get("error"))}), 502
        err = (proc.stderr or stdout or f"exit={proc.returncode}")[:2000]
        return jsonify({"error": _sanitize_secret(err)}), 502
    except subprocess.TimeoutExpired:
        return jsonify({"error": "TradingAgents 执行超时"}), 504
    except Exception as e:
        return jsonify({"error": f"执行失败: {e}"}), 500

@app.route("/api/ai/tradingagents/health")
def ta_health():
    try:
        venv_py  = os.path.join(os.path.dirname(__file__), ".venv_tradingagents", "bin", "python")
        runner   = os.path.join(os.path.dirname(__file__), "tradingagents_runner.py")
        env_key  = os.environ.get("OPENAI_API_KEY")
        dot_key  = _read_dotenv("OPENAI_API_KEY")
        return jsonify({
            "success": True,
            "data": {
                "server_python": os.sys.version.split(" ")[0],
                "has_openai_key_env":   bool(env_key),
                "has_openai_key_dotenv": bool(dot_key),
                "ta_venv_exists":  os.path.exists(venv_py),
                "ta_runner_exists": os.path.exists(runner),
                "env_dotenv_match": bool(env_key and dot_key and env_key == dot_key),
                "env_key_fp":  _fingerprint_secret(env_key),
                "dotenv_key_fp": _fingerprint_secret(dot_key),
            }
        })
    except Exception as e:
        return jsonify({"error": f"health 检查失败: {e}"}), 500


# ============================================================
# 投资策略
# ============================================================
@app.route("/api/strategy", methods=["GET"])
def get_strategies():
    return jsonify({"success": True, "data": load_strategies().get("strategies", [])})

@app.route("/api/strategy", methods=["POST"])
def add_strategy():
    try:
        d = request.json
        title   = d.get("title", "")
        content = d.get("content", "")
        tags    = d.get("tags", [])
        if not title or not content:
            return jsonify({"error": "标题和内容不能为空"}), 400
        strat = load_strategies()
        new_s = {"id": len(strat["strategies"]) + 1, "title": title,
                 "content": content, "tags": tags,
                 "created_at": datetime.now().isoformat()}
        strat["strategies"].append(new_s)
        save_strategies(strat)
        return jsonify({"success": True, "data": new_s})
    except Exception as e:
        return jsonify({"error": f"添加策略失败: {e}"}), 500

@app.route("/api/strategy/<int:sid>", methods=["DELETE"])
def del_strategy(sid):
    try:
        strat = load_strategies()
        strat["strategies"] = [s for s in strat.get("strategies", []) if s.get("id") != sid]
        save_strategies(strat)
        return jsonify({"success": True})
    except Exception as e:
        return jsonify({"error": f"删除策略失败: {e}"}), 500

@app.route("/api/memory/clear", methods=["POST"])
def clear_memory():
    save_memory({"chat_history": [], "user_id": "default_user"})
    save_strategies({"strategies": []})
    return jsonify({"success": True})


# ============================================================
# 热门榜单 / 智能选股 (akshare)
# ============================================================
@app.route("/api/stock/ranking")
def get_ranking():
    try:
        import akshare as ak, time
        stocks = [{"code": "600519", "name": "贵州茅台"},
                  {"code": "300750", "name": "宁德时代"},
                  {"code": "601318", "name": "中国平安"},
                  {"code": "600036", "name": "招商银行"},
                  {"code": "002594", "name": "比亚迪"}]
        result = []
        for s in stocks:
            try:
                time.sleep(0.2)
                xq = f"SH{s['code']}" if s["code"].startswith("6") else f"SZ{s['code']}"
                df = ak.stock_individual_spot_xq(symbol=xq)
                if df is not None and len(df) > 0:
                    d = dict(zip(df["item"], df["value"]))
                    p   = float(d.get("现价", 0))
                    pct = float(d.get("涨跌幅", 0))
                    pre = float(d.get("昨收", p))
                    result.append({"code": s["code"], "name": s["name"],
                                   "price": p, "change": round(p - pre, 2),
                                   "changePercent": pct})
                else:
                    result.append({"code": s["code"], "name": s["name"],
                                   "price": 0, "change": 0, "changePercent": 0})
            except:
                result.append({"code": s["code"], "name": s["name"],
                               "price": 0, "change": 0, "changePercent": 0})
        return jsonify({"success": True, "data": result,
                        "updateTime": datetime.now().strftime("%Y-%m-%d %H:%M:%S")})
    except Exception as e:
        return jsonify({"error": f"获取榜单失败: {e}"}), 500

@app.route("/api/stock/picker")
def get_picker():
    """智能选股 — akshare 实时数据 + 通义千问理由生成"""
    try:
        import builtins, akshare as ak, time, random, pandas as pd
        _orig_print = builtins.print
        builtins.print = lambda *a, **k: None   # suppress all akshare prints
        targets = ["600519", "000858", "300750", "601318", "600036",
                   "002594", "000333", "601012", "002415", "300059"]
        mock = [
            {"代码": "600519", "名称": "贵州茅台", "最新价": 1680.0, "涨跌幅": 2.35,
             "市盈率-动态": 32.5, "市净率": 9.8},
            {"代码": "300750", "名称": "宁德时代", "最新价": 195.5, "涨跌幅": -0.82,
             "市盈率-动态": 28.3, "市净率": 4.5},
            {"代码": "600036", "名称": "招商银行", "最新价": 32.80, "涨跌幅": 0.35,
             "市盈率-动态": 8.5,  "市净率": 1.2},
        ]
        selected = None
        try:
            df = ak.stock_zh_a_spot_em()
            maotai = df[df["代码"] == "600519"]
            others = df[df["代码"].isin(targets[1:])]
            if len(others) >= 2:
                sel = others.sample(2)
                selected = pd.concat([maotai, sel], ignore_index=True)
            elif len(maotai) > 0:
                selected = maotai
        except Exception as e:
            builtins.print = _orig_print
            print(f"[!] picker real-time failed: {e}")
            selected = pd.DataFrame(mock[:3])
        finally:
            builtins.print = _orig_print

        recs = []
        for _, row in selected.head(3).iterrows():
            code  = str(row["代码"])
            name  = str(row["名称"])
            price = float(row["最新价"])
            pct   = float(row["涨跌幅"]) if pd.notna(row.get("涨跌幅")) else 0
            pe    = float(row["市盈率-动态"]) if pd.notna(row.get("市盈率-动态")) and row["市盈率-动态"] > 0 else 0
            pb    = float(row["市净率"]) if pd.notna(row.get("市净率")) and row["市净率"] > 0 else 0

            # 生成理由
            reasons = []
            ai_resp = call_qwen_api(
                f"股票{name}({code})现价¥{price}，涨跌幅{pct:+.2f}%，PE={pe}，PB={pb}。"
                "请给出3条简洁买入理由，以JSON数组返回，如[\"理由1\",\"理由2\",\"理由3\"]",
                system_prompt="你是一位专业股票分析师，回复JSON数组。")
            if ai_resp:
                try:
                    import re as _re
                    m = _re.search(r'\[[\s\S]*\]', ai_resp)
                    if m:
                        reasons = json.loads(m.group(0))
                except:
                    pass
            if len(reasons) < 2:
                reasons = [f"涨跌幅{pct:+.2f}%，走势{'强' if pct > 0 else '弱'}",
                           f"PE={pe:.1f}{'估值合理' if 0<pe<40 else '估值偏高'}",
                           f"PB={pb:.1f}{'资产质量好' if 0<pb<3 else ''}"]

            industry_map = {"600519":"白酒","300750":"新能源","601318":"保险",
                             "600036":"银行","002594":"汽车","000333":"家电",
                             "601012":"光伏","002415":"安防","300059":"券商","000858":"白酒"}
            recs.append({
                "code": code, "name": name,
                "industry": industry_map.get(code, "优质股"),
                "currentPrice": price, "changePercent": pct,
                "pe": pe, "pb": pb,
                "reasons": reasons[:3],
                "buyPrice":  round(price * (1 + random.uniform(-0.01, 0.015)), 2),
                "stopLoss":  round(price * (1 - random.uniform(0.03, 0.06)), 2),
            })
        return jsonify({"success": True, "data": recs,
                        "updateTime": datetime.now().strftime("%Y-%m-%d %H:%M:%S")})
    except Exception as e:
        return jsonify({"error": f"智能选股失败: {e}"}), 500


# ============================================================
# 自选管理：搜索与技术指标
# ============================================================
_cn_code_name_cache = {"ts": 0, "data": None}
_cn_spot_cache = {"ts": 0, "data": None}

def _load_cn_code_name():
    import time as _time
    if _cn_code_name_cache["data"] is not None and (_time.time() - _cn_code_name_cache["ts"]) < 6 * 3600:
        return _cn_code_name_cache["data"]
    import akshare as ak
    df, err = _ob_call(lambda: ak.stock_info_a_code_name(), timeout=15)
    if err or df is None:
        if _cn_code_name_cache["data"] is not None:
            return _cn_code_name_cache["data"]
        raise RuntimeError(err or "akshare stock_info_a_code_name failed")
    rows = []
    for _, row in df.iterrows():
        rows.append({"code": str(row.get("code", "")).strip(), "name": str(row.get("name", "")).strip()})
    _cn_code_name_cache["data"] = rows
    _cn_code_name_cache["ts"] = _time.time()
    return rows

def _load_cn_spot_basic():
    import time as _time
    if _cn_spot_cache["data"] is not None and (_time.time() - _cn_spot_cache["ts"]) < 10 * 60:
        return _cn_spot_cache["data"]
    import akshare as ak
    df, err = _ob_call(lambda: ak.stock_zh_a_spot_em(), timeout=20)
    if err or df is None:
        if _cn_spot_cache["data"] is not None:
            return _cn_spot_cache["data"]
        raise RuntimeError(err or "akshare stock_zh_a_spot_em failed")
    code_col = "代码" if "代码" in df.columns else "code"
    name_col = "名称" if "名称" in df.columns else "name"
    rows = []
    for _, row in df.iterrows():
        rows.append({"code": str(row.get(code_col, "")).strip(), "name": str(row.get(name_col, "")).strip()})
    _cn_spot_cache["data"] = rows
    _cn_spot_cache["ts"] = _time.time()
    return rows

def _calc_ema(series, period):
    if not series or period <= 0:
        return []
    k = 2 / (period + 1)
    ema = []
    for i, v in enumerate(series):
        if v is None:
            ema.append(None)
            continue
        if i == 0 or ema[-1] is None:
            ema.append(v)
        else:
            ema.append(v * k + ema[-1] * (1 - k))
    return ema

def _calc_macd_simple(closes, fast=12, slow=26, signal=9):
    closes = [to_float(c) for c in closes if c is not None]
    if len(closes) < slow + signal:
        return None
    ema_fast = _calc_ema(closes, fast)
    ema_slow = _calc_ema(closes, slow)
    macd_line = [(f - s) if f is not None and s is not None else None for f, s in zip(ema_fast, ema_slow)]
    macd_vals = [m for m in macd_line if m is not None]
    sig_line = _calc_ema(macd_vals, signal)
    hist = macd_vals[-1] - sig_line[-1] if sig_line else None
    trend = "bullish" if hist is not None and hist > 0 else "bearish" if hist is not None else "unknown"
    return {"histogram": to_float_2(hist), "trend": trend}

@app.route("/api/watchlist/search")
def watchlist_search():
    market = (request.args.get("market") or "cn").strip().lower()
    q = (request.args.get("q") or "").strip()
    if not q:
        return jsonify({"success": False, "error": "缺少 q"}), 400
    if market == "cn":
        try:
            q2 = q.strip()
            rows = []
            try:
                rows = _load_cn_code_name()
            except Exception:
                rows = _load_cn_spot_basic()
            out = []
            if q2.isdigit():
                if len(q2) == 6:
                    out.append({"code": q2, "name": q2})
                for r in rows:
                    if r["code"].startswith(q2):
                        out.append(r)
                        if len(out) >= 10:
                            break
            else:
                for r in rows:
                    if q2 in r["name"]:
                        out.append(r)
                        if len(out) >= 10:
                            break
            return jsonify({"success": True, "data": out})
        except Exception as e:
            return jsonify({"success": False, "error": f"A股搜索失败: {e}"}), 502

    if market == "us":
        obb = _get_obb()
        if not obb:
            return jsonify({"success": False, "error": "OpenBB 不可用"}), 503
        try:
            q_raw = q.strip()
            q_sym = q_raw.upper()
            is_symbol = bool(q_raw and len(q_raw) <= 10 and all(c.isalnum() or c in "-._" for c in q_sym))

            out = []
            last_err = None
            for provider in ["nasdaq", "sec", ""]:
                try:
                    if provider:
                        r = obb.equity.search(query=q_raw, is_symbol=is_symbol, provider=provider)
                    else:
                        r = obb.equity.search(query=q_raw, is_symbol=is_symbol)
                    for it in (r.results or [])[:10]:
                        d = it.model_dump() if hasattr(it, "model_dump") else {}
                        code = str(d.get("symbol", "")).strip().upper()
                        name2 = str(d.get("name", "")).strip()
                        if not code:
                            continue
                        out.append({"code": code, "name": name2 or code})
                    if out:
                        break
                except Exception as e:
                    last_err = str(e)

            if out:
                uniq = {}
                for it in out:
                    uniq[it["code"]] = it
                return jsonify({"success": True, "data": list(uniq.values())[:10]})

            if is_symbol:
                qt_df, qerr = _ob_call(lambda: obb.equity.price.quote(q_sym, provider="yfinance").to_dataframe(), timeout=12)
                if not qerr and qt_df is not None and hasattr(qt_df, "iloc") and len(qt_df) > 0:
                    row = qt_df.iloc[0]
                    name2 = row.get("name") or row.get("short_name") or row.get("long_name") or q_sym
                    return jsonify({"success": True, "data": [{"code": q_sym, "name": str(name2)}]})
                if qerr:
                    last_err = f"{last_err or ''} | quote: {qerr}".strip(" |")

            return jsonify({"success": True, "data": [], "warning": f"OpenBB 搜索无结果：{last_err or 'no result'}"})
        except Exception as e:
            return jsonify({"success": False, "error": f"OpenBB 搜索失败: {e}"}), 502

    return jsonify({"success": False, "error": "该市场暂不支持"}), 400

@app.route("/api/watchlist/indicators")
def watchlist_indicators():
    market = (request.args.get("market") or "cn").strip().lower()
    code = (request.args.get("code") or "").strip().upper()
    name = (request.args.get("name") or "").strip()
    if not code:
        return jsonify({"success": False, "error": "缺少 code"}), 400

    if market == "cn":
        import akshare as ak
        import time as _time
        from datetime import timedelta

        today = datetime.now().strftime("%Y%m%d")
        start = (datetime.now() - timedelta(days=220)).strftime("%Y%m%d")

        df = None
        last_err = None
        for _ in range(3):
            try:
                df, err = _ob_call(lambda: ak.stock_zh_a_hist(symbol=code, period="daily", start_date=start, end_date=today, adjust=""), timeout=15)
                if err:
                    last_err = err
                    df = None
                if df is not None and len(df) > 0:
                    break
            except Exception as e:
                last_err = e
                _time.sleep(0.3)

        if df is None or len(df) <= 0:
            return jsonify({"success": False, "error": f"获取K线失败: {last_err or 'no data'}"}), 502

        close_col = "收盘" if "收盘" in df.columns else "close"
        vol_col = "成交量" if "成交量" in df.columns else "volume"
        closes = [to_float(x) for x in df[close_col].tolist()]
        last_price = to_float_2(closes[-1]) if closes else None
        prev_price = to_float_2(closes[-2]) if len(closes) > 1 else None
        chg = round(last_price - prev_price, 2) if last_price is not None and prev_price is not None else 0
        pct = round(chg / prev_price * 100, 2) if prev_price else 0
        rsi_list = _calc_rsi([c for c in closes if c is not None], 14)
        rsi14 = rsi_list[-1] if rsi_list else None
        ma20 = to_float_2(sum([c for c in closes[-20:] if c is not None]) / min(20, len([c for c in closes[-20:] if c is not None]))) if closes else None
        ma60 = to_float_2(sum([c for c in closes[-60:] if c is not None]) / min(60, len([c for c in closes[-60:] if c is not None]))) if closes else None
        macd = _calc_macd_simple(closes)
        volume = int(to_float(df[vol_col].iloc[-1]) or 0) if vol_col in df.columns else 0

        return jsonify({"success": True, "data": {
            "code": code,
            "name": name,
            "price": last_price,
            "changePercent": pct,
            "rsi14": rsi14,
            "macdTrend": (macd or {}).get("trend"),
            "ma20": ma20,
            "ma60": ma60,
            "volume": volume,
            "provider": "akshare",
        }})

    if market == "us":
        obb = _get_obb()
        if not obb:
            return jsonify({"success": False, "error": "OpenBB 不可用"}), 503
        try:
            sym = format_symbol(code)
            df, err = _ob_call(lambda: obb.equity.price.historical(sym, interval="1d", provider="yfinance").to_dataframe(), timeout=20)
            if err or df is None or (hasattr(df, "empty") and df.empty):
                return jsonify({"success": False, "error": f"历史数据获取失败: {err or 'no data'}"}), 502

            closes = [to_float(x) for x in df["close"].tolist() if x is not None]
            last_price = to_float_2(closes[-1]) if closes else None
            prev_price = to_float_2(closes[-2]) if len(closes) > 1 else None
            chg = round(last_price - prev_price, 2) if last_price is not None and prev_price is not None else 0
            pct = round(chg / prev_price * 100, 2) if prev_price else 0

            rsi_list = _calc_rsi([c for c in closes if c is not None], 14)
            rsi14 = rsi_list[-1] if rsi_list else None

            def _sma(vals, n):
                if not vals:
                    return None
                tail = [v for v in vals[-n:] if v is not None]
                if not tail:
                    return None
                return to_float_2(sum(tail) / len(tail))

            ma20 = _sma(closes, 20)
            ma60 = _sma(closes, 60)
            macd = _calc_macd_simple(closes)

            out = {
                "code": code,
                "name": name,
                "price": last_price,
                "changePercent": pct,
                "rsi14": rsi14,
                "macdTrend": (macd or {}).get("trend"),
                "ma20": ma20,
                "ma60": ma60,
                "provider": "openbb",
            }

            return jsonify({"success": True, "data": out})
        except Exception as e:
            return jsonify({"success": False, "error": f"OpenBB 指标失败: {e}"}), 502

    return jsonify({"success": False, "error": "该市场暂不支持"}), 400


# ============================================================
# 静态文件
# ============================================================
@app.route("/vendor/chart.js")
def vendor_chartjs():
    p = os.path.join(os.path.dirname(__file__), "node_modules", "chart.js", "dist",
                     "chart.umd.min.js")
    if os.path.exists(p):
        return send_from_directory(os.path.dirname(p), "chart.umd.min.js")
    return jsonify({"error": "chart.js 未安装，请先执行 npm install"}), 404

@app.route("/favicon.ico")
def favicon():
    resp = jsonify({})
    resp.status_code = 204
    try:
        resp.headers["Cache-Control"] = "no-store"
    except:
        pass
    return resp

@app.route("/")
def index():
    resp = send_from_directory(".", "index.html")
    try:
        resp.headers["Cache-Control"] = "no-store"
    except:
        pass
    return resp

@app.route("/<path:path>")
def static_files(path):
    resp = send_from_directory(".", path)
    try:
        if path.endswith(".js") or path.endswith(".css") or path.endswith(".html"):
            resp.headers["Cache-Control"] = "no-store"
    except:
        pass
    return resp

# ============================================================
# Entry
# ============================================================
if __name__ == "__main__":
    print('''
+==============================================================+
|  A股/美股/加密货币 统一分析服务器  [server.py]              |
|  Access: http://localhost:3000                               |
|  A股: akshare (主) + OpenBB HTTP (fallback)                 |
|  美股/加密货币: OpenBB Package (主)                         |
|  冲突接口: 双格式兼容 (server_openBB + server.py)           |
+==============================================================+
    ''')
    app.run(host="0.0.0.0", port=3000, debug=True, use_reloader=False, threaded=True)
