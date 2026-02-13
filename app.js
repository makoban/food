// ========================================
// AI飲食店エリア分析 v1.0 — 飲食業特化版
// Cloudflare Workers Proxy経由でGemini API + e-Stat API
// ========================================

// Cloudflare Worker Proxy (APIキー秘匿)
var WORKER_BASE = 'https://house-search-proxy.ai-fudosan.workers.dev';
var CORS_PROXIES = [
  { name: 'corsproxy.io', build: function(u) { return 'https://corsproxy.io/?' + encodeURIComponent(u); } },
  { name: 'allorigins', build: function(u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); } },
  { name: 'codetabs', build: function(u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); } }
];
var _crawledAddresses = [];
var _crawlDebugInfo = { pages: [], scoredLinks: [], addresses: [] };
var _activeProxy = '';

// ---- 飲食業専用設定（industry-config統合） ----
var RESTAURANT_CONFIG = {
  name: '飲食店・フード',
  icon: '🍽️',
  color: '#ef4444',
  estatDataSets: [
    { id: '0003348239', name: '家計調査（外食）', key: 'household_dining' }
  ],
  kpis: ['外食支出額', '飲食店密度', '人口あたり店舗数', '世帯消費傾向'],
  marketJsonTemplate: {
    dining_market:    { monthly_dining_spend: 0, annual_dining_spend: 0, food_spend_ratio: 0, source: '推計' },
    competition:      { restaurant_count: 0, per_10k_population: 0, chain_ratio_pct: 0 },
    consumer_profile: { avg_household_income: 0, single_household_pct: 0, office_worker_density: 0 },
    potential:        { target_population: 0, daily_foot_traffic: 0, lunch_demand: 0, dinner_demand: 0, ai_insight: '' }
  }
};

// ---- Prefecture Codes ----
var PREFECTURE_CODES = {
  '北海道':'01','青森県':'02','岩手県':'03','宮城県':'04','秋田県':'05',
  '山形県':'06','福島県':'07','茨城県':'08','栃木県':'09','群馬県':'10',
  '埼玉県':'11','千葉県':'12','東京都':'13','神奈川県':'14','新潟県':'15',
  '富山県':'16','石川県':'17','福井県':'18','山梨県':'19','長野県':'20',
  '岐阜県':'21','静岡県':'22','愛知県':'23','三重県':'24','滋賀県':'25',
  '京都府':'26','大阪府':'27','兵庫県':'28','奈良県':'29','和歌山県':'30',
  '鳥取県':'31','島根県':'32','岡山県':'33','広島県':'34','山口県':'35',
  '徳島県':'36','香川県':'37','愛媛県':'38','高知県':'39','福岡県':'40',
  '佐賀県':'41','長崎県':'42','熊本県':'43','大分県':'44','宮崎県':'45',
  '鹿児島県':'46','沖縄県':'47'
};

// ---- State ----
var analysisData = null;

// ---- DOM References ----
var urlInput = document.getElementById('url-input');
var analyzeBtn = document.getElementById('analyze-btn');
var errorMsg = document.getElementById('error-msg');
var progressSection = document.getElementById('progress-section');
var resultsSection = document.getElementById('results-section');
var resultsContent = document.getElementById('results-content');
var progressLogContent = document.getElementById('progress-log-content');

// ---- Settings Modal ----
var settingsModal = document.getElementById('settings-modal');

// ---- Gemini API via Cloudflare Worker Proxy (with throttle + auto-retry) ----
var _lastGeminiCall = 0;
var _geminiMinInterval = 6000;

async function callGemini(prompt) {
  var now = Date.now();
  var elapsed = now - _lastGeminiCall;
  if (_lastGeminiCall > 0 && elapsed < _geminiMinInterval) {
    var waitMs = _geminiMinInterval - elapsed;
    addLog('  ⏳ API間隔調整 ' + Math.ceil(waitMs/1000) + '秒...', 'info');
    await new Promise(function(r) { setTimeout(r, waitMs); });
  }
  _lastGeminiCall = Date.now();

  var maxRetries = 5;
  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    var res = await fetch(WORKER_BASE + '/api/gemini', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: prompt })
    });

    if (res.status === 429 && attempt < maxRetries) {
      var waitSec = 10 * (attempt + 1);
      addLog('  API制限検知、' + waitSec + '秒後にリトライ... (' + (attempt + 1) + '/' + maxRetries + ')', 'info');
      await new Promise(function(r) { setTimeout(r, waitSec * 1000); });
      _lastGeminiCall = Date.now();
      continue;
    }

    var data = await res.json();
    if (!res.ok) {
      var errMessage = (data.error && typeof data.error === 'string') ? data.error : (data.error && data.error.message) || ('API Error: ' + res.status);
      throw new Error(errMessage);
    }

    return data.text || '';
  }
}

// ---- e-Stat API via Cloudflare Worker Proxy ----
async function fetchEstatPopulation(prefecture, city) {
  var prefCode = PREFECTURE_CODES[prefecture];
  if (!prefCode) return null;

  addLog('e-Stat APIから人口データを取得中...', 'info');

  try {
    var url = WORKER_BASE + '/api/estat/population' +
      '?statsDataId=0003448233' +
      '&cdArea=' + prefCode + '000' +
      '&limit=100';

    var res = await fetch(url);
    if (!res.ok) throw new Error('e-Stat API HTTP ' + res.status);
    var data = await res.json();

    var result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) {
      url = WORKER_BASE + '/api/estat/population' +
        '?statsDataId=0003448233' +
        '&cdArea=' + prefCode +
        '&limit=100';
      res = await fetch(url);
      data = await res.json();
      result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    }

    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) {
      addLog('e-Stat: 該当データがありません。AI推計に切り替えます。', 'info');
      return null;
    }

    var values = result.DATA_INF.VALUE;
    var population = null;
    var households = null;

    for (var i = 0; i < values.length; i++) {
      var v = values[i];
      var val = parseInt(v.$, 10);
      if (isNaN(val)) continue;
      if (v['@tab'] === '020' || (v['@cat01'] && v['@cat01'].indexOf('0010') >= 0)) {
        if (!population || val > 100) population = val;
      }
      if (v['@tab'] === '040' || (v['@cat01'] && v['@cat01'].indexOf('0020') >= 0)) {
        if (!households || val > 100) households = val;
      }
    }

    if (population) {
      addLog('e-Stat: 人口データ取得成功 (' + formatNumber(population) + '人)', 'success');
      return {
        total_population: population,
        households: households || Math.round(population / 2.3),
        source: 'e-Stat 国勢調査',
        from_estat: true
      };
    }

    return null;
  } catch (e) {
    console.warn('[e-Stat] Error:', e);
    addLog('e-Stat API接続エラー: ' + e.message + '。AI推計に切り替えます。', 'info');
    return null;
  }
}

// ---- e-Stat Generic Query via Cloudflare Worker Proxy ----
async function fetchEstatGeneric(statsDataId, cdArea, limit) {
  if (!statsDataId) return null;
  try {
    var url = WORKER_BASE + '/api/estat/query' +
      '?statsDataId=' + statsDataId +
      '&cdArea=' + (cdArea || '') +
      '&limit=' + (limit || '100');

    var res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    var data = await res.json();

    var result = data.GET_STATS_DATA && data.GET_STATS_DATA.STATISTICAL_DATA;
    if (!result || !result.DATA_INF || !result.DATA_INF.VALUE) return null;
    return result.DATA_INF.VALUE;
  } catch (e) {
    console.warn('[e-Stat Generic] Error:', e);
    return null;
  }
}

// 飲食業用e-Statデータを一括取得
async function fetchEstatForRestaurant(prefCode, cityCode) {
  var results = {};

  // 共通データ: 人口・世帯
  var pref = null;
  for (var p in PREFECTURE_CODES) {
    if (PREFECTURE_CODES[p] === prefCode) { pref = p; break; }
  }
  if (pref) {
    results.population = await fetchEstatPopulation(pref, cityCode || '');
  }

  // 飲食業専用: 家計調査（外食）
  var estatDataSets = RESTAURANT_CONFIG.estatDataSets;
  for (var i = 0; i < estatDataSets.length; i++) {
    var ds = estatDataSets[i];
    addLog('  e-Stat: ' + ds.name + ' を取得中...', 'info');
    var rawValues = await fetchEstatGeneric(ds.id, prefCode + '000');
    if (rawValues) {
      results[ds.key] = rawValues;
      addLog('  e-Stat: ' + ds.name + ' 取得成功 (' + rawValues.length + '件)', 'success');
    } else {
      addLog('  e-Stat: ' + ds.name + ' データなし', 'info');
    }
  }

  return results;
}

// ---- Fetch Page via CORS Proxy ----
var IMPORTANT_PATH_KEYWORDS = [
  'company', 'about', 'corporate', 'profile', 'access', 'overview',
  'summary', 'gaiyou', 'kaisya', 'info', 'office',
  '会社概要', '会社案内', '企業情報', '事業所', 'greeting',
  'menu', 'shop', 'store', 'location', 'branch',
  'メニュー', '店舗', '店舗一覧', '店舗情報', 'アクセス'
];

var _stickyProxyIdx = -1;

async function fetchSinglePage(url) {
  var order = [];
  if (_stickyProxyIdx >= 0) {
    order.push(_stickyProxyIdx);
    for (var i = 0; i < CORS_PROXIES.length; i++) {
      if (i !== _stickyProxyIdx) order.push(i);
    }
  } else {
    for (var i = 0; i < CORS_PROXIES.length; i++) order.push(i);
  }

  for (var oi = 0; oi < order.length; oi++) {
    var p = order[oi];
    var proxy = CORS_PROXIES[p];
    try {
      var proxyUrl = proxy.build(url);
      var timeout = (oi === 0 && _stickyProxyIdx >= 0) ? 15000 : 10000;
      var res = await fetch(proxyUrl, { signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var html = await res.text();
      if (html && html.length > 100) {
        _stickyProxyIdx = p;
        _activeProxy = proxy.name;
        return html;
      }
    } catch (e) {
      console.warn('[Fetch/' + proxy.name + '] Failed: ' + url + ' - ' + e.message);
      if (oi === 0 && _stickyProxyIdx >= 0) {
        addLog('  プロキシ ' + proxy.name + ' 失敗、代替を試行...', 'info');
        _stickyProxyIdx = -1;
      }
    }
  }
  console.warn('[Fetch] All proxies failed for: ' + url);
  return null;
}

function extractTextFromHtml(html) {
  var parser = new DOMParser();
  var doc = parser.parseFromString(html, 'text/html');
  doc.querySelectorAll('script, style, noscript, iframe, svg').forEach(function(el) { el.remove(); });
  var text = (doc.body && doc.body.textContent) || '';
  return text.replace(/[ \t]+/g, ' ').replace(/\n\s*\n/g, '\n').trim();
}

function extractLinks(html, baseUrl) {
  var links = [];
  var seen = {};
  var base;
  try { base = new URL(baseUrl); } catch(e) { return []; }

  var linkRegex = /<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  var m;

  while ((m = linkRegex.exec(html)) !== null) {
    try {
      var href = m[1];
      if (!href || href.charAt(0) === '#' || href.indexOf('mailto:') === 0 || href.indexOf('tel:') === 0) continue;
      var resolved = new URL(href, baseUrl);
      if (resolved.hostname !== base.hostname) continue;
      var path = resolved.pathname.toLowerCase();
      if (/\.(jpg|jpeg|png|gif|svg|pdf|zip|doc|mp4|mp3)$/i.test(path)) continue;
      var key = resolved.origin + resolved.pathname;
      if (seen[key]) continue;
      seen[key] = true;
      var linkText = m[2].replace(/<[^>]+>/g, '').trim();
      links.push({ url: key, path: path, text: linkText.slice(0, 50) });
    } catch(e) { /* ignore invalid URLs */ }
  }
  return links;
}

function scoreLink(link) {
  var score = 0;
  var path = link.path;
  var text = link.text;

  for (var i = 0; i < IMPORTANT_PATH_KEYWORDS.length; i++) {
    if (path.indexOf(IMPORTANT_PATH_KEYWORDS[i]) >= 0) score += 10;
    if (text.indexOf(IMPORTANT_PATH_KEYWORDS[i]) >= 0) score += 5;
  }

  // 日本語のリンクテキストでスコアリング
  if (text.indexOf('会社概要') >= 0 || text.indexOf('会社案内') >= 0) score += 20;
  if (text.indexOf('企業情報') >= 0 || text.indexOf('事業所') >= 0) score += 15;
  if (text.indexOf('アクセス') >= 0 || text.indexOf('所在地') >= 0) score += 15;
  if (text.indexOf('事業内容') >= 0 || text.indexOf('サービス') >= 0) score += 10;
  // 飲食業特化スコアリング
  if (text.indexOf('店舗') >= 0 || text.indexOf('店舗一覧') >= 0) score += 20;
  if (text.indexOf('メニュー') >= 0 || text.indexOf('料理') >= 0) score += 15;
  if (text.indexOf('ランチ') >= 0 || text.indexOf('ディナー') >= 0) score += 12;
  if (text.indexOf('テイクアウト') >= 0 || text.indexOf('デリバリー') >= 0) score += 10;
  if (text.indexOf('予約') >= 0 || text.indexOf('席') >= 0) score += 8;

  var depth = (path.match(/\//g) || []).length;
  if (depth > 4) score -= 3;

  return score;
}

async function crawlSite(url) {
  addLog('トップページを取得中...', 'info');
  var topHtml = await fetchSinglePage(url);
  if (!topHtml) {
    _crawlDebugInfo = { pages: [{ url: url, status: 'FAILED (timeout/error)', size: 0, text: 'トップページ' }], scoredLinks: [], addresses: [] };
    addLog('トップページの取得に失敗しました', 'info');
    return null;
  }

  var topText = extractTextFromHtml(topHtml);
  addLog('トップページ取得完了 (' + topText.length + '文字)', 'success');

  _crawlDebugInfo = { pages: [{ url: url, status: 'OK (' + _activeProxy + ')', size: topHtml.length, text: 'トップページ' }], scoredLinks: [], addresses: [] };

  var allHtmlSources = [topHtml];
  var links = extractLinks(topHtml, url);
  addLog('内部リンク ' + links.length + '件を検出', 'info');

  var allLinks = links.map(function(link) {
    return { url: link.url, path: link.path, text: link.text, score: scoreLink(link) };
  }).filter(function(link) {
    return link.url !== url && link.url !== url + '/';
  }).sort(function(a, b) {
    return b.score - a.score;
  });

  var maxSubPages = Math.min(allLinks.length, 100);
  var allTexts = [
    '【トップページ】\n' + topText.slice(0, 3000)
  ];
  var _crawledPages = [{ name: 'トップページ', url: url, chars: topText.length, status: 'OK' }];

  addLog('巡回対象: ' + maxSubPages + 'ページ（全 ' + allLinks.length + 'リンク中）', 'info');

  for (var i = 0; i < maxSubPages; i++) {
    var subLink = allLinks[i];
    addLog('[' + (i+1) + '/' + maxSubPages + '] ' + (subLink.text || subLink.path));

    var subHtml = await fetchSinglePage(subLink.url);
    if (subHtml) {
      allHtmlSources.push(subHtml);
      var subText = extractTextFromHtml(subHtml);
      if (subText.length > 50) {
        var pageName = subLink.text || subLink.path;
        var summary = extractPageSummary(subHtml);
        allTexts.push('【' + pageName + '】\n' + subText.slice(0, 2000));
        _crawledPages.push({ name: pageName, url: subLink.url, chars: subText.length, status: 'OK', summary: summary });
      }
      _crawlDebugInfo.pages.push({ url: subLink.url, status: 'OK', size: subHtml.length, text: subLink.text });
    } else {
      _crawledPages.push({ name: subLink.text || subLink.path, url: subLink.url, chars: 0, status: 'FAILED' });
      _crawlDebugInfo.pages.push({ url: subLink.url, status: 'FAILED', size: 0, text: subLink.text });
    }
  }

  _crawlDebugInfo.crawledPages = _crawledPages;

  addLog('合計 ' + _crawledPages.filter(function(p) { return p.status === 'OK'; }).length + '/' + (maxSubPages + 1) + ' ページ取得完了', 'success');

  // 全HTMLソースからページごとに住所を抽出
  var allAddrs = [];
  var seenZips = {};
  var topAddrs = extractAddressesFromHtml(topHtml, 'トップページ');
  topAddrs.forEach(function(a) { if (!seenZips[a.zip]) { seenZips[a.zip] = true; allAddrs.push(a); } });
  allHtmlSources.forEach(function(srcHtml, idx) {
    if (idx === 0) return;
    var pName = (_crawledPages[idx] && _crawledPages[idx].name) || 'ページ' + idx;
    var pageAddrs = extractAddressesFromHtml(srcHtml, pName);
    pageAddrs.forEach(function(a) { if (!seenZips[a.zip]) { seenZips[a.zip] = true; allAddrs.push(a); } });
  });
  _crawledAddresses = allAddrs;
  addLog('HTMLソースから住所 ' + _crawledAddresses.length + '件を直接検出', _crawledAddresses.length > 0 ? 'success' : 'info');

  var combined = allTexts.join('\n\n---\n\n');
  if (combined.length > 15000) combined = combined.slice(0, 15000);
  return combined;
}

// HTMLソースから直接住所を抽出
function extractAddressesFromHtml(html, pageName) {
  if (!html) return [];
  var results = [];
  var seen = {};

  var plainText = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  var regex = /〒(\d{3}-?\d{4})\s*([^〒]{5,120})/g;
  var m;

  while ((m = regex.exec(plainText)) !== null) {
    var zip = m[1].trim();
    if (seen[zip]) continue;
    seen[zip] = true;

    var rawAddr = m[2].trim();
    var addrMatch = rawAddr.match(/^(.+?)(?:\s*(?:TEL|FAX|tel|fax|電話))/i);
    var address = addrMatch ? addrMatch[1].trim() : rawAddr;

    var telMatch = rawAddr.match(/(?:TEL|tel|電話)[\s:]*(\d[\d\-]+\d)/i);
    var tel = telMatch ? telMatch[1] : '';
    if (!tel) {
      var numMatch = rawAddr.match(/(\d{2,4}-\d{2,4}-\d{3,4})/);
      if (numMatch && address.indexOf(numMatch[1]) < 0) {
        tel = numMatch[1];
      }
    }

    address = address.replace(/\s+/g, ' ').replace(/[\n\r]/g, '').trim();
    if (address.length < 5 || address.length > 100) continue;
    if (!address.match(/[都道府県市区町村郡]/)) continue;

    var matchPos = m.index;
    var ctxStart = Math.max(0, matchPos - 40);
    var ctxEnd = Math.min(plainText.length, matchPos + m[0].length + 40);
    var context = plainText.slice(ctxStart, ctxEnd).replace(/\s+/g, ' ').trim();

    results.push({
      zip: '〒' + zip,
      address: address,
      tel: tel,
      page: pageName || '',
      context: context
    });
  }

  return results;
}


// ---- Progress Log Helper ----
function addLog(message, type) {
  if (!type) type = 'normal';
  if (!progressLogContent) return;
  var div = document.createElement('div');
  div.className = 'log-item ' + type;
  div.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
  progressLogContent.appendChild(div);
  progressLogContent.scrollTop = progressLogContent.scrollHeight;
}

function clearLogs() {
  if (progressLogContent) progressLogContent.innerHTML = '';
}

// ---- Main Analysis Flow ----
async function startAnalysis() {
  var url = urlInput.value.trim();

  if (!url) { showError('URLを入力してください'); return; }
  if (!isValidUrl(url)) { showError('有効なURLを入力してください（例: https://example.co.jp）'); return; }

  hideError();
  hideResults();
  showProgress();
  setLoading(true);
  clearLogs();

  addLog('飲食店エリア分析を開始します...', 'info');
  addLog('APIプロキシ経由でGemini + e-Statを使用', 'info');

  try {
    // Step 1: Crawl site
    activateStep('step-crawl');
    addLog('Webサイトを巡回中: ' + url);

    var pageContent = await crawlSite(url);
    if (pageContent) {
      addLog('サイト内容の取得完了 (合計 ' + pageContent.length + '文字)', 'success');
    } else {
      addLog('CORSプロキシ経由の取得に失敗。URLのみでAI分析を実行します。', 'info');
      pageContent = '';
    }
    completeStep('step-crawl');

    // Step 2: AI Business Analysis (飲食業固定)
    activateStep('step-analyze');
    addLog('Gemini 2.0 Flash で店舗情報を分析中...');

    var analysisPrompt = buildAnalysisPrompt(url, pageContent);
    var analysisRaw = await callGemini(analysisPrompt);
    var analysis = parseJSON(analysisRaw);
    addLog('分析完了: ' + ((analysis.company && analysis.company.name) || '店舗情報取得'), 'success');
    addLog('業種: 🍽️ 飲食店・フード（固定）', 'success');

    completeStep('step-analyze');

    // Step 2.5: AI事業所フィルタリング
    var rawAddresses = _crawledAddresses || [];
    var extractedAddresses = rawAddresses;

    if (rawAddresses.length > 1) {
      addLog('抽出住所 ' + rawAddresses.length + '件をAIで店舗判定中...');
      try {
        var companyName = (analysis.company && analysis.company.name) || '';
        var businessType = (analysis.company && analysis.company.business_type) || '';
        var addrList = rawAddresses.map(function(a, i) {
          return (i+1) + '. ' + a.zip + ' ' + a.address +
            (a.tel ? ' TEL:' + a.tel : '') +
            '\n   出現ページ: ' + (a.page || '不明') +
            '\n   前後テキスト: 「' + (a.context || '').slice(0, 80) + '」';
        }).join('\n\n');

        var filterPrompt = '■ 企業名: ' + companyName + '\n' +
          '■ 業種: 飲食店 ' + businessType + '\n\n' +
          '以下はこの飲食店のWebサイトの各ページから抽出された住所一覧です。\n' +
          '各住所には「出現ページ名」と「前後テキスト」を付記しています。\n\n' +
          addrList + '\n\n' +
          '【判定基準】\n' +
          '✅ 店舗・事業所として採用する住所:\n' +
          '- 本店・支店・直営店・FC店の住所\n' +
          '- 本社・事務所の住所\n' +
          '- 「店舗一覧」「アクセス」ページに記載された住所\n' +
          '- ヘッダー/フッターに記載された企業住所\n\n' +
          '❌ 除外すべき住所:\n' +
          '- 仕入先・納入業者・取引先の住所\n' +
          '- 求人サイトの勤務地（自社以外）\n' +
          '- イベント会場・出店先の住所\n' +
          '- 免許の登録先（保健所等）の住所\n\n' +
          '以下のJSON形式で回答してください:\n' +
          '{"offices":[{"no":1,"is_office":true,"reason":"本店住所（店舗情報ページ）"},{"no":2,"is_office":false,"reason":"仕入先の住所"},...]}';

        var filterRaw = await callGemini(filterPrompt);
        var filterResult = parseJSON(filterRaw);
        if (filterResult && filterResult.offices && filterResult.offices.length > 0) {
          extractedAddresses = [];
          filterResult.offices.forEach(function(item) {
            var idx = item.no - 1;
            if (item.is_office && rawAddresses[idx]) {
              extractedAddresses.push(rawAddresses[idx]);
              addLog('  ✅ ' + rawAddresses[idx].address + ' → ' + (item.reason || '店舗'), 'success');
            } else if (rawAddresses[idx]) {
              addLog('  ❌ ' + rawAddresses[idx].address + ' → ' + (item.reason || '除外'), 'info');
            }
          });
          var removedCount = rawAddresses.length - extractedAddresses.length;
          if (removedCount > 0) {
            addLog('AI判定: ' + removedCount + '件の非店舗住所を除外 → 店舗 ' + extractedAddresses.length + '件', 'success');
          } else {
            addLog('AI判定: 全 ' + rawAddresses.length + '件が店舗と確認', 'success');
          }
        } else {
          var filterMatch = filterRaw.match(/\[[\d\s,]+\]/);
          if (filterMatch) {
            var officeIndices = JSON.parse(filterMatch[0]);
            extractedAddresses = officeIndices.map(function(idx) { return rawAddresses[idx - 1]; }).filter(function(a) { return !!a; });
            addLog('AI判定: 店舗 ' + extractedAddresses.length + '/' + rawAddresses.length + '件', 'success');
          } else {
            addLog('AI判定のパースに失敗 → 全住所を使用', 'info');
          }
        }
      } catch (e) {
        addLog('AI店舗判定スキップ: ' + e.message, 'info');
      }
    }

    // Step 3: Market Data (per area) — 飲食業特化
    activateStep('step-market');
    addLog('サイトから店舗住所 ' + extractedAddresses.length + '件を確認済み', 'info');

    var uniqueAreas = [];
    var seenAreaKeys = {};

    var hqLocation = analysis.location || {};
    if (hqLocation.prefecture) {
      var hqKey = hqLocation.prefecture + ' ' + (hqLocation.city || '');
      seenAreaKeys[hqKey] = true;
      uniqueAreas.push({ prefecture: hqLocation.prefecture, city: hqLocation.city || '', label: hqKey, isHQ: true });
    }

    extractedAddresses.forEach(function(addr) {
      var area = extractAreaFromAddress(addr.address);
      if (area && !seenAreaKeys[area.label]) {
        seenAreaKeys[area.label] = true;
        uniqueAreas.push(area);
      }
    });

    addLog('分析対象エリア: ' + uniqueAreas.length + '件', 'info');

    var markets = [];
    for (var aIdx = 0; aIdx < uniqueAreas.length; aIdx++) {
      var area = uniqueAreas[aIdx];
      addLog('[' + (aIdx+1) + '/' + uniqueAreas.length + '] 飲食市場データ取得: ' + area.label);

      var prefCode = PREFECTURE_CODES[area.prefecture];
      var estatDataForArea = {};
      if (prefCode) {
        estatDataForArea = await fetchEstatForRestaurant(prefCode, area.city);
      }

      // 飲食業専用プロンプト
      var marketPrompt = buildRestaurantMarketPrompt(analysis, estatDataForArea, area);
      var marketRaw = await callGemini(marketPrompt);
      var marketData = parseJSON(marketRaw);

      // e-Statデータをマージ
      var areaEstatPop = estatDataForArea.population;
      if (areaEstatPop && areaEstatPop.from_estat) {
        if (!marketData.population) marketData.population = {};
        marketData.population.total_population = areaEstatPop.total_population;
        marketData.population.households = areaEstatPop.households;
        marketData.population.source = areaEstatPop.source;
      }

      markets.push({ area: area, data: marketData });
      addLog('  → ' + area.label + ' 完了', 'success');
    }

    addLog('全 ' + markets.length + ' エリアの飲食市場データ収集完了', 'success');

    // Step 3.5: 全エリア横断AI分析（経営層向け）
    var crossAreaInsight = null;
    if (markets.length >= 2) {
      addLog('全エリア横断分析（飲食業向け）を実行中...');
      try {
        var summaryForAI = markets.map(function(mkt) {
          var d = mkt.data || {};
          var pop = d.population || {};
          var summary = {
            area: mkt.area.label,
            isHQ: mkt.area.isHQ || false,
            population: pop.total_population || 0,
            households: pop.households || 0
          };
          for (var key in d) {
            if (key === 'area_name' || key === 'population') continue;
            if (typeof d[key] === 'object') {
              for (var subKey in d[key]) {
                summary[key + '_' + subKey] = d[key][subKey];
              }
            }
          }
          return summary;
        });
        var crossPrompt = buildRestaurantCrossAreaPrompt(analysis, summaryForAI);
        var crossRaw = await callGemini(crossPrompt);
        crossAreaInsight = parseJSON(crossRaw);
        addLog('横断分析完了', 'success');
      } catch (e) {
        addLog('横断分析スキップ: ' + e.message, 'info');
      }
    }

    completeStep('step-market');

    // Step 4: Render Report
    activateStep('step-report');
    addLog('飲食業分析レポート生成中...');
    await sleep(300);

    analysisData = {
      url: url,
      company: analysis.company || {},
      industry: { id: 'restaurant', name: '飲食店・フード', confidence: 1.0 },
      industryId: 'restaurant',
      industryConfig: RESTAURANT_CONFIG,
      location: analysis.location || {},
      markets: markets,
      market: markets.length > 0 ? markets[0].data : {},
      crossAreaInsight: crossAreaInsight,
      timestamp: new Date().toISOString(),
      data_source: 'e-Stat + Gemini',
      extracted_addresses: extractedAddresses
    };

    renderResults(analysisData);
    addLog('飲食業分析レポート作成完了！', 'success');
    completeStep('step-report');

    await sleep(300);
    hideProgress();
    showResults();

  } catch (err) {
    console.error('Analysis error:', err);
    addLog('エラー: ' + err.message, 'error');
    showError(err.message);
  } finally {
    setLoading(false);
  }
}

// ---- Prompt Builders (飲食業特化) ----
function buildAnalysisPrompt(url, content) {
  var contentSection = content
    ? '\n以下はWebサイトから取得したテキストの一部です:\n---\n' + content + '\n---'
    : '\nWebサイトの内容は取得できませんでしたが、URLから推測してください。';

  return 'あなたは飲食業界の企業分析と市場調査の専門家です。\n' +
    '以下のURLの飲食店・飲食企業について分析してください。\n\n' +
    'URL: ' + url + '\n' +
    contentSection + '\n\n' +
    '重要: 住所は必ずWebサイトの情報から特定してください。店舗情報ページやフッターに記載があります。\n' +
    '複数の店舗がある場合、本店の住所を"address"に、他の店舗は"branches"にリストしてください。\n\n' +
    '以下のJSON形式で回答してください。マークダウンのコードブロックで囲まず、純粋JSONのみ返してください:\n' +
    '{\n' +
    '  "company": {\n' +
    '    "name": "店舗名・企業名",\n' +
    '    "address": "本店の住所（〒XXX-XXXX 都道府県市区町村以降）",\n' +
    '    "branches": [\n' +
    '      {"name": "支店名", "address": "住所"}\n' +
    '    ],\n' +
    '    "business_type": "飲食業態（例: イタリアン、居酒屋、カフェ、ラーメン等）",\n' +
    '    "main_services": "主力メニュー・サービス",\n' +
    '    "cuisine_type": "料理ジャンル",\n' +
    '    "price_range": "客単価帯（例: ランチ1000-1500円、ディナー3000-5000円）",\n' +
    '    "strengths": "強み・特徴（100文字以内）",\n' +
    '    "weaknesses": "改善余地・課題（100文字以内）",\n' +
    '    "keywords": ["キーワード1", "キーワード2", "キーワード3"]\n' +
    '  },\n' +
    '  "location": {\n' +
    '    "prefecture": "本店の都道府県",\n' +
    '    "city": "本店の市区町村"\n' +
    '  }\n' +
    '}';
}

// 飲食業専用 市場データプロンプト
function buildRestaurantMarketPrompt(analysis, estatData, area) {
  var company = analysis.company || {};
  var pref = area.prefecture || '不明';
  var city = area.city || '';

  var estatInfo = '';
  if (estatData && estatData.population && estatData.population.from_estat) {
    var pop = estatData.population;
    estatInfo = '\n\n【参考: e-Stat政府統計データ】\n' +
      '・総人口: ' + formatNumber(pop.total_population) + '人\n' +
      '・世帯数: ' + formatNumber(pop.households) + '世帯\n';
    for (var key in estatData) {
      if (key === 'population') continue;
      var d = estatData[key];
      if (d && typeof d === 'object') {
        estatInfo += '・' + key + ': データあり\n';
      }
    }
    estatInfo += 'これらの実データを基準にして、他の項目も整合性のある値を推定してください。\n';
  }

  return 'あなたは日本の飲食業界・商圏分析の専門家です。\n' +
    '以下の地域の飲食業市場データを推定・提供してください。\n\n' +
    '対象エリア: ' + pref + ' ' + city + '\n' +
    '企業の事業: ' + (company.business_type || '飲食業') + '\n' +
    '主力メニュー: ' + (company.main_services || '不明') + '\n' +
    '料理ジャンル: ' + (company.cuisine_type || '不明') + '\n' +
    '客単価帯: ' + (company.price_range || '不明') + '\n' +
    estatInfo + '\n\n' +
    '重要KPI: 外食支出額, 飲食店密度, 人口あたり店舗数, 世帯消費傾向, ランチ需要, ディナー需要\n' +
    'できる限り正確な数値を提供してください。不明な場合は合理的な推計値を提供してください。\n\n' +
    '以下のJSON形式で回答してください。マークダウンのコードブロックで囲まず、純粋JSONのみ返してください:\n' +
    '{\n' +
    '  "area_name": "' + pref + ' ' + city + '",\n' +
    '  "population": { "total_population": 0, "households": 0, "age_20_50_pct": 0, "elderly_pct": 0, "source": "" },\n' +
    '  "dining_market": {\n' +
    '    "monthly_dining_spend": 0,\n' +
    '    "annual_dining_spend": 0,\n' +
    '    "food_spend_ratio": 0,\n' +
    '    "avg_lunch_price": 0,\n' +
    '    "avg_dinner_price": 0,\n' +
    '    "delivery_demand_index": 0,\n' +
    '    "takeout_ratio_pct": 0,\n' +
    '    "source": "推計"\n' +
    '  },\n' +
    '  "competition": {\n' +
    '    "restaurant_count": 0,\n' +
    '    "per_10k_population": 0,\n' +
    '    "chain_ratio_pct": 0,\n' +
    '    "same_genre_count": 0,\n' +
    '    "new_openings_1yr": 0,\n' +
    '    "closure_rate_pct": 0\n' +
    '  },\n' +
    '  "consumer_profile": {\n' +
    '    "avg_household_income": 0,\n' +
    '    "single_household_pct": 0,\n' +
    '    "office_worker_density": 0,\n' +
    '    "student_population": 0,\n' +
    '    "tourist_visitors_annual": 0\n' +
    '  },\n' +
    '  "potential": {\n' +
    '    "target_population": 0,\n' +
    '    "daily_foot_traffic": 0,\n' +
    '    "lunch_demand": 0,\n' +
    '    "dinner_demand": 0,\n' +
    '    "weekend_demand_index": 0,\n' +
    '    "seat_turnover_potential": 0,\n' +
    '    "ai_insight": "このエリアでの飲食店出店・経営戦略に関する提言(200字)"\n' +
    '  }\n' +
    '}';
}

// 飲食業専用 横断分析プロンプト
function buildRestaurantCrossAreaPrompt(analysis, marketsData) {
  return '以下は飲食企業の各エリアの商圏データです。経営層向けに出店戦略を分析してください。\n' +
    '特に以下の観点で分析してください:\n' +
    '- ランチ需要 vs ディナー需要のバランス\n' +
    '- 競合飲食店の密度と差別化余地\n' +
    '- テイクアウト・デリバリー展開の可能性\n' +
    '- 客層（オフィスワーカー、学生、ファミリー、観光客）\n\n' +
    JSON.stringify(marketsData, null, 2) + '\n\n' +
    '以下のJSON形式で回答してください:\n' +
    '{\n' +
    '  "opportunity_ranking": [{"rank":1,"area":"エリア名","reason":"理由(50字以内)","score":85},...],\n' +
    '  "strategic_summary": "全体の出店戦略サマリー(200字以内)",\n' +
    '  "sales_advice": "営業・マーケティングチームへのアドバイス(200字以内)",\n' +
    '  "risk_areas": "リスクのあるエリアと理由(100字以内)",\n' +
    '  "growth_areas": "成長が見込めるエリアと理由(100字以内)"\n' +
    '}';
}

// 政令指定都市 → 都道府県マッピング
var CITY_TO_PREF = {
  '札幌市':'北海道','仙台市':'宮城県','さいたま市':'埼玉県','千葉市':'千葉県',
  '横浜市':'神奈川県','川崎市':'神奈川県','相模原市':'神奈川県','新潟市':'新潟県',
  '静岡市':'静岡県','浜松市':'静岡県','名古屋市':'愛知県','京都市':'京都府',
  '大阪市':'大阪府','堺市':'大阪府','神戸市':'兵庫県','岡山市':'岡山県',
  '広島市':'広島県','北九州市':'福岡県','福岡市':'福岡県','熊本市':'熊本県'
};

function extractAreaFromAddress(address) {
  if (!address) return null;

  var prefMatch = address.match(/(北海道|東京都|大阪府|京都府|.{2,3}県)/);
  if (prefMatch) {
    var pref = prefMatch[1];
    var rest = address.slice(address.indexOf(pref) + pref.length);
    var city = '';
    if (pref === '東京都') {
      var wardMatch = rest.match(/^(.+?区)/);
      city = wardMatch ? wardMatch[1] : '';
    } else {
      var cityMatch = rest.match(/^(.+?市)(.+?区)?/) || rest.match(/^(.+?郡)(.+?[町村])/);
      if (cityMatch) {
        city = cityMatch[1] + (cityMatch[2] || '');
      } else {
        var kuMatch = rest.match(/^(.+?区)/);
        city = kuMatch ? kuMatch[1] : '';
      }
    }
    return { prefecture: pref, city: city, label: pref + ' ' + city };
  }

  for (var cName in CITY_TO_PREF) {
    var idx = address.indexOf(cName);
    if (idx >= 0) {
      var cPref = CITY_TO_PREF[cName];
      var cRest = address.slice(idx);
      var cMatch = cRest.match(/^(.+?市)(.+?区)?/);
      var cCity = cMatch ? cMatch[1] + (cMatch[2] || '') : cName;
      return { prefecture: cPref, city: cCity, label: cPref + ' ' + cCity };
    }
  }

  return null;
}

function extractPageSummary(html) {
  try {
    var parser = new DOMParser();
    var doc = parser.parseFromString(html, 'text/html');
    doc.querySelectorAll('header, nav, footer, aside, script, style, noscript, iframe, svg, form, .header, .footer, .nav, .sidebar, .menu, #header, #footer, #nav').forEach(function(el) { el.remove(); });
    var mainEl = doc.querySelector('main, article, .main, .content, #main, #content, .entry-content');
    var text = (mainEl || doc.body || doc).textContent || '';
    var lines = text.split(/[\n\r]+/);
    var meaningful = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/\s+/g, ' ').trim();
      if (line.length < 20) continue;
      if (/^(TOP|HOME|MENU|Cookie|©|Copyright|All Rights Reserved)/.test(line)) continue;
      meaningful.push(line);
      if (meaningful.length >= 2) break;
    }
    return meaningful.join(' ').slice(0, 200);
  } catch(e) {
    return '';
  }
}

// ---- JSON Parser ----
function parseJSON(text) {
  var cleaned = text.trim();
  var codeBlockStart = /^```(?:json)?\s*\n?/;
  var codeBlockEnd = /\n?```\s*$/;
  if (cleaned.match(codeBlockStart)) {
    cleaned = cleaned.replace(codeBlockStart, '').replace(codeBlockEnd, '');
  }
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    var match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { /* fall through */ }
    }
    console.error('JSON parse error:', e, '\nRaw:', cleaned.slice(0, 500));
    throw new Error('AIの応答をパースできませんでした。再度お試しください。');
  }
}

// ---- 飲食業比較テーブル生成 ----
function buildComparisonTable(markets) {
  if (!markets || markets.length === 0) return '';

  var html = '<div style="overflow-x:auto; margin-bottom:20px;">' +
    '<table class="data-table" style="font-size:11px; width:100%; min-width:800px;">' +
    '<thead><tr style="background:rgba(239,68,68,0.1);">' +
    '<th style="text-align:left;">エリア</th>' +
    '<th>人口</th>' +
    '<th>世帯数</th>' +
    '<th>月間外食支出</th>' +
    '<th>飲食店数</th>' +
    '<th>万人あたり店舗</th>' +
    '<th>ランチ需要</th>' +
    '<th>ディナー需要</th>' +
    '</tr></thead><tbody>';

  var totPop = 0, totHH = 0, totSpend = 0, totRest = 0, totPer10k = 0, totLunch = 0, totDinner = 0;
  var cnt = 0;

  markets.forEach(function(mkt) {
    var d = mkt.data || {};
    var pop = (d.population || {}).total_population || 0;
    var hh = (d.population || {}).households || 0;
    var spend = (d.dining_market || {}).monthly_dining_spend || 0;
    var rest = (d.competition || {}).restaurant_count || 0;
    var per10k = (d.competition || {}).per_10k_population || 0;
    var lunch = (d.potential || {}).lunch_demand || 0;
    var dinner = (d.potential || {}).dinner_demand || 0;

    totPop += pop; totHH += hh; totSpend += spend; totRest += rest;
    totPer10k += per10k; totLunch += lunch; totDinner += dinner;
    cnt++;

    var icon = (mkt.area && mkt.area.isHQ) ? '🏢' : '📍';
    var label = mkt.area ? mkt.area.label : 'エリア';
    html += '<tr><td style="font-weight:600; white-space:nowrap;">' + icon + ' ' + escapeHtml(label) + '</td>' +
      '<td style="text-align:right;">' + formatNumber(pop) + '</td>' +
      '<td style="text-align:right;">' + formatNumber(hh) + '</td>' +
      '<td style="text-align:right;">' + formatNumber(spend) + '円</td>' +
      '<td style="text-align:right;">' + formatNumber(rest) + '</td>' +
      '<td style="text-align:right;">' + (per10k || '—') + '</td>' +
      '<td style="text-align:right;">' + formatNumber(lunch) + '</td>' +
      '<td style="text-align:right;">' + formatNumber(dinner) + '</td></tr>';
  });

  var n = cnt || 1;
  html += '<tr style="background:rgba(16,185,129,0.08); font-weight:700;">' +
    '<td>平均</td>' +
    '<td style="text-align:right;">' + formatNumber(Math.round(totPop / n)) + '</td>' +
    '<td style="text-align:right;">' + formatNumber(Math.round(totHH / n)) + '</td>' +
    '<td style="text-align:right;">' + formatNumber(Math.round(totSpend / n)) + '円</td>' +
    '<td style="text-align:right;">' + formatNumber(Math.round(totRest / n)) + '</td>' +
    '<td style="text-align:right;">' + (totPer10k / n).toFixed(1) + '</td>' +
    '<td style="text-align:right;">' + formatNumber(Math.round(totLunch / n)) + '</td>' +
    '<td style="text-align:right;">' + formatNumber(Math.round(totDinner / n)) + '</td></tr>';

  html += '</tbody></table></div>';
  return html;
}

// ---- 飲食業データセクション生成 ----
function renderDiningDataSections(marketData) {
  var html = '';

  // 飲食市場データ
  if (marketData.dining_market) {
    var dm = marketData.dining_market;
    html += '<div style="margin-bottom:16px;">' +
      '<div style="font-size:14px; font-weight:700; margin-bottom:8px;">🍽️ 飲食市場データ</div>' +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(dm.monthly_dining_spend) + '<span style="font-size:14px">円</span></div><div class="stat-box__label">月間外食支出/世帯</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(dm.annual_dining_spend) + '<span style="font-size:14px">円</span></div><div class="stat-box__label">年間外食支出/世帯</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (dm.food_spend_ratio || '—') + '<span style="font-size:14px">%</span></div><div class="stat-box__label">食費に占める外食比率</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(dm.avg_lunch_price || 0) + '<span style="font-size:14px">円</span></div><div class="stat-box__label">平均ランチ単価</div></div>' +
      '</div>';
    if (dm.delivery_demand_index || dm.takeout_ratio_pct) {
      html += '<div class="stat-grid" style="margin-top:8px;">' +
        '<div class="stat-box"><div class="stat-box__value">' + formatNumber(dm.avg_dinner_price || 0) + '<span style="font-size:14px">円</span></div><div class="stat-box__label">平均ディナー単価</div></div>' +
        '<div class="stat-box"><div class="stat-box__value">' + (dm.delivery_demand_index || '—') + '</div><div class="stat-box__label">デリバリー需要指数</div></div>' +
        '<div class="stat-box"><div class="stat-box__value">' + (dm.takeout_ratio_pct || '—') + '<span style="font-size:14px">%</span></div><div class="stat-box__label">テイクアウト比率</div></div>' +
        '</div>';
    }
    html += '</div>';
  }

  // 競合分析
  if (marketData.competition) {
    var comp = marketData.competition;
    html += '<div style="margin-bottom:16px;">' +
      '<div style="font-size:14px; font-weight:700; margin-bottom:8px;">🏢 競合分析</div>' +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(comp.restaurant_count) + '<span style="font-size:14px">店</span></div><div class="stat-box__label">飲食店総数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (comp.per_10k_population || '—') + '</div><div class="stat-box__label">万人あたり店舗数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (comp.chain_ratio_pct || '—') + '<span style="font-size:14px">%</span></div><div class="stat-box__label">チェーン店比率</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(comp.same_genre_count || 0) + '<span style="font-size:14px">店</span></div><div class="stat-box__label">同ジャンル店舗数</div></div>' +
      '</div>';
    if (comp.new_openings_1yr || comp.closure_rate_pct) {
      html += '<div class="stat-grid" style="margin-top:8px;">' +
        '<div class="stat-box"><div class="stat-box__value">' + formatNumber(comp.new_openings_1yr || 0) + '<span style="font-size:14px">店</span></div><div class="stat-box__label">直近1年新規出店</div></div>' +
        '<div class="stat-box"><div class="stat-box__value">' + (comp.closure_rate_pct || '—') + '<span style="font-size:14px">%</span></div><div class="stat-box__label">閉店率</div></div>' +
        '</div>';
    }
    html += '</div>';
  }

  // 消費者プロファイル
  if (marketData.consumer_profile) {
    var cp = marketData.consumer_profile;
    html += '<div style="margin-bottom:16px;">' +
      '<div style="font-size:14px; font-weight:700; margin-bottom:8px;">👤 消費者プロファイル</div>' +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(cp.avg_household_income) + '<span style="font-size:14px">万円</span></div><div class="stat-box__label">平均世帯年収</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (cp.single_household_pct || '—') + '<span style="font-size:14px">%</span></div><div class="stat-box__label">単身世帯率</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(cp.office_worker_density || 0) + '</div><div class="stat-box__label">オフィスワーカー密度</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(cp.student_population || 0) + '<span style="font-size:14px">人</span></div><div class="stat-box__label">学生人口</div></div>' +
      '</div>';
    if (cp.tourist_visitors_annual) {
      html += '<div class="stat-grid" style="margin-top:8px;">' +
        '<div class="stat-box"><div class="stat-box__value">' + formatNumber(cp.tourist_visitors_annual) + '<span style="font-size:14px">人/年</span></div><div class="stat-box__label">年間観光客数</div></div>' +
        '</div>';
    }
    html += '</div>';
  }

  // 市場ポテンシャル
  if (marketData.potential) {
    var pot = marketData.potential;
    html += '<div style="margin-bottom:16px;">' +
      '<div style="font-size:14px; font-weight:700; margin-bottom:8px;">🎯 市場ポテンシャル</div>' +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pot.target_population) + '<span style="font-size:14px">人</span></div><div class="stat-box__label">ターゲット人口</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pot.daily_foot_traffic) + '<span style="font-size:14px">人/日</span></div><div class="stat-box__label">日次歩行者数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pot.lunch_demand) + '</div><div class="stat-box__label">ランチ需要</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pot.dinner_demand) + '</div><div class="stat-box__label">ディナー需要</div></div>' +
      '</div>';
    if (pot.weekend_demand_index || pot.seat_turnover_potential) {
      html += '<div class="stat-grid" style="margin-top:8px;">' +
        '<div class="stat-box"><div class="stat-box__value">' + (pot.weekend_demand_index || '—') + '</div><div class="stat-box__label">週末需要指数</div></div>' +
        '<div class="stat-box"><div class="stat-box__value">' + (pot.seat_turnover_potential || '—') + '<span style="font-size:14px">回</span></div><div class="stat-box__label">席回転ポテンシャル</div></div>' +
        '</div>';
    }

    if (pot.ai_insight) {
      html += '<div class="summary-box" style="margin-top:10px">' +
        '<div class="summary-box__title">📌 AIからの出店戦略提言</div>' +
        '<div class="summary-box__text">' + escapeHtml(pot.ai_insight) + '</div></div>';
    }
    html += '</div>';
  }

  return html;
}

// ---- Render Results ----
function renderResults(data) {
  var company = data.company;
  var market = data.market;
  var html = '';

  var sourceBadge = data.data_source === 'e-Stat + Gemini'
    ? '<span style="background: linear-gradient(135deg, #10b981, #ef4444); color:#fff; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">📊 e-Stat実データ + AI分析</span>'
    : '<span style="background: var(--accent-gradient); color:#fff; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:700;">🤖 AI推計モード</span>';

  // Company Card
  html += '<div class="result-card result-card--company">' +
    '<div class="result-card__header">' +
    '<div class="result-card__icon">🍽️</div>' +
    '<div>' +
    '<div class="result-card__title">' + escapeHtml(company.name || '店舗分析') + '</div>' +
    '<div class="result-card__subtitle">Gemini 2.0 Flash による飲食店分析 ' + sourceBadge + '</div>' +
    '</div></div>' +
    '<div class="result-card__body">' +
    '<table class="data-table">' +
    '<tr><th>店舗名</th><td>' + escapeHtml(company.name || '—') + '</td></tr>' +
    '<tr><th>所在地</th><td>' + escapeHtml(company.address || '—') + '</td></tr>' +
    '<tr><th>業態</th><td>' + escapeHtml(company.business_type || '—') + '</td></tr>' +
    '<tr><th>主力メニュー</th><td>' + escapeHtml(company.main_services || '—') + '</td></tr>' +
    '<tr><th>料理ジャンル</th><td>' + escapeHtml(company.cuisine_type || '—') + '</td></tr>' +
    '<tr><th>客単価帯</th><td>' + escapeHtml(company.price_range || '—') + '</td></tr>';

  // 業種バッジ（固定: 飲食業）
  var indBadge = '<span class="industry-badge" style="background:#ef4444; color:#fff; padding:4px 12px; border-radius:20px; font-size:12px; font-weight:700;">🍽️ 飲食店・フード</span>';
  html += '<tr><th>業種</th><td>' + indBadge + '</td></tr>' +
    '</table>';

  // 店舗一覧
  var addrs = data.extracted_addresses || [];
  if (addrs.length > 1) {
    html += '<div style="margin-top:12px; padding:12px 16px; background:rgba(239,68,68,0.08); border-radius:10px; border:1px solid rgba(239,68,68,0.15);">' +
      '<div style="font-size:13px; font-weight:700; color:var(--accent); margin-bottom:8px;">📍 店舗一覧 (' + addrs.length + '店舗)</div>';
    addrs.forEach(function(a, idx) {
      var label = idx === 0 ? '🏢 本店' : '📍 ' + (idx + 1) + '号店';
      html += '<div style="font-size:12px; color:var(--text-secondary); margin-bottom:6px; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05);">' +
        '<span style="font-weight:600; color:var(--text-primary); min-width:70px; display:inline-block;">' + label + '</span> ' +
        '<span style="color:var(--accent);">' + escapeHtml(a.zip) + '</span> ' +
        escapeHtml(a.address) +
        (a.tel ? ' <span style="color:var(--text-secondary); font-size:11px;">TEL ' + escapeHtml(a.tel) + '</span>' : '') +
        '</div>';
    });
    html += '</div>';
  }

  if (company.strengths) {
    html += '<div class="summary-box" style="margin-top:16px"><div class="summary-box__title">💪 強み・特徴</div><div class="summary-box__text">' + escapeHtml(company.strengths) + '</div></div>';
  }
  if (company.weaknesses) {
    html += '<div class="summary-box" style="margin-top:12px; background: linear-gradient(135deg, rgba(244,63,94,0.1), rgba(249,115,22,0.1)); border-color: rgba(244,63,94,0.2);"><div class="summary-box__title" style="color:var(--accent-rose)">⚠️ 改善余地</div><div class="summary-box__text">' + escapeHtml(company.weaknesses) + '</div></div>';
  }
  if (company.keywords && company.keywords.length) {
    html += '<div class="tag-list" style="margin-top:16px">';
    company.keywords.forEach(function(k) { html += '<span class="tag">' + escapeHtml(k) + '</span>'; });
    html += '</div>';
  }
  html += '</div></div>';

  // 巡回ページサマリー
  var crawledPages = (_crawlDebugInfo && _crawlDebugInfo.crawledPages) || [];
  if (crawledPages.length > 0) {
    var okPages = crawledPages.filter(function(p) { return p.status === 'OK'; });
    var totalChars = okPages.reduce(function(sum, p) { return sum + (p.chars || 0); }, 0);

    var importantKeywords = ['会社概要','企業情報','店舗','アクセス','メニュー','サービス','about','company','shop','store','menu','access'];
    var keyPages = okPages.filter(function(p) {
      var name = (p.name || '').toLowerCase();
      return importantKeywords.some(function(kw) { return name.indexOf(kw) >= 0; });
    }).slice(0, 5);
    if (okPages.length > 0 && keyPages.indexOf(okPages[0]) < 0) {
      keyPages.unshift(okPages[0]);
    }

    html += '<div class="result-card" style="border: 1px solid rgba(239,68,68,0.15);">' +
      '<div class="result-card__header">' +
      '<div class="result-card__icon">🌐</div>' +
      '<div><div class="result-card__title">Webサイト巡回結果</div>' +
      '<div class="result-card__subtitle">サイト構造・情報量の概要</div></div></div>' +
      '<div class="result-card__body">' +
      '<div class="crawl-stats-grid">' +
      '<div class="stat-box"><div class="stat-box__value">' + okPages.length + '</div><div class="stat-box__label">取得ページ数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + (totalChars >= 10000 ? (totalChars/10000).toFixed(1) + '万' : totalChars.toLocaleString()) + '</div><div class="stat-box__label">合計文字数</div></div>' +
      '<div class="stat-box"><div class="stat-box__value">' + crawledPages.length + '</div><div class="stat-box__label">検出リンク数</div></div>' +
      '</div>';

    if (keyPages.length > 0) {
      html += '<div style="font-size:12px; font-weight:700; color:var(--text-primary); margin-bottom:8px;">📌 主要ページ</div>';
      keyPages.forEach(function(p) {
        html += '<div style="display:flex; align-items:center; gap:8px; padding:5px 10px; margin-bottom:4px; border-radius:6px; background:rgba(239,68,68,0.04);">' +
          '<span style="font-size:11px; font-weight:600; color:var(--text-primary); flex:1;">' + escapeHtml(p.name || '') + '</span>' +
          '<span style="font-size:10px; color:var(--text-muted); white-space:nowrap;">' + (p.chars || 0).toLocaleString() + '文字</span>' +
          '</div>';
      });
    }

    html += '</div></div>';
  }

  // ========== 全店サマリーダッシュボード ==========
  var markets = data.markets || [];
  var cross = data.crossAreaInsight || {};
  if (markets.length > 0) {
    html += '<div class="result-card" style="border:2px solid rgba(239,68,68,0.3); background:linear-gradient(135deg,rgba(239,68,68,0.05),rgba(249,115,22,0.05));">' +
      '<div class="result-card__header">' +
      '<div class="result-card__icon">📊</div>' +
      '<div><div class="result-card__title">全店エリア比較サマリー</div>' +
      '<div class="result-card__subtitle">' + markets.length + 'エリアの横断比較 — 飲食業経営ダッシュボード</div></div></div>' +
      '<div class="result-card__body">';

    html += buildComparisonTable(markets);

    // Chart.jsグラフ用Canvas
    html += '<div class="chart-grid">' +
      '<div style="background:rgba(30,41,59,0.5); border-radius:12px; padding:16px; border:1px solid rgba(239,68,68,0.1);">' +
      '<div style="font-size:13px; font-weight:700; margin-bottom:8px; color:var(--text-primary);">📈 人口 × 外食支出</div>' +
      '<div style="position:relative; height:220px;"><canvas id="chart-pop-spend"></canvas></div></div>' +
      '<div style="background:rgba(30,41,59,0.5); border-radius:12px; padding:16px; border:1px solid rgba(239,68,68,0.1);">' +
      '<div style="font-size:13px; font-weight:700; margin-bottom:8px; color:var(--text-primary);">📊 飲食店数 × ランチ需要</div>' +
      '<div style="position:relative; height:220px;"><canvas id="chart-rest-lunch"></canvas></div></div>' +
      '</div>';

    // AIチャンスランキング
    if (cross.opportunity_ranking && cross.opportunity_ranking.length > 0) {
      html += '<div style="margin-bottom:20px;">' +
        '<div style="font-size:15px; font-weight:700; margin-bottom:12px; color:var(--text-primary);">🏆 出店チャンスランキング</div>';
      cross.opportunity_ranking.forEach(function(r, i) {
        var barW = (r.score || 50);
        var colors = ['#ef4444','#f97316','#f59e0b','#10b981','#3b82f6','#8b5cf6'];
        var c = colors[i % colors.length];
        html += '<div style="margin-bottom:10px; padding:10px 14px; background:rgba(30,41,59,0.4); border-radius:10px; border:1px solid rgba(239,68,68,0.08);">' +
          '<div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">' +
          '<span style="font-size:18px; font-weight:800; color:' + c + ';">#' + (r.rank||i+1) + '</span>' +
          '<span style="font-size:14px; font-weight:700; color:var(--text-primary);">' + escapeHtml(r.area||'') + '</span>' +
          '<span style="margin-left:auto; font-size:20px; font-weight:800; color:' + c + ';">' + (r.score||0) + '<span style="font-size:11px; color:var(--text-muted);">点</span></span></div>' +
          '<div style="background:rgba(255,255,255,0.05); border-radius:6px; height:8px; overflow:hidden;">' +
          '<div style="width:' + barW + '%; height:100%; background:' + c + '; border-radius:6px; transition:width 1s;"></div></div>' +
          '<div style="font-size:11px; color:var(--text-secondary); margin-top:6px;">' + escapeHtml(r.reason||'') + '</div></div>';
      });
      html += '</div>';
    }

    // 戦略提言カードグリッド
    var insightCards = [];
    if (cross.strategic_summary) insightCards.push({icon:'🎯',title:'出店戦略サマリー',text:cross.strategic_summary,color:'#ef4444'});
    if (cross.sales_advice) insightCards.push({icon:'💼',title:'マーケティングアドバイス',text:cross.sales_advice,color:'#10b981'});
    if (cross.growth_areas) insightCards.push({icon:'📈',title:'成長が見込めるエリア',text:cross.growth_areas,color:'#f97316'});
    if (cross.risk_areas) insightCards.push({icon:'⚠️',title:'リスク・注意エリア',text:cross.risk_areas,color:'#f59e0b'});

    if (insightCards.length > 0) {
      html += '<div class="insight-grid">';
      insightCards.forEach(function(card) {
        html += '<div style="background:rgba(30,41,59,0.5); border-radius:12px; padding:16px; border-left:4px solid ' + card.color + ';">' +
          '<div style="font-size:13px; font-weight:700; margin-bottom:8px; color:' + card.color + ';">' + card.icon + ' ' + card.title + '</div>' +
          '<div style="font-size:12px; color:var(--text-secondary); line-height:1.6;">' + escapeHtml(card.text) + '</div></div>';
      });
      html += '</div>';
    }

    html += '</div></div>';
  }

  // エリア別市場データ（タブ式）
  if (markets.length > 0) {
    html += '<div class="result-card" style="border: 1px solid rgba(239,68,68,0.15); padding: 0;">' +
      '<div class="result-card__header" style="padding:16px 20px 0">' +
      '<div class="result-card__icon">🍽️</div>' +
      '<div><div class="result-card__title">エリア別飲食市場データ</div>' +
      '<div class="result-card__subtitle">' + markets.length + 'エリアの詳細データ</div></div></div>' +
      '<div class="area-tab-btns" style="display:flex; flex-wrap:wrap; gap:6px; padding:12px 20px; border-bottom:1px solid rgba(239,68,68,0.1);">';

    markets.forEach(function(mkt, idx) {
      var isHQ = mkt.area && mkt.area.isHQ;
      var label = isHQ ? '🏢 ' + (mkt.area.label || '本店') : '📍 ' + (mkt.area.label || 'エリア' + (idx+1));
      var activeStyle = idx === 0
        ? 'background:var(--accent-gradient); color:#fff; border-color:transparent;'
        : 'background:var(--bg-tertiary); color:var(--text-secondary); border-color:rgba(239,68,68,0.15);';
      html += '<button class="area-tab-btn" data-area-idx="' + idx + '" onclick="switchAreaTab(' + idx + ')" style="' +
        'padding:6px 14px; border-radius:20px; border:1px solid; font-size:11px; font-weight:600; cursor:pointer; transition:all 0.2s; white-space:nowrap; ' +
        activeStyle + '">' + escapeHtml(label) + '</button>';
    });
    html += '</div>';

    markets.forEach(function(mkt, idx) {
      var m = mkt.data || {};
      var areaLabel = m.area_name || (mkt.area && mkt.area.label) || 'エリア';
      var display = idx === 0 ? 'block' : 'none';
      var isHQ = mkt.area && mkt.area.isHQ;
      var fullLabel = (isHQ ? '🏢 ' : '📍 ') + areaLabel;
      html += '<div class="area-tab-content" id="area-tab-' + idx + '" data-area-label="' + escapeHtml(fullLabel) + '" style="display:' + display + '; padding:16px 20px;">';

      // 人口
      if (m.population) {
        var pop = m.population;
        var popSource = pop.source ? ' <span style="font-size:11px; color:var(--text-muted);">(' + escapeHtml(pop.source) + ')</span>' : '';
        html += '<div style="margin-bottom:16px;"><div style="font-size:14px; font-weight:700; margin-bottom:8px;">👥 人口・世帯データ' + popSource + '</div>' +
          '<div class="stat-grid">' +
          '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pop.total_population) + '</div><div class="stat-box__label">総人口</div></div>' +
          '<div class="stat-box"><div class="stat-box__value">' + formatNumber(pop.households) + '</div><div class="stat-box__label">世帯数</div></div>' +
          '<div class="stat-box"><div class="stat-box__value">' + (pop.age_20_50_pct || '—') + '%</div><div class="stat-box__label">20〜50歳</div></div>' +
          '<div class="stat-box"><div class="stat-box__value">' + (pop.elderly_pct || '—') + '%</div><div class="stat-box__label">65歳以上</div></div>' +
          '</div></div>';
      }

      // 飲食業専用データセクション
      html += renderDiningDataSections(m);

      html += '</div>';
    });

    html += '</div>';
  }

  resultsContent.innerHTML = html;

  // Chart.jsでグラフ描画
  if (markets.length > 0 && typeof Chart !== 'undefined') {
    setTimeout(function() { renderSummaryCharts(markets); }, 100);
  }
}

// ---- Summary Charts (Chart.js) — 飲食業向け ----
function renderSummaryCharts(markets) {
  var labels = markets.map(function(mkt) {
    return mkt.area ? mkt.area.label : 'エリア';
  });
  var popData = markets.map(function(mkt) { return ((mkt.data||{}).population||{}).total_population||0; });
  var spendData = markets.map(function(mkt) { return ((mkt.data||{}).dining_market||{}).monthly_dining_spend||0; });
  var restData = markets.map(function(mkt) { return ((mkt.data||{}).competition||{}).restaurant_count||0; });
  var lunchData = markets.map(function(mkt) { return ((mkt.data||{}).potential||{}).lunch_demand||0; });

  var chartFont = { color: '#94a3b8', family: 'system-ui' };
  var gridColor = 'rgba(148,163,184,0.1)';

  // Chart 1: 人口 × 外食支出
  var ctx1 = document.getElementById('chart-pop-spend');
  if (ctx1) {
    new Chart(ctx1, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: '人口', data: popData, backgroundColor: 'rgba(239,68,68,0.6)', borderRadius: 6, yAxisID: 'y', order: 2 },
          { label: '月間外食支出(円)', data: spendData, type: 'line', borderColor: '#f97316', backgroundColor: 'rgba(249,115,22,0.15)', pointBackgroundColor: '#f97316', pointRadius: 5, borderWidth: 3, fill: true, yAxisID: 'y1', order: 1 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: chartFont.color, font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: chartFont.color, font: { size: 10 } }, grid: { color: gridColor } },
          y: { position: 'left', ticks: { color: chartFont.color, font: { size: 10 }, callback: function(v) { return v >= 10000 ? (v/10000).toFixed(0)+'万' : v; } }, grid: { color: gridColor } },
          y1: { position: 'right', ticks: { color: '#f97316', font: { size: 10 } }, grid: { display: false } }
        }
      }
    });
  }

  // Chart 2: 飲食店数 × ランチ需要
  var ctx2 = document.getElementById('chart-rest-lunch');
  if (ctx2) {
    new Chart(ctx2, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [
          { label: '飲食店数', data: restData, backgroundColor: 'rgba(239,68,68,0.6)', borderRadius: 6 },
          { label: 'ランチ需要', data: lunchData, backgroundColor: 'rgba(249,115,22,0.6)', borderRadius: 6 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: chartFont.color, font: { size: 11 } } } },
        scales: {
          x: { ticks: { color: chartFont.color, font: { size: 10 } }, grid: { color: gridColor } },
          y: { ticks: { color: chartFont.color, font: { size: 10 } }, grid: { color: gridColor } }
        }
      }
    });
  }
}

// ---- Area Tab Switching ----
function switchAreaTab(idx) {
  var contents = document.querySelectorAll('.area-tab-content');
  contents.forEach(function(el) { el.style.display = 'none'; });
  var target = document.getElementById('area-tab-' + idx);
  if (target) target.style.display = 'block';
  var btns = document.querySelectorAll('.area-tab-btn');
  btns.forEach(function(btn) {
    var btnIdx = parseInt(btn.getAttribute('data-area-idx'));
    if (btnIdx === idx) {
      btn.style.background = 'var(--accent-gradient)';
      btn.style.color = '#fff';
      btn.style.borderColor = 'transparent';
    } else {
      btn.style.background = 'var(--bg-tertiary)';
      btn.style.color = 'var(--text-secondary)';
      btn.style.borderColor = 'rgba(239,68,68,0.15)';
    }
  });
}

// ---- Excel Export (飲食業専用) ----
function exportExcel() {
  if (!analysisData) return;
  var wb = XLSX.utils.book_new();
  var company = analysisData.company || {};
  var markets = analysisData.markets || [];
  var cross = analysisData.crossAreaInsight || {};

  function makeBar(value, maxVal) {
    if (!value || !maxVal) return '';
    var len = Math.round((value / maxVal) * 20);
    var bar = '';
    for (var b = 0; b < len; b++) bar += '█';
    return bar;
  }

  // ===== Sheet 1: 全店サマリー =====
  var s0 = [];
  s0.push(['飲食店エリア比較サマリー — ' + (company.name || '店舗名')]);
  s0.push(['出力日: ' + new Date().toLocaleDateString('ja-JP'), '', '', '', '', '', '', '', '', '分析URL: ' + (analysisData.url || '')]);
  s0.push([]);

  if (markets.length > 0) {
    s0.push(['No', 'エリア名', '人口', '世帯数', '月間外食支出(円)', '飲食店数', '万人あたり店舗', 'チェーン比率(%)', 'ランチ需要', 'ディナー需要', 'ターゲット人口', 'チャンスバー']);

    var lunchMax = 0;
    markets.forEach(function(mkt) {
      var lunch = ((mkt.data||{}).potential||{}).lunch_demand || 0;
      if (lunch > lunchMax) lunchMax = lunch;
    });

    var totPop=0, totHH=0, totSpend=0, totRest=0, totPer=0, totChain=0, totLunch=0, totDinner=0, totTarget=0;
    var cnt = 0;

    var areaRows = [];
    markets.forEach(function(mkt) {
      var d = mkt.data || {};
      var pop = (d.population || {}).total_population || 0;
      var hh = (d.population || {}).households || 0;
      var spend = (d.dining_market || {}).monthly_dining_spend || 0;
      var rest = (d.competition || {}).restaurant_count || 0;
      var per = (d.competition || {}).per_10k_population || 0;
      var chain = (d.competition || {}).chain_ratio_pct || 0;
      var lunch = (d.potential || {}).lunch_demand || 0;
      var dinner = (d.potential || {}).dinner_demand || 0;
      var target = (d.potential || {}).target_population || 0;

      totPop+=pop; totHH+=hh; totSpend+=spend; totRest+=rest; totPer+=per;
      totChain+=chain; totLunch+=lunch; totDinner+=dinner; totTarget+=target;
      cnt++;

      var label = (mkt.area.isHQ ? '🏢 ' : '📍 ') + mkt.area.label;
      areaRows.push([label, pop, hh, spend, rest, per, chain, lunch, dinner, target]);
    });

    areaRows.forEach(function(r, idx) {
      var score = lunchMax > 0 ? Math.round((r[7] / lunchMax) * 100) : 0;
      s0.push([idx+1, r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], makeBar(score, 100) + ' ' + score + '点']);
    });

    var n = cnt || 1;
    s0.push([]);
    s0.push(['', '【合計】', totPop, totHH, totSpend, totRest, '', '', totLunch, totDinner, totTarget, '']);
    s0.push(['', '【平均】', Math.round(totPop/n), Math.round(totHH/n), Math.round(totSpend/n), Math.round(totRest/n),
      (totPer/n).toFixed(1), (totChain/n).toFixed(1), Math.round(totLunch/n), Math.round(totDinner/n), Math.round(totTarget/n), '']);

    s0.push([]);
    s0.push([]);
    s0.push(['■ AI出店戦略分析']);
    s0.push([]);

    if (cross.opportunity_ranking && cross.opportunity_ranking.length > 0) {
      s0.push(['▼ 出店チャンスランキング']);
      s0.push(['順位', 'エリア', 'スコア', '理由']);
      cross.opportunity_ranking.forEach(function(r) {
        s0.push([r.rank || '', r.area || '', r.score || '', r.reason || '']);
      });
      s0.push([]);
    }

    if (cross.strategic_summary) { s0.push(['▼ 出店戦略サマリー']); s0.push([cross.strategic_summary]); s0.push([]); }
    if (cross.sales_advice) { s0.push(['▼ マーケティングアドバイス']); s0.push([cross.sales_advice]); s0.push([]); }
    if (cross.growth_areas) { s0.push(['▼ 成長が見込めるエリア']); s0.push([cross.growth_areas]); s0.push([]); }
    if (cross.risk_areas) { s0.push(['▼ リスク・注意エリア']); s0.push([cross.risk_areas]); }
  }

  var ws0 = XLSX.utils.aoa_to_sheet(s0);
  ws0['!cols'] = [
    { wch: 5 }, { wch: 24 }, { wch: 10 }, { wch: 10 }, { wch: 16 },
    { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 },
    { wch: 12 }, { wch: 28 }
  ];
  ws0['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 11 } }];
  XLSX.utils.book_append_sheet(wb, ws0, '全店サマリー');

  // ===== Sheet 2: 店舗概要 =====
  var s1Data = [
    ['店舗概要 — ' + (company.name || '')],
    ['出力日: ' + new Date().toLocaleDateString('ja-JP')],
    [],
    ['■ 基本情報'],
    ['店舗名', company.name || '—'],
    ['所在地', company.address || '—'],
    ['業態', company.business_type || '—'],
    ['主力メニュー', company.main_services || '—'],
    ['料理ジャンル', company.cuisine_type || '—'],
    ['客単価帯', company.price_range || '—'],
    [],
    ['■ 強み・特徴'],
    [company.strengths || '—'],
    [],
    ['■ 改善余地'],
    [company.weaknesses || '—'],
  ];

  var ws1 = XLSX.utils.aoa_to_sheet(s1Data);
  ws1['!cols'] = [{ wch: 18 }, { wch: 50 }, { wch: 20 }, { wch: 18 }];
  ws1['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
  XLSX.utils.book_append_sheet(wb, ws1, '店舗概要');

  // ===== Sheet 3: 巡回ページ =====
  var crawledPages = (_crawlDebugInfo && _crawlDebugInfo.crawledPages) || [];
  if (crawledPages.length > 0) {
    var s2Data = [['No.', 'ページ名', '文字数', 'URL', '要約']];
    crawledPages.forEach(function(p, i) {
      s2Data.push([i + 1, p.name || '', p.chars || 0, p.url || '', p.summary || '']);
    });
    var ws2 = XLSX.utils.aoa_to_sheet(s2Data);
    ws2['!cols'] = [{ wch: 5 }, { wch: 30 }, { wch: 8 }, { wch: 50 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws2, '巡回ページ');
  }

  // ===== Sheet 4+: エリア別詳細 =====
  if (markets.length > 0) {
    markets.forEach(function(mkt, idx) {
      var m = mkt.data || {};
      var areaLabel = m.area_name || (mkt.area && mkt.area.label) || 'エリア' + (idx + 1);
      var sheetName = areaLabel.slice(0, 28);
      var rows = [];

      rows.push(['飲食市場エリア詳細: ' + areaLabel]);
      rows.push([]);

      if (m.population) {
        var pop = m.population;
        rows.push(['① 人口・世帯データ', '', 'ソース:', pop.source || '推計']);
        rows.push(['総人口', pop.total_population || 0]);
        rows.push(['世帯数', pop.households || 0]);
        rows.push(['20〜50歳比率', (pop.age_20_50_pct || 0) + '%']);
        rows.push(['65歳以上比率', (pop.elderly_pct || 0) + '%']);
        rows.push([]);
      }

      if (m.dining_market) {
        var dm = m.dining_market;
        rows.push(['② 飲食市場データ']);
        rows.push(['月間外食支出/世帯', (dm.monthly_dining_spend || 0) + '円']);
        rows.push(['年間外食支出/世帯', (dm.annual_dining_spend || 0) + '円']);
        rows.push(['食費に占める外食比率', (dm.food_spend_ratio || 0) + '%']);
        rows.push(['平均ランチ単価', (dm.avg_lunch_price || 0) + '円']);
        rows.push(['平均ディナー単価', (dm.avg_dinner_price || 0) + '円']);
        rows.push(['デリバリー需要指数', dm.delivery_demand_index || '—']);
        rows.push(['テイクアウト比率', (dm.takeout_ratio_pct || 0) + '%']);
        rows.push([]);
      }

      if (m.competition) {
        var comp = m.competition;
        rows.push(['③ 競合分析']);
        rows.push(['飲食店総数', (comp.restaurant_count || 0) + '店']);
        rows.push(['万人あたり店舗数', (comp.per_10k_population || 0)]);
        rows.push(['チェーン店比率', (comp.chain_ratio_pct || 0) + '%']);
        rows.push(['同ジャンル店舗数', (comp.same_genre_count || 0) + '店']);
        rows.push(['直近1年新規出店', (comp.new_openings_1yr || 0) + '店']);
        rows.push(['閉店率', (comp.closure_rate_pct || 0) + '%']);
        rows.push([]);
      }

      if (m.consumer_profile) {
        var cp = m.consumer_profile;
        rows.push(['④ 消費者プロファイル']);
        rows.push(['平均世帯年収', (cp.avg_household_income || 0) + '万円']);
        rows.push(['単身世帯率', (cp.single_household_pct || 0) + '%']);
        rows.push(['オフィスワーカー密度', cp.office_worker_density || '—']);
        rows.push(['学生人口', cp.student_population || '—']);
        rows.push(['年間観光客数', cp.tourist_visitors_annual || '—']);
        rows.push([]);
      }

      if (m.potential) {
        var pot = m.potential;
        rows.push(['⑤ 市場ポテンシャル']);
        rows.push(['ターゲット人口', formatNumber(pot.target_population) + '人']);
        rows.push(['日次歩行者数', formatNumber(pot.daily_foot_traffic) + '人/日']);
        rows.push(['ランチ需要', formatNumber(pot.lunch_demand)]);
        rows.push(['ディナー需要', formatNumber(pot.dinner_demand)]);
        rows.push(['週末需要指数', pot.weekend_demand_index || '—']);
        rows.push(['席回転ポテンシャル', (pot.seat_turnover_potential || '—') + '回']);
        if (pot.ai_insight) {
          rows.push([]);
          rows.push(['AIコメント', pot.ai_insight]);
        }
      }

      var ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = [{ wch: 24 }, { wch: 35 }, { wch: 12 }, { wch: 20 }];
      ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }];
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });
  }

  var fileName = '飲食店市場分析_' + (company.name || 'report') + '_' + new Date().toISOString().slice(0, 10) + '.xlsx';
  XLSX.writeFile(wb, fileName);
}

// ---- Reset ----
function resetAll() {
  analysisData = null;
  urlInput.value = '';
  hideResults();
  hideProgress();
  hideError();
  resultsContent.innerHTML = '';
}

// ---- UI Helpers ----
function setLoading(isLoading) {
  analyzeBtn.disabled = isLoading;
  analyzeBtn.classList.toggle('is-loading', isLoading);
}

function showProgress() {
  progressSection.classList.add('is-active');
  document.querySelectorAll('.progress__step').forEach(function(s) {
    s.classList.remove('is-active', 'is-done');
  });
}

function hideProgress() { progressSection.classList.remove('is-active'); }

function activateStep(id) {
  var step = document.getElementById(id);
  if (step) { step.classList.add('is-active'); step.classList.remove('is-done'); }
}

function completeStep(id) {
  var step = document.getElementById(id);
  if (step) { step.classList.remove('is-active'); step.classList.add('is-done'); }
}

function showResults() {
  resultsSection.classList.add('is-active');
  resultsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function hideResults() { resultsSection.classList.remove('is-active'); }

function showError(msg) {
  errorMsg.textContent = msg;
  errorMsg.classList.add('is-active');
}

function hideError() { errorMsg.classList.remove('is-active'); }

// ---- Utility ----
function isValidUrl(string) {
  try {
    var url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (e) { return false; }
}

function escapeHtml(str) {
  if (!str) return '';
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

function formatNumber(num) {
  if (num == null || num === '') return '—';
  return Number(num).toLocaleString('ja-JP');
}

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

// Enter key
urlInput.addEventListener('keypress', function(e) {
  if (e.key === 'Enter') startAnalysis();
});
