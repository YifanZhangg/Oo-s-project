let klineChart = null;
let macdChart = null;
let rsiChart = null;
let currentKlinePeriod = '1d';  // 当前K线周期: 1d=日K, 1w=周K, 1M=月K

let aiChatHistory = [];

let simInitialCapital = 1000000;
let simAvailableCapital = 1000000;
let simHoldings = [];
let simTradeHistory = [];
let currentTradeType = 'buy';
let currentTradeStock = null;
let currentUsername = 'Ooking';
let currentUserId = '1234';
let pkList = [];

const APP_SETTINGS_KEY = 'stock_app_settings_v1';

function getDefaultAppSettings() {
    return {
        apiBaseUrl: '',
        lastView: 'analysis',
        sidebar: {
            collapsed: false,
            groups: {
                stockAnalysis: false,
                trading: false,
                ai: false
            }
        },
        ai: {
            provider: 'backend',
            apiKey: '',
            baseUrl: 'https://api.openai.com/v1',
            model: '',
            maxTokens: 1024
        },
        tradingagents: {
            openaiApiKey: '',
            openaiBaseUrl: 'https://api.openai.com/v1',
            deepModel: 'gpt-4.1',
            quickModel: 'gpt-4.1-mini',
            maxDebateRounds: 1,
            maxRiskDiscussRounds: 1
        }
    };
}

function loadAppSettings() {
    try {
        const raw = localStorage.getItem(APP_SETTINGS_KEY);
        if (!raw) return getDefaultAppSettings();
        const parsed = JSON.parse(raw);
        const defaults = getDefaultAppSettings();
        return {
            ...defaults,
            ...parsed,
            sidebar: {
                ...defaults.sidebar,
                ...(parsed.sidebar || {}),
                groups: {
                    ...defaults.sidebar.groups,
                    ...((parsed.sidebar && parsed.sidebar.groups) || {})
                }
            },
            ai: {
                ...defaults.ai,
                ...(parsed.ai || {})
            },
            tradingagents: {
                ...defaults.tradingagents,
                ...(parsed.tradingagents || {})
            }
        };
    } catch (e) {
        return getDefaultAppSettings();
    }
}

let appSettings = loadAppSettings();

function persistAppSettings(next) {
    appSettings = next;
    localStorage.setItem(APP_SETTINGS_KEY, JSON.stringify(appSettings));
}

function normalizeBaseUrl(url) {
    const value = (url || '').trim();
    if (!value) return '';
    return value.replace(/\/+$/, '');
}

function joinUrl(base, path) {
    const b = normalizeBaseUrl(base);
    const p = (path || '').trim();
    if (!b) return p;
    if (!p) return b;
    if (p.startsWith('http://') || p.startsWith('https://')) return p;
    if (p.startsWith('/')) return `${b}${p}`;
    return `${b}/${p}`;
}

function apiFetch(path, options) {
    const baseUrl = normalizeBaseUrl(appSettings.apiBaseUrl);
    return fetch(joinUrl(baseUrl, path), options);
}

const __rawFetch = window.fetch.bind(window);
window.fetch = function(input, init) {
    try {
        if (typeof input === 'string' && input.startsWith('/')) {
            const baseUrl = normalizeBaseUrl(appSettings.apiBaseUrl);
            return __rawFetch(joinUrl(baseUrl, input), init);
        }
    } catch (e) {}
    return __rawFetch(input, init);
};

function toggleUserMenu() {
    const menu = document.getElementById('userMenu');
    if (!menu) return;
    menu.classList.toggle('hidden');
}

document.addEventListener('click', function(e) {
    const userProfile = document.getElementById('userProfile');
    const menu = document.getElementById('userMenu');
    if (userProfile && !userProfile.contains(e.target)) {
        if (menu) {
            menu.classList.add('hidden');
        }
    }
});

function openEditUserModal() {
    const menu = document.getElementById('userMenu');
    if (menu) menu.classList.add('hidden');
    
    document.getElementById('editUsername').value = currentUsername;
    document.getElementById('editUserId').value = currentUserId;
    document.getElementById('editUserModal').classList.remove('hidden');
}

function closeEditUserModal() {
    document.getElementById('editUserModal').classList.add('hidden');
}

function saveUserProfile() {
    const newUsername = document.getElementById('editUsername').value.trim();
    
    if (!newUsername) {
        alert('请输入用户名');
        return;
    }
    
    currentUsername = newUsername;
    localStorage.setItem('simUsername', currentUsername);
    localStorage.setItem('simUserId', currentUserId);
    
    const displayUsername = document.getElementById('displayUsername');
    if (displayUsername) displayUsername.textContent = currentUsername;
    
    const usernameInput = document.getElementById('username');
    if (usernameInput) {
        usernameInput.value = currentUsername;
    }
    
    alert('用户资料已保存！');
    closeEditUserModal();
}

window.addEventListener('load', function() {
    const stockCodeInput = document.getElementById('stockCode');
    if (stockCodeInput) {
        stockCodeInput.value = '600519';
    }
    
    const savedUsername = localStorage.getItem('simUsername');
    if (savedUsername) {
        currentUsername = savedUsername;
        const displayUsername = document.getElementById('displayUsername');
        if (displayUsername) displayUsername.textContent = currentUsername;
    }
    
    const savedUserId = localStorage.getItem('simUserId');
    if (savedUserId) {
        currentUserId = savedUserId;
    }
    
    const usernameInput = document.getElementById('username');
    if (usernameInput) {
        usernameInput.value = currentUsername;
    }
    
    const savedPK = localStorage.getItem('simPKList');
    if (savedPK) {
        pkList = JSON.parse(savedPK);
    }
    
    const savedCapital = localStorage.getItem('simInitialCapital');
    if (savedCapital) {
        simInitialCapital = parseFloat(savedCapital);
        simAvailableCapital = parseFloat(savedCapital);
    }
    
    const savedHoldings = localStorage.getItem('simHoldings');
    if (savedHoldings) {
        simHoldings = JSON.parse(savedHoldings);
    }
    
    const savedTradeHistory = localStorage.getItem('simTradeHistory');
    if (savedTradeHistory) {
        simTradeHistory = JSON.parse(savedTradeHistory);
    }
    
    updateCapitalDisplay();
    renderSimHoldings();
    renderSimTradeHistory();
    renderPKList();
    checkCapitalSet();
    
    loadMyPortfolioData();
});

function saveSimData() {
    localStorage.setItem('simInitialCapital', simInitialCapital.toString());
    localStorage.setItem('simHoldings', JSON.stringify(simHoldings));
    localStorage.setItem('simTradeHistory', JSON.stringify(simTradeHistory));
}

function generateStockData(stockCode) {
    const basePrice = stockCode.startsWith('6') ? 150 : 
                      stockCode.startsWith('0') ? 50 : 
                      stockCode.startsWith('3') ? 80 : 100;
    
    const data = [];
    let currentPrice = basePrice;
    const days = 60;
    
    for (let i = days - 1; i >= 0; i--) {
        const date = new Date();
        date.setDate(date.getDate() - i);
        
        const volatility = 0.03;
        const change = (Math.random() - 0.48) * volatility * currentPrice;
        
        const open = currentPrice;
        currentPrice = currentPrice + change;
        const high = Math.max(open, currentPrice) * (1 + Math.random() * 0.01);
        const low = Math.min(open, currentPrice) * (1 - Math.random() * 0.01);
        const close = currentPrice;
        const volume = Math.floor(Math.random() * 10000000) + 1000000;
        const amount = volume * close;
        
        data.push({
            date: date.toISOString().split('T')[0],
            open: parseFloat(open.toFixed(2)),
            high: parseFloat(high.toFixed(2)),
            low: parseFloat(low.toFixed(2)),
            close: parseFloat(close.toFixed(2)),
            volume: volume,
            amount: amount
        });
    }
    
    return data;
}

function getStockName(stockCode) {
    const stocks = {
        '600519': '贵州茅台',
        '601318': '中国平安',
        '600036': '招商银行',
        '000001': '平安银行',
        '000002': '万科A',
        '300750': '宁德时代',
        '300059': '东方财富',
        '600118': '中国卫星',
        'AAPL': '苹果公司',
        'GOOGL': '谷歌',
        'MSFT': '微软',
        'TSLA': '特斯拉',
        'AMZN': '亚马逊',
        'META': 'Meta Platforms',
        'NVDA': '英伟达',
        'JPM': '摩根大通',
        'V': 'Visa'
    };
    return stocks[stockCode] || '未知股票';
}

function calculateMA(data, period) {
    const ma = [];
    for (let i = 0; i < data.length; i++) {
        if (i < period - 1) {
            ma.push(null);
        } else {
            let sum = 0;
            for (let j = 0; j < period; j++) {
                sum += data[i - j].close;
            }
            ma.push(parseFloat((sum / period).toFixed(2)));
        }
    }
    return ma;
}

function calculateMACD(data, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    const closes = data.map(d => d.close);
    
    function ema(values, period) {
        const emaValues = [];
        const multiplier = 2 / (period + 1);
        emaValues.push(values[0]);
        for (let i = 1; i < values.length; i++) {
            emaValues.push(values[i] * multiplier + emaValues[i - 1] * (1 - multiplier));
        }
        return emaValues;
    }
    
    const fastEMA = ema(closes, fastPeriod);
    const slowEMA = ema(closes, slowPeriod);
    
    const macdLine = [];
    for (let i = 0; i < closes.length; i++) {
        macdLine.push(fastEMA[i] - slowEMA[i]);
    }
    
    const signalLine = ema(macdLine, signalPeriod);
    
    const histogram = [];
    for (let i = 0; i < closes.length; i++) {
        histogram.push(macdLine[i] - signalLine[i]);
    }
    
    return { macdLine, signalLine, histogram };
}

function calculateRSI(data, period = 14) {
    const rsi = [];
    const gains = [];
    const losses = [];
    
    for (let i = 1; i < data.length; i++) {
        const change = data[i].close - data[i - 1].close;
        gains.push(change > 0 ? change : 0);
        losses.push(change < 0 ? -change : 0);
    }
    
    for (let i = 0; i < data.length; i++) {
        if (i < period) {
            rsi.push(null);
        } else if (i === period) {
            let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
            let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
            const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            rsi.push(100 - (100 / (1 + rs)));
        } else {
            const avgGain = gains.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
            const avgLoss = losses.slice(i - period, i).reduce((a, b) => a + b, 0) / period;
            const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            rsi.push(100 - (100 / (1 + rs)));
        }
    }
    
    return rsi.map(v => v ? parseFloat(v.toFixed(2)) : null);
}

function findSupportResistance(data) {
    const supports = [];
    const resistances = [];
    const period = 5;
    
    for (let i = period; i < data.length - period; i++) {
        let isSupport = true;
        let isResistance = true;
        
        for (let j = 1; j <= period; j++) {
            if (data[i].low > data[i - j].low || data[i].low > data[i + j].low) {
                isSupport = false;
            }
            if (data[i].high < data[i - j].high || data[i].high < data[i + j].high) {
                isResistance = false;
            }
        }
        
        if (isSupport) {
            supports.push({ price: data[i].low, date: data[i].date });
        }
        if (isResistance) {
            resistances.push({ price: data[i].high, date: data[i].date });
        }
    }
    
    const recentSupports = supports.slice(-3).reverse();
    const recentResistances = resistances.slice(-3).reverse();
    
    return { supports: recentSupports, resistances: recentResistances };
}

function findGaps(data) {
    const gaps = [];
    
    for (let i = 1; i < data.length; i++) {
        const prevClose = data[i - 1].close;
        const currOpen = data[i].open;
        const prevHigh = data[i - 1].high;
        const prevLow = data[i - 1].low;
        
        if (currOpen > prevHigh) {
            gaps.push({
                type: 'up',
                startPrice: prevHigh,
                endPrice: currOpen,
                date: data[i].date
            });
        } else if (currOpen < prevLow) {
            gaps.push({
                type: 'down',
                startPrice: prevLow,
                endPrice: currOpen,
                date: data[i].date
            });
        }
    }
    
    return gaps.slice(-5).reverse();
}

function predictFuture(data) {
    const latest = data[data.length - 1];
    const ma5 = calculateMA(data, 5);
    const ma10 = calculateMA(data, 10);
    const ma20 = calculateMA(data, 20);
    const macd = calculateMACD(data);
    const rsi = calculateRSI(data);
    
    const predictions = [];
    let trend = 'neutral';
    let confidence = 50;
    
    const latestMA5 = ma5[ma5.length - 1];
    const latestMA10 = ma10[ma10.length - 1];
    const latestMA20 = ma20[ma20.length - 1];
    const latestMACD = macd.macdLine[macd.macdLine.length - 1];
    const latestSignal = macd.signalLine[macd.signalLine.length - 1];
    const latestRSI = rsi[rsi.length - 1];
    
    let bullishSignals = 0;
    let bearishSignals = 0;
    
    if (latestMA5 && latestMA10 && latestMA5 > latestMA10) {
        bullishSignals++;
    } else if (latestMA5 && latestMA10 && latestMA5 < latestMA10) {
        bearishSignals++;
    }
    
    if (latestMA10 && latestMA20 && latestMA10 > latestMA20) {
        bullishSignals++;
    } else if (latestMA10 && latestMA20 && latestMA10 < latestMA20) {
        bearishSignals++;
    }
    
    if (latestMACD > latestSignal) {
        bullishSignals++;
    } else if (latestMACD < latestSignal) {
        bearishSignals++;
    }
    
    if (latestMACD > 0) {
        bullishSignals++;
    } else if (latestMACD < 0) {
        bearishSignals++;
    }
    
    if (latestRSI < 30) {
        bullishSignals += 2;
    } else if (latestRSI > 70) {
        bearishSignals += 2;
    } else if (latestRSI < 50) {
        bullishSignals++;
    } else if (latestRSI > 50) {
        bearishSignals++;
    }
    
    if (bullishSignals > bearishSignals) {
        trend = 'bullish';
        confidence = 50 + (bullishSignals - bearishSignals) * 10;
    } else if (bearishSignals > bullishSignals) {
        trend = 'bearish';
        confidence = 50 + (bearishSignals - bullishSignals) * 10;
    }
    
    confidence = Math.min(confidence, 90);
    
    let currentPrice = latest.close;
    for (let i = 1; i <= 3; i++) {
        const date = new Date();
        date.setDate(date.getDate() + i);
        
        const volatility = trend === 'bullish' ? 0.02 : 
                          trend === 'bearish' ? -0.02 : (Math.random() - 0.5) * 0.02;
        
        const change = currentPrice * volatility * (0.5 + Math.random() * 0.5);
        currentPrice = currentPrice + change;
        
        predictions.push({
            date: date.toISOString().split('T')[0],
            predictedPrice: parseFloat(currentPrice.toFixed(2)),
            change: parseFloat(((currentPrice - latest.close) / latest.close * 100).toFixed(2))
        });
    }
    
    let recommendation = '';
    if (trend === 'bullish' && confidence > 60) {
        recommendation = '建议：考虑适量买入，设置止损位在近期支撑位下方。';
    } else if (trend === 'bearish' && confidence > 60) {
        recommendation = '建议：考虑减仓或观望，等待更明确的信号。';
    } else {
        recommendation = '建议：暂时观望，等待趋势明朗后再操作。';
    }
    
    return { predictions, trend, confidence, recommendation };
}

function renderCharts(data, stockCode = null) {
    const labels = data.map(d => d.date);
    const closes = data.map(d => d.close);
    const volumes = data.map(d => d.volume);
    
    const ma5 = calculateMA(data, 5);
    const ma10 = calculateMA(data, 10);
    const ma20 = calculateMA(data, 20);
    
    if (klineChart) klineChart.destroy();
    
    const datasets = [
        {
            label: '收盘价',
            data: closes,
            borderColor: '#00d4ff',
            backgroundColor: 'rgba(0, 212, 255, 0.1)',
            fill: true,
            tension: 0.1
        },
        {
            label: 'MA5',
            data: ma5,
            borderColor: '#ffd93d',
            borderDash: [],
            fill: false,
            pointRadius: 0
        },
        {
            label: 'MA10',
            data: ma10,
            borderColor: '#ff6b6b',
            borderDash: [5, 5],
            fill: false,
            pointRadius: 0
        },
        {
            label: 'MA20',
            data: ma20,
            borderColor: '#4ecdc4',
            borderDash: [10, 5],
            fill: false,
            pointRadius: 0
        }
    ];
    
    if (stockCode) {
        const holdingsForStock = holdings.filter(h => h.code === stockCode);
        if (holdingsForStock.length > 0) {
            const positionPoints = new Array(labels.length).fill(null);
            holdingsForStock.forEach(position => {
                const index = labels.indexOf(position.buyDate);
                if (index !== -1) {
                    positionPoints[index] = position.buyPrice;
                }
            });
            
            datasets.push({
                label: '买入点',
                data: positionPoints,
                borderColor: '#ff4757',
                backgroundColor: '#ff4757',
                pointRadius: 8,
                pointHoverRadius: 10,
                showLine: false,
                pointStyle: 'triangle',
                pointRotation: 180
            });
        }
    }
    
    const klineCtx = document.getElementById('klineChart').getContext('2d');
    klineChart = new Chart(klineCtx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: datasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    labels: { color: '#fff' }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            if (context.dataset.label === '买入点') {
                                const index = context.dataIndex;
                                const holdingsForStock = stockCode ? holdings.filter(h => h.code === stockCode) : [];
                                const position = holdingsForStock.find(h => h.buyDate === labels[index]);
                                if (position) {
                                    return [
                                        `买入点: ¥${position.buyPrice}`,
                                        `数量: ${position.quantity}股`,
                                        `备注: ${position.note || '无'}`
                                    ];
                                }
                            }
                            return context.dataset.label + ': ' + context.parsed.y;
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#8892b0', maxTicksLimit: 10 },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                },
                y: {
                    ticks: { color: '#8892b0' },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                }
            }
        }
    });
    
    const macd = calculateMACD(data);
    
    if (macdChart) macdChart.destroy();
    
    const macdCtx = document.getElementById('macdChart').getContext('2d');
    macdChart = new Chart(macdCtx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [
                {
                    type: 'line',
                    label: 'MACD',
                    data: macd.macdLine,
                    borderColor: '#00d4ff',
                    fill: false,
                    pointRadius: 0,
                    yAxisID: 'y'
                },
                {
                    type: 'line',
                    label: '信号线',
                    data: macd.signalLine,
                    borderColor: '#ff6b6b',
                    fill: false,
                    pointRadius: 0,
                    yAxisID: 'y'
                },
                {
                    label: '柱状图',
                    data: macd.histogram,
                    backgroundColor: macd.histogram.map(h => h >= 0 ? '#ff4757' : '#00ff88'),
                    yAxisID: 'y'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    labels: { color: '#fff' }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#8892b0', maxTicksLimit: 10 },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                },
                y: {
                    ticks: { color: '#8892b0' },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                }
            }
        }
    });
    
    const rsi = calculateRSI(data);
    
    if (rsiChart) rsiChart.destroy();
    
    const rsiCtx = document.getElementById('rsiChart').getContext('2d');
    rsiChart = new Chart(rsiCtx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'RSI',
                    data: rsi,
                    borderColor: '#00ff88',
                    backgroundColor: 'rgba(0, 255, 136, 0.1)',
                    fill: true,
                    tension: 0.1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
                legend: {
                    labels: { color: '#fff' }
                }
            },
            scales: {
                x: {
                    ticks: { color: '#8892b0', maxTicksLimit: 10 },
                    grid: { color: 'rgba(255, 255, 255, 0.1)' }
                },
                y: {
                    min: 0,
                    max: 100,
                    ticks: { color: '#8892b0' },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)',
                        lineWidth: (context) => {
                            if (context.tick.value === 30 || context.tick.value === 70) {
                                return 2;
                            }
                            return 1;
                        },
                        color: (context) => {
                            if (context.tick.value === 30 || context.tick.value === 70) {
                                return '#ffd93d';
                            }
                            return 'rgba(255, 255, 255, 0.1)';
                        }
                    }
                }
            }
        }
    });
}

function displayIndicators(data) {
    const ma5 = calculateMA(data, 5);
    const ma10 = calculateMA(data, 10);
    const ma20 = calculateMA(data, 20);
    const ma60 = calculateMA(data, 60);
    
    const maHtml = `
        <div class="indicator-item">
            <span>MA5</span>
            <span>${ma5[ma5.length - 1] || '--'}</span>
        </div>
        <div class="indicator-item">
            <span>MA10</span>
            <span>${ma10[ma10.length - 1] || '--'}</span>
        </div>
        <div class="indicator-item">
            <span>MA20</span>
            <span>${ma20[ma20.length - 1] || '--'}</span>
        </div>
        <div class="indicator-item">
            <span>MA60</span>
            <span>${ma60[ma60.length - 1] || '--'}</span>
        </div>
    `;
    document.getElementById('maData').innerHTML = maHtml;
    
    const macd = calculateMACD(data);
    const latestMACD = macd.macdLine[macd.macdLine.length - 1];
    const latestSignal = macd.signalLine[macd.signalLine.length - 1];
    const latestHist = macd.histogram[macd.histogram.length - 1];
    
    const macdHtml = `
        <div class="indicator-item">
            <span>MACD</span>
            <span>${latestMACD ? latestMACD.toFixed(4) : '--'}</span>
        </div>
        <div class="indicator-item">
            <span>信号线</span>
            <span>${latestSignal ? latestSignal.toFixed(4) : '--'}</span>
        </div>
        <div class="indicator-item">
            <span>柱状图</span>
            <span>${latestHist ? latestHist.toFixed(4) : '--'}</span>
        </div>
        <div class="indicator-item">
            <span>信号</span>
            <span class="${latestMACD > latestSignal ? 'bullish' : latestMACD < latestSignal ? 'bearish' : ''}">
                ${latestMACD > latestSignal ? '金叉' : latestMACD < latestSignal ? '死叉' : '中性'}
            </span>
        </div>
    `;
    document.getElementById('macdData').innerHTML = macdHtml;
    
    const rsi = calculateRSI(data);
    const latestRSI = rsi[rsi.length - 1];
    
    let rsiStatus = '中性';
    let rsiClass = 'neutral';
    if (latestRSI < 30) {
        rsiStatus = '超卖';
        rsiClass = 'bullish';
    } else if (latestRSI > 70) {
        rsiStatus = '超买';
        rsiClass = 'bearish';
    }
    
    const rsiHtml = `
        <div class="indicator-item">
            <span>RSI(14)</span>
            <span>${latestRSI ? latestRSI.toFixed(2) : '--'}</span>
        </div>
        <div class="indicator-item">
            <span>状态</span>
            <span class="${rsiClass}">${rsiStatus}</span>
        </div>
        <div class="indicator-item">
            <span>超买线</span>
            <span>70</span>
        </div>
        <div class="indicator-item">
            <span>超卖线</span>
            <span>30</span>
        </div>
    `;
    document.getElementById('rsiData').innerHTML = rsiHtml;
}

function displaySupportResistance(data) {
    const { supports, resistances } = findSupportResistance(data);
    
    let srHtml = '<div style="margin-bottom: 15px;"><strong style="color: #00ff88;">支撑位：</strong></div>';
    if (supports.length > 0) {
        supports.forEach(s => {
            srHtml += `<div class="indicator-item">
                <span>${s.date}</span>
                <span style="color: #00ff88;">¥${s.price}</span>
            </div>`;
        });
    } else {
        srHtml += '<p style="color: #8892b0;">暂无明显支撑位</p>';
    }
    
    srHtml += '<div style="margin: 20px 0 15px;"><strong style="color: #ff4757;">压力位：</strong></div>';
    if (resistances.length > 0) {
        resistances.forEach(r => {
            srHtml += `<div class="indicator-item">
                <span>${r.date}</span>
                <span style="color: #ff4757;">¥${r.price}</span>
            </div>`;
        });
    } else {
        srHtml += '<p style="color: #8892b0;">暂无明显压力位</p>';
    }
    
    document.getElementById('supportResistance').innerHTML = srHtml;
}

function displayGaps(data) {
    const gaps = findGaps(data);
    
    let gapsHtml = '';
    if (gaps.length > 0) {
        gaps.forEach(g => {
            const gapClass = g.type === 'up' ? 'bullish' : 'bearish';
            const gapType = g.type === 'up' ? '向上跳空' : '向下跳空';
            gapsHtml += `<div class="indicator-item">
                <span>${g.date}</span>
                <span class="${gapClass}">${gapType}: ¥${g.startPrice.toFixed(2)} - ¥${g.endPrice.toFixed(2)}</span>
            </div>`;
        });
    } else {
        gapsHtml = '<p style="color: #8892b0;">近期无跳空缺口</p>';
    }
    
    document.getElementById('gaps').innerHTML = gapsHtml;
}

function displayPrediction(data) {
    const prediction = predictFuture(data);
    
    const trendClass = prediction.trend === 'bullish' ? 'bullish' : 
                       prediction.trend === 'bearish' ? 'bearish' : 'neutral';
    const trendText = prediction.trend === 'bullish' ? '看涨' : 
                      prediction.trend === 'bearish' ? '看跌' : '震荡';
    
    let predHtml = `
        <div class="prediction-row">
            <span>趋势判断</span>
            <span class="${trendClass}"><strong>${trendText}</strong></span>
        </div>
        <div class="prediction-row">
            <span>置信度</span>
            <span>${prediction.confidence}%</span>
        </div>
        <div style="margin-top: 20px; margin-bottom: 10px;"><strong>未来3天预测：</strong></div>
    `;
    
    prediction.predictions.forEach(p => {
        const changeClass = p.change >= 0 ? 'bullish' : 'bearish';
        const changeSign = p.change >= 0 ? '+' : '';
        const currencySymbol = window.currentCurrencySymbol || '¥';
        predHtml += `
            <div class="prediction-row">
                <span>${p.date}</span>
                <span>预测价: ${currencySymbol}${p.predictedPrice} <span class="${changeClass}">(${changeSign}${p.change}%)</span></span>
            </div>
        `;
    });
    
    predHtml += `
        <div class="recommendation">
            <strong>操作建议：</strong>
            <p>${prediction.recommendation}</p>
        </div>
    `;
    
    document.getElementById('prediction').innerHTML = predHtml;
}

async function analyzeStock() {
    const stockCode = document.getElementById('stockCode').value.trim().toUpperCase();
    const stockType = document.getElementById('stockType').value;
    
    if (!stockCode) {
        alert('请输入股票代码');
        return;
    }
    
    if (stockType === 'cn' && !/^\d{6}$/.test(stockCode)) {
        alert('A股请输入6位数字的股票代码');
        return;
    }
    
    document.getElementById('loading').classList.remove('hidden');
    document.getElementById('result').classList.add('hidden');
    
    try {
        let stockData, quote;
        
        // 1) 并行获取行情快照 + K线数据
        const [quoteRes, klineRes] = await Promise.all([
            apiFetch(`/api/stock/full?code=${stockCode}&market=${stockType}`),
            apiFetch(`/api/stock/kline?code=${stockCode}&interval=${currentKlinePeriod}&market=${stockType}`)
        ]);
        
        // 处理报价数据
        if (!quoteRes.ok) {
            let errMsg = `请求失败(${quoteRes.status})`;
            try { const e = await quoteRes.json(); if (e && e.error) errMsg = e.error; } catch (_) {}
            throw new Error(errMsg);
        }
        const quoteData = await quoteRes.json();
        if (!quoteData) throw new Error('行情数据不完整');
        quote = quoteData;
        
        // 处理K线数据
        if (!klineRes.ok) {
            let errMsg = `K线请求失败(${klineRes.status})`;
            try { const e = await klineRes.json(); if (e && e.error) errMsg = e.error; } catch (_) {}
            throw new Error(errMsg);
        }
        const klineData = await klineRes.json();
        // kline 接口返回 {data:[], kline:[], ...} 或直接是数组
        const klineArr = Array.isArray(klineData) ? klineData
            : (klineData.data || klineData.kline);
        if (!klineArr || !Array.isArray(klineArr)) throw new Error('K线数据不完整');
        stockData = klineArr;
            
            const holdingsForStock = holdings.filter(h => h.code === stockCode);
            
            let newsData = null;
            let financialData = null;
            
            await Promise.all([
                fetchRelatedNews(stockCode, quote.name).then(data => newsData = data),
                fetchFinancialData(stockCode, quote.name).then(data => financialData = data)
            ]);
            
            window.currentNewsData = newsData;
            window.currentFinancialData = financialData;
            
            // 获取管理团队数据
            await fetchManagementData(stockCode);
            
            await loadEnhancedAnalysis(stockCode, quote, holdingsForStock, newsData, financialData);
        
        const latest = stockData[stockData.length - 1];
        const prev = stockData[stockData.length - 2];
        
        const priceChange = quote.change != null ? parseFloat(quote.change) : (quote.price - parseFloat(quote.prevClose));
        const priceChangePercent = quote.changePercent != null ? parseFloat(quote.changePercent).toFixed(2) : ((priceChange / parseFloat(quote.prevClose)) * 100).toFixed(2);
        const changeClass = priceChange >= 0 ? 'up' : 'down';
        const changeSign = priceChange >= 0 ? '+' : '';
        const currencySymbol = stockType === 'cn'
            ? '¥'
            : (quote.currency === 'HKD' || stockType === 'hk')
                ? 'HK$'
                : (quote.currency === 'USD' || stockType === 'us' || stockType === 'crypto')
                    ? '$'
                    : '';
        window.currentCurrencySymbol = currencySymbol;
        
        let displayName = quote.name;
        if (quote.isMock) {
            displayName = quote.name + ' (模拟)';
        }
        
        document.getElementById('stockName').textContent = displayName;
        document.getElementById('stockCodeDisplay').textContent = stockCode;
        document.getElementById('currentPrice').textContent = `${currencySymbol}${quote.price}`;
        document.getElementById('currentPrice').className = `price ${changeClass}`;
        document.getElementById('priceChange').textContent = `${changeSign}${currencySymbol}${priceChange.toFixed(2)}`;
        document.getElementById('priceChange').className = `change ${changeClass}`;
        document.getElementById('priceChangePercent').textContent = `(${changeSign}${priceChangePercent}%)`;
        document.getElementById('priceChangePercent').className = `change-percent ${changeClass}`;
        
        const p2 = v => (v != null && !isNaN(v)) ? parseFloat(v).toFixed(2) : '--';
        const vol = quote.volume != null ? (quote.volume / 1000000).toFixed(2) + 'M' : '--';
        const amt = quote.amount != null ? (quote.amount / 1000000000).toFixed(2) + 'B' : (quote.volume != null && quote.price != null ? (quote.volume * quote.price / 1000000000).toFixed(2) + 'B' : '--');
        
        document.getElementById('openPrice').textContent = `${currencySymbol}${p2(quote.open)}`;
        document.getElementById('highPrice').textContent = `${currencySymbol}${p2(quote.high)}`;
        document.getElementById('lowPrice').textContent = `${currencySymbol}${p2(quote.low)}`;
        const preCloseEl = document.getElementById('preClosePrice');
        if (preCloseEl) preCloseEl.textContent = `${currencySymbol}${p2(quote.prevClose)}`;
        document.getElementById('volume').textContent = vol;
        document.getElementById('amount').textContent = amt;
        const bidAskEl = document.getElementById('bidAsk');
        if (bidAskEl) {
            const b = quote.bid != null ? p2(quote.bid) : '--';
            const a = quote.ask != null ? p2(quote.ask) : '--';
            bidAskEl.textContent = `${b} / ${a}`;
        }
        const yearRangeEl = document.getElementById('yearRange');
        if (yearRangeEl) {
            const yh = quote.yearHigh != null ? p2(quote.yearHigh) : '--';
            const yl = quote.yearLow != null ? p2(quote.yearLow) : '--';
            yearRangeEl.textContent = `${yl} - ${yh}`;
        }
        const peEl = document.getElementById('peRatio');
        if (peEl) {
            peEl.textContent = quote.peRatio != null ? parseFloat(quote.peRatio).toFixed(2) : '--';
        }
        const providerEl = document.getElementById('dataProvider');
        if (providerEl) providerEl.textContent = quote.provider || '--';
        
        if (typeof Chart !== 'undefined') {
            try {
                renderCharts(stockData, stockCode);
            } catch (e) {
                console.error('渲染图表失败:', e);
            }
        } else {
            console.error('Chart.js 未加载');
        }
        
        try {
            displayIndicators(stockData);
        } catch (e) {
            console.error('渲染指标失败:', e);
        }
        
        document.getElementById('loading').classList.add('hidden');
        document.getElementById('result').classList.remove('hidden');
    } catch (error) {
        console.error('获取数据失败:', error);
        alert(error && error.message ? `获取数据失败：${error.message}` : '获取数据失败，请稍后重试');
        document.getElementById('loading').classList.add('hidden');
    }
}

async function fetchRelatedNews(stockCode, stockName) {
    try {
        const response = await apiFetch(`/api/stock/related-news?code=${stockCode}&name=${encodeURIComponent(stockName)}`);
        const data = await response.json();
        
        if (data.success && data.data) {
            renderRelatedNews(data.data);
        }
    } catch (error) {
        console.error('获取相关新闻失败:', error);
    }
}

async function fetchStockEvents(stockCode, stockName) {
    try {
        const response = await apiFetch(`/api/stock/events?code=${stockCode}&name=${encodeURIComponent(stockName)}`);
        const data = await response.json();
        
        if (data.success && data.data) {
            renderStockEvents(data.data);
        }
    } catch (error) {
        console.error('获取大事纪要失败:', error);
    }
}

function renderRelatedNews(news) {
    const container = document.getElementById('relatedNewsList');
    if (!container) return;
    
    let html = '';
    const visibleCount = 3;
    const hasMore = news.length > visibleCount;
    
    news.forEach((item, index) => {
        const isHidden = index >= visibleCount;
        html += `
            <div class="related-news-item ${isHidden ? 'hidden-news' : ''}" id="newsItem-${item.id}" onclick="toggleNewsDetail(${item.id})">
                <div class="related-news-header">
                    <div class="related-news-title">${item.title}</div>
                    <span class="related-news-source">${item.source}</span>
                </div>
                <div class="related-news-meta">
                    <span class="related-news-time">🕐 ${item.time}</span>
                    <span class="related-news-type">${item.type}</span>
                </div>
                <div class="related-news-detail" id="newsDetail-${item.id}">
                    ${item.detail}
                </div>
            </div>
        `;
    });
    
    if (hasMore) {
        html += `
            <button class="toggle-news-btn" onclick="toggleMoreNews()">
                <span id="toggleNewsText">展开更多 (${news.length - visibleCount}条)</span>
            </button>
        `;
    }
    
    container.innerHTML = html;
}

let allNewsVisible = false;

function toggleMoreNews() {
    allNewsVisible = !allNewsVisible;
    const hiddenItems = document.querySelectorAll('.related-news-item.hidden-news');
    const toggleText = document.getElementById('toggleNewsText');
    
    hiddenItems.forEach(item => {
        if (allNewsVisible) {
            item.classList.add('show');
        } else {
            item.classList.remove('show');
        }
    });
    
    if (toggleText) {
        if (allNewsVisible) {
            toggleText.textContent = '收起';
        } else {
            const hiddenCount = document.querySelectorAll('.related-news-item.hidden-news').length;
            toggleText.textContent = `展开更多 (${hiddenCount}条)`;
        }
    }
}

function toggleNewsDetail(newsId) {
    const detailEl = document.getElementById(`newsDetail-${newsId}`);
    if (detailEl) {
        detailEl.classList.toggle('show');
    }
}

async function fetchFinancialData(stockCode, stockName) {
    try {
        const response = await apiFetch(`/api/stock/financial?code=${stockCode}&name=${encodeURIComponent(stockName)}`);
        const data = await response.json();
        
        if (data.success && data.data) {
            renderFinancialData(data.data);
            return data.data;
        }
    } catch (error) {
        console.error('获取财务数据失败:', error);
    }
    return null;
}

function renderFinancialData(financialData) {
    const container = document.getElementById('financialData');
    if (!container) return;
    
    let html = '';
    
    if (financialData.profit) {
        html += `
            <div class="financial-card">
                <h4>📈 利润表</h4>
                ${Object.entries(financialData.profit).map(([key, value]) => {
                    const isNumeric = !isNaN(parseFloat(value)) && isFinite(value);
                    const isPositive = isNumeric && parseFloat(value) > 0;
                    const isNegative = isNumeric && parseFloat(value) < 0;
                    let valueClass = '';
                    if (isPositive) valueClass = 'positive';
                    if (isNegative) valueClass = 'negative';
                    
                    return `
                        <div class="financial-item">
                            <span class="financial-label">${key}</span>
                            <span class="financial-value ${valueClass}">${value}</span>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }
    
    if (financialData.balance) {
        html += `
            <div class="financial-card">
                <h4>🏦 资产负债表</h4>
                ${Object.entries(financialData.balance).map(([key, value]) => {
                    const isNumeric = !isNaN(parseFloat(value)) && isFinite(value);
                    const isPositive = isNumeric && parseFloat(value) > 0;
                    const isNegative = isNumeric && parseFloat(value) < 0;
                    let valueClass = '';
                    if (isPositive) valueClass = 'positive';
                    if (isNegative) valueClass = 'negative';
                    
                    return `
                        <div class="financial-item">
                            <span class="financial-label">${key}</span>
                            <span class="financial-value ${valueClass}">${value}</span>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }
    
    if (financialData.cash) {
        html += `
            <div class="financial-card">
                <h4>💵 现金流量表</h4>
                ${Object.entries(financialData.cash).map(([key, value]) => {
                    const isNumeric = !isNaN(parseFloat(value)) && isFinite(value);
                    const isPositive = isNumeric && parseFloat(value) > 0;
                    const isNegative = isNumeric && parseFloat(value) < 0;
                    let valueClass = '';
                    if (isPositive) valueClass = 'positive';
                    if (isNegative) valueClass = 'negative';
                    
                    return `
                        <div class="financial-item">
                            <span class="financial-label">${key}</span>
                            <span class="financial-value ${valueClass}">${value}</span>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }
    
    container.innerHTML = html;
}

function renderStockEvents(events) {
    const container = document.getElementById('eventsTimeline');
    if (!container) return;
    
    container.innerHTML = events.map(event => `
        <div class="event-item">
            <div class="event-date">${event.date}</div>
            <div class="event-title">${event.title}</div>
            <span class="event-type">${event.type}</span>
        </div>
    `).join('');
}

async function fetchManagementData(stockCode) {
    try {
        console.log('[Management] Fetching data for:', stockCode);
        const response = await apiFetch(`/api/stock/management?code=${stockCode}`);
        console.log('[Management] Response status:', response.status);
        const data = await response.json();
        console.log('[Management] Response data:', data);
        
        if (data.data && data.data.length > 0) {
            console.log('[Management] Rendering', data.data.length, 'people');
            renderManagementData(data.data);
            return data.data;
        } else {
            console.log('[Management] No data returned');
        }
    } catch (error) {
        console.error('获取管理团队数据失败:', error);
    }
    return null;
}

function renderManagementData(managementData) {
    const container = document.getElementById('managementData');
    if (!container) return;
    
    let html = '';
    
    managementData.forEach(person => {
        const initials = person.name.split(' ').map(n => n[n.length-1]).join('').slice(-2);
        const pay = person.pay ? formatCurrency(person.pay) : 'N/A';
        
        html += `
            <div class="management-card">
                <div class="management-header">
                    <div class="management-avatar">${initials}</div>
                    <div class="management-info">
                        <h4>${person.name}</h4>
                        <div class="management-title">${person.title}</div>
                    </div>
                </div>
                <div class="management-details">
                    <div class="management-item">
                        <span class="label">年龄</span>
                        <span class="value">${person.age || 'N/A'} 岁</span>
                    </div>
                    <div class="management-item">
                        <span class="label">出生年份</span>
                        <span class="value">${person.year_born || 'N/A'}</span>
                    </div>
                    <div class="management-item">
                        <span class="label">已执行期权</span>
                        <span class="value">${formatCurrency(person.exercised_value)}</span>
                    </div>
                    <div class="management-item">
                        <span class="label">未执行期权</span>
                        <span class="value">${formatCurrency(person.unexercised_value)}</span>
                    </div>
                    <div class="management-pay">
                        <span class="label">年薪报酬</span>
                        <span class="value">${pay}</span>
                    </div>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function formatCurrency(value) {
    if (value == null || isNaN(value)) return 'N/A';
    if (value >= 1000000) {
        return '$' + (value / 1000000).toFixed(2) + 'M';
    } else if (value >= 1000) {
        return '$' + (value / 1000).toFixed(2) + 'K';
    }
    return '$' + value.toFixed(2);
}

async function loadEnhancedAnalysis(stockCode, quote, holdingsForStock, newsData = null, financialData = null) {
    try {
        const response = await apiFetch('/api/enhanced/analysis', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                code: stockCode,
                name: quote.name,
                holdings: holdingsForStock,
                news: newsData,
                financial: financialData
            })
        });
        const data = await response.json();
        
        if (data.analysis) {
            displayEnhancedSupportResistance(data.analysis.support_resistance);
            displayEnhancedGaps(data.analysis.gaps);
            displayEnhancedPrediction(data.analysis.prediction);
        }
    } catch (error) {
        console.error('获取增强分析失败:', error);
    }
}

function displayEnhancedSupportResistance(srData) {
    let srHtml = '<div style="margin-bottom: 15px;"><strong style="color: #00ff88;">支撑位：</strong></div>';
    
    if (srData.supports && srData.supports.length > 0) {
        srData.supports.forEach(s => {
            srHtml += `<div class="indicator-item">
                <span>${s.date}</span>
                <span style="color: #00ff88;">¥${s.price}</span>
            </div>`;
            if (s.reason) {
                srHtml += `<div style="font-size: 0.85rem; color: #8892b0; margin: 5px 0 10px 0; padding-left: 10px;">💡 ${s.reason}</div>`;
            }
        });
    } else {
        srHtml += '<p style="color: #8892b0;">暂无明显支撑位</p>';
    }
    
    srHtml += '<div style="margin: 20px 0 15px;"><strong style="color: #ff4757;">压力位：</strong></div>';
    
    if (srData.resistances && srData.resistances.length > 0) {
        srData.resistances.forEach(r => {
            srHtml += `<div class="indicator-item">
                <span>${r.date}</span>
                <span style="color: #ff4757;">¥${r.price}</span>
            </div>`;
            if (r.reason) {
                srHtml += `<div style="font-size: 0.85rem; color: #8892b0; margin: 5px 0 10px 0; padding-left: 10px;">💡 ${r.reason}</div>`;
            }
        });
    } else {
        srHtml += '<p style="color: #8892b0;">暂无明显压力位</p>';
    }
    
    if (srData.reasons && srData.reasons.length > 0) {
        srHtml += '<div style="margin-top: 15px; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 5px;">';
        srHtml += '<strong style="color: #ffd93d;">分析依据：</strong><ul style="margin: 8px 0 0 20px; color: #8892b0;">';
        srData.reasons.forEach(r => {
            srHtml += `<li style="margin-bottom: 5px;">${r}</li>`;
        });
        srHtml += '</ul></div>';
    }
    
    // ---- OpenBB 技术分析：Fibonacci / ATR / Donchian ----
    if (srData.openbb) {
        const obb = srData.openbb;
        const price = srData.currentPrice || 0;
        
        // Fibonacci
        if (obb.fib && obb.fib.length > 0) {
            srHtml += '<div style="margin-top: 20px; padding: 12px; background: rgba(255,255,255,0.04); border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);">';
            srHtml += '<div style="color: #ffd93d; font-weight: 600; margin-bottom: 10px; font-size: 0.9rem;">🎯 Fibonacci 回撤位</div>';
            srHtml += '<div style="display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; font-size: 0.85rem;">';
            srHtml += '<span style="color: #8892b0;">位置</span><span style="color: #8892b0;">价格</span><span style="color: #8892b0;">类型</span>';
            obb.fib.forEach(f => {
                const distStr = f.distance ? (f.distance > 0 ? '+' + f.distance.toFixed(1) + '%' : f.distance.toFixed(1) + '%') : '';
                const typeColor = f.type === 'resistance' ? '#ff4757' : '#00ff88';
                const typeText  = f.type === 'resistance' ? '压力' : '支撑';
                srHtml += `<span style="color: #ffd93d;">${f.level}%</span>`;
                srHtml += `<span style="color: #e0e0e0;">$${f.price.toFixed(2)} <span style="color: #64b5f6; font-size:0.8rem;">${distStr}</span></span>`;
                srHtml += `<span style="color: ${typeColor}; font-weight:600;">${typeText}</span>`;
            });
            srHtml += '</div></div>';
        }
        
        // ATR 动态支撑/压力
        if (obb.atr && obb.atr.atr) {
            const atr = obb.atr;
            srHtml += '<div style="margin-top: 12px; padding: 12px; background: rgba(255,255,255,0.04); border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);">';
            srHtml += `<div style="color: #ffd93d; font-weight: 600; margin-bottom: 10px; font-size: 0.9rem;">📊 ATR 动态区间 <span style="font-size: 0.8rem; color: #64b5f6;">(ATR=${atr.atr})</span></div>`;
            srHtml += '<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 6px 12px; font-size: 0.85rem;">';
            srHtml += `<div><span style="color: #ff4757;">压力2</span> <span style="color:#e0e0e0;">$${atr.resistance2}</span></div>`;
            srHtml += `<div><span style="color: #ff4757;">压力1</span> <span style="color:#e0e0e0;">$${atr.resistance1}</span></div>`;
            srHtml += `<div><span style="color: #00ff88;">支撑1</span> <span style="color:#e0e0e0;">$${atr.support1}</span></div>`;
            srHtml += `<div><span style="color: #00ff88;">支撑2</span> <span style="color:#e0e0e0;">$${atr.support2}</span></div>`;
            srHtml += '</div></div>';
        }
        
        // Donchian Channel
        if (obb.donchian && obb.donchian.upper) {
            const dc = obb.donchian;
            srHtml += '<div style="margin-top: 12px; padding: 12px; background: rgba(255,255,255,0.04); border-radius: 8px; border: 1px solid rgba(255,255,255,0.08);">';
            srHtml += '<div style="color: #ffd93d; font-weight: 600; margin-bottom: 10px; font-size: 0.9rem;">🔷 Donchian 通道</div>';
            srHtml += '<div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; font-size: 0.85rem; text-align: center;">';
            srHtml += `<div><div style="color: #ff4757;">上轨(压力)</div><div style="color:#e0e0e0;">$${dc.upper ? dc.upper.toFixed(2) : '--'}</div></div>`;
            srHtml += `<div><div style="color: #ffd93d;">中轨</div><div style="color:#e0e0e0;">$${dc.middle ? dc.middle.toFixed(2) : '--'}</div></div>`;
            srHtml += `<div><div style="color: #00ff88;">下轨(支撑)</div><div style="color:#e0e0e0;">$${dc.lower ? dc.lower.toFixed(2) : '--'}</div></div>`;
            srHtml += '</div></div>';
        }
    }
    
    document.getElementById('supportResistance').innerHTML = srHtml;
}

function displayEnhancedGaps(gapsData) {
    let gapsHtml = '';
    
    if (gapsData.gaps && gapsData.gaps.length > 0) {
        gapsData.gaps.forEach(g => {
            const gapClass = g.type === 'up' ? 'bullish' : 'bearish';
            const gapType = g.type === 'up' ? '向上跳空' : '向下跳空';
            gapsHtml += `<div class="indicator-item">
                <span>${g.date}</span>
                <span class="${gapClass}">${gapType}: ¥${g.startPrice.toFixed(2)} - ¥${g.endPrice.toFixed(2)}</span>
            </div>`;
            if (g.reason) {
                gapsHtml += `<div style="font-size: 0.85rem; color: #8892b0; margin: 5px 0 10px 0; padding-left: 10px;">💡 ${g.reason}</div>`;
            }
        });
    } else {
        gapsHtml = '<p style="color: #8892b0;">近期无跳空缺口</p>';
    }
    
    if (gapsData.reasons && gapsData.reasons.length > 0) {
        gapsHtml += '<div style="margin-top: 15px; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 5px;">';
        gapsHtml += '<strong style="color: #ffd93d;">分析依据：</strong><ul style="margin: 8px 0 0 20px; color: #8892b0;">';
        gapsData.reasons.forEach(r => {
            gapsHtml += `<li style="margin-bottom: 5px;">${r}</li>`;
        });
        gapsHtml += '</ul></div>';
    }
    
    document.getElementById('gaps').innerHTML = gapsHtml;
}

function displayEnhancedPrediction(predictionData) {
    const trendClass = predictionData.trend === 'bullish' ? 'bullish' : 
                       predictionData.trend === 'bearish' ? 'bearish' : 'neutral';
    const trendText = predictionData.trend === 'bullish' ? '看涨' : 
                      predictionData.trend === 'bearish' ? '看跌' : '震荡';
    
    let predHtml = `
        <div class="prediction-row">
            <span>趋势判断</span>
            <span class="${trendClass}"><strong>${trendText}</strong></span>
        </div>
        <div class="prediction-row">
            <span>置信度</span>
            <span>${predictionData.confidence}%</span>
        </div>
        <div style="margin-top: 20px; margin-bottom: 10px;"><strong>未来3天预测：</strong></div>
    `;
    
    predictionData.predictions.forEach(p => {
        const changeClass = p.change >= 0 ? 'bullish' : 'bearish';
        const changeSign = p.change >= 0 ? '+' : '';
        predHtml += `
            <div class="prediction-row">
                <span>${p.date}</span>
                <span>预测价: ¥${p.predictedPrice} <span class="${changeClass}">(${changeSign}${p.change}%)</span></span>
            </div>
        `;
    });
    
    if (predictionData.reasons && predictionData.reasons.length > 0) {
        predHtml += '<div style="margin-top: 15px; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 5px;">';
        predHtml += '<strong style="color: #ffd93d;">分析依据：</strong><ul style="margin: 8px 0 0 20px; color: #8892b0;">';
        predictionData.reasons.forEach(r => {
            predHtml += `<li style="margin-bottom: 5px;">${r}</li>`;
        });
        predHtml += '</ul></div>';
    }
    
    predHtml += `
        <div class="recommendation">
            <strong>操作建议：</strong>
            <p>${predictionData.recommendation}</p>
        </div>
    `;
    
    document.getElementById('prediction').innerHTML = predHtml;
}

document.getElementById('stockCode').addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
        analyzeStock();
    }
});

window.addEventListener('load', function() {
    document.getElementById('stockCode').value = '600519';
    loadPortfolioData();
});

let holdings = [];
let history = [];
let strategies = [];

function savePortfolioData() {
    localStorage.setItem('holdings', JSON.stringify(holdings));
    localStorage.setItem('history', JSON.stringify(history));
    localStorage.setItem('strategies', JSON.stringify(strategies));
}

function loadPortfolioData() {
    const savedHoldings = localStorage.getItem('holdings');
    const savedHistory = localStorage.getItem('history');
    const savedStrategies = localStorage.getItem('strategies');
    
    if (savedHoldings) holdings = JSON.parse(savedHoldings);
    if (savedHistory) history = JSON.parse(savedHistory);
    if (savedStrategies) strategies = JSON.parse(savedStrategies);
}

function openAddPositionModal() {
    document.getElementById('addPositionModal').classList.remove('hidden');
    document.getElementById('positionDate').value = new Date().toISOString().split('T')[0];
}

function closeAddPositionModal() {
    document.getElementById('addPositionModal').classList.add('hidden');
}

function openStrategyModal() {
    document.getElementById('strategyModal').classList.remove('hidden');
}

function closeStrategyModal() {
    document.getElementById('strategyModal').classList.add('hidden');
}

async function addPosition() {
    const code = document.getElementById('positionCode').value.trim();
    const quantity = parseInt(document.getElementById('positionQuantity').value);
    const price = parseFloat(document.getElementById('positionPrice').value);
    const date = document.getElementById('positionDate').value;
    const note = document.getElementById('positionNote').value.trim();
    
    if (!code || !quantity || !price || !date) {
        alert('请填写完整信息');
        return;
    }
    
    // Auto-detect market from code pattern
    let market = 'us';
    if (/^\d{6}$/.test(code)) market = 'cn';
    else if (/^(BTC|ETH|SOL|XRP|ADA|DOT|AVAX|MATIC|LINK|UNI|USDT)$/i.test(code)) market = 'crypto';
    
    let stockName = getStockName(code);
    
    try {
        const response = await fetch(`/api/stock/quote?code=${code}&market=${market}`);
        const data = await response.json();
        if (data.name) {
            stockName = data.name;
        }
    } catch (e) {
    }
    
    const position = {
        id: Date.now(),
        code: code,
        name: stockName,
        quantity: quantity,
        buyPrice: price,
        buyDate: date,
        note: note,
        currentPrice: price
    };
    
    holdings.push(position);
    
    history.push({
        id: Date.now(),
        type: 'buy',
        code: code,
        name: stockName,
        quantity: quantity,
        price: price,
        date: date,
        note: note
    });
    
    savePortfolioData();
    renderPortfolio();
    closeAddPositionModal();
    
    document.getElementById('positionCode').value = '';
    document.getElementById('positionQuantity').value = '';
    document.getElementById('positionPrice').value = '';
    document.getElementById('positionNote').value = '';
}

async function updatePositionPrices() {
    for (let position of holdings) {
        try {
            const pm = position.market || (/^\d{6}$/.test(position.code) ? 'cn' : 'us');
            const response = await fetch(`/api/stock/quote?code=${position.code}&market=${pm}`);
            const data = await response.json();
            if (data.price) {
                position.currentPrice = data.price;
            }
        } catch (e) {
        }
    }
    savePortfolioData();
}

async function renderPortfolio() {
    await updatePositionPrices();
    renderHoldings();
    renderHistory();
    renderStrategies();
    renderSummary();
}

function renderHoldings() {
    const container = document.getElementById('holdingsList');
    
    if (holdings.length === 0) {
        container.innerHTML = '<p style="color: #8892b0; text-align: center; padding: 30px;">暂无持仓，点击上方按钮添加</p>';
        return;
    }
    
    let html = '';
    holdings.forEach(position => {
        const marketValue = position.quantity * position.currentPrice;
        const cost = position.quantity * position.buyPrice;
        const pnl = marketValue - cost;
        const pnlPercent = ((pnl / cost) * 100).toFixed(2);
        const pnlClass = pnl >= 0 ? 'bullish' : 'bearish';
        const pnlSign = pnl >= 0 ? '+' : '';
        
        html += `
            <div class="holding-card">
                <div class="holding-header">
                    <span class="holding-name">${position.name}</span>
                    <span class="holding-code">${position.code}</span>
                </div>
                <div class="holding-stats">
                    <div class="holding-stat">
                        <span class="holding-stat-label">持仓数量</span>
                        <span class="holding-stat-value">${position.quantity}股</span>
                    </div>
                    <div class="holding-stat">
                        <span class="holding-stat-label">成本价</span>
                        <span class="holding-stat-value">¥${position.buyPrice}</span>
                    </div>
                    <div class="holding-stat">
                        <span class="holding-stat-label">现价</span>
                        <span class="holding-stat-value">¥${position.currentPrice}</span>
                    </div>
                    <div class="holding-stat">
                        <span class="holding-stat-label">市值</span>
                        <span class="holding-stat-value">¥${marketValue.toFixed(2)}</span>
                    </div>
                    <div class="holding-stat">
                        <span class="holding-stat-label">浮动盈亏</span>
                        <span class="holding-stat-value ${pnlClass}">${pnlSign}¥${pnl.toFixed(2)}</span>
                    </div>
                    <div class="holding-stat">
                        <span class="holding-stat-label">收益率</span>
                        <span class="holding-stat-value ${pnlClass}">${pnlSign}${pnlPercent}%</span>
                    </div>
                </div>
                <div class="holding-actions">
                    <button class="btn-small btn-success" onclick="sellPosition(${position.id})">卖出</button>
                    <button class="btn-small btn-danger" onclick="removePosition(${position.id})">删除</button>
                </div>
                ${position.note ? `<p style="margin-top: 10px; color: #8892b0; font-size: 0.9rem;">备注: ${position.note}</p>` : ''}
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function sellPosition(id) {
    const position = holdings.find(h => h.id === id);
    if (!position) return;
    
    const sellPrice = position.currentPrice;
    const marketValue = position.quantity * sellPrice;
    const cost = position.quantity * position.buyPrice;
    const pnl = marketValue - cost;
    
    history.push({
        id: Date.now(),
        type: 'sell',
        code: position.code,
        name: position.name,
        quantity: position.quantity,
        price: sellPrice,
        costPrice: position.buyPrice,
        pnl: pnl,
        date: new Date().toISOString().split('T')[0],
        note: `卖出${position.name}，盈亏: ${pnl >= 0 ? '+' : ''}¥${pnl.toFixed(2)}`
    });
    
    holdings = holdings.filter(h => h.id !== id);
    savePortfolioData();
    renderPortfolio();
}

function removePosition(id) {
    if (confirm('确定要删除这个持仓吗？')) {
        holdings = holdings.filter(h => h.id !== id);
        savePortfolioData();
        renderPortfolio();
    }
}

function renderHistory() {
    const container = document.getElementById('historyList');
    
    if (history.length === 0) {
        container.innerHTML = '<p style="color: #8892b0; text-align: center; padding: 30px;">暂无交易记录</p>';
        return;
    }
    
    let html = '';
    history.slice().reverse().forEach(record => {
        const typeClass = record.type === 'buy' ? 'bullish' : 'bearish';
        const typeText = record.type === 'buy' ? '买入' : '卖出';
        
        html += `
            <div class="history-card">
                <div class="holding-header">
                    <span class="holding-name">${record.name} <span class="${typeClass}">(${typeText})</span></span>
                    <span class="holding-code">${record.date}</span>
                </div>
                <div class="holding-stats">
                    <div class="holding-stat">
                        <span class="holding-stat-label">数量</span>
                        <span class="holding-stat-value">${record.quantity}股</span>
                    </div>
                    <div class="holding-stat">
                        <span class="holding-stat-label">价格</span>
                        <span class="holding-stat-value">¥${record.price}</span>
                    </div>
                    ${record.pnl !== undefined ? `
                    <div class="holding-stat">
                        <span class="holding-stat-label">盈亏</span>
                        <span class="holding-stat-value ${record.pnl >= 0 ? 'bullish' : 'bearish'}">
                            ${record.pnl >= 0 ? '+' : ''}¥${record.pnl.toFixed(2)}
                        </span>
                    </div>
                    ` : ''}
                </div>
                ${record.note ? `<p style="margin-top: 10px; color: #8892b0; font-size: 0.9rem;">${record.note}</p>` : ''}
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function saveStrategy() {
    const name = document.getElementById('strategyName').value.trim();
    const desc = document.getElementById('strategyDesc').value.trim();
    const condition = document.getElementById('strategyCondition').value;
    const note = document.getElementById('strategyNote').value.trim();
    
    if (!name || !desc) {
        alert('请填写策略名称和描述');
        return;
    }
    
    const strategy = {
        id: Date.now(),
        name: name,
        description: desc,
        condition: condition,
        note: note,
        createdAt: new Date().toISOString().split('T')[0],
        uses: 0
    };
    
    strategies.push(strategy);
    savePortfolioData();
    renderStrategies();
    closeStrategyModal();
    
    document.getElementById('strategyName').value = '';
    document.getElementById('strategyDesc').value = '';
    document.getElementById('strategyNote').value = '';
}

function renderStrategies() {
    const container = document.getElementById('strategyList');
    
    if (strategies.length === 0) {
        container.innerHTML = '<p style="color: #8892b0; text-align: center; padding: 30px;">暂无策略，记录你的投资策略吧！</p>';
        return;
    }
    
    let html = '';
    strategies.forEach(strategy => {
        html += `
            <div class="strategy-card">
                <div class="holding-header">
                    <span class="holding-name">${strategy.name}</span>
                    <span class="holding-code">${strategy.createdAt}</span>
                </div>
                <p style="color: #fff; margin-bottom: 10px;">${strategy.description}</p>
                <p style="color: #8892b0; font-size: 0.9rem;">类型: ${getConditionText(strategy.condition)}</p>
                ${strategy.note ? `<p style="color: #8892b0; font-size: 0.9rem; margin-top: 10px;">笔记: ${strategy.note}</p>` : ''}
                <div class="holding-actions">
                    <button class="btn-small btn-info" onclick="useStrategy(${strategy.id})">应用策略</button>
                    <button class="btn-small btn-danger" onclick="deleteStrategy(${strategy.id})">删除</button>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function getConditionText(condition) {
    const conditions = {
        'technical': '技术指标',
        'fundamental': '基本面',
        'news': '消息面',
        'mixed': '综合'
    };
    return conditions[condition] || condition;
}

function useStrategy(id) {
    const strategy = strategies.find(s => s.id === id);
    if (strategy) {
        strategy.uses = (strategy.uses || 0) + 1;
        savePortfolioData();
        alert(`策略 "${strategy.name}" 已记录使用！`);
    }
}

function deleteStrategy(id) {
    if (confirm('确定要删除这个策略吗？')) {
        strategies = strategies.filter(s => s.id !== id);
        savePortfolioData();
        renderStrategies();
    }
}

function renderSummary() {
    let totalCost = 0;
    let totalMarketValue = 0;
    
    holdings.forEach(position => {
        totalCost += position.quantity * position.buyPrice;
        totalMarketValue += position.quantity * position.currentPrice;
    });
    
    const totalPnL = totalMarketValue - totalCost;
    const totalReturn = totalCost > 0 ? ((totalPnL / totalCost) * 100).toFixed(2) : 0;
    
    document.getElementById('totalAssets').textContent = `¥${(totalCost + totalPnL).toFixed(2)}`;
    document.getElementById('totalMarketValue').textContent = `¥${totalMarketValue.toFixed(2)}`;
    
    const pnlClass = totalPnL >= 0 ? 'bullish' : 'bearish';
    const pnlSign = totalPnL >= 0 ? '+' : '';
    
    document.getElementById('totalPnL').textContent = `${pnlSign}¥${totalPnL.toFixed(2)}`;
    document.getElementById('totalPnL').style.color = totalPnL >= 0 ? '#ff4757' : '#00ff88';
    document.getElementById('totalReturn').textContent = `${pnlSign}${totalReturn}%`;
    document.getElementById('totalReturn').style.color = totalPnL >= 0 ? '#ff4757' : '#00ff88';
}

function getAIRecommendation() {
    let recommendation = `
        <div class="recommendation-card">
            <h4>🤖 AI智能分析建议</h4>
            <ul>
                <li>基于你的持仓表现，建议关注高收益率股票的加仓机会</li>
                <li>对亏损较大的持仓，考虑设置止损位控制风险</li>
                <li>建议分散投资，避免单一股票占比过高</li>
    `;
    
    if (strategies.length > 0) {
        const topStrategy = strategies.reduce((a, b) => (a.uses || 0) > (b.uses || 0) ? a : b);
        recommendation += `<li>你最常用的策略是"${topStrategy.name}"，考虑继续优化这个策略</li>`;
    }
    
    if (holdings.length > 0) {
        const topHolding = holdings.reduce((a, b) => {
            const aPnl = (a.currentPrice - a.buyPrice) / a.buyPrice;
            const bPnl = (b.currentPrice - b.buyPrice) / b.buyPrice;
            return aPnl > bPnl ? a : b;
        });
        recommendation += `<li>表现最好的持仓是${topHolding.name}，可以分析其成功原因</li>`;
    }
    
    recommendation += `
            </ul>
        </div>
    `;
    
    const container = document.createElement('div');
    container.innerHTML = recommendation;
    const strategySection = document.querySelector('.strategy-section');
    const existingCard = strategySection.querySelector('.recommendation-card');
    if (existingCard) {
        existingCard.remove();
    }
    strategySection.appendChild(container.firstChild);
}

function switchTab(tab) {
    const tabs = document.querySelectorAll('.nav-tab');
    tabs.forEach(t => t.classList.remove('active'));
    
    const analysisSection = document.getElementById('analysisSection');
    const newsSection = document.getElementById('newsSection');
    const stockPickerSection = document.getElementById('stockPickerSection');
    const diarySection = document.getElementById('diarySection');
    const myPortfolioSection = document.getElementById('myPortfolioSection');
    const portfolioSection = document.getElementById('portfolioSection');
    const financeSection = document.getElementById('financeSection');
    
    analysisSection.classList.add('hidden');
    newsSection.classList.add('hidden');
    stockPickerSection.classList.add('hidden');
    diarySection.classList.add('hidden');
    myPortfolioSection.classList.add('hidden');
    portfolioSection.classList.add('hidden');
    if (financeSection) financeSection.classList.add('hidden');
    
    if (tab === 'analysis') {
        tabs[0].classList.add('active');
        analysisSection.classList.remove('hidden');
    } else if (tab === 'news') {
        tabs[1].classList.add('active');
        newsSection.classList.remove('hidden');
        loadNews();
    } else if (tab === 'stockPicker') {
        tabs[2].classList.add('active');
        stockPickerSection.classList.remove('hidden');
        loadStockPicker();
    } else if (tab === 'finance') {
        tabs[3].classList.add('active');
        if (financeSection) {
            financeSection.classList.remove('hidden');
            loadFinanceData();
        }
    } else if (tab === 'diary') {
        tabs[4].classList.add('active');
        diarySection.classList.remove('hidden');
        initDiary();
    } else if (tab === 'myPortfolio') {
        tabs[5].classList.add('active');
        myPortfolioSection.classList.remove('hidden');
        renderMyHoldings();
        renderMyTradeHistory();
    } else {
        tabs[6].classList.add('active');
        portfolioSection.classList.remove('hidden');
        renderPortfolio();
    }
}

function switchStockPickerTab(tab) {
    const tabs = document.querySelectorAll('.stock-picker-tab');
    tabs.forEach(t => t.classList.remove('active'));
    
    const cnTab = document.getElementById('cnStockPickerTab');
    const usTab = document.getElementById('usStockPickerTab');
    
    cnTab.classList.add('hidden');
    usTab.classList.add('hidden');
    
    if (tab === 'cn') {
        tabs[0].classList.add('active');
        cnTab.classList.remove('hidden');
        loadStockPicker();
    }
}

async function loadStockPicker() {
    const container = document.getElementById('stockPickerList');
    if (!container) return;
    
    container.innerHTML = `
        <div class="loading-picker">
            <div class="spinner"></div>
            <p>正在加载推荐股票...</p>
        </div>
    `;
    
    try {
        const response = await apiFetch('/api/stock/picker');
        const result = await response.json();
        
        if (result.success && result.data) {
            renderStockPicker(result.data);
        } else {
            container.innerHTML = '<p style="color: #ff4757; text-align: center; padding: 60px 20px;">加载失败，请稍后重试</p>';
        }
    } catch (error) {
        console.error('加载智能选股失败:', error);
        container.innerHTML = '<p style="color: #ff4757; text-align: center; padding: 60px 20px;">网络错误，请稍后重试</p>';
    }
}

function renderStockPicker(stocks) {
    const container = document.getElementById('stockPickerList');
    if (!container) return;
    
    container.innerHTML = stocks.map(stock => {
        const changeClass = stock.changePercent >= 0 ? 'positive' : 'negative';
        const changeSign = stock.changePercent >= 0 ? '+' : '';
        
        return `
            <div class="stock-picker-card">
                <div class="picker-card-header">
                    <div class="picker-stock-info">
                        <div class="picker-stock-name">${stock.name}</div>
                        <div class="picker-stock-code">${stock.code}</div>
                        <span class="picker-stock-industry">${stock.industry}</span>
                    </div>
                    <div class="picker-price-info">
                        <div class="picker-current-price">¥${stock.currentPrice.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</div>
                        <div class="picker-change ${changeClass}">${changeSign}${stock.changePercent.toFixed(2)}%</div>
                    </div>
                </div>
                
                <div class="picker-financials">
                    <div class="picker-financial-item">
                        <span class="picker-financial-label">市盈率 (PE)</span>
                        <span class="picker-financial-value">${stock.pe > 0 ? stock.pe.toFixed(1) : '--'}</span>
                    </div>
                    <div class="picker-financial-item">
                        <span class="picker-financial-label">市净率 (PB)</span>
                        <span class="picker-financial-value">${stock.pb > 0 ? stock.pb.toFixed(1) : '--'}</span>
                    </div>
                </div>
                
                <div class="picker-reasons">
                    <div class="picker-reasons-title">📋 买入理由</div>
                    <div class="picker-reasons-list">
                        ${stock.reasons.map(reason => `
                            <div class="picker-reason-item">
                                <span class="picker-reason-dot">•</span>
                                <span>${reason}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
                
                <div class="picker-price-targets">
                    <div class="picker-target-item">
                        <span class="picker-target-label">🎯 建议买入价</span>
                        <span class="picker-target-value buy">¥${stock.buyPrice.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                    </div>
                    <div class="picker-target-item">
                        <span class="picker-target-label">⚠️ 建议止损价</span>
                        <span class="picker-target-value stop">¥${stock.stopLoss.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function switchMyPortfolioTab(tab) {
    const tabs = document.querySelectorAll('.my-portfolio-tab');
    tabs.forEach(t => t.classList.remove('active'));
    
    const manualTab = document.getElementById('manualTab');
    const aiTab = document.getElementById('aiTab');
    
    manualTab.classList.add('hidden');
    aiTab.classList.add('hidden');
    
    if (tab === 'manual') {
        tabs[0].classList.add('active');
        manualTab.classList.remove('hidden');
    } else {
        tabs[1].classList.add('active');
        aiTab.classList.remove('hidden');
    }
}

let selectedBroker = 'galaxy';

function selectBroker(broker) {
    selectedBroker = broker;
    const options = document.querySelectorAll('.broker-option');
    options.forEach(opt => opt.classList.remove('selected'));
    event.currentTarget.classList.add('selected');
}

let verifyCodeCountdown = 0;

function sendVerifyCode() {
    if (verifyCodeCountdown > 0) return;
    
    const phone = document.getElementById('brokerPhone').value;
    if (!phone) {
        alert('请先输入手机号码');
        return;
    }
    
    alert('验证码已发送！');
    verifyCodeCountdown = 60;
    const btn = event.currentTarget;
    const originalText = btn.textContent;
    
    const interval = setInterval(() => {
        verifyCodeCountdown--;
        btn.textContent = `${verifyCodeCountdown}秒后重发`;
        btn.disabled = true;
        
        if (verifyCodeCountdown <= 0) {
            clearInterval(interval);
            btn.textContent = originalText;
            btn.disabled = false;
        }
    }, 1000);
}

function connectBroker() {
    const account = document.getElementById('brokerAccount').value;
    const password = document.getElementById('brokerPassword').value;
    const phone = document.getElementById('brokerPhone').value;
    const verifyCode = document.getElementById('brokerVerifyCode').value;
    
    if (!account || !password || !phone || !verifyCode) {
        alert('请填写完整信息');
        return;
    }
    
    const brokerNames = {
        'galaxy': '中国银河证券',
        'citic': '中信证券',
        'htsec': '海通证券',
        'gf': '广发证券'
    };
    
    const connectionStatus = document.getElementById('connectionStatus');
    connectionStatus.classList.remove('hidden');
    connectionStatus.querySelector('.status-text').textContent = 
        `✓ 账户已连接 - ${brokerNames[selectedBroker]}`;
    
    alert('账户绑定成功！');
}

let aiAgentRunning = false;
let aiAgentInterval = null;

function startAIAgent() {
    if (aiAgentRunning) return;
    
    const strategy = document.getElementById('aiStrategy').value;
    if (!strategy) {
        alert('请先输入交易策略');
        return;
    }
    
    aiAgentRunning = true;
    const aiAgentStatus = document.getElementById('aiAgentStatus');
    aiAgentStatus.classList.remove('hidden');
    
    const log = aiAgentStatus.querySelector('.agent-log');
    let logCount = 4;
    
    aiAgentInterval = setInterval(() => {
        const now = new Date();
        const timeStr = now.toTimeString().split(' ')[0];
        const messages = [
            '正在监控市场数据...',
            '分析技术指标中...',
            '检查策略条件...',
            '暂无符合策略的交易机会',
            '继续监控中...',
            '扫描股票池...'
        ];
        const msg = messages[Math.floor(Math.random() * messages.length)];
        
        const logItem = document.createElement('div');
        logItem.className = 'log-item';
        logItem.textContent = `[${timeStr}] ${msg}`;
        log.appendChild(logItem);
        log.scrollTop = log.scrollHeight;
        
        logCount++;
    }, 3000);
    
    alert('AI Agent 已启动！');
}

function stopAIAgent() {
    if (!aiAgentRunning) return;
    
    aiAgentRunning = false;
    if (aiAgentInterval) {
        clearInterval(aiAgentInterval);
        aiAgentInterval = null;
    }
    
    alert('AI Agent 已停止！');
}

let myHoldings = [];
let myTradeHistory = [];

function loadMyPortfolioData() {
    const savedHoldings = localStorage.getItem('myHoldings');
    const savedTradeHistory = localStorage.getItem('myTradeHistory');
    if (savedHoldings) {
        myHoldings = JSON.parse(savedHoldings);
    }
    if (savedTradeHistory) {
        myTradeHistory = JSON.parse(savedTradeHistory);
    }
}

function saveMyPortfolioData() {
    localStorage.setItem('myHoldings', JSON.stringify(myHoldings));
    localStorage.setItem('myTradeHistory', JSON.stringify(myTradeHistory));
}

function updateMyPortfolioSummary() {
    const totalAmountEl = document.getElementById('myTotalAmount');
    const totalPnLEl = document.getElementById('myTotalPnL');
    const totalReturnEl = document.getElementById('myTotalReturn');
    const positionCountEl = document.getElementById('myPositionCount');
    
    if (!totalAmountEl || !totalPnLEl || !totalReturnEl || !positionCountEl) {
        return;
    }
    
    let totalCost = 0;
    let totalMarketValue = 0;
    
    myHoldings.forEach(position => {
        totalCost += position.quantity * position.buyPrice;
        totalMarketValue += position.quantity * position.currentPrice;
    });
    
    const totalPnL = totalMarketValue - totalCost;
    const totalReturn = totalCost > 0 ? ((totalPnL / totalCost) * 100) : 0;
    const pnlClass = totalPnL >= 0 ? 'positive' : 'negative';
    
    totalAmountEl.textContent = `¥${totalMarketValue.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    totalPnLEl.textContent = `${totalPnL >= 0 ? '+' : ''}¥${totalPnL.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    totalPnLEl.className = `my-summary-value ${pnlClass}`;
    totalReturnEl.textContent = `${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`;
    totalReturnEl.className = `my-summary-value ${pnlClass}`;
    positionCountEl.textContent = `${myHoldings.length}只`;
}

function addMyPosition() {
    const code = document.getElementById('myPositionCode').value;
    const name = document.getElementById('myPositionName').value;
    const quantity = parseInt(document.getElementById('myPositionQuantity').value);
    const price = parseFloat(document.getElementById('myPositionPrice').value);
    const date = document.getElementById('myPositionDate').value;
    const fee = parseFloat(document.getElementById('myPositionFee').value) || 0;
    const note = document.getElementById('myPositionNote').value;
    
    if (!code || !quantity || !price) {
        alert('请填写必填项');
        return;
    }
    
    const stockName = name || getStockName(code) || '未知股票';
    
    const position = {
        id: Date.now(),
        code: code,
        name: stockName,
        quantity: quantity,
        buyPrice: price,
        buyDate: date || new Date().toISOString().split('T')[0],
        fee: fee,
        note: note,
        currentPrice: price * (1 + (Math.random() - 0.4) * 0.1)
    };
    
    myHoldings.push(position);
    
    const trade = {
        id: Date.now(),
        date: position.buyDate,
        type: 'buy',
        code: code,
        name: stockName,
        quantity: quantity,
        price: price
    };
    myTradeHistory.unshift(trade);
    
    renderMyHoldings();
    renderMyTradeHistory();
    updateMyPortfolioSummary();
    saveMyPortfolioData();
    
    document.getElementById('myPositionCode').value = '';
    document.getElementById('myPositionName').value = '';
    document.getElementById('myPositionQuantity').value = '';
    document.getElementById('myPositionPrice').value = '';
    document.getElementById('myPositionDate').value = '';
    document.getElementById('myPositionNote').value = '';
    
    alert('持仓添加成功！');
}

function renderMyHoldings() {
    const container = document.getElementById('myHoldingsList');
    if (!container) return;
    
    if (myHoldings.length === 0) {
        container.innerHTML = '<p style="color: #8892b0; text-align: center; padding: 30px;">暂无持仓</p>';
    } else {
        let html = '';
        myHoldings.forEach(position => {
            const pnl = (position.currentPrice - position.buyPrice) * position.quantity;
            const pnlPercent = ((position.currentPrice - position.buyPrice) / position.buyPrice * 100);
            const pnlClass = pnl >= 0 ? 'positive' : 'negative';
            
            html += `
                <div class="my-holding-item">
                    <div class="my-holding-header">
                        <div class="my-holding-info">
                            <span class="my-holding-name">${position.name}</span>
                            <span class="my-holding-code">${position.code}</span>
                        </div>
                        <div class="my-holding-pnl ${pnlClass}">
                            ${pnl >= 0 ? '+' : ''}¥${pnl.toFixed(2)}
                        </div>
                    </div>
                    <div class="my-holding-details">
                        <div class="my-holding-detail-item">
                            <span class="label">持仓数量</span>
                            <span class="value">${position.quantity}股</span>
                        </div>
                        <div class="my-holding-detail-item">
                            <span class="label">买入价格</span>
                            <span class="value">¥${position.buyPrice.toFixed(2)}</span>
                        </div>
                        <div class="my-holding-detail-item">
                            <span class="label">当前价格</span>
                            <span class="value">¥${position.currentPrice.toFixed(2)}</span>
                        </div>
                        <div class="my-holding-detail-item">
                            <span class="label">收益率</span>
                            <span class="value ${pnlClass}">${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</span>
                        </div>
                    </div>
                </div>
            `;
        });
        
        container.innerHTML = html;
    }
    
    updateMyPortfolioSummary();
}

function renderMyTradeHistory() {
    const container = document.getElementById('myTradeHistory');
    if (!container) return;
    
    if (myTradeHistory.length === 0) {
        container.innerHTML = '<p style="color: #8892b0; text-align: center; padding: 30px;">暂无交易记录</p>';
        return;
    }
    
    let html = '';
    myTradeHistory.forEach(trade => {
        html += `
            <div class="my-history-item">
                <div class="my-history-date">${trade.date}</div>
                <div class="my-history-content">
                    <div class="my-history-type ${trade.type}">${trade.type === 'buy' ? '买入' : '卖出'}</div>
                    <div class="my-history-stock">${trade.name} (${trade.code})</div>
                    <div class="my-history-quantity">${trade.quantity}股</div>
                    <div class="my-history-price">¥${trade.price.toFixed(2)}</div>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

let diaries = [];
let selectedMood = null;

function initDiary() {
    const today = new Date().toISOString().split('T')[0];
    const diaryDateInput = document.getElementById('diaryDate');
    if (diaryDateInput) {
        diaryDateInput.value = today;
    }
    
    const moodTags = document.querySelectorAll('.mood-tag');
    moodTags.forEach(tag => {
        tag.addEventListener('click', function() {
            moodTags.forEach(t => t.classList.remove('selected'));
            this.classList.add('selected');
            selectedMood = this.dataset.mood;
        });
    });
    
    loadDiaries();
}

function loadDiaries() {
    const saved = localStorage.getItem('tradingDiaries');
    if (saved) {
        diaries = JSON.parse(saved);
    } else {
        diaries = [];
    }
}

function saveDiary() {
    const date = document.getElementById('diaryDate').value;
    const title = document.getElementById('diaryTitle').value;
    const trade = document.getElementById('diaryTrade').value;
    const note = document.getElementById('diaryNote').value;
    const knowledge = document.getElementById('diaryKnowledge').value;
    
    if (!title) {
        alert('请输入日记标题');
        return;
    }
    
    const moodEmojis = {
        'excited': '😆',
        'calm': '😊',
        'anxious': '😰',
        'frustrated': '😤',
        'regret': '😔'
    };
    
    const diary = {
        id: Date.now(),
        date: date,
        title: title,
        mood: selectedMood || 'calm',
        moodEmoji: moodEmojis[selectedMood || 'calm'],
        trade: trade,
        note: note,
        knowledge: knowledge
    };
    
    diaries.unshift(diary);
    localStorage.setItem('tradingDiaries', JSON.stringify(diaries));
    
    renderDiaries();
    
    document.getElementById('diaryTitle').value = '';
    document.getElementById('diaryTrade').value = '';
    document.getElementById('diaryNote').value = '';
    document.getElementById('diaryKnowledge').value = '';
    document.querySelectorAll('.mood-tag').forEach(t => t.classList.remove('selected'));
    selectedMood = null;
    
    alert('日记保存成功！');
}

function renderDiaries() {
    const container = document.getElementById('diaryList');
    if (!container) return;
    
    if (diaries.length === 0) {
        container.innerHTML = '<p style="color: #8892b0; text-align: center; padding: 30px;">还没有日记，开始写第一篇吧！</p>';
        return;
    }
    
    let html = '';
    diaries.forEach(diary => {
        html += `
            <div class="diary-item">
                <div class="diary-item-header">
                    <div class="diary-item-date">${diary.date}</div>
                    <div class="diary-item-mood">${diary.moodEmoji}</div>
                </div>
                <div class="diary-item-title">${diary.title}</div>
                <div class="diary-item-content">
                    ${diary.trade ? `<p><strong>今日交易：</strong>${diary.trade}</p>` : ''}
                    ${diary.note ? `<p><strong>心得体会：</strong>${diary.note}</p>` : ''}
                    ${diary.knowledge ? `<p><strong>知识点：</strong>${diary.knowledge}</p>` : ''}
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

async function loadStockRanking() {
    try {
        const response = await fetch('/api/stock/ranking');
        const result = await response.json();
        
        if (result.success && result.data) {
            renderStockRanking(result.data);
        }
    } catch (error) {
        console.error('加载股票榜单失败:', error);
    }
}

function renderStockRanking(stocks) {
    const container = document.getElementById('stockRanking');
    if (!container) return;
    
    container.innerHTML = stocks.map(stock => {
        const changeClass = stock.changePercent >= 0 ? 'positive' : 'negative';
        return `
            <div class="stock-ranking-item">
                <div class="stock-info">
                    <span class="stock-name">${stock.name}</span>
                    <span class="stock-code">${stock.code}</span>
                </div>
                <div class="stock-price">
                    <span class="price">¥${stock.price.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
                    <span class="change ${changeClass}">${stock.changePercent >= 0 ? '+' : ''}${stock.changePercent.toFixed(2)}%</span>
                </div>
                <button class="btn-primary btn-small" onclick="openTradeModal('${stock.code}', '${stock.name}', ${stock.price})">交易</button>
            </div>
        `;
    }).join('');
}

function switchPortfolioTab(tab) {
    const tabs = document.querySelectorAll('.portfolio-tab');
    tabs.forEach(t => t.classList.remove('active'));
    
    const tradingTab = document.getElementById('tradingTab');
    const pkTab = document.getElementById('pkTab');
    
    tradingTab.classList.add('hidden');
    pkTab.classList.add('hidden');
    
    if (tab === 'trading') {
        tabs[0].classList.add('active');
        tradingTab.classList.remove('hidden');
        loadStockRanking();
        checkCapitalSet();
    } else {
        tabs[1].classList.add('active');
        pkTab.classList.remove('hidden');
    }
}

function setInitialCapital() {
    const capital = parseFloat(document.getElementById('initialCapital').value);
    if (!capital || capital <= 0) {
        alert('请输入有效的初始资金');
        return;
    }
    
    simInitialCapital = capital;
    simAvailableCapital = capital;
    simHoldings = [];
    simTradeHistory = [];
    
    localStorage.setItem('simCapitalSet', 'true');
    
    updateCapitalDisplay();
    renderSimHoldings();
    renderSimTradeHistory();
    saveSimData();
    
    const capitalSetup = document.getElementById('capitalSetup');
    if (capitalSetup) {
        capitalSetup.classList.add('hidden');
    }
    
    alert('初始资金设置成功！');
}

function checkCapitalSet() {
    const capitalSet = localStorage.getItem('simCapitalSet');
    const capitalSetup = document.getElementById('capitalSetup');
    if (capitalSet === 'true' && capitalSetup) {
        capitalSetup.classList.add('hidden');
    }
}

function updateCapitalDisplay() {
    const availableEl = document.getElementById('availableCapital');
    const holdingValueEl = document.getElementById('holdingMarketValue');
    const totalEl = document.getElementById('totalAssets');
    const returnEl = document.getElementById('totalReturn');
    
    if (!availableEl || !holdingValueEl || !totalEl || !returnEl) {
        return;
    }
    
    let holdingMarketValue = 0;
    simHoldings.forEach(h => {
        holdingMarketValue += h.quantity * h.currentPrice;
    });
    
    const totalAssets = simAvailableCapital + holdingMarketValue;
    const totalReturn = ((totalAssets - simInitialCapital) / simInitialCapital * 100);
    
    availableEl.textContent = `¥${simAvailableCapital.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    holdingValueEl.textContent = `¥${holdingMarketValue.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    totalEl.textContent = `¥${totalAssets.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    
    const returnClass = totalReturn >= 0 ? 'positive' : 'negative';
    returnEl.textContent = `${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`;
    returnEl.className = `value ${returnClass}`;
}

function openTradeModal(code, name, price) {
    currentTradeStock = { code, name, price };
    currentTradeType = 'buy';
    
    document.getElementById('tradeModalTitle').textContent = `交易 - ${name}`;
    document.getElementById('tradeStockName').textContent = name;
    document.getElementById('tradeStockCode').textContent = code;
    document.getElementById('tradeCurrentPrice').textContent = `¥${price.toFixed(2)}`;
    document.getElementById('tradePrice').value = price.toFixed(2);
    document.getElementById('tradeQuantity').value = '';
    document.getElementById('tradeEstimatedAmount').textContent = '¥0.00';
    
    const tradeTabs = document.querySelectorAll('.trade-tab');
    tradeTabs.forEach(t => t.classList.remove('active'));
    tradeTabs[0].classList.add('active');
    
    document.getElementById('tradeModal').classList.remove('hidden');
}

function closeTradeModal() {
    document.getElementById('tradeModal').classList.add('hidden');
}

function switchTradeType(type) {
    currentTradeType = type;
    const tradeTabs = document.querySelectorAll('.trade-tab');
    tradeTabs.forEach(t => t.classList.remove('active'));
    
    if (type === 'buy') {
        tradeTabs[0].classList.add('active');
    } else {
        tradeTabs[1].classList.add('active');
    }
    
    updateTradeEstimate();
}

function updateTradeEstimate() {
    const price = parseFloat(document.getElementById('tradePrice').value) || 0;
    const quantity = parseInt(document.getElementById('tradeQuantity').value) || 0;
    const amount = price * quantity;
    
    document.getElementById('tradeEstimatedAmount').textContent = 
        `¥${amount.toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
}

document.addEventListener('input', function(e) {
    if (e.target.id === 'tradePrice' || e.target.id === 'tradeQuantity') {
        updateTradeEstimate();
    }
});

function executeTrade() {
    const price = parseFloat(document.getElementById('tradePrice').value);
    const quantity = parseInt(document.getElementById('tradeQuantity').value);
    
    if (!price || !quantity || quantity <= 0) {
        alert('请输入有效的价格和数量');
        return;
    }
    
    const amount = price * quantity;
    
    if (currentTradeType === 'buy') {
        if (amount > simAvailableCapital) {
            alert('可用资金不足');
            return;
        }
        
        simAvailableCapital -= amount;
        
        const existingHolding = simHoldings.find(h => h.code === currentTradeStock.code);
        if (existingHolding) {
            const totalQuantity = existingHolding.quantity + quantity;
            const totalCost = existingHolding.quantity * existingHolding.buyPrice + quantity * price;
            existingHolding.quantity = totalQuantity;
            existingHolding.buyPrice = totalCost / totalQuantity;
            existingHolding.currentPrice = price;
        } else {
            simHoldings.push({
                code: currentTradeStock.code,
                name: currentTradeStock.name,
                quantity: quantity,
                buyPrice: price,
                currentPrice: price
            });
        }
        
        simTradeHistory.unshift({
            id: Date.now(),
            date: new Date().toISOString().split('T')[0],
            type: 'buy',
            code: currentTradeStock.code,
            name: currentTradeStock.name,
            quantity: quantity,
            price: price
        });
        
    } else {
        const holding = simHoldings.find(h => h.code === currentTradeStock.code);
        if (!holding) {
            alert('没有该股票持仓');
            return;
        }
        
        if (quantity > holding.quantity) {
            alert('持仓数量不足');
            return;
        }
        
        simAvailableCapital += amount;
        
        if (quantity === holding.quantity) {
            simHoldings = simHoldings.filter(h => h.code !== currentTradeStock.code);
        } else {
            holding.quantity -= quantity;
        }
        
        simTradeHistory.unshift({
            id: Date.now(),
            date: new Date().toISOString().split('T')[0],
            type: 'sell',
            code: currentTradeStock.code,
            name: currentTradeStock.name,
            quantity: quantity,
            price: price
        });
    }
    
    updateCapitalDisplay();
    renderSimHoldings();
    renderSimTradeHistory();
    saveSimData();
    closeTradeModal();
    
    alert(`${currentTradeType === 'buy' ? '买入' : '卖出'}成功！`);
}

function renderSimHoldings() {
    const container = document.getElementById('holdingsList');
    if (!container) return;
    
    if (simHoldings.length === 0) {
        container.innerHTML = '<p style="color: #8892b0; text-align: center; padding: 30px;">暂无持仓</p>';
        return;
    }
    
    let html = '';
    simHoldings.forEach(h => {
        const pnl = (h.currentPrice - h.buyPrice) * h.quantity;
        const pnlPercent = ((h.currentPrice - h.buyPrice) / h.buyPrice * 100);
        const pnlClass = pnl >= 0 ? 'positive' : 'negative';
        
        html += `
            <div class="holding-item">
                <div class="holding-header">
                    <div class="holding-info">
                        <span class="holding-name">${h.name}</span>
                        <span class="holding-code">${h.code}</span>
                    </div>
                    <div class="holding-pnl ${pnlClass}">
                        ${pnl >= 0 ? '+' : ''}¥${pnl.toFixed(2)}
                    </div>
                </div>
                <div class="holding-details">
                    <div class="holding-detail-item">
                        <span class="label">持仓数量</span>
                        <span class="value">${h.quantity}股</span>
                    </div>
                    <div class="holding-detail-item">
                        <span class="label">买入价格</span>
                        <span class="value">¥${h.buyPrice.toFixed(2)}</span>
                    </div>
                    <div class="holding-detail-item">
                        <span class="label">当前价格</span>
                        <span class="value">¥${h.currentPrice.toFixed(2)}</span>
                    </div>
                    <div class="holding-detail-item">
                        <span class="label">收益率</span>
                        <span class="value ${pnlClass}">${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%</span>
                    </div>
                </div>
                <button class="btn-secondary btn-small" onclick="openTradeModal('${h.code}', '${h.name}', ${h.currentPrice})">交易</button>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function renderSimTradeHistory() {
    const container = document.getElementById('historyList');
    if (!container) return;
    
    if (simTradeHistory.length === 0) {
        container.innerHTML = '<p style="color: #8892b0; text-align: center; padding: 30px;">暂无交易记录</p>';
        return;
    }
    
    let html = '';
    simTradeHistory.forEach(t => {
        html += `
            <div class="history-item">
                <div class="history-date">${t.date}</div>
                <div class="history-content">
                    <div class="history-type ${t.type}">${t.type === 'buy' ? '买入' : '卖出'}</div>
                    <div class="history-stock">${t.name} (${t.code})</div>
                    <div class="history-quantity">${t.quantity}股</div>
                    <div class="history-price">¥${t.price.toFixed(2)}</div>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function setUsername() {
    const username = document.getElementById('username').value.trim();
    if (!username) {
        alert('请输入用户名');
        return;
    }
    
    currentUsername = username;
    localStorage.setItem('simUsername', username);
    const displayUsername = document.getElementById('displayUsername');
    if (displayUsername) displayUsername.textContent = username;
    alert(`用户名设置成功：${username}`);
}

function createPK() {
    const name = document.getElementById('pkName').value.trim();
    const capital = parseFloat(document.getElementById('pkInitialCapital').value);
    const duration = parseInt(document.getElementById('pkDuration').value);
    
    if (!name) {
        alert('请输入比赛名称');
        return;
    }
    
    if (!capital || capital <= 0) {
        alert('请输入有效的初始资金');
        return;
    }
    
    if (!duration || duration <= 0) {
        alert('请输入有效的比赛时长');
        return;
    }
    
    const pk = {
        id: 'pk' + Date.now(),
        name: name,
        initialCapital: capital,
        duration: duration,
        startDate: new Date().toISOString().split('T')[0],
        players: [
            {
                username: currentUsername || '我',
                capital: capital,
                returnRate: 0,
                rank: 1
            }
        ],
        inviteCode: 'PK' + Math.random().toString(36).substring(2, 8).toUpperCase()
    };
    
    pkList.unshift(pk);
    localStorage.setItem('simPKList', JSON.stringify(pkList));
    renderPKList();
    
    alert('PK比赛创建成功！');
}

function renderPKList() {
    const container = document.getElementById('pkList');
    if (!container) return;
    
    const saved = localStorage.getItem('simPKList');
    if (saved) {
        pkList = JSON.parse(saved);
    }
    
    if (pkList.length === 0) {
        container.innerHTML = '<p style="color: #8892b0; text-align: center; padding: 30px;">还没有PK比赛</p>';
        return;
    }
    
    let html = '';
    pkList.forEach(pk => {
        const today = new Date();
        const startDate = new Date(pk.startDate);
        const daysPassed = Math.floor((today - startDate) / (1000 * 60 * 60 * 24));
        const remainingDays = Math.max(0, pk.duration - daysPassed);
        
        html += `
            <div class="pk-item">
                <div class="pk-header">
                    <div class="pk-name">${pk.name}</div>
                    <div class="pk-status">进行中</div>
                </div>
                <div class="pk-info">
                    <div class="pk-info-item">
                        <span class="label">初始资金</span>
                        <span class="value">¥${pk.initialCapital.toLocaleString('zh-CN')}</span>
                    </div>
                    <div class="pk-info-item">
                        <span class="label">剩余天数</span>
                        <span class="value">${remainingDays}天</span>
                    </div>
                    <div class="pk-info-item">
                        <span class="label">参赛人数</span>
                        <span class="value">${pk.players.length}人</span>
                    </div>
                </div>
                <div class="pk-actions">
                    <button class="btn-secondary btn-small" onclick="inviteToPK('${pk.id}')">邀请好友</button>
                    <button class="btn-primary btn-small" onclick="viewPKLeaderboard('${pk.id}')">查看排行榜</button>
                </div>
            </div>
        `;
    });
    
    container.innerHTML = html;
}

function inviteToPK(pkId) {
    const pk = pkList.find(p => p.id === pkId);
    if (!pk) return;
    
    document.getElementById('inviteCode').textContent = pk.inviteCode;
    document.getElementById('inviteLink').textContent = 
        `http://localhost:3000?invite=${pk.inviteCode}`;
    
    document.getElementById('inviteModal').classList.remove('hidden');
}

function closeInviteModal() {
    document.getElementById('inviteModal').classList.add('hidden');
}

function copyInviteCode() {
    const code = document.getElementById('inviteCode').textContent;
    navigator.clipboard.writeText(code).then(() => {
        alert('邀请码已复制！');
    }).catch(() => {
        alert('复制失败，请手动复制');
    });
}

function viewPKLeaderboard(pkId) {
    const section = document.getElementById('leaderboardSection');
    section.classList.remove('hidden');
    section.scrollIntoView({ behavior: 'smooth' });
}

async function loadNews() {
    const newsList = document.getElementById('newsList');
    
    try {
        newsList.innerHTML = `
            <div class="loading">
                <div class="spinner"></div>
                <p>正在加载新闻...</p>
            </div>
        `;
        
        const response = await apiFetch('/api/news');
        const data = await response.json();
        
        if (data.success && data.data) {
            let html = '';
            data.data.forEach((news, index) => {
                const categoryText = {
                    'market': '市场',
                    'policy': '政策',
                    'commodity': '商品',
                    'industry': '行业',
                    'global': '国际',
                    'forex': '外汇'
                }[news.category] || news.category;
                
                html += `
                    <div class="news-item ${news.impact}" id="news-${index}">
                        <div class="news-header" onclick="toggleNewsDetail(${index})">
                            <div class="news-title">${news.title}</div>
                            <div class="news-expand-icon" id="expand-icon-${index}">▼</div>
                        </div>
                        <div class="news-meta">
                            <span class="news-category">${categoryText}</span>
                            <span>${news.time}</span>
                            <span class="news-source">来源：${news.source || '未知'}</span>
                        </div>
                        <div class="news-detail" id="news-detail-${index}">
                            ${news.detail || '暂无详情'}
                        </div>
                    </div>
                `;
            });
            newsList.innerHTML = html;
        }
    } catch (error) {
        console.error('加载新闻失败:', error);
        newsList.innerHTML = '<p style="color: #ff4757; text-align: center; padding: 30px;">加载新闻失败</p>';
    }
}

function toggleNewsDetail(index) {
    const detail = document.getElementById(`news-detail-${index}`);
    const icon = document.getElementById(`expand-icon-${index}`);
    
    if (detail.classList.contains('expanded')) {
        detail.classList.remove('expanded');
        icon.textContent = '▼';
    } else {
        detail.classList.add('expanded');
        icon.textContent = '▲';
    }
}

async function getAIAnalysis() {
    const stockCode = document.getElementById('aiStockCode').value.trim();
    
    if (!stockCode || !/^\d{6}$/.test(stockCode)) {
        alert('请输入有效的A股6位代码');
        return;
    }
    
    const aiAnalysis = document.getElementById('aiAnalysis');
    
    try {
        aiAnalysis.innerHTML = `
            <div class="loading">
                <div class="spinner"></div>
                <p>AI正在分析中...</p>
            </div>
        `;
        aiAnalysis.classList.remove('hidden');
        
        const holdingsForStock = holdings.filter(h => h.code === stockCode);
        
        const response = await apiFetch('/api/ai/analysis', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                code: stockCode,
                holdings: holdingsForStock
            })
        });
        const data = await response.json();
        
        if (data.success) {
            const stock = data.stock;
            const analysis = data.analysis;
            const enhanced = data.enhanced;
            
            const confidenceClass = analysis.confidence >= 70 ? 'high' : 
                                   analysis.confidence >= 50 ? 'medium' : 'low';
            const riskClass = analysis.risk_level === '低风险' ? 'low' :
                             analysis.risk_level === '中等风险' ? 'medium' : 'high';
            
            let html = `
                <div class="ai-stock-summary">
                    <h3>📊 ${stock.name} (${stock.code}) 股票数据</h3>
                    <div class="stock-metrics">
                        <div class="metric-item">
                            <div class="metric-label">当前价格</div>
                            <div class="metric-value">¥${stock.price}</div>
                        </div>
                        <div class="metric-item">
                            <div class="metric-label">涨跌幅</div>
                            <div class="metric-value">${stock.changePercent >= 0 ? '+' : ''}${stock.changePercent.toFixed(2)}%</div>
                        </div>
                        <div class="metric-item">
                            <div class="metric-label">市盈率(动)</div>
                            <div class="metric-value">${stock.pe ? stock.pe.toFixed(2) : '--'}</div>
                        </div>
                        <div class="metric-item">
                            <div class="metric-label">市净率</div>
                            <div class="metric-value">${stock.pb ? stock.pb.toFixed(2) : '--'}</div>
                        </div>
                        <div class="metric-item">
                            <div class="metric-label">成交量</div>
                            <div class="metric-value">${(stock.volume / 1000000).toFixed(2)}M</div>
                        </div>
                    </div>
                </div>
            `;
            
            if (holdingsForStock.length > 0) {
                html += `
                    <div class="ai-analysis-card" style="border-left: 4px solid #ffd93d;">
                        <h4>💼 您的持仓情况</h4>
                `;
                holdingsForStock.forEach(position => {
                    const marketValue = position.quantity * stock.price;
                    const cost = position.quantity * position.buyPrice;
                    const pnl = marketValue - cost;
                    const pnlPercent = ((pnl / cost) * 100).toFixed(2);
                    const pnlClass = pnl >= 0 ? 'bullish' : 'bearish';
                    const pnlSign = pnl >= 0 ? '+' : '';
                    
                    html += `
                        <div style="margin: 10px 0; padding: 10px; background: rgba(255,255,255,0.05); border-radius: 5px;">
                            <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                                <span><strong>买入日期:</strong> ${position.buyDate}</span>
                                <span><strong>数量:</strong> ${position.quantity}股</span>
                            </div>
                            <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                                <span><strong>成本价:</strong> ¥${position.buyPrice}</span>
                                <span><strong>现价:</strong> ¥${stock.price}</span>
                            </div>
                            <div style="display: flex; justify-content: space-between;">
                                <span><strong>市值:</strong> ¥${marketValue.toFixed(2)}</span>
                                <span class="${pnlClass}"><strong>盈亏:</strong> ${pnlSign}¥${pnl.toFixed(2)} (${pnlSign}${pnlPercent}%)</span>
                            </div>
                            ${position.note ? `<div style="margin-top: 8px; color: #8892b0; font-size: 0.9rem;"><strong>备注:</strong> ${position.note}</div>` : ''}
                        </div>
                    `;
                });
                html += '</div>';
            }
            
            html += `
                <div class="ai-analysis-card">
                    <h4>📈 整体分析</h4>
                    <p>${analysis.overall}</p>
                    ${analysis.overall_reason ? `<p style="margin-top: 8px; color: #8892b0; font-size: 0.9rem;">💡 ${analysis.overall_reason}</p>` : ''}
                </div>
                
                <div class="ai-analysis-card">
                    <h4>📊 技术面分析</h4>
                    <p>${analysis.technical}</p>
                    ${analysis.technical_reason ? `<p style="margin-top: 8px; color: #8892b0; font-size: 0.9rem;">💡 ${analysis.technical_reason}</p>` : ''}
                </div>
                
                <div class="ai-analysis-card">
                    <h4>💼 基本面分析</h4>
                    <p>${analysis.fundamental}</p>
                    ${analysis.fundamental_reason ? `<p style="margin-top: 8px; color: #8892b0; font-size: 0.9rem;">💡 ${analysis.fundamental_reason}</p>` : ''}
                </div>
                
                <div class="ai-analysis-card">
                    <h4>📰 市场消息面</h4>
                    <p>${analysis.news_impact}</p>
                </div>
                
                <div class="ai-analysis-card">
                    <h4>🎯 AI分析置信度</h4>
                    <div class="confidence-bar">
                        <div class="confidence-label">
                            <span>置信度</span>
                            <span>${analysis.confidence}%</span>
                        </div>
                        <div class="confidence-track">
                            <div class="confidence-fill ${confidenceClass}" style="width: ${analysis.confidence}%"></div>
                        </div>
                    </div>
                </div>
                
                <div class="recommendation-final">
                    <h3>🎯 AI决策建议</h3>
                    <p class="recommendation-text">${analysis.recommendation}</p>
                    ${analysis.recommendation_reason ? `<p style="margin-top: 10px; color: #8892b0; font-size: 0.95rem;">💡 ${analysis.recommendation_reason}</p>` : ''}
                    <span class="risk-badge ${riskClass}">${analysis.risk_level}</span>
                </div>
            `;
            
            aiAnalysis.innerHTML = html;
        } else {
            aiAnalysis.innerHTML = '<p style="color: #ff4757; text-align: center; padding: 30px;">获取AI分析失败</p>';
        }
    } catch (error) {
        console.error('AI分析失败:', error);
        aiAnalysis.innerHTML = '<p style="color: #ff4757; text-align: center; padding: 30px;">AI分析失败</p>';
    }
}

// AI助手功能
function toggleAIChat() {
    const chatWindow = document.getElementById('aiChatWindow');
    chatWindow.classList.toggle('hidden');
}

function handleAIInputKeypress(event) {
    if (event.key === 'Enter') {
        sendAIMessage();
    }
}

async function sendAIChatMessage(message) {
    const provider = (appSettings.ai && appSettings.ai.provider) || 'backend';
    if (provider === 'openai-chat') {
        return await callOpenAiChat(message);
    }
    
    const response = await apiFetch('/api/ai/chat', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            message: message
        })
    });
    
    const result = await response.json();
    if (result && result.success && result.reply) return result.reply;
    throw new Error((result && result.error) || 'AI聊天失败');
}

async function callOpenAiChat(message) {
    const apiKey = (appSettings.ai && appSettings.ai.apiKey) ? appSettings.ai.apiKey.trim() : '';
    const baseUrl = normalizeBaseUrl(appSettings.ai && appSettings.ai.baseUrl);
    const model = (appSettings.ai && appSettings.ai.model) ? appSettings.ai.model.trim() : '';
    const maxTokens = Number(appSettings.ai && appSettings.ai.maxTokens) || 1024;
    
    if (!apiKey) throw new Error('AI API Key 未配置');
    if (!baseUrl) throw new Error('AI Base URL 未配置');
    if (!model) throw new Error('AI 模型名称未配置');
    
    const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : joinUrl(baseUrl, 'chat/completions');
    
    const systemPrompt = '你是股票智能助手。回答要简洁、可执行，必要时分点说明。';
    
    if (!Array.isArray(aiChatHistory)) aiChatHistory = [];
    const history = aiChatHistory.slice(-12);
    
    const messages = [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message }
    ];
    
    const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model,
            messages,
            max_tokens: maxTokens
        })
    });
    
    if (!response.ok) {
        let errText = `请求失败(${response.status})`;
        try {
            const errData = await response.json();
            const msg = errData && (errData.error?.message || errData.message);
            if (msg) errText = msg;
        } catch (e) {}
        throw new Error(errText);
    }
    
    const data = await response.json();
    const reply = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof reply !== 'string' || !reply.trim()) throw new Error('AI返回内容为空');
    
    aiChatHistory = [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: reply }
    ].slice(-12);
    
    return reply;
}

async function sendAIMessage() {
    const input = document.getElementById('aiChatInput');
    const message = input.value.trim();
    
    if (!message) return;
    
    const messagesContainer = document.getElementById('aiChatMessages');
    
    // 添加用户消息
    addUserMessage(message);
    input.value = '';
    
    // 滚动到底部
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    
    try {
        const reply = await sendAIChatMessage(message);
        addAIMessage(reply || '抱歉，我暂时无法回答你的问题，请稍后再试。');
    } catch (error) {
        console.error('AI聊天失败:', error);
        addAIMessage('抱歉，网络错误，请稍后再试。');
    }
    
    // 滚动到底部
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function addUserMessage(message) {
    const messagesContainer = document.getElementById('aiChatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'user-message';
    messageDiv.innerHTML = `
        <div class="user-message-avatar">👤</div>
        <div class="user-message-content">${escapeHtml(message)}</div>
    `;
    messagesContainer.appendChild(messageDiv);
}

function addAIMessage(message) {
    const messagesContainer = document.getElementById('aiChatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'ai-message';
    messageDiv.innerHTML = `
        <div class="ai-message-avatar">🤖</div>
        <div class="ai-message-content">${formatAIMessage(message)}</div>
    `;
    messagesContainer.appendChild(messageDiv);
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatAIMessage(message) {
    return message
        .replace(/\n/g, '<br>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>');
}

function formatMarkdownSafe(message) {
    const escaped = escapeHtml(message || '');
    return escaped
        .replace(/\n/g, '<br>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.*?)\*/g, '<em>$1</em>');
}

// 交易日记标签页切换
function switchDiaryTab(tab) {
    const tabs = document.querySelectorAll('.diary-tab');
    const diaryContent = document.getElementById('diaryTabContent');
    const strategyContent = document.getElementById('strategyTabContent');
    
    tabs.forEach(t => t.classList.remove('active'));
    
    if (tab === 'diary') {
        tabs[0].classList.add('active');
        diaryContent.classList.remove('hidden');
        strategyContent.classList.add('hidden');
    } else {
        tabs[1].classList.add('active');
        diaryContent.classList.add('hidden');
        strategyContent.classList.remove('hidden');
        loadStrategies();
    }
}

// 策略标签选择
let selectedStrategyTags = [];

document.addEventListener('DOMContentLoaded', function() {
    const strategyTags = document.querySelectorAll('.strategy-tag');
    strategyTags.forEach(tag => {
        tag.addEventListener('click', function() {
            this.classList.toggle('selected');
            const tagText = this.dataset.tag;
            if (this.classList.contains('selected')) {
                selectedStrategyTags.push(tagText);
            } else {
                selectedStrategyTags = selectedStrategyTags.filter(t => t !== tagText);
            }
        });
    });
    
    const moodTags = document.querySelectorAll('.mood-tag');
    moodTags.forEach(tag => {
        tag.addEventListener('click', function() {
            moodTags.forEach(t => t.classList.remove('selected'));
            this.classList.add('selected');
        });
    });
});

// 保存投资策略
async function saveStrategy() {
    const title = document.getElementById('strategyTitle').value.trim();
    const content = document.getElementById('strategyContent').value.trim();
    
    if (!title || !content) {
        alert('请填写策略标题和内容');
        return;
    }
    
    try {
        const response = await fetch('/api/strategy', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                title: title,
                content: content,
                tags: selectedStrategyTags
            })
        });
        
        const result = await response.json();
        
        if (result.success) {
            alert('策略保存成功！');
            document.getElementById('strategyTitle').value = '';
            document.getElementById('strategyContent').value = '';
            selectedStrategyTags = [];
            document.querySelectorAll('.strategy-tag').forEach(t => t.classList.remove('selected'));
            loadStrategies();
        } else {
            alert('保存失败：' + (result.error || '未知错误'));
        }
    } catch (error) {
        console.error('保存策略失败:', error);
        alert('保存失败，请稍后再试');
    }
}

// 加载投资策略列表
async function loadStrategies() {
    try {
        const response = await fetch('/api/strategy');
        const result = await response.json();
        
        if (result.success) {
            renderStrategies(result.data);
        }
    } catch (error) {
        console.error('加载策略失败:', error);
    }
}

// 渲染策略列表
function renderStrategies(strategies) {
    const container = document.getElementById('strategyList');
    
    if (!strategies || strategies.length === 0) {
        container.innerHTML = '<p style="color: #8892b0; text-align: center; padding: 40px;">暂无策略，快去添加你的第一个投资策略吧！</p>';
        return;
    }
    
    container.innerHTML = strategies.map(strategy => `
        <div class="strategy-card">
            <div class="strategy-card-header">
                <div class="strategy-card-title">${escapeHtml(strategy.title)}</div>
                <button class="strategy-card-delete" onclick="deleteStrategy(${strategy.id})">删除</button>
            </div>
            ${strategy.tags && strategy.tags.length > 0 ? `
                <div class="strategy-card-tags">
                    ${strategy.tags.map(tag => `<span class="strategy-card-tag">${escapeHtml(tag)}</span>`).join('')}
                </div>
            ` : ''}
            <div class="strategy-card-content">${escapeHtml(strategy.content).replace(/\n/g, '<br>')}</div>
            <div class="strategy-card-date">创建于: ${new Date(strategy.created_at).toLocaleString('zh-CN')}</div>
        </div>
    `).join('');
}

// 删除策略
async function deleteStrategy(strategyId) {
    if (!confirm('确定要删除这个策略吗？')) {
        return;
    }
    
    try {
        const response = await fetch(`/api/strategy/${strategyId}`, {
            method: 'DELETE'
        });
        
        const result = await response.json();
        
        if (result.success) {
            loadStrategies();
        } else {
            alert('删除失败：' + (result.error || '未知错误'));
        }
    } catch (error) {
        console.error('删除策略失败:', error);
        alert('删除失败，请稍后再试');
    }
}

// 清空所有记忆
async function clearAllMemory() {
    if (!confirm('确定要清空所有聊天记录和投资策略吗？此操作不可恢复！')) {
        return;
    }
    
    try {
        const response = await fetch('/api/memory/clear', {
            method: 'POST'
        });
        
        const result = await response.json();
        
        if (result.success) {
            alert('记忆已清空！');
            aiChatHistory = [];
            loadStrategies();
        } else {
            alert('清空失败：' + (result.error || '未知错误'));
        }
    } catch (error) {
        console.error('清空记忆失败:', error);
        alert('清空失败，请稍后再试');
    }
}

// 页面加载时初始化
document.addEventListener('DOMContentLoaded', function() {
    const today = new Date().toISOString().split('T')[0];
    const diaryDate = document.getElementById('diaryDate');
    if (diaryDate) {
        diaryDate.value = today;
    }
});

function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    if (!sidebar) return;
    const nextCollapsed = !sidebar.classList.contains('collapsed');
    sidebar.classList.toggle('collapsed', nextCollapsed);
    persistAppSettings({
        ...appSettings,
        sidebar: {
            ...appSettings.sidebar,
            collapsed: nextCollapsed
        }
    });
}

function toggleSidebarGroup(groupKey) {
    const submenu = document.querySelector(`[data-submenu="${groupKey}"]`);
    const caret = document.querySelector(`[data-caret="${groupKey}"]`);
    if (!submenu) return;
    const nextCollapsed = !submenu.classList.contains('collapsed');
    submenu.classList.toggle('collapsed', nextCollapsed);
    if (caret) caret.textContent = nextCollapsed ? '▸' : '▾';
    persistAppSettings({
        ...appSettings,
        sidebar: {
            ...appSettings.sidebar,
            groups: {
                ...appSettings.sidebar.groups,
                [groupKey]: nextCollapsed
            }
        }
    });
}

function hideAllAppViews() {
    const ids = [
        'overviewSection',
        'watchlistSection',
        'backtestSection',
        'settingsSection',
        'aiReportSection',
        'analysisSection',
        'newsSection',
        'stockPickerSection',
        'diarySection',
        'myPortfolioSection',
        'portfolioSection'
    ];
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.add('hidden');
    });
}

function setActiveSidebarItem(view) {
    const items = document.querySelectorAll('.sidebar-item[data-view]');
    items.forEach(item => item.classList.remove('active'));
    const active = document.querySelector(`.sidebar-item[data-view="${view}"]`);
    if (active) active.classList.add('active');
}

function expandGroupForView(view) {
    const map = {
        analysis: 'stockAnalysis',
        news: 'stockAnalysis',
        watchlist: 'stockAnalysis',
        backtest: 'trading',
        portfolio: 'trading',
        myPortfolio: 'trading',
        diary: 'trading',
        aiReport: 'ai',
        stockPicker: 'ai'
    };
    const groupKey = map[view];
    if (!groupKey) return;
    const submenu = document.querySelector(`[data-submenu="${groupKey}"]`);
    const caret = document.querySelector(`[data-caret="${groupKey}"]`);
    if (!submenu) return;
    submenu.classList.remove('collapsed');
    if (caret) caret.textContent = '▾';
    if (appSettings.sidebar && appSettings.sidebar.groups && appSettings.sidebar.groups[groupKey]) {
        persistAppSettings({
            ...appSettings,
            sidebar: {
                ...appSettings.sidebar,
                groups: {
                    ...appSettings.sidebar.groups,
                    [groupKey]: false
                }
            }
        });
    }
}

function appNavigate(view) {
    hideAllAppViews();
    expandGroupForView(view);
    setActiveSidebarItem(view);
    persistAppSettings({ ...appSettings, lastView: view });
    
    if (view === 'overview') {
        const el = document.getElementById('overviewSection');
        if (el) el.classList.remove('hidden');
        return;
    }
    
    if (view === 'watchlist') {
        const el = document.getElementById('watchlistSection');
        if (el) el.classList.remove('hidden');
        return;
    }
    
    if (view === 'backtest') {
        const el = document.getElementById('backtestSection');
        if (el) el.classList.remove('hidden');
        return;
    }
    
    if (view === 'settings') {
        const el = document.getElementById('settingsSection');
        if (el) el.classList.remove('hidden');
        populateSettingsUI();
        return;
    }

    if (view === 'aiReport') {
        const el = document.getElementById('aiReportSection');
        if (el) el.classList.remove('hidden');
        const dateInput = document.getElementById('taDate');
        if (dateInput && !dateInput.value) {
            const d = new Date();
            d.setDate(d.getDate() - 1);
            dateInput.value = d.toISOString().split('T')[0];
        }
        const hint = document.getElementById('taHint');
        if (hint) {
            const hasKey = appSettings.tradingagents && (appSettings.tradingagents.openaiApiKey || '').trim();
            hint.textContent = hasKey ? '' : '提示：先到“设置 → TradingAgents”填写 OpenAI API Key，然后再生成报告。';
        }
        return;
    }
    
    if (view === 'finance') {
        switchTab('finance');
        return;
    }
    
    if (typeof switchTab === 'function') {
        switchTab(view);
    }
}

async function diagnoseTradingAgents() {
    const hint = document.getElementById('taHint');
    if (hint) hint.textContent = '诊断中...';
    try {
        const resp = await apiFetch('/api/ai/tradingagents/health');
        const result = await resp.json();
        if (!resp.ok) throw new Error((result && result.error) || `请求失败(${resp.status})`);
        const data = result && result.data ? result.data : {};
        const localKey = appSettings.tradingagents && (appSettings.tradingagents.openaiApiKey || '').trim();
        const lines = [];
        lines.push(`服务端 Python: ${data.server_python || '--'}`);
        lines.push(`服务端已配置 OPENAI_API_KEY: ${data.has_openai_api_key_env ? '是' : '否'}`);
        if (data.openai_key_fingerprint_env) lines.push(`服务端 Key 指纹: ${data.openai_key_fingerprint_env}`);
        if (data.openai_key_fingerprint_dotenv) lines.push(`.env Key 指纹: ${data.openai_key_fingerprint_dotenv}`);
        if (data.openai_key_fingerprint_env && data.openai_key_fingerprint_dotenv) {
            lines.push(`.env 与服务端一致: ${data.dotenv_matches_env ? '是' : '否'}`);
        }
        lines.push(`浏览器已保存 TradingAgents Key: ${localKey ? '是' : '否'}`);
        lines.push(`TradingAgents venv: ${data.tradingagents_venv_python_exists ? 'OK' : '缺失'}`);
        lines.push(`Runner 脚本: ${data.tradingagents_runner_exists ? 'OK' : '缺失'}`);
        if (!localKey && !data.has_openai_api_key_env) {
            lines.push('下一步：到“设置 → TradingAgents”填写 OpenAI API Key 并保存，然后回到此页生成报告。');
        } else {
            lines.push('下一步：回到此页点击“生成报告”，如果报错会显示具体原因。');
        }
        if (hint) hint.innerHTML = formatMarkdownSafe(lines.map(s => `- ${s}`).join('\n'));
    } catch (e) {
        if (hint) hint.textContent = `诊断失败：${e && e.message ? e.message : '未知错误'}`;
    }
}

function populateSettingsUI() {
    const apiBaseUrlInput = document.getElementById('settingApiBaseUrl');
    if (apiBaseUrlInput) apiBaseUrlInput.value = appSettings.apiBaseUrl || '';
    
    const providerSelect = document.getElementById('settingAiProvider');
    if (providerSelect) providerSelect.value = (appSettings.ai && appSettings.ai.provider) || 'backend';
    
    const aiApiKey = document.getElementById('settingAiApiKey');
    if (aiApiKey) aiApiKey.value = (appSettings.ai && appSettings.ai.apiKey) || '';
    
    const aiBaseUrl = document.getElementById('settingAiBaseUrl');
    if (aiBaseUrl) aiBaseUrl.value = (appSettings.ai && appSettings.ai.baseUrl) || '';
    
    const aiModel = document.getElementById('settingAiModel');
    if (aiModel) aiModel.value = (appSettings.ai && appSettings.ai.model) || '';
    
    const aiMaxTokens = document.getElementById('settingAiMaxTokens');
    if (aiMaxTokens) aiMaxTokens.value = (appSettings.ai && appSettings.ai.maxTokens) || 1024;
    
    const hint = document.getElementById('aiTestHint');
    if (hint) hint.textContent = '';

    const taKey = document.getElementById('settingTaOpenAiApiKey');
    if (taKey) taKey.value = (appSettings.tradingagents && appSettings.tradingagents.openaiApiKey) || '';

    const taBase = document.getElementById('settingTaOpenAiBaseUrl');
    if (taBase) taBase.value = (appSettings.tradingagents && appSettings.tradingagents.openaiBaseUrl) || '';

    const taDeep = document.getElementById('settingTaDeepModel');
    if (taDeep) taDeep.value = (appSettings.tradingagents && appSettings.tradingagents.deepModel) || '';

    const taQuick = document.getElementById('settingTaQuickModel');
    if (taQuick) taQuick.value = (appSettings.tradingagents && appSettings.tradingagents.quickModel) || '';

    const taDebate = document.getElementById('settingTaDebateRounds');
    if (taDebate) taDebate.value = (appSettings.tradingagents && appSettings.tradingagents.maxDebateRounds) || 1;

    const taRisk = document.getElementById('settingTaRiskRounds');
    if (taRisk) taRisk.value = (appSettings.tradingagents && appSettings.tradingagents.maxRiskDiscussRounds) || 1;
}

function saveAppSettingsFromUI() {
    const apiBaseUrlInput = document.getElementById('settingApiBaseUrl');
    const providerSelect = document.getElementById('settingAiProvider');
    const aiApiKey = document.getElementById('settingAiApiKey');
    const aiBaseUrl = document.getElementById('settingAiBaseUrl');
    const aiModel = document.getElementById('settingAiModel');
    const aiMaxTokens = document.getElementById('settingAiMaxTokens');
    const taKey = document.getElementById('settingTaOpenAiApiKey');
    const taBase = document.getElementById('settingTaOpenAiBaseUrl');
    const taDeep = document.getElementById('settingTaDeepModel');
    const taQuick = document.getElementById('settingTaQuickModel');
    const taDebate = document.getElementById('settingTaDebateRounds');
    const taRisk = document.getElementById('settingTaRiskRounds');
    
    const next = {
        ...appSettings,
        apiBaseUrl: apiBaseUrlInput ? apiBaseUrlInput.value.trim() : appSettings.apiBaseUrl,
        ai: {
            ...appSettings.ai,
            provider: providerSelect ? providerSelect.value : appSettings.ai.provider,
            apiKey: aiApiKey ? aiApiKey.value : appSettings.ai.apiKey,
            baseUrl: aiBaseUrl ? aiBaseUrl.value.trim() : appSettings.ai.baseUrl,
            model: aiModel ? aiModel.value.trim() : appSettings.ai.model,
            maxTokens: aiMaxTokens ? Number(aiMaxTokens.value) || 1024 : appSettings.ai.maxTokens
        },
        tradingagents: {
            ...appSettings.tradingagents,
            openaiApiKey: taKey ? taKey.value : appSettings.tradingagents.openaiApiKey,
            openaiBaseUrl: taBase ? taBase.value.trim() : appSettings.tradingagents.openaiBaseUrl,
            deepModel: taDeep ? taDeep.value.trim() : appSettings.tradingagents.deepModel,
            quickModel: taQuick ? taQuick.value.trim() : appSettings.tradingagents.quickModel,
            maxDebateRounds: taDebate ? Number(taDebate.value) || 1 : appSettings.tradingagents.maxDebateRounds,
            maxRiskDiscussRounds: taRisk ? Number(taRisk.value) || 1 : appSettings.tradingagents.maxRiskDiscussRounds
        }
    };
    
    persistAppSettings(next);
    populateSettingsUI();
    alert('设置已保存');
}

function resetAppSettings() {
    persistAppSettings(getDefaultAppSettings());
    const sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.remove('collapsed');
    ['stockAnalysis', 'trading', 'ai'].forEach(groupKey => {
        const submenu = document.querySelector(`[data-submenu="${groupKey}"]`);
        const caret = document.querySelector(`[data-caret="${groupKey}"]`);
        if (submenu) submenu.classList.remove('collapsed');
        if (caret) caret.textContent = '▾';
    });
    populateSettingsUI();
    alert('已恢复默认设置');
}

async function testAiChatConfig() {
    const hint = document.getElementById('aiTestHint');
    if (hint) hint.textContent = '测试中...';
    
    const providerSelect = document.getElementById('settingAiProvider');
    const aiApiKey = document.getElementById('settingAiApiKey');
    const aiBaseUrl = document.getElementById('settingAiBaseUrl');
    const aiModel = document.getElementById('settingAiModel');
    const aiMaxTokens = document.getElementById('settingAiMaxTokens');
    
    const tempSettings = {
        ...appSettings,
        ai: {
            ...appSettings.ai,
            provider: providerSelect ? providerSelect.value : appSettings.ai.provider,
            apiKey: aiApiKey ? aiApiKey.value : appSettings.ai.apiKey,
            baseUrl: aiBaseUrl ? aiBaseUrl.value.trim() : appSettings.ai.baseUrl,
            model: aiModel ? aiModel.value.trim() : appSettings.ai.model,
            maxTokens: aiMaxTokens ? Number(aiMaxTokens.value) || 256 : (appSettings.ai.maxTokens || 256)
        }
    };
    
    const prev = appSettings;
    try {
        appSettings = tempSettings;
        const reply = await sendAIChatMessage('你好，请用一句话说明你是谁。');
        if (hint) hint.textContent = `测试成功：${reply.slice(0, 80)}`;
    } catch (e) {
        if (hint) hint.textContent = `测试失败：${e && e.message ? e.message : '未知错误'}`;
    } finally {
        appSettings = prev;
    }
}

async function generateTradingAgentsReport() {
    const symbolInput = document.getElementById('taSymbol');
    const dateInput = document.getElementById('taDate');
    const languageSelect = document.getElementById('taLanguage');
    const modeSelect = document.getElementById('taMode');
    const hint = document.getElementById('taHint');
    const meta = document.getElementById('taMeta');
    const content = document.getElementById('taReportContent');
    
    const symbol = symbolInput ? symbolInput.value.trim().toUpperCase() : '';
    const date = dateInput ? dateInput.value : '';
    const language = languageSelect ? languageSelect.value : 'Chinese';
    const mode = modeSelect ? modeSelect.value : 'fast';
    const ta = appSettings.tradingagents || {};
    const openaiApiKey = (ta.openaiApiKey || '').trim();
    const openaiBaseUrl = (ta.openaiBaseUrl || '').trim();
    const deepModel = (ta.deepModel || '').trim();
    const quickModel = (ta.quickModel || '').trim();
    const maxDebateRounds = ta.maxDebateRounds;
    const maxRiskDiscussRounds = ta.maxRiskDiscussRounds;
    
    if (!symbol) {
        alert('请输入股票代码');
        return;
    }

    const shouldSendKey = !!openaiApiKey;
    
    if (hint) hint.textContent = '生成中...';
    if (meta) meta.textContent = '';
    if (content) content.textContent = '正在生成报告，请稍候...';
    
    try {
        const response = await apiFetch('/api/ai/tradingagents/report', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                symbol,
                date,
                language,
                mode,
                openai_api_key: shouldSendKey ? openaiApiKey : '',
                openai_base_url: openaiBaseUrl,
                deep_model: deepModel,
                quick_model: quickModel,
                max_debate_rounds: maxDebateRounds,
                max_risk_discuss_rounds: maxRiskDiscussRounds
            })
        });
        
        const result = await response.json();
        
        if (!response.ok) {
            throw new Error((result && result.error) || `请求失败(${response.status})`);
        }
        
        if (!result.success || !result.data) {
            throw new Error((result && result.error) || '返回数据不完整');
        }
        
        const payload = result.data;
        const md = payload.report_markdown || '';
        const decision = payload.decision ? `\n\n### 信号摘要\n${payload.decision}` : '';
        if (meta) meta.textContent = `${payload.symbol || symbol} · ${payload.trade_date || date || ''} · 数据源: ${payload.data_vendor || '--'}`;
        if (content) content.innerHTML = formatMarkdownSafe(`${md}${decision}`.trim() || '暂无报告内容');
        if (hint) hint.textContent = '生成完成';
    } catch (e) {
        if (hint) hint.textContent = `生成失败：${e && e.message ? e.message : '未知错误'}`;
        if (content) content.textContent = '生成失败，请检查后端配置与网络情况。';
    }
}

document.addEventListener('DOMContentLoaded', function() {
    const sidebar = document.getElementById('sidebar');
    if (sidebar && appSettings.sidebar && appSettings.sidebar.collapsed) {
        sidebar.classList.add('collapsed');
    }
    
    ['stockAnalysis', 'trading', 'ai'].forEach(groupKey => {
        const submenu = document.querySelector(`[data-submenu="${groupKey}"]`);
        const caret = document.querySelector(`[data-caret="${groupKey}"]`);
        const isCollapsed = appSettings.sidebar && appSettings.sidebar.groups && appSettings.sidebar.groups[groupKey];
        if (submenu) submenu.classList.toggle('collapsed', !!isCollapsed);
        if (caret) caret.textContent = isCollapsed ? '▸' : '▾';
    });
    
    const initialView = (appSettings && appSettings.lastView) ? appSettings.lastView : 'analysis';
    appNavigate(initialView);
});

// 切换K线周期
async function switchKlinePeriod(period) {
    currentKlinePeriod = period;
    
    // 更新按钮状态
    document.querySelectorAll('.period-btn').forEach(btn => {
        btn.classList.remove('active');
    });
    const btn = document.querySelector(`[data-period="${period}"]`);
    if (btn) btn.classList.add('active');
    
    // 重新加载数据 - 无论A股还是美股都重新调用
    const stockCode = document.getElementById('stockCode').value.trim().toUpperCase();
    const stockType = document.getElementById('stockType').value;
    
    if (stockCode) {
        await analyzeStock();
    }
}

// ==================== 财务报表模块 ====================

let currentFinancePeriod = 'annual';
let currentFinanceStatement = 'income';
let currentFinanceSymbol = '';
let currentFinanceName = '';
let financeSortCol = null;   // column key to sort by
let financeSortAsc = true;   // true = asc, false = desc
let financeRawData = [];      // keep raw rows for sorting

const FINANCE_LABELS = {
    // Income Statement
    operating_revenue: '营业总收入',
    total_revenue: '总收入',
    cost_of_revenue: '营业成本',
    gross_profit: '毛利润',
    selling_general_and_admin_expense: '管理费用（SGA）',
    research_and_development_expense: '研发费用（R&D）',
    operating_expense: '营业费用',
    operating_income: '营业利润',
    ebitda: 'EBITDA',
    total_pre_tax_income: '税前利润',
    tax_provision: '所得税',
    net_income: '净利润',
    basic_earnings_per_share: '基本每股收益',
    diluted_earnings_per_share: '稀释每股收益',
    // Balance Sheet
    cash_and_cash_equivalents: '现金及现金等价物',
    short_term_investments: '短期投资',
    net_receivables: '应收账款净额',
    inventories: '存货',
    total_current_assets: '流动资产合计',
    plant_property_equipment_net: '固定资产净值',
    total_non_current_assets: '非流动资产合计',
    total_assets: '资产总计',
    accounts_payable: '应付账款',
    current_debt: '短期债务',
    current_deferred_revenue: '递延收入（流动）',
    total_current_liabilities: '流动负债合计',
    long_term_debt: '长期债务',
    total_non_current_liabilities: '非流动负债合计',
    total_liabilities_net_minority_interest: '负债合计',
    common_stock_equity: '普通股权益',
    retained_earnings: '留存收益',
    // Cash Flow
    net_income_from_continuing_operations: '净利润（经营）',
    depreciation_and_amortization: '折旧与摊销',
    stock_based_compensation: '股票补偿（SBC）',
    change_in_working_capital: '营运资本变动',
    cash_flow_from_continuing_operating_activities: '经营活动现金流',
    investments_in_property_plant_and_equipment: '资本支出（PP&E）',
    net_investment_purchase_and_sale: '投资活动现金流净额',
    cash_flow_from_continuing_investing_activities: '投资活动现金流',
    net_issuance_payments_of_debt: '债务净变动',
    repurchase_of_common_equity: '股票回购',
    cash_dividends_paid: '支付股利',
    cash_flow_from_continuing_financing_activities: '筹资活动现金流',
    net_change_in_cash_and_equivalents: '现金及等价物净增加',
    beginning_cash_position: '期初现金',
    end_cash_position: '期末现金',
    free_cash_flow: '自由现金流',
};

function _fmtNum(v) {
    if (v === null || v === undefined || v === '') return '-';
    const n = parseFloat(v);
    if (isNaN(n)) return '-';
    if (Math.abs(n) >= 1e12) return (n / 1e12).toFixed(2) + 'T';
    if (Math.abs(n) >= 1e9)  return (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6)  return (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3)  return n.toLocaleString('en-US', {maximumFractionDigits: 2});
    return n.toFixed(2);
}

function _fmtDate(v) {
    if (!v) return '-';
    try {
        const d = new Date(v);
        if (isNaN(d)) return '-';
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    } catch { return '-'; }
}

function _getColLabel(key) {
    return FINANCE_LABELS[key] || key.replace(/_/g, ' ');
}

async function loadFinanceData() {
    const emptyEl = document.getElementById('financeEmpty');
    const loadingEl = document.getElementById('financeLoading');
    const wrapperEl = document.getElementById('financeTableWrapper');
    if (!currentFinanceSymbol) {
        if (emptyEl) { emptyEl.classList.remove('hidden'); emptyEl.querySelector('p').textContent = '\u2709 \u5728\u4e0a\u65b9\u641c\u7d22\u80a1\u7968\u540e\uff0c\u5373\u53ef\u67e5\u770b\u8d22\u52a1\u62a5\u8868'; }
        if (loadingEl) loadingEl.classList.add('hidden');
        if (wrapperEl) wrapperEl.classList.add('hidden');
        return;
    }
    if (emptyEl) emptyEl.classList.add('hidden');
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (wrapperEl) wrapperEl.classList.add('hidden');

    const stmtMap = { income: 'income', balance: 'balance', cash: 'cash' };
    const endpoint = `/api/stock/financial/${stmtMap[currentFinanceStatement]}`;
    try {
        const resp = await apiFetch(`${endpoint}?code=${encodeURIComponent(currentFinanceSymbol)}&period=${currentFinancePeriod}`);
        const json = await resp.json();
        if (json.success && json.data && json.data.length > 0) {
            financeRawData = json.data;
            // reset sort on new data load
            financeSortCol = null;
            financeSortAsc = true;
            renderFinanceTable(json.data);
            if (loadingEl) loadingEl.classList.add('hidden');
            if (wrapperEl) wrapperEl.classList.remove('hidden');
        } else {
            financeRawData = [];
            if (loadingEl) loadingEl.classList.add('hidden');
            if (emptyEl) { emptyEl.classList.remove('hidden'); emptyEl.querySelector('p').textContent = '\u6682\u65e0\u8be5\u80a1\u7968\u7684\u8d22\u52a1\u6570\u636e'; }
        }
    } catch (e) {
        console.error('Finance load error:', e);
        financeRawData = [];
        if (loadingEl) loadingEl.classList.add('hidden');
        if (emptyEl) { emptyEl.classList.remove('hidden'); emptyEl.querySelector('p').textContent = '\u52a0\u8f7d\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5'; }
    }
}

function renderFinanceTable(rows) {
    const thead = document.getElementById('financeTableHead');
    const tbody = document.getElementById('financeTableBody');
    if (!thead || !tbody || !rows.length) return;

    const periods = rows.map(r => _fmtDate(r.period_ending));
    const fields = Object.keys(rows[0]).filter(k => k !== 'period_ending' && k !== 'fiscal_period' && rows[0][k] !== null && rows[0][k] !== undefined);

    // Build sortable header
    thead.innerHTML = '<tr><th class="finance-th-index">\u6307\u6807</th>' +
        periods.map((p, i) => {
            // find field index (column) — periods[i] corresponds to rows[i]
            return `<th class="finance-th finance-th-sortable" data-col="${i}" onclick="sortFinanceCol(${i})">
                <span class="finance-th-text">${p}</span>
                <span class="finance-sort-icon" id="sort-icon-${i}"></span>
            </th>`;
        }).join('') + '</tr>';

    // Apply current sort
    let sortedRows = rows.slice();
    if (financeSortCol !== null) {
        sortedRows.sort((a, b) => {
            const va = Object.values(a)[financeSortCol + 2]; // +2: skip period_ending, fiscal_period
            const vb = Object.values(b)[financeSortCol + 2];
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            const na = parseFloat(va), nb = parseFloat(vb);
            if (!isNaN(na) && !isNaN(nb)) return financeSortAsc ? na - nb : nb - na;
            return financeSortAsc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
        });
        // Update sort icons
        fields.forEach((_, i) => {
            const icon = document.getElementById(`sort-icon-${i}`);
            if (!icon) return;
            if (i === financeSortCol) {
                icon.textContent = financeSortAsc ? ' \u25b2' : ' \u25bc'; // ▲ or ▼
                icon.style.color = '#00d4ff';
            } else {
                icon.textContent = '';
            }
        });
    }

    // Find field keys in same order as values() iteration
    const fieldKeys = Object.keys(rows[0]).filter(k => k !== 'period_ending' && k !== 'fiscal_period');

    tbody.innerHTML = '';
    fields.forEach(key => {
        const fi = fieldKeys.indexOf(key);
        const label = _getColLabel(key);
        const tr = document.createElement('tr');
        tr.innerHTML = `<td class="finance-td-index">${label}</td>` +
            sortedRows.map(row => {
                const val = row[key];
                const num = parseFloat(val);
                const cls = !isNaN(num) ? (num < 0 ? ' finance-td-negative' : num > 0 ? ' finance-td-positive' : '') : '';
                return `<td class="finance-td${cls}">${_fmtNum(val)}</td>`;
            }).join('');
        tbody.appendChild(tr);
    });
}

function sortFinanceCol(colIdx) {
    if (financeSortCol === colIdx) {
        financeSortAsc = !financeSortAsc;
    } else {
        financeSortCol = colIdx;
        financeSortAsc = true;
    }
    if (financeRawData.length) renderFinanceTable(financeRawData);
}

function switchFinancePeriod(period) {
    currentFinancePeriod = period;
    document.querySelectorAll('.finance-period-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.period === period);
    });
    loadFinanceData();
}

function switchFinanceStatement(stmt) {
    currentFinanceStatement = stmt;
    document.querySelectorAll('.finance-stmt-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.stmt === stmt);
    });
    loadFinanceData();
}

function exportFinanceTable() {
    const table = document.getElementById('financeTable');
    if (!table) return;
    const rows = Array.from(table.querySelectorAll('tr'));
    const csv = rows.map(row =>
        Array.from(row.querySelectorAll('th, td'))
            .map(cell => `"${cell.textContent.replace(/"/g, '""')}"`)
            .join(',')
    ).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentFinanceSymbol}_${currentFinanceStatement}_${currentFinancePeriod}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

function toggleFinanceFullscreen(btn) {
    const wrapper = document.getElementById('financeTableWrapper');
    if (!wrapper) return;
    const isFullscreen = wrapper.classList.toggle('finance-fullscreen');
    if (btn) {
        btn.textContent = isFullscreen ? '\u2212' : '\u2b1a'; // − or ⬚
        btn.style.color = isFullscreen ? '#00ff88' : '';
    }
    document.getElementById('financeTableWrapper').dataset.fullscreen = isFullscreen;
}

// ESC key exits finance fullscreen
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        const wrapper = document.getElementById('financeTableWrapper');
        if (wrapper && wrapper.dataset.fullscreen === 'true') {
            wrapper.classList.remove('finance-fullscreen');
            wrapper.dataset.fullscreen = 'false';
            const btn = document.querySelector('[data-fullscreen-btn]');
            if (btn) { btn.textContent = '\u2b1a'; btn.style.color = ''; }
        }
    }
});

// Sync finance tab when analyzeStock completes
const _origAnalyzeStock = window.analyzeStock;
window.analyzeStock = async function() {
    if (_origAnalyzeStock) await _origAnalyzeStock.apply(this, arguments);
    const codeInput = document.getElementById('stockCode');
    const nameEl = document.getElementById('stockName');
    currentFinanceSymbol = codeInput ? codeInput.value.trim().toUpperCase() : '';
    currentFinanceName = nameEl ? nameEl.textContent : '';
    const fNameEl = document.getElementById('financeStockName');
    const fCodeEl = document.getElementById('financeStockCode');
    if (fNameEl) fNameEl.textContent = currentFinanceName || currentFinanceSymbol;
    if (fCodeEl) fCodeEl.textContent = currentFinanceSymbol;
    const financeSection = document.getElementById('financeSection');
    if (financeSection && !financeSection.classList.contains('hidden')) {
        loadFinanceData();
    }
};
