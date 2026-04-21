(() => {
  try {
    if (window.safeHudCleanup) window.safeHudCleanup();
  } catch (e) {}

  const MSG = {
    UPDATE: 'SAFE_HUD_UPDATE',
    PLAY: 'SAFE_HUD_PLAY',
    STOP_SEVERE: 'SAFE_HUD_STOP_SEVERE',
    SETTINGS_CHANGED: 'SAFE_HUD_SETTINGS_CHANGED',
  };

  /** Ağır alarm sekansı bitene kadar (ms) — fiyat yukarı dönünce susturmak için; süre çarpanı ile uzar */
  const SEVERE_PLAYBACK_WINDOW_MS = 14000;

  /** Kayar pencere: son 3 dakikadaki zirveden bugüne düşüş (USD) alarm şiddetini belirler */
  const PRICE_ROLLING_WINDOW_MS = 1 * 60 * 1000;
  /** Bu düşüşte tam “güçlü” ölçek kabul edilir (üstü daha da artar, tavan kodda) */
  const SEVERE_DROP_REF_USD = 200;

  /**
   * @description Nuxt risk header içindeki cüzdan tutarı (.value).
   * `.ready` yoksa yedek seçici denenir. `settings.walletSelector` doluysa önce o kullanılır.
   */
  const WALLET_SELECTOR =
    '#__nuxt > div > div:nth-child(2) > div > div.content-wrapper.common-scroll-bar.x-scroll.ready > div > div > section:nth-child(3) > div > div.account-info-wrapper > section > div.module-content > div.risk-header > div:nth-child(4) > div.value';

  const WALLET_SELECTOR_FALLBACK = WALLET_SELECTOR.replace(
    'common-scroll-bar.x-scroll.ready',
    'common-scroll-bar.x-scroll',
  );

  const SELECTORS = {
    coinNames: '.symbol-name-wrapper',
    pnlRoots: '.unrealized-pnl-value',
  };

  const STORAGE_KEY = 'safe_hud_settings_multi_v2';
  const LAUNCHER_TOAST_ID = 'safe-hud-launcher-toast';

  const defaults = {
    walletFontSize: 64,
    pnlFontSize: 26,
    coinFontSize: 28,
    hideOriginals: false,

    hudWalletFontSize: 32,
    hudCoinFontSize: 16,
    hudPnlFontSize: 14,
    hudPctFontSize: 15,
    hudWidth: 220,
    hudGap: 2,

    severeEnabled: true,
    happyEnabled: true,
    /** @description 50’lik banda girince değil, band + bu USD (ör. 1500 → 1505+) ile yükseliş sesi */
    happyUpBufferUsd: 5,
    severeVolume: 0.06,
    happyVolume: 0.06,
    severeStart: 3000,
    severeStep: 50,
    rearmOffset: 5,

    panelCollapsed: false,
    hudLeft: 16,
    hudTop: 16,
    settingsLeft: null,
    settingsTop: null,

    walletSelector: '',
    coinSelector: '',
    pnlSelector: '',

    /** @description HUD pozisyon sırası: none | pnl-desc (kârdan zarara) | pnl-asc (zarardan kara) */
    hudPnlSort: 'pnl-desc',

    /** @description Ofis: görev çubuğu başlığı ve sade görünüm */
    privacyOfficeMode: false,
    /** @description Gizlilikte coin yerine Kalem 1, Kalem 2… */
    maskRowLabels: true,
    discreetWindowTitle: 'Çalışma özeti',
  };

  const settings = { ...defaults };

  function loadSettingsIntoSettings() {
    try {
      Object.assign(settings, defaults, JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
    } catch {
      Object.assign(settings, defaults);
    }
  }

  loadSettingsIntoSettings();

  const state = {
    timer: null,
    lastWalletPrice: null,
    armedLevels: new Set(),
    hudWindow: null,
    /** @description true iken veri döngüsü popup penceresinde çalışır (ana sekme arka planda kısılsa bile). */
    popupPollsOpener: false,
    pendingSounds: [],
    popupWinRef: null,
    /** @description performance.now() — ağır alarm çalarken fiyat yukarı çıkınca susturulur */
    severePlaybackUntil: 0,
    /** @description { t: epochMs, p: number } — son ~3 dk cüzdan örnekleri */
    priceHistory: [],
    /** @description Tampon eşiği (örn. 1505) için ses çalındı; fiyat eşiğin altına inene kadar tekrar yok */
    happyLatchedThresholds: new Set(),
  };

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }

  function qs(sel) {
    if (!sel || !String(sel).trim()) return null;
    try {
      return document.querySelector(sel);
    } catch {
      return null;
    }
  }

  function qsa(sel) {
    if (!sel || !String(sel).trim()) return [];
    try {
      return [...document.querySelectorAll(sel)];
    } catch {
      return [];
    }
  }

  function getWalletElement() {
    const custom = (settings.walletSelector || '').trim();
    if (custom) {
      const el = qs(custom);
      if (el) return el;
    }
    return qs(WALLET_SELECTOR) || qs(WALLET_SELECTOR_FALLBACK);
  }

  function getCoinEls() {
    const s = (settings.coinSelector || '').trim();
    return qsa(s || SELECTORS.coinNames);
  }

  function getPnlEls() {
    const s = (settings.pnlSelector || '').trim();
    return qsa(s || SELECTORS.pnlRoots);
  }

  function cleanCoinName(text) {
    return (text || '').replace(/USDT/gi, '').trim() || '-';
  }

  function parseNumber(text) {
    const normalized = (text || '').replace(/[^0-9.,-]/g, '').replace(/,/g, '');
    const n = parseFloat(normalized);
    return Number.isFinite(n) ? n : null;
  }

  function getWalletText() {
    return getWalletElement()?.textContent?.trim() || '-';
  }

  /**
   * @description HUD cüzdan satırı: USD kaldırır, son `.` ve sonrasını (kuruş) göstermez.
   */
  function formatHudWalletDisplay(raw) {
    let t = String(raw ?? '').trim();
    if (!t || t === '-') return '-';
    t = t.replace(/\bUSD\b/gi, '').replace(/\s+/g, ' ').trim();
    const dot = t.lastIndexOf('.');
    if (dot !== -1) {
      t = t.slice(0, dot).trim();
    }
    return t || '-';
  }

  /** @description HUD’da renk işaret ettiği için + / - karakterlerini göstermez. */
  function formatHudStripSignChars(raw) {
    const t = String(raw ?? '').trim();
    if (!t || t === '-') return '';
    return t.replace(/[+\-]/g, '');
  }

  function getWalletPrice() {
    return parseNumber(getWalletText());
  }

  function getAllCoins() {
    return getCoinEls()
      .map((el) => cleanCoinName(el.textContent.trim()))
      .filter(Boolean);
  }

  function getAllPnlRows() {
    return getPnlEls().map((root) => {
      const txt = root.textContent.replace(/\s+/g, ' ').trim();
      const numMatch = txt.match(/([+\-]?\d+(?:\.\d+)?)/);
      const pctMatch = txt.match(/\(([+\-]?\d+(?:\.\d+)?%)\)/);

      return {
        pnl: numMatch ? numMatch[1] : '',
        pct: pctMatch ? pctMatch[1] : '',
      };
    });
  }

  /**
   * @description Pozisyon listesini PnL sayısal değerine göre sıralar.
   * @param rows - Ham satırlar
   * @param sortMode - none | pnl-desc | pnl-asc
   */
  function sortPositionsByPnlPreference(rows, sortMode) {
    if (sortMode !== 'pnl-desc' && sortMode !== 'pnl-asc') return rows;
    const copy = [...rows];
    copy.sort((a, b) => {
      const na = parseNumber(String(a.pnl));
      const nb = parseNumber(String(b.pnl));
      const aNaN = na == null ? 1 : 0;
      const bNaN = nb == null ? 1 : 0;
      if (aNaN !== bNaN) return aNaN - bNaN;
      if (na == null) return 0;
      if (sortMode === 'pnl-desc') return nb - na;
      return na - nb;
    });
    return copy;
  }

  function getPositions() {
    const coins = getAllCoins();
    const pnls = getAllPnlRows();
    const maxLen = Math.max(coins.length, pnls.length);

    const result = [];
    for (let i = 0; i < maxLen; i++) {
      result.push({
        coin: coins[i] || '-',
        pnl: pnls[i]?.pnl || '',
        pct: pnls[i]?.pct || '',
      });
    }
    return sortPositionsByPnlPreference(result, settings.hudPnlSort || 'none');
  }

  function applyOriginalFontStyles() {
    const walletEl = getWalletElement();
    if (walletEl) {
      walletEl.style.fontSize = `${settings.walletFontSize}px`;
      walletEl.style.lineHeight = '1';
      walletEl.style.fontWeight = '800';
      walletEl.style.letterSpacing = '-1px';
    }

    getCoinEls().forEach((el) => {
      el.style.fontSize = `${settings.coinFontSize}px`;
      el.style.fontWeight = '800';
      el.style.lineHeight = '1.05';
      el.textContent = cleanCoinName(el.textContent.trim());
    });

    getPnlEls().forEach((el) => {
      el.style.fontSize = `${settings.pnlFontSize}px`;
      el.style.fontWeight = '700';
      el.style.lineHeight = '1.05';
    });

    qsa(
      '.unrealized-pnl-value .dynamic-text, .unrealized-pnl-value .tip-container, .unrealized-pnl-value .container-text, .unrealized-pnl-value .number',
    ).forEach((el) => {
      el.style.fontSize = `${settings.pnlFontSize}px`;
      el.style.fontWeight = '700';
      el.style.lineHeight = '1.05';
    });
  }

  function applyOriginalVisibility() {
    getCoinEls().forEach((el) => {
      el.style.visibility = settings.hideOriginals ? 'hidden' : '';
      el.style.pointerEvents = settings.hideOriginals ? 'none' : '';
    });

    getPnlEls().forEach((el) => {
      el.style.visibility = settings.hideOriginals ? 'hidden' : '';
      el.style.pointerEvents = settings.hideOriginals ? 'none' : '';
    });

    const walletContainer = getWalletElement()?.parentElement;
    if (walletContainer) {
      walletContainer.style.visibility = settings.hideOriginals ? 'hidden' : '';
      walletContainer.style.pointerEvents = settings.hideOriginals ? 'none' : '';
    }
  }

  function postToPopup(payload) {
    try {
      if (state.hudWindow && !state.hudWindow.closed) {
        state.hudWindow.postMessage(payload, '*');
      }
    } catch (e) {}
  }

  /**
   * @description Son penceredeki zirveden `price`’a kadar düşüş (USD).
   * @param price - Anlık cüzdan sayısı
   * @param windowMs - Kayar pencere süresi (ms)
   */
  function getDropUsdInRollingWindow(price, windowMs) {
    if (price == null || !Number.isFinite(price)) return 0;
    const now = Date.now();
    const cutoff = now - windowMs;
    let peak = price;
    for (const row of state.priceHistory) {
      if (row.t >= cutoff && row.p > peak) peak = row.p;
    }
    return Math.max(0, peak - price);
  }

  /**
   * @description 3 dk içindeki düşüşe göre ağır alarm şiddeti ve süresi çarpanları.
   * @param dropUsd - `SEVERE_DROP_REF_USD` ile ölçeklenir
   */
  function computeSevereScalingFromDrop(dropUsd) {
    const r = SEVERE_DROP_REF_USD > 0 ? dropUsd / SEVERE_DROP_REF_USD : 0;
    const t = Math.min(2.8, Math.max(0, r));
    const intensityMul = Math.min(2.45, Math.max(0.62, 0.62 + t * 0.58));
    const durationMul = Math.min(2.1, Math.max(1, 1 + t * 0.42));
    return { intensityMul, durationMul };
  }

  function recordPriceSample(price) {
    if (price == null || !Number.isFinite(price)) return;
    const t = Date.now();
    state.priceHistory.push({ t, p: price });
    const cutoff = t - PRICE_ROLLING_WINDOW_MS - 5000;
    state.priceHistory = state.priceHistory.filter((row) => row.t >= cutoff);
  }

  /**
   * @description Alarm sesi: popup kendi poll’unda iken kuyruğa alınır, aksi halde postMessage ile gönderilir.
   * @param sound - severe (yükseliş bandı da aynı acil sekans; meta ile ayırt edilir)
   * @param meta - `computeSevereScalingFromDrop` çıktısı; `skipRecoveryStopWindow` true iken fiyat artışında kesilmez
   */
  function emitPlaySound(sound, meta = {}) {
    if (sound !== 'severe') return;

    const durationMul = meta.durationMul ?? 1;
    const skipRecoveryStopWindow = !!meta.skipRecoveryStopWindow;
    if (skipRecoveryStopWindow) {
      state.severePlaybackUntil = 0;
    } else {
      state.severePlaybackUntil = performance.now() + SEVERE_PLAYBACK_WINDOW_MS * durationMul;
    }
    const play = {
      sound: 'severe',
      intensityMul: meta.intensityMul ?? 1,
      durationMul,
      skipRecoveryStopWindow,
      quickRepeatCooldown: !!meta.quickRepeatCooldown,
    };
    if (state.popupPollsOpener) {
      state.pendingSounds.push(play);
    } else {
      postToPopup({ type: MSG.PLAY, ...play });
    }
  }

  /**
   * @description Çalan ağır alarmı anında keser (popup veya mesaj yolu).
   */
  function notifyStopSevere() {
    try {
      if (state.popupPollsOpener && state.popupWinRef && !state.popupWinRef.closed) {
        state.popupWinRef.postMessage({ type: MSG.STOP_SEVERE }, '*');
      } else if (state.hudWindow && !state.hudWindow.closed) {
        state.hudWindow.postMessage({ type: MSG.STOP_SEVERE }, '*');
      }
    } catch (e) {}
  }

  /** @description `severeStep` için güvenli pozitif tam sayı adım. */
  function getSevereStep() {
    const s = Math.round(Number(settings.severeStep) || 50);
    return Math.max(1, s);
  }

  /**
   * @description Aşağı taranacak en üst eşik (adımın katı). Cüzdan `severeStart` üstündeyken de kademeler (ör. 2650) listeye girer.
   * @param priceCandidates - Örn. anlık cüzdan veya prev+current
   */
  function getSevereGridTopAligned(...priceCandidates) {
    const step = getSevereStep();
    const nums = priceCandidates.filter((p) => p != null && Number.isFinite(p));
    const rawTop = nums.length ? Math.max(settings.severeStart, ...nums) : settings.severeStart;
    return Math.ceil(rawTop / step) * step;
  }

  function updateArmedLevels(price) {
    if (price == null) return;
    const step = getSevereStep();
    const top = getSevereGridTopAligned(price);
    for (let level = top; level >= 0; level -= step) {
      if (price >= level + settings.rearmOffset) {
        state.armedLevels.add(level);
      }
    }
  }

  function checkSevereCrossings(prevPrice, currentPrice) {
    if (!settings.severeEnabled) return;
    if (prevPrice == null || currentPrice == null) return;
    if (!(currentPrice < prevPrice)) return;

    /** Bir fiyat güncellemesinde yalnızca tek alarm; aksi halde birden fazla eşik aşılınca sesler üst üste biner. */
    let severePlayedThisTick = false;
    const step = getSevereStep();
    const top = getSevereGridTopAligned(prevPrice, currentPrice);
    for (let level = top; level >= 0; level -= step) {
      const crossed = prevPrice > level && currentPrice <= level;
      if (state.armedLevels.has(level) && crossed) {
        if (!severePlayedThisTick) {
          const dropUsd = getDropUsdInRollingWindow(currentPrice, PRICE_ROLLING_WINDOW_MS);
          const scale = computeSevereScalingFromDrop(dropUsd);
          emitPlaySound('severe', scale);
          severePlayedThisTick = true;
        }
        state.armedLevels.delete(level);
      }
    }
  }

  /**
   * @description 50 USD’lik yükseliş bandında ses: yalnızca `band + tampon` üstüne çıkınca (ör. 1500 → en az 1505). Sınırı yalayarak tekrar çalmasın diye tampon eşiği latch’lenir.
   * @param prevPrice - Bir önceki tick cüzdan USD
   * @param currentPrice - Şimdiki tick
   */
  function checkHappy50Up(prevPrice, currentPrice) {
    if (prevPrice == null || currentPrice == null) return;

    const bufRaw = Number(settings.happyUpBufferUsd);
    const buf =
      Number.isFinite(bufRaw) && bufRaw >= 0 ? Math.min(100, bufRaw) : 5;

    for (const thr of [...state.happyLatchedThresholds]) {
      if (currentPrice < thr) {
        state.happyLatchedThresholds.delete(thr);
      }
    }

    if (!settings.happyEnabled) return;
    if (!settings.severeEnabled) return;

    if (!(currentPrice > prevPrice)) return;

    const prev50 = Math.floor(prevPrice / 50) * 50;
    const curr50 = Math.floor(currentPrice / 50) * 50;

    /** Büyük sıçramada onlarca “mutlu” üst üste binmesin; tick başına en fazla 3. */
    let happyCount = 0;
    const maxHappyPerTick = 3;

    const tryEmitForThreshold = (threshold) => {
      if (happyCount >= maxHappyPerTick) return;
      if (state.happyLatchedThresholds.has(threshold)) return;
      if (prevPrice < threshold && currentPrice >= threshold) {
        emitPlaySound('severe', {
          intensityMul: 1,
          durationMul: 1,
          skipRecoveryStopWindow: true,
          quickRepeatCooldown: true,
        });
        state.happyLatchedThresholds.add(threshold);
        happyCount += 1;
      }
    };

    if (curr50 > prev50) {
      for (let level = prev50 + 50; level <= curr50; level += 50) {
        tryEmitForThreshold(level + buf);
      }
    } else if (curr50 === prev50) {
      tryEmitForThreshold(curr50 + buf);
    }
  }

  /**
   * @description Kritik eşik kaydırıldığında popup veya dışarıdan çağrılır.
   */
  window.safeHudRearmFromSevereSlider = () => {
    state.armedLevels.clear();
    const currentPrice = getWalletPrice();
    if (currentPrice != null) {
      updateArmedLevels(currentPrice);
    }
  };

  window.safeHudInvalidateDom = () => {
    /* Ayarlar / seçici değişince bir sonraki tick yeniden okur */
  };

  window.safeHudGetWalletPrice = () => getWalletPrice();

  /**
   * @description Popup’tan “ölçekli uyarı” testi: opener’daki son 3 dk fiyat geçmişi + anlık cüzdan ile aynı çarpanlar.
   * @returns intensityMul, durationMul, dropUsd
   */
  window.safeHudGetSevereTestScaling = () => {
    try {
      loadSettingsIntoSettings();
      const p = getWalletPrice();
      if (p == null || !Number.isFinite(p)) {
        return { intensityMul: 1, durationMul: 1, dropUsd: 0 };
      }
      const dropUsd = getDropUsdInRollingWindow(p, PRICE_ROLLING_WINDOW_MS);
      const scale = computeSevereScalingFromDrop(dropUsd);
      return { ...scale, dropUsd };
    } catch (e) {
      return { intensityMul: 1, durationMul: 1, dropUsd: 0 };
    }
  };

  /**
   * @description Popup ve ana sayfa ayar paneli için ortak CSS metni.
   */
  function getSafeHudChromeCss() {
    return `
      #sh-app { min-height:100vh; background:var(--sh-bg,#0f1419); color:var(--sh-text,#e8eaed); }
      #sh-app.sh-privacy { --sh-up:#aab4c5; --sh-down:#aab4c5; }
      :root { --sh-bg:#0f1419; --sh-card:#151c26; --sh-card2:#1c2636; --sh-line:#2a3548; --sh-text:#e8eaed; --sh-muted:#8b98ab; --sh-accent:#2f6fbe; --sh-up:#3ecf8e; --sh-down:#f07178; }
      .sh-top { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding:14px 18px;
        background:linear-gradient(168deg,#1e2a3d 0%,#121820 55%); border-bottom:1px solid var(--sh-line); box-shadow:inset 0 1px 0 rgba(255,255,255,0.04); }
      .sh-top-left { display:flex; align-items:center; gap:12px; min-width:0; }
      .sh-dot { width:10px; height:10px; border-radius:50%; flex-shrink:0; background:linear-gradient(135deg,#5ad48f,var(--sh-accent)); box-shadow:0 0 14px rgba(47,111,190,0.35); }
      .sh-top-title { font-size:15px; font-weight:650; letter-spacing:-0.02em; }
      .sh-top-hint { font-size:11px; color:var(--sh-muted); max-width:min(380px,92vw); line-height:1.35; }
      .sh-btn { border:0; border-radius:10px; padding:9px 14px; font-size:13px; font-weight:600; cursor:pointer; transition:opacity .15s, transform .1s; }
      .sh-btn:active { transform:scale(0.98); }
      .sh-btn-primary { background:linear-gradient(180deg,#3a7bd5,#2a5fad); color:#fff; box-shadow:0 4px 14px rgba(42,95,173,0.35); }
      .sh-btn-quiet { background:#2a3548; color:var(--sh-text); }
      .sh-card { margin:14px 16px; background:var(--sh-card); border:1px solid var(--sh-line); border-radius:14px; overflow:hidden; box-shadow:0 12px 40px rgba(0,0,0,0.25); }
      .sh-card-h { padding:12px 16px; background:rgba(255,255,255,0.03); border-bottom:1px solid var(--sh-line); display:flex; justify-content:space-between; align-items:center; gap:8px; }
      .sh-card-h strong { font-size:14px; letter-spacing:-0.01em; }
      .sh-card-body { padding:14px 16px 16px; }
      .sh-grid { display:grid; grid-template-columns:1fr auto; gap:10px 12px; align-items:center; font-size:13px; }
      .sh-grid label { color:var(--sh-muted); }
      .sh-inp, .sh-select { width:100%; max-width:100%; padding:8px 10px; border-radius:8px; border:1px solid var(--sh-line); background:#0d1219; color:var(--sh-text); box-sizing:border-box; font-size:13px; }
      .sh-hud { margin:0 16px 20px; padding:16px 18px; background:linear-gradient(180deg,#121a24,#0e141c); border:1px solid var(--sh-line); border-radius:16px; box-sizing:border-box; overflow:hidden;
        box-shadow:0 8px 32px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.03); }
      .sh-hud-label { font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:var(--sh-muted); margin-bottom:8px; }
      .sh-hud-wallet { font-weight:800; line-height:1.08; margin-bottom:12px; letter-spacing:-0.02em; }
      #safe-hud-positions { width:100%; max-width:100%; min-width:0; box-sizing:border-box; }
      .sh-row { display:flex; justify-content:space-between; align-items:flex-end; gap:10px; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.06);
        width:100%; max-width:100%; min-width:0; box-sizing:border-box; overflow:hidden; }
      .sh-row:last-child { border-bottom:0; }
      .sh-status { margin-top:12px; font-size:11px; color:var(--sh-muted); }
    `;
  }

  /**
   * @description Ortak stilleri belirtilen belgeye bir kez enjekte eder.
   */
  function injectChromeStylesDoc(doc, styleId) {
    if (doc.getElementById(styleId)) return;
    const st = doc.createElement('style');
    st.id = styleId;
    st.textContent = getSafeHudChromeCss();
    doc.head.appendChild(st);
  }

  function injectPopupChromeStyles(doc) {
    injectChromeStylesDoc(doc, 'safe-popup-chrome-css');
  }

  function injectMainChromeStyles(doc) {
    injectChromeStylesDoc(doc, 'safe-hud-main-chrome-css');
  }

  /**
   * @description Ana penceredeki ayar formunun HTML’i (sadece gövde içeriği).
   */
  function buildMainSettingsFormHtml(s) {
    const wSel = String(s.walletSelector || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
    const cSel = String(s.coinSelector || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
    const pSel = String(s.pnlSelector || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
    const dTitle = String(s.discreetWindowTitle || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');

    return `
    <p style="margin:0 0 12px;font-size:12px;color:var(--sh-muted);line-height:1.45;">Seçiciler boşsa varsayılan site yolları kullanılır.</p>
    <label style="display:block;font-size:11px;color:var(--sh-muted);margin-bottom:4px;">Cüzdan CSS</label>
    <input id="safe-wallet-selector" class="sh-inp" type="text" value="${wSel}" placeholder="Boş = varsayılan yol" style="margin-bottom:10px;">
    <label style="display:block;font-size:11px;color:var(--sh-muted);margin-bottom:4px;">Coin CSS</label>
    <input id="safe-coin-selector" class="sh-inp" type="text" value="${cSel}" placeholder=".symbol-name-wrapper" style="margin-bottom:10px;">
    <label style="display:block;font-size:11px;color:var(--sh-muted);margin-bottom:4px;">PnL kök CSS</label>
    <input id="safe-pnl-selector" class="sh-inp" type="text" value="${pSel}" placeholder=".unrealized-pnl-value" style="margin-bottom:14px;">

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;">
      <button type="button" class="sh-btn sh-btn-quiet" id="safe-test-happy">Ses testi (yükseliş)</button>
      <button type="button" class="sh-btn sh-btn-quiet" id="safe-test-severe" title="Sabit 1× şiddet / süre">Uyarı (basit)</button>
      <button type="button" class="sh-btn sh-btn-quiet" id="safe-test-severe-scaled" title="Kaynak sekmede son 3 dk düşüşüne göre">Uyarı (ölçekli)</button>
      <button type="button" class="sh-btn sh-btn-quiet" id="safe-test-severe-demo-max" title="Yaklaşık maksimum süre ve şiddet">Uyarı (max örnek)</button>
    </div>

    <div class="sh-grid">
      <label style="grid-column:1/-1;font-weight:600;color:var(--sh-text);">Gizlilik (yan monitör)</label>
      <label>Ofis modu</label>
      <input id="safe-privacy-office" type="checkbox" ${s.privacyOfficeMode ? 'checked' : ''} title="Sade renkler, nötr sekme başlığı, isteğe bağlı maskeleme">
      <label>Coin maskele</label>
      <input id="safe-privacy-mask" type="checkbox" ${s.maskRowLabels ? 'checked' : ''}>
      <label style="grid-column:1/-1;margin-top:6px;">Sekme başlığı</label>
      <input id="safe-discreet-title" class="sh-inp" type="text" value="${dTitle}" placeholder="Çalışma özeti" style="grid-column:1/-1;margin-bottom:8px;">
      <label>Orijinalleri gizle</label>
      <input id="safe-hide-originals" type="checkbox" ${s.hideOriginals ? 'checked' : ''}>
      <label>Ağır alarm</label>
      <input id="safe-severe-enabled" type="checkbox" ${s.severeEnabled ? 'checked' : ''}>
      <label>50 yükseliş sesi</label>
      <input id="safe-happy-enabled" type="checkbox" ${s.happyEnabled ? 'checked' : ''}>
      <label>Yükseliş tamponu (USD)</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-happy-buffer" type="range" min="0" max="25" step="1" value="${Number.isFinite(s.happyUpBufferUsd) ? s.happyUpBufferUsd : 5}">
        <span id="safe-happy-buffer-val">${Number.isFinite(s.happyUpBufferUsd) ? s.happyUpBufferUsd : 5}</span>
      </div>
      <label>Ağır ses</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-severe-volume" type="range" min="0" max="1" step="0.01" value="${s.severeVolume}">
        <span id="safe-severe-volume-val">${s.severeVolume.toFixed(2)}</span>
      </div>
      <label>Mutlu ses</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-happy-volume" type="range" min="0" max="1" step="0.01" value="${s.happyVolume}">
        <span id="safe-happy-volume-val">${s.happyVolume.toFixed(2)}</span>
      </div>
      <label>HUD coin font</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-coin-font" type="range" min="16" max="64" step="1" value="${s.hudCoinFontSize}">
        <span id="safe-coin-font-val">${s.hudCoinFontSize}px</span>
      </div>
      <label>HUD pnl font</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-pnl-font" type="range" min="14" max="56" step="1" value="${s.hudPnlFontSize}">
        <span id="safe-pnl-font-val">${s.hudPnlFontSize}px</span>
      </div>
      <label>HUD yüzde font</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-pct-font" type="range" min="10" max="40" step="1" value="${s.hudPctFontSize}">
        <span id="safe-pct-font-val">${s.hudPctFontSize}px</span>
      </div>
      <label>HUD cüzdan font</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-wallet-font" type="range" min="18" max="90" step="1" value="${s.hudWalletFontSize}">
        <span id="safe-wallet-font-val">${s.hudWalletFontSize}px</span>
      </div>
      <label>HUD genişlik</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-hud-width" type="range" min="220" max="520" step="1" value="${s.hudWidth}">
        <span id="safe-hud-width-val">${s.hudWidth}px</span>
      </div>
      <label>HUD satır boşluğu</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-hud-gap" type="range" min="2" max="20" step="1" value="${s.hudGap}">
        <span id="safe-hud-gap-val">${s.hudGap}px</span>
      </div>
      <label>HUD PnL sırası</label>
      <select id="safe-hud-pnl-sort" class="sh-select" style="max-width:240px;">
        <option value="none" ${(s.hudPnlSort || 'none') === 'none' ? 'selected' : ''}>Sayfa sırası</option>
        <option value="pnl-desc" ${s.hudPnlSort === 'pnl-desc' ? 'selected' : ''}>PnL: yüksek → düşük</option>
        <option value="pnl-asc" ${s.hudPnlSort === 'pnl-asc' ? 'selected' : ''}>PnL: düşük → yüksek</option>
      </select>
      <label>Kritik eşik</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-severe-start" type="range" min="500" max="3000" step="50" value="${s.severeStart}">
        <span id="safe-severe-start-val">${s.severeStart}</span>
      </div>
    </div>`;
  }

  /**
   * @description Yalnızca canlı özet HUD’u (ikinci pencere).
   */
  function buildHudPopupHtml(s) {
    return `
<div id="sh-app" class="${s.privacyOfficeMode ? 'sh-privacy' : ''}">
  <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;background:var(--sh-card);border-bottom:1px solid var(--sh-line);">
    <span style="font-size:12px;color:var(--sh-muted);">Ses için tıklayın</span>
    <button type="button" class="sh-btn sh-btn-primary" id="safe-popup-focus-opener" style="padding:6px 12px;font-size:12px;">Kaynak sekmesi</button>
  </div>
  <div id="safe-hud-display" class="sh-hud" style="width:${s.hudWidth}px;margin:12px auto 16px;">
    <div class="sh-hud-label" id="safe-hud-main-label">Canlı özet</div>
    <div id="safe-hud-wallet" class="sh-hud-wallet">-</div>
    <div id="safe-hud-positions" style="display:flex;flex-direction:column;gap:${s.hudGap}px;width:100%;max-width:100%;min-width:0;box-sizing:border-box;"></div>
    <div id="safe-hud-status" class="sh-status"></div>
  </div>
</div>`;
  }

  /**
   * @description Ayarlar kaydedilince ana bellek + HUD penceresi güncellenir.
   */
  function notifyHudSettingsChanged() {
    loadSettingsIntoSettings();
    try {
      const w = state.hudWindow;
      if (w && !w.closed) {
        w.postMessage({ type: MSG.SETTINGS_CHANGED }, '*');
      }
    } catch (e) {}
  }

  /**
   * @description HUD’a ses çalmayı iletir (Web Audio HUD penceresindedir).
   */
  function postSoundToHudWindow(playMsg) {
    try {
      const w = state.hudWindow;
      if (!w || w.closed) {
        showSafeHudLauncherToast('Önce HUD penceresini açın; ses orada çalar.');
        return;
      }
      w.postMessage(playMsg, '*');
    } catch (e2) {
      showSafeHudLauncherToast('HUD penceresine mesaj gönderilemedi.');
    }
  }

  /**
   * @description Ana sayfada açılır-kapanır ayar paneli (veri sekmesi).
   */
  function createMainSettingsPanel() {
    document.getElementById('safe-hud-main-settings-wrap')?.remove();
    loadSettingsIntoSettings();
    const s = { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
    injectMainChromeStyles(document);

    const wrap = document.createElement('div');
    wrap.id = 'safe-hud-main-settings-wrap';
    wrap.style.cssText = [
      'position:fixed',
      'left:12px',
      'right:12px',
      'bottom:58px',
      'z-index:2147483645',
      'max-width:min(520px,calc(100vw - 24px))',
      'max-height:min(72vh,calc(100vh - 120px))',
      'display:flex',
      'flex-direction:column',
      'pointer-events:auto',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    ].join(';');

    const collapsed = !!s.panelCollapsed;
    wrap.innerHTML = `
      <div class="sh-card" style="margin:0;display:flex;flex-direction:column;max-height:100%;overflow:hidden;">
        <div class="sh-card-h" style="flex-shrink:0;">
          <strong>HUD ayarları</strong>
          <button type="button" id="safe-main-panel-toggle" class="sh-btn sh-btn-quiet" style="padding:6px 12px;">${collapsed ? 'Aç' : 'Daralt'}</button>
        </div>
        <div id="safe-main-settings-body" class="sh-card-body" style="overflow-y:auto;flex:1;min-height:0;display:${collapsed ? 'none' : 'block'};">
          ${buildMainSettingsFormHtml(s)}
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const bodyEl = document.getElementById('safe-main-settings-body');
    const toggleBtn = document.getElementById('safe-main-panel-toggle');

    const readMainPanelSettings = () => {
      try {
        return { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
      } catch {
        return { ...defaults };
      }
    };

    const refreshHudPreviewMain = () => {
      notifyHudSettingsChanged();
    };

    toggleBtn.onclick = () => {
      const st = readMainPanelSettings();
      st.panelCollapsed = !st.panelCollapsed;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
      const nowCollapsed = st.panelCollapsed;
      bodyEl.style.display = nowCollapsed ? 'none' : 'block';
      toggleBtn.textContent = nowCollapsed ? 'Aç' : 'Daralt';
      notifyHudSettingsChanged();
    };

    const bindCheckMain = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.onchange = (e) => {
        const st = readMainPanelSettings();
        st[key] = e.target.checked;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
        notifyHudSettingsChanged();
      };
    };
    bindCheckMain('safe-hide-originals', 'hideOriginals');
    bindCheckMain('safe-severe-enabled', 'severeEnabled');
    bindCheckMain('safe-happy-enabled', 'happyEnabled');

    const poEl = document.getElementById('safe-privacy-office');
    if (poEl) {
      poEl.onchange = (e) => {
        const st = readMainPanelSettings();
        st.privacyOfficeMode = e.target.checked;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
        refreshHudPreviewMain();
      };
    }
    const pmEl = document.getElementById('safe-privacy-mask');
    if (pmEl) {
      pmEl.onchange = (e) => {
        const st = readMainPanelSettings();
        st.maskRowLabels = e.target.checked;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
        refreshHudPreviewMain();
      };
    }
    const dtEl = document.getElementById('safe-discreet-title');
    if (dtEl) {
      const commitDiscreetTitle = () => {
        const st = readMainPanelSettings();
        st.discreetWindowTitle = dtEl.value.trim() || 'Çalışma özeti';
        localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
        refreshHudPreviewMain();
      };
      dtEl.addEventListener('change', commitDiscreetTitle);
      dtEl.addEventListener('blur', commitDiscreetTitle);
    }

    const commitSelectors = () => {
      const st = readMainPanelSettings();
      st.walletSelector = document.getElementById('safe-wallet-selector').value.trim();
      st.coinSelector = document.getElementById('safe-coin-selector').value.trim();
      st.pnlSelector = document.getElementById('safe-pnl-selector').value.trim();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
      try {
        if (window.safeHudInvalidateDom) window.safeHudInvalidateDom();
      } catch (e) {}
      notifyHudSettingsChanged();
    };
    ['safe-wallet-selector', 'safe-coin-selector', 'safe-pnl-selector'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('change', commitSelectors);
        el.addEventListener('blur', commitSelectors);
      }
    });

    document.getElementById('safe-severe-volume').oninput = (e) => {
      const st = readMainPanelSettings();
      st.severeVolume = parseFloat(e.target.value);
      document.getElementById('safe-severe-volume-val').textContent = st.severeVolume.toFixed(2);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
      notifyHudSettingsChanged();
    };
    document.getElementById('safe-happy-volume').oninput = (e) => {
      const st = readMainPanelSettings();
      st.happyVolume = parseFloat(e.target.value);
      document.getElementById('safe-happy-volume-val').textContent = st.happyVolume.toFixed(2);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
      notifyHudSettingsChanged();
    };
    document.getElementById('safe-happy-buffer').oninput = (e) => {
      const st = readMainPanelSettings();
      st.happyUpBufferUsd = parseInt(e.target.value, 10);
      document.getElementById('safe-happy-buffer-val').textContent = String(st.happyUpBufferUsd);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
      notifyHudSettingsChanged();
    };

    document.getElementById('safe-severe-start').oninput = (e) => {
      const st = readMainPanelSettings();
      st.severeStart = parseInt(e.target.value, 10);
      document.getElementById('safe-severe-start-val').textContent = String(st.severeStart);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
      try {
        if (window.safeHudRearmFromSevereSlider) window.safeHudRearmFromSevereSlider();
      } catch (err) {}
      notifyHudSettingsChanged();
    };

    const bindRangeMain = (id, key, suffix = 'px') => {
      const el = document.getElementById(id);
      if (!el) return;
      el.oninput = (e) => {
        const st = readMainPanelSettings();
        st[key] = parseInt(e.target.value, 10);
        const val = document.getElementById(`${id}-val`);
        if (val) val.textContent = `${st[key]}${suffix}`;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
        notifyHudSettingsChanged();
      };
    };
    bindRangeMain('safe-coin-font', 'hudCoinFontSize');
    bindRangeMain('safe-pnl-font', 'hudPnlFontSize');
    bindRangeMain('safe-pct-font', 'hudPctFontSize');
    bindRangeMain('safe-wallet-font', 'hudWalletFontSize');
    bindRangeMain('safe-hud-width', 'hudWidth');
    bindRangeMain('safe-hud-gap', 'hudGap');

    const pnlSortEl = document.getElementById('safe-hud-pnl-sort');
    if (pnlSortEl) {
      pnlSortEl.onchange = () => {
        const st = readMainPanelSettings();
        st.hudPnlSort = pnlSortEl.value;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
        refreshHudPreviewMain();
      };
    }

    document.getElementById('safe-test-happy').onclick = () => {
      postSoundToHudWindow({ type: MSG.PLAY, sound: 'happy', force: true });
    };
    document.getElementById('safe-test-severe').onclick = () => {
      postSoundToHudWindow({ type: MSG.PLAY, sound: 'severe', force: true });
    };
    document.getElementById('safe-test-severe-scaled').onclick = () => {
      let sc = { intensityMul: 1, durationMul: 1 };
      try {
        if (typeof window.safeHudGetSevereTestScaling === 'function') {
          sc = window.safeHudGetSevereTestScaling();
        }
      } catch (e) {}
      postSoundToHudWindow({
        type: MSG.PLAY,
        sound: 'severe',
        force: true,
        intensityMul: sc.intensityMul,
        durationMul: sc.durationMul,
      });
    };
    document.getElementById('safe-test-severe-demo-max').onclick = () => {
      postSoundToHudWindow({
        type: MSG.PLAY,
        sound: 'severe',
        force: true,
        intensityMul: 2.2,
        durationMul: 2.05,
      });
    };
  }

  /**
   * @description Popup penceresini doldurur; ses Web Audio bu belgede çalışır.
   */
  function mountPopup(win) {
    const d = win.document;
    const root = d.getElementById('safe-popup-root');
    if (!root) return;

    injectPopupChromeStyles(d);

    if (win.__safeHudPopupOnMessage) {
      win.removeEventListener('message', win.__safeHudPopupOnMessage);
      win.__safeHudPopupOnMessage = null;
    }
    if (win.__safeHudPopupClickUnlock) {
      win.removeEventListener('click', win.__safeHudPopupClickUnlock);
      win.__safeHudPopupClickUnlock = null;
    }

    root.innerHTML = buildHudPopupHtml(readSettings());

    const audioState = {
      ctx: null,
      /** @description performance.now() — ağır alarm üst üste binmesin */
      severeCooldownUntil: 0,
      severeStopHandles: [],
    };

    function getAudioCtx() {
      const AC = win.AudioContext || win.webkitAudioContext;
      if (!AC) return null;
      if (!audioState.ctx) audioState.ctx = new AC();
      return audioState.ctx;
    }

    async function unlockAudio() {
      try {
        const ctx = getAudioCtx();
        if (ctx && ctx.state === 'suspended') await ctx.resume();
      } catch (e) {}
    }

    function compressor(ctx, threshold = -10, ratio = 18) {
      const c = ctx.createDynamicsCompressor();
      c.threshold.setValueAtTime(threshold, ctx.currentTime);
      c.knee.setValueAtTime(16, ctx.currentTime);
      c.ratio.setValueAtTime(Math.min(20, Math.max(1, ratio)), ctx.currentTime);
      c.attack.setValueAtTime(0.002, ctx.currentTime);
      c.release.setValueAtTime(0.25, ctx.currentTime);
      c.connect(ctx.destination);
      return c;
    }

    function readSettings() {
      try {
        return { ...defaults, ...JSON.parse(win.localStorage.getItem(STORAGE_KEY) || '{}') };
      } catch {
        return { ...defaults };
      }
    }

    /**
     * @description Devam eden ağır alarm osilatörlerini durdurur (yeni tetiklemeden önce).
     */
    function stopSevereVoicesNow() {
      audioState.severeStopHandles.forEach((fn) => {
        try {
          fn();
        } catch (e) {}
      });
      audioState.severeStopHandles = [];
    }

    /**
     * @description Ağır alarm. `force: true` soğumayı ve çakışmayı yok sayar (test düğmesi).
     * @param opts.force - Test için soğuma atlanır; yine de önceki ses durdurulur.
     */
    function playSevere(s, opts = {}) {
      if (!s.severeEnabled) return;
      const ctx = getAudioCtx();
      if (!ctx) return;

      const intM = Math.min(2.5, Math.max(0.5, Number(opts.intensityMul) || 1));
      const durM = Math.min(2.2, Math.max(0.85, Number(opts.durationMul) || 1));

      const nowWall = performance.now();
      const baseCooldownMs = opts.quickRepeatCooldown ? 2200 : 11500;
      const cooldownMs = Math.round(baseCooldownMs * durM);
      if (!opts.force && audioState.severeCooldownUntil > nowWall) {
        return;
      }

      stopSevereVoicesNow();

      const start = ctx.currentTime;
      const compRatio = Math.min(22, 16 + intM * 2.2);
      const comp = compressor(ctx, -8 - intM * 1.5, compRatio);
      const oscCount = Math.min(110, Math.round(42 * durM + 8));
      const stepSec = 0.2 / Math.max(0.82, Math.sqrt(intM));
      const volPeak = Math.max(0.0001, Math.min(1.28, s.severeVolume * intM));
      const pulseAttack = 0.014;
      const pulseDecayEnd = 0.52;
      const pulseStop = 0.62;

      for (let i = 0; i < oscCount; i++) {
        const t = start + i * stepSec;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = i % 3 === 0 ? 'square' : i % 3 === 1 ? 'sawtooth' : 'triangle';
        osc.frequency.setValueAtTime(i % 2 === 0 ? 1600 : 900, t);
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(volPeak, t + pulseAttack);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + pulseDecayEnd);
        osc.connect(gain);
        gain.connect(comp);
        osc.start(t);
        osc.stop(t + pulseStop);
        audioState.severeStopHandles.push(() => {
          try {
            osc.stop(0);
          } catch (e) {}
          try {
            osc.disconnect();
            gain.disconnect();
          } catch (e2) {}
        });
      }
      audioState.severeStopHandles.push(() => {
        try {
          comp.disconnect();
        } catch (e) {}
      });

      if (!opts.force) {
        audioState.severeCooldownUntil = nowWall + cooldownMs;
      }
    }

    function parseHudRowPnl(txt) {
      const normalized = (txt || '').replace(/[^0-9.,-]/g, '').replace(/,/g, '');
      const n = parseFloat(normalized);
      return Number.isFinite(n) ? n : null;
    }

    function sortHudRowsForDisplay(rows, sortMode) {
      if (sortMode !== 'pnl-desc' && sortMode !== 'pnl-asc') return rows;
      const copy = [...rows];
      copy.sort((a, b) => {
        const na = parseHudRowPnl(a.pnl);
        const nb = parseHudRowPnl(b.pnl);
        const aNaN = na == null ? 1 : 0;
        const bNaN = nb == null ? 1 : 0;
        if (aNaN !== bNaN) return aNaN - bNaN;
        if (na == null) return 0;
        if (sortMode === 'pnl-desc') return nb - na;
        return na - nb;
      });
      return copy;
    }

    function applyUpdate(payload) {
      const s = readSettings();
      const privacy = !!s.privacyOfficeMode;
      try {
        const tabTitle = String(s.discreetWindowTitle || '').trim() || 'Çalışma özeti';
        win.document.title = privacy ? tabTitle : 'Özet paneli';
      } catch (e) {}

      d.getElementById('sh-app')?.classList.toggle('sh-privacy', privacy);

      const mainLbl = d.getElementById('safe-hud-main-label');
      if (mainLbl) {
        mainLbl.textContent = privacy ? 'Özet' : 'Canlı özet';
      }

      const walletEl = d.getElementById('safe-hud-wallet');
      const positionsEl = d.getElementById('safe-hud-positions');
      const statusEl = d.getElementById('safe-hud-status');
      const hudBox = d.getElementById('safe-hud-display');

      const green = '#4ade80';
      const red = '#f87171';
      const neutral = 'rgba(255,255,255,0.92)';
      const officeMuted = '#aeb4c8';

      if (hudBox) hudBox.style.width = `${s.hudWidth}px`;

      if (walletEl) {
        walletEl.textContent = formatHudWalletDisplay(payload.wallet);
        walletEl.style.fontSize = `${s.hudWalletFontSize}px`;
        walletEl.style.color = privacy ? officeMuted : neutral;
      }
      if (positionsEl) {
        positionsEl.style.gap = `${s.hudGap}px`;
        positionsEl.style.width = '100%';
        positionsEl.style.maxWidth = '100%';
        positionsEl.style.minWidth = '0';
        positionsEl.style.boxSizing = 'border-box';
        positionsEl.innerHTML = '';
        const sortMode = s.hudPnlSort || 'none';
        const rows = sortHudRowsForDisplay(payload.positions || [], sortMode);
        const mask = privacy && !!s.maskRowLabels;
        rows.forEach((pos, idx) => {
          const row = d.createElement('div');
          row.className = 'sh-row';
          const left = d.createElement('div');
          left.textContent = mask ? `Kalem ${idx + 1}` : pos.coin || '-';
          const pnlNum = parseHudRowPnl(pos.pnl);
          let rowTone = neutral;
          if (!privacy) {
            if (pnlNum != null) {
              if (pnlNum > 0) rowTone = green;
              else if (pnlNum < 0) rowTone = red;
            }
          } else {
            rowTone = officeMuted;
          }
          left.style.cssText = `font-weight:800;font-size:${s.hudCoinFontSize}px;line-height:1;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${rowTone};`;
          const rightWrap = d.createElement('div');
          rightWrap.style.cssText =
            'display:flex;flex-direction:column;align-items:flex-end;gap:2px;flex:0 1 auto;min-width:0;max-width:58%;';
          const pnl = d.createElement('div');
          const pnlShown = formatHudStripSignChars(pos.pnl);
          pnl.textContent = pnlShown;
          let pnlColor = rowTone;
          if (privacy && pnlNum != null) {
            if (pnlNum > 0) pnlColor = '#8daf9e';
            else if (pnlNum < 0) pnlColor = '#b89a9a';
            else pnlColor = officeMuted;
          }
          pnl.style.cssText = `font-weight:700;font-size:${s.hudPnlFontSize}px;line-height:1;color:${pnlColor};max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
          const pctShown = formatHudStripSignChars(pos.pct);
          rightWrap.appendChild(pnl);
          if (pctShown) {
            const pct = d.createElement('div');
            pct.textContent = pctShown;
            pct.style.cssText = `font-weight:600;opacity:0.92;font-size:${s.hudPctFontSize}px;line-height:1;color:${pnlColor};max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
            rightWrap.appendChild(pct);
          }
          row.appendChild(left);
          row.appendChild(rightWrap);
          positionsEl.appendChild(row);
        });
      }
      if (statusEl) {
        statusEl.textContent = privacy ? '' : payload.debug || '';
      }
      win.__safeHudLastPayload = payload;
    }

    const refreshHudPreview = () => {
      if (win.__safeHudLastPayload) applyUpdate(win.__safeHudLastPayload);
    };

    const onMessage = (ev) => {
      if (ev.data?.type === MSG.STOP_SEVERE) {
        stopSevereVoicesNow();
        audioState.severeCooldownUntil = 0;
        return;
      }
      if (ev.data?.type === MSG.SETTINGS_CHANGED) {
        refreshHudPreview();
        return;
      }
      if (ev.data?.type === MSG.UPDATE) applyUpdate(ev.data.payload || {});
      if (ev.data?.type === MSG.PLAY) {
        const s = readSettings();
        unlockAudio().then(() => {
          if (ev.data.sound === 'severe') {
            playSevere(s, {
              force: !!ev.data.force,
              intensityMul: ev.data.intensityMul,
              durationMul: ev.data.durationMul,
              quickRepeatCooldown: !!ev.data.quickRepeatCooldown,
            });
          }
          if (ev.data.sound === 'happy') {
            playSevere(s, {
              force: !!ev.data.force,
              intensityMul: 1,
              durationMul: 1,
              skipRecoveryStopWindow: true,
              quickRepeatCooldown: true,
            });
          }
        });
      }
    };
    win.addEventListener('message', onMessage);
    win.__safeHudPopupOnMessage = onMessage;

    const onClickUnlock = () => unlockAudio();
    win.__safeHudPopupClickUnlock = onClickUnlock;
    win.addEventListener('click', onClickUnlock, { passive: true });

    d.getElementById('safe-popup-focus-opener').onclick = () => {
      try {
        if (win.opener && !win.opener.closed) win.opener.focus();
      } catch (e) {}
    };

    try {
      if (win.opener && typeof win.opener.safeHudBeginPopupPolling === 'function') {
        win.opener.safeHudBeginPopupPolling(win);
      }
    } catch (e) {}
  }

  /** Sabit isim: aynı hedefi yeniden kullanır; bazı tarayıcılarda engel oranını düşürür. */
  const POPUP_WINDOW_NAME = 'FairGridSafeHUD';

  /**
   * @description Açılır pencereyi yalnızca canlı kullanıcı hareketi yığınında açar (engel riskini azaltır).
   * @returns Açıldıysa true
   */
  function attemptOpenHudFromUserGesture() {
    if (state.hudWindow && !state.hudWindow.closed) {
      try {
        state.hudWindow.focus();
      } catch (e) {}
      return true;
    }

    const w = window.open(
      '',
      POPUP_WINDOW_NAME,
      'width=300,height=720,scrollbars=yes,resizable=yes',
    );
    if (!w) {
      showPopupBlockedHelp();
      return false;
    }

    state.hudWindow = w;
    const d = w.document;
    d.open();
    d.write(`<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><title>Çalışma özeti</title></head><body style="margin:0;background:#0f1419;color:#e8eaed;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;min-height:100vh;"><div id="safe-popup-root"></div></body></html>`);
    d.close();

    /**
     * @description `write`/`close` sonrası `load` çoğu zaman dinleyici eklenmeden önce tetiklenir; bu yüzden mount burada senkron + yedeklenir.
     */
    const remountIfHudMissing = () => {
      try {
        if (w.closed) return;
        const root = w.document.getElementById('safe-popup-root');
        if (root && !root.querySelector('#safe-hud-display')) {
          mountPopup(w);
        }
      } catch (e) {}
    };

    mountPopup(w);
    setTimeout(remountIfHudMissing, 0);
    w.addEventListener('load', remountIfHudMissing, { once: true });

    w.addEventListener('beforeunload', () => {
      try {
        if (w.opener && !w.opener.closed && w.opener.safeHudEndPopupPolling) {
          w.opener.safeHudEndPopupPolling();
        }
      } catch (e2) {}
      try {
        if (w.__safeHudPopupOnMessage) w.removeEventListener('message', w.__safeHudPopupOnMessage);
      } catch (e) {}
    });

    return true;
  }

  /**
   * @description Popup engellendiğinde sayfada kısa yönlendirme; "Yeniden dene" yeni bir kullanıcı hareketi sağlar.
   */
  function showPopupBlockedHelp() {
    document.getElementById('safe-hud-popup-blocked')?.remove();
    const wrap = document.createElement('div');
    wrap.id = 'safe-hud-popup-blocked';
    wrap.style.cssText = [
      'position:fixed',
      'left:50%',
      'top:50%',
      'transform:translate(-50%,-50%)',
      'z-index:1000000',
      'max-width:min(420px,calc(100vw - 24px))',
      'padding:16px 18px',
      'background:rgba(22,22,22,0.98)',
      'color:#fff',
      'border:1px solid rgba(255,255,255,0.15)',
      'border-radius:12px',
      'box-shadow:0 16px 48px rgba(0,0,0,0.45)',
      'font-family:Arial,sans-serif',
      'font-size:13px',
      'line-height:1.45',
    ].join(';');
    wrap.innerHTML = `
      <p style="margin:0 0 8px;font-weight:bold;">Açılır pencere engellendi</p>
      <p style="margin:0 0 10px;opacity:0.92;">Tarayıcılar bunun için ayrı bir izin penceresi göstermez; siteye izin vermeniz gerekir.</p>
      <ul style="margin:0 0 12px;padding-left:18px;opacity:0.9;">
        <li><b>Chrome / Edge:</b> adres çubuğundaki “açılır pencere engellendi” simgesine tıklayın → <b>Her zaman açılır pencerelere ve yönlendirmelere izin ver</b> (veya bu site için izin verin).</li>
        <li><b>Safari:</b> Ayarlar → Websiteleri → Açılır Pencereler → bu site için İzin ver.</li>
      </ul>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
        <button type="button" id="safe-hud-blocked-dismiss" style="background:#333;color:#fff;border:0;border-radius:8px;padding:8px 12px;cursor:pointer;">Kapat</button>
        <button type="button" id="safe-hud-blocked-retry" style="background:#1a5f8a;color:#fff;border:0;border-radius:8px;padding:8px 14px;cursor:pointer;">Yeniden dene</button>
      </div>
    `;
    document.body.appendChild(wrap);

    const dismiss = () => wrap.remove();
    wrap.querySelector('#safe-hud-blocked-dismiss').addEventListener('click', dismiss);

    const retryBtn = wrap.querySelector('#safe-hud-blocked-retry');
    const openFromRetry = () => {
      wrap.remove();
      attemptOpenHudFromUserGesture();
    };
    retryBtn.addEventListener('pointerdown', openFromRetry, { capture: true });
    retryBtn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openFromRetry();
      }
    });
  }

  function bindUserGestureOpen(buttonEl) {
    const run = (e) => {
      if (e.type === 'pointerdown') {
        if (!e.isPrimary) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
      }
      attemptOpenHudFromUserGesture();
    };
    buttonEl.addEventListener('pointerdown', run, { capture: true });
    buttonEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        attemptOpenHudFromUserGesture();
      }
    });
  }

  /**
   * @description Kısa bilgi balonu (sol alt).
   */
  function showSafeHudLauncherToast(message) {
    try {
      document.getElementById(LAUNCHER_TOAST_ID)?.remove();
      const t = document.createElement('div');
      t.id = LAUNCHER_TOAST_ID;
      t.textContent = message;
      t.style.cssText = [
        'position:fixed',
        'left:12px',
        'bottom:88px',
        'z-index:2147483646',
        'max-width:min(480px,calc(100vw - 24px))',
        'padding:12px 14px',
        'background:rgba(18,26,38,0.98)',
        'color:#eef2f8',
        'border-radius:12px',
        'font-size:12px',
        'line-height:1.5',
        'box-shadow:0 10px 36px rgba(0,0,0,0.45)',
        'border:1px solid rgba(255,255,255,0.12)',
        'font-family:system-ui,-apple-system,sans-serif',
      ].join(';');
      document.body.appendChild(t);
      window.setTimeout(() => {
        try {
          t.remove();
        } catch (e2) {}
      }, 10000);
    } catch (e) {}
  }

  function createLauncherOnPage() {
    document.getElementById('safe-hud-launcher-host')?.remove();
    const host = document.createElement('div');
    host.id = 'safe-hud-launcher-host';
    host.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:2147483646;font-family:Arial,sans-serif;display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
    host.innerHTML = `
      <button type="button" id="safe-hud-open-win" style="background:#1a5f8a;color:#fff;border:0;border-radius:10px;padding:10px 14px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.35);">HUD penceresini aç</button>
      <button type="button" id="safe-hud-close-all" style="background:#333;color:#fff;border:0;border-radius:10px;padding:10px 12px;cursor:pointer;">Kapat</button>
    `;
    document.body.appendChild(host);
    bindUserGestureOpen(document.getElementById('safe-hud-open-win'));
    document.getElementById('safe-hud-close-all').onclick = () => window.safeHudCleanup();
    createMainSettingsPanel();
  }

  /**
   * @description DOM okuma + alarm mantığı (ana sekme veya popup poll ortak).
   */
  function runPollBody() {
    loadSettingsIntoSettings();
    state.pendingSounds.length = 0;
    applyOriginalFontStyles();
    applyOriginalVisibility();

    const wallet = getWalletText();
    const positions = getPositions();
    const wEl = getWalletElement();
    const debug = `Cüzdan: ${wEl ? 'ok' : 'yok'} · Coin: ${getCoinEls().length} · PnL: ${getPnlEls().length}`;
    const payload = { wallet, positions, debug };

    const currentPrice = getWalletPrice();
    if (currentPrice == null) {
      const sounds = [...state.pendingSounds];
      state.pendingSounds.length = 0;
      return { payload, sounds };
    }

    const prevSample = state.lastWalletPrice;
    if (
      prevSample != null &&
      currentPrice > prevSample &&
      state.severePlaybackUntil > performance.now()
    ) {
      state.severePlaybackUntil = 0;
      notifyStopSevere();
    }

    if (state.lastWalletPrice === null) {
      state.lastWalletPrice = currentPrice;
      updateArmedLevels(currentPrice);
    } else {
      updateArmedLevels(currentPrice);
      checkSevereCrossings(state.lastWalletPrice, currentPrice);
      checkHappy50Up(state.lastWalletPrice, currentPrice);
      state.lastWalletPrice = currentPrice;
    }

    recordPriceSample(currentPrice);

    const sounds = [...state.pendingSounds];
    state.pendingSounds.length = 0;
    return { payload, sounds };
  }

  function tick() {
    const { payload, sounds } = runPollBody();
    postToPopup({ type: MSG.UPDATE, payload });
    sounds.forEach((item) => {
      const play =
        typeof item === 'string'
          ? { type: MSG.PLAY, sound: item }
          : {
              type: MSG.PLAY,
              sound: item.sound,
              intensityMul: item.intensityMul,
              durationMul: item.durationMul,
              skipRecoveryStopWindow: item.skipRecoveryStopWindow,
              quickRepeatCooldown: item.quickRepeatCooldown,
            };
      postToPopup(play);
    });
  }

  /**
   * @description Popup penceresinden çağrılır; ana sekme arka planda kısılsa bile güncel veri üretir.
   */
  window.safeHudPerformPollCycle = () => runPollBody();

  /**
   * @description Veri döngüsünü popup’a taşır (minimize / arka plan throttle’ından kaçış).
   */
  window.safeHudBeginPopupPolling = (popupWin) => {
    if (!popupWin || popupWin.closed) return;
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    state.popupPollsOpener = true;
    state.popupWinRef = popupWin;
    popupWin.clearInterval(popupWin.__safeHudPopupPollTimer);
    const run = () => {
      try {
        if (popupWin.closed) {
          window.safeHudEndPopupPolling();
          return;
        }
        const { payload, sounds } = runPollBody();
        popupWin.postMessage({ type: MSG.UPDATE, payload }, '*');
        for (const item of sounds) {
          const msg =
            typeof item === 'string'
              ? { type: MSG.PLAY, sound: item }
              : {
                  type: MSG.PLAY,
                  sound: item.sound,
                  intensityMul: item.intensityMul,
                  durationMul: item.durationMul,
                  skipRecoveryStopWindow: item.skipRecoveryStopWindow,
                  quickRepeatCooldown: item.quickRepeatCooldown,
                };
          popupWin.postMessage(msg, '*');
        }
      } catch (e) {}
    };
    run();
    /** Popup üzerindeki timer: ana sekme minimize/throttle olsa bile çalışır. */
    popupWin.__safeHudPopupPollTimer = popupWin.setInterval(run, 400);
  };

  function stopPopupPollOnly() {
    const p = state.popupWinRef;
    if (p) {
      try {
        p.clearInterval(p.__safeHudPopupPollTimer);
      } catch (e) {}
    }
    if (state.popupWinRef) {
      try {
        state.popupWinRef.__safeHudPopupPollTimer = undefined;
      } catch (e) {}
    }
    state.popupWinRef = null;
    state.popupPollsOpener = false;
    state.pendingSounds.length = 0;
    state.severePlaybackUntil = 0;
    state.priceHistory.length = 0;
    state.happyLatchedThresholds.clear();
  }

  /**
   * @description Popup kapandığında ana sekmedeki interval’i geri yükler.
   */
  window.safeHudEndPopupPolling = () => {
    stopPopupPollOnly();
    if (state.timer) {
      clearInterval(state.timer);
    }
    state.timer = setInterval(tick, 500);
  };

  window.safeHudCleanup = () => {
    stopPopupPollOnly();
    if (state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
    document.getElementById('safe-hud-launcher-host')?.remove();
    try {
      document.getElementById('safe-hud-main-settings-wrap')?.remove();
    } catch (eRm) {}
    try {
      document.getElementById('safe-hud-main-chrome-css')?.remove();
    } catch (eRm2) {}
    try {
      document.getElementById(LAUNCHER_TOAST_ID)?.remove();
    } catch (e0b) {}
    try {
      if (state.hudWindow && !state.hudWindow.closed) {
        const w = state.hudWindow;
        if (w.__safeHudPopupOnMessage) w.removeEventListener('message', w.__safeHudPopupOnMessage);
        if (w.__safeHudPopupClickUnlock) w.removeEventListener('click', w.__safeHudPopupClickUnlock);
        w.close();
      }
    } catch (e) {}
    state.hudWindow = null;
    delete window.safeHudRearmFromSevereSlider;
    delete window.safeHudInvalidateDom;
    delete window.safeHudGetSevereTestScaling;
  };

  createLauncherOnPage();
  tick();
  state.timer = setInterval(tick, 500);

  console.log(
    'HUD ayarları: sol alttaki açılır panel (ana pencere). Canlı özet: “HUD penceresini aç”. Ses testleri HUD açıkken çalar. Kaynak pencereyi minimize etmeyin.',
  );
})();
