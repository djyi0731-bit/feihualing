/* ============================================================
   FHLDB —— 飞花令数据层（本地为主 + 在线补全）
   - 本地核心库 window.POEM_DB 秒开可玩
   - 读取 IndexedDB 缓存（上次在线拉取的诗，离线也可用）
   - 联网时后台从开源 CDN 增量拉取更多诗词 → 繁简转换 → 并入索引 → 写缓存
   - 断网 / 拉取失败：静默降级，不影响本地对战
   数据格式：{t:标题, a:作者, d:朝代, p:[段落...], i:作者头像名|null}
   ============================================================ */
window.FHLDB = (function () {
  const PUNCT = /[，。、？！,.?!；;：:""''「」『』（）()《》<>—\-…·~～·\s]/g;
  const strip = s => (s || "").replace(PUNCT, "");
  const isUnit = u => /^[一-鿿]{4,40}$/.test(u);
  /* 异体字 / 简体异体归一（繁→简已处理大部分，这里补简体异体，如 翦→剪、峯→峰） */
  const ALIAS = { "翦":"剪", "峯":"峰", "蘋":"苹", "裡":"里", "煙":"烟", "餘":"余", "雲":"云", "羣":"群" };
  const norm = s => strip(s).split("").map(c => ALIAS[c] || c).join("");
  function poemUnits(p) {
    const clauses = [];
    (p.p || []).forEach(para => para.split(/[，。、？！；：]/).forEach(c => { const s = strip(c); if (s) clauses.push(s); }));
    const units = [];
    for (let i = 0; i < clauses.length; i += 2) {
      const u = clauses[i] + (i + 1 < clauses.length ? clauses[i + 1] : "");
      if (isUnit(u)) units.push(u);
    }
    return units;
  }

  const DB = [];
  const seen = new Set();                 // 去重键（标题|作者|正文，避免同名不同诗被误删）
  const keyOf = p => p.t + "|" + p.a + "|" + (p.p || []).join("");
  const unitIndex = new Map();            // 联句 -> [诗索引]
  const tokenPoems = new Map();           // 单字 -> Set(诗索引)
  const tokenUnits = new Map();           // 令字 -> [{u,pi}] 候选联（供模糊匹配）
  let TOKENS = [];

  function setTokens(list) { TOKENS = list || []; TOKENS.forEach(t => { if (!tokenUnits.has(t)) tokenUnits.set(t, []); }); }

  /* 增量并入一批诗，返回实际新增数 */
  function addPoems(list) {
    let added = 0;
    (list || []).forEach(p => {
      if (!p || !p.t || !p.a || !Array.isArray(p.p) || !p.p.length) return;
      const key = keyOf(p);
      if (seen.has(key)) return; seen.add(key);
      const pi = DB.length; DB.push(p);
      const units = poemUnits(p).map(norm); p._units = units;
      units.forEach(u => { if (!unitIndex.has(u)) unitIndex.set(u, []); unitIndex.get(u).push(pi); });
      const chars = new Set(); units.forEach(u => [...u].forEach(c => chars.add(c)));
      chars.forEach(c => { if (!tokenPoems.has(c)) tokenPoems.set(c, new Set()); tokenPoems.get(c).add(pi); });
      // 令字候选联（仅 42 令字）
      units.forEach(u => TOKENS.forEach(t => { if (u.includes(t)) tokenUnits.get(t).push({ u, pi }); }));
      added++;
    });
    return added;
  }

  /* 精确匹配（整联）→ 返回 {poem, unit:命中的联}；未中再尝试「包含匹配」 */
  const match = clean => {
    clean = norm(clean);
    const a = unitIndex.get(clean);
    if (a && a.length) return { poem: DB[a[0]], unit: clean };
    return matchContained(clean);
  };
  /* 包含匹配：用户所说里若完整包含某个联单元（子串），即判命中该联。
     解决「三短句连读」（剪不断/理还乱/是离愁）、「多说几字」等自然说法 ≠ 固定两两联单元的问题。
     从最长子串起找，优先命中更完整的一联；最短 5 字，避免短子串巧合误命中。
     半句（不含任何完整联单元）仍不会命中 → 仍被拒。 */
  const MIN_SUB = 5;
  function matchContained(clean) {
    const n = clean.length; if (n < MIN_SUB) return null;
    for (let len = n - 1; len >= MIN_SUB; len--) {
      for (let i = 0; i + len <= n; i++) {
        const sub = clean.slice(i, i + len);
        const a = unitIndex.get(sub);
        if (a && a.length) return { poem: DB[a[0]], unit: sub };
      }
    }
    return null;
  }

  /* 语音容错：编辑距离相似度 */
  function lev(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let dp = new Array(n + 1); for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) { let prev = dp[0]; dp[0] = i;
      for (let j = 1; j <= n; j++) { const t = dp[j]; dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; } }
    return dp[n];
  }
  const sim = (a, b) => { const d = lev(a, b); const mx = Math.max(a.length, b.length) || 1; return 1 - d / mx; };
  const FUZZY_TH = 0.8;
  function fuzzy(clean, token) {
    clean = norm(clean);
    const cands = tokenUnits.get(token) || []; if (!cands.length || !clean) return null;
    let best = null, bestSim = 0;
    for (const { u, pi } of cands) {
      if (Math.abs(u.length - clean.length) > 3) continue;
      const s = sim(clean, u);
      if (s > bestSim) { bestSim = s; best = { u, pi }; }
    }
    return best && bestSim >= FUZZY_TH ? { poem: DB[best.pi], unit: best.u } : null;
  }

  /* 按令字随机取一首（系统接句用），可排除已用标题 */
  function randomByToken(token, usedTitles) {
    const ids = [...(tokenPoems.get(token) || [])];
    if (!ids.length) return null;
    const pool = ids.map(i => DB[i]).filter(p => !usedTitles || !usedTitles.has(p.t));
    const arr = pool.length ? pool : ids.map(i => DB[i]);
    return arr[Math.floor(Math.random() * arr.length)];
  }

  const stats = () => ({ poems: DB.length, units: unitIndex.size, tokens: TOKENS.length });

  /* ---------------- IndexedDB 缓存（在线拉取的诗） ---------------- */
  const IDB_NAME = "fhl_db", IDB_STORE = "remote_poems", IDB_VER = 1;
  function idbOpen() {
    return new Promise((res, rej) => {
      if (!("indexedDB" in window)) return rej(new Error("no-idb"));
      const rq = indexedDB.open(IDB_NAME, IDB_VER);
      rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: "k" }); };
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
  }
  async function idbLoadAll() {
    try {
      const db = await idbOpen();
      return await new Promise((res) => {
        const tx = db.transaction(IDB_STORE, "readonly").objectStore(IDB_STORE).getAll();
        tx.onsuccess = () => res((tx.result || []).map(r => r.v)); tx.onerror = () => res([]);
      });
    } catch (_) { return []; }
  }
  async function idbSave(list) {
    try {
      const db = await idbOpen();
      await new Promise((res) => {
        const st = db.transaction(IDB_STORE, "readwrite").objectStore(IDB_STORE);
        list.forEach(p => { try { st.put({ k: keyOf(p), v: p }); } catch (_) {} });
        st.transaction.oncomplete = () => res(); st.transaction.onerror = () => res();
      });
    } catch (_) {}
  }

  /* ---------------- 在线补全（CDN 增量拉取 + 繁简转换） ---------------- */
  // 默认远程源：chinese-poetry 开源库（jsDelivr CDN，支持 CORS）。按序尝试，失败跳过。
  const CDN = "https://cdn.jsdelivr.net/gh/chinese-poetry/chinese-poetry@master/";
  // 本地已内置全量唐诗(58片)+宋词(22片)+宋诗+元曲+诗经，默认无需在线补全。
  // 如需扩充其它库（如更多宋诗分片 poet.song.N.json），在此按格式追加即可；重复会自动去重。
  const REMOTE_SOURCES = [];
  const AUTHOR_IMG = { "李白":"libai","杜甫":"dufu","苏轼":"sushi","王维":"wangwei","白居易":"baijuyi","柳宗元":"liuzongyuan","王之涣":"wangzhihuan","孟浩然":"menghaoran","王安石":"wanganshi","张籍":"zhangji","张九龄":"zhangjiuling","李煜":"liyu","杜牧":"dumu","陆游":"luyou","崔颢":"cuihao","贾岛":"jiadao","刘禹锡":"liuyuxi","李峤":"liqiao","韩愈":"hanyu","李商隐":"lishangyin","叶绍翁":"yeshaoweng","崔护":"cuihu","李清照":"liqingzhao","辛弃疾":"xinqiji","柳永":"liuyong","晏殊":"yanshu","欧阳修":"ouyangxiu","秦观":"qinguan","岳飞":"yuefei" };

  let _t2sMap = null;
  async function loadT2S() {
    if (_t2sMap) return _t2sMap;
    try { const r = await fetch("tsc.json"); _t2sMap = await r.json(); } catch (_) { _t2sMap = {}; }
    return _t2sMap;
  }
  function t2s(map, s) { return [...String(s || "")].map(c => map[c] || c).join(""); }

  function normalize(map, raw, src) {
    // chinese-poetry：poet 用 {title,author,paragraphs}；ci 用 {rhythmic/title,author,paragraphs}
    const out = [];
    (raw || []).forEach(o => {
      const title = t2s(map, o.title || o.rhythmic || "");
      const author = t2s(map, o.author || "佚名") || "佚名";
      const p = (o.paragraphs || []).map(x => t2s(map, x)).filter(Boolean);
      if (title && p.length) out.push({ t: title, a: author, d: src.d, p, i: AUTHOR_IMG[author] || null });
    });
    return out;
  }

  let syncing = false;
  async function syncRemote(onProgress) {
    if (syncing) return; syncing = true;
    if (!navigator.onLine) { syncing = false; onProgress && onProgress({ done: true, offline: true, ...stats() }); return; }
    let map;
    try { map = await loadT2S(); } catch (_) { map = {}; }
    let totalAdded = 0;
    for (const src of REMOTE_SOURCES) {
      try {
        const r = await fetch(CDN + encodeURI(src.url), { cache: "force-cache" });
        if (!r.ok) continue;
        const raw = await r.json();
        const list = normalize(map, raw, src);
        const added = addPoems(list);
        totalAdded += added;
        if (added) { idbSave(list); onProgress && onProgress({ done: false, added, ...stats() }); }
      } catch (_) { /* 单源失败跳过 */ }
    }
    syncing = false;
    onProgress && onProgress({ done: true, totalAdded, ...stats() });
  }

  /* ---------------- 启动 ---------------- */
  async function init(tokens, onReady) {
    setTokens(tokens);
    addPoems(window.POEM_DB || []);          // 1) 本地核心库
    const cached = await idbLoadAll();        // 2) 上次在线拉取的缓存
    if (cached.length) addPoems(cached);
    onReady && onReady(stats());
  }

  return { init, setTokens, addPoems, match, fuzzy, randomByToken, stats, syncRemote, norm,
           get size() { return DB.length; } };
})();
