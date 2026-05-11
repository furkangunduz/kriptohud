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

  const SEVERE_PLAYBACK_WINDOW_MS = 14000;
  const PRICE_ROLLING_WINDOW_MS = 1 * 60 * 1000;
  const WALLET_FLAT_STALE_MS = 60 * 1000;
  const SEVERE_DROP_REF_USD = 200;

  /**
   * @description Nuxt risk header içindeki cüzdan tutarı (.value).
   * `.ready` yoksa yedek seçici denenir. `settings.walletSelector` doluysa önce o kullanılır.
   */
  const WALLET_SELECTOR =
    '#__nuxt > div > div:nth-child(2) > div > div.content-wrapper.common-scroll-bar.x-scroll.ready > div > div > section:nth-child(3) > div > div.account-info-wrapper > section > div.module-content > div.risk-header > div:nth-child(4) > div.value';

  const WALLET_SELECTOR_FALLBACK = WALLET_SELECTOR.replace('common-scroll-bar.x-scroll.ready', 'common-scroll-bar.x-scroll');

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

    smallUpEnabled: true,
    smallDownEnabled: true,
    bigUpEnabled: true,
    bigDownEnabled: true,
    criticalDropEnabled: true,
    smallUpUsd: 25,
    smallDownUsd: 25,
    bigUpUsd: 100,
    bigDownUsd: 100,
    criticalDropUsd: 180,
    smallAlarmVolume: 0.06,
    bigAlarmVolume: 0.08,
    criticalAlarmVolume: 0.16,
    smallAlarmCooldownMs: 5000,
    bigAlarmCooldownMs: 14000,
    criticalAlarmCooldownMs: 45000,
    criticalRollingWindowMs: 60000,
    hudSurface: 'popup',
    rearmOffset: 5,

    panelCollapsed: false,
    hudLeft: 16,
    hudTop: 16,
    settingsLeft: null,
    settingsTop: null,

    walletSelector: '',
    coinSelector: '',
    pnlSelector: '',

    hudPnlSort: 'pnl-desc',

    privacyOfficeMode: false,

    maskRowLabels: true,
    discreetWindowTitle: 'Çalışma özeti',
  };

  const settings = { ...defaults };

  function normalizeSettings(raw = {}) {
    const clean = { ...defaults };
    Object.keys(defaults).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(raw, key)) clean[key] = raw[key];
    });
    return clean;
  }

  function loadSettingsIntoSettings() {
    try {
      Object.assign(settings, normalizeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}')));
    } catch {
      Object.assign(settings, defaults);
    }
  }

  loadSettingsIntoSettings();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {}

  const state = {
    timer: null,
    lastWalletPrice: null,
    hudWindow: null,
    popupPollsOpener: false,
    pendingSounds: [],
    popupWinRef: null,

    severePlaybackUntil: 0,

    priceHistory: [],

    criticalVoiceUntil: 0,

    walletFlatAnchorPrice: null,

    walletFlatAnchorAt: 0,
    walletFlatAlarmed: false,
    movementLatchedLevels: new Set(),
    alarmCooldownUntil: {},
    criticalDropLatched: false,
    inlineHudEl: null,
  };

  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeSettings(settings)));
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
    t = t
      .replace(/\bUSD\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    const dot = t.lastIndexOf('.');
    if (dot !== -1) {
      t = t.slice(0, dot).trim();
    }
    return t || '-';
  }

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
      if ((settings.hudSurface || 'popup') === 'inline' && payload?.type === MSG.UPDATE) {
        applyInlineHudUpdate(payload?.payload || payload);
      }
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
   * @description Kayar penceredeki düşüşe göre ağır alarm şiddeti ve süresi çarpanları.
   * @param dropUsd - `SEVERE_DROP_REF_USD` ile ölçeklenir
   */
  function computeSevereScalingFromDrop(dropUsd) {
    const r = SEVERE_DROP_REF_USD > 0 ? dropUsd / SEVERE_DROP_REF_USD : 0;
    const t = Math.min(2.8, Math.max(0, r));
    const intensityMul = Math.min(2.45, Math.max(0.62, 0.62 + t * 0.58));
    const durationMul = Math.min(2.1, Math.max(1, 1 + t * 0.42));
    return { intensityMul, durationMul };
  }

  /**
   * @description 100 USD kritik alarm osilatör süresi (playSevere ile aynı formül).
   * @returns totalMs — sesin bitişine kadar ms; voice-lock için
   */
  function criticalSevereSynthTiming(intensityMul, durationMul) {
    const intBase = Math.min(2.5, Math.max(0.5, Number(intensityMul) || 1));
    const durBase = Math.min(2.2, Math.max(0.85, Number(durationMul) || 1));
    const intM = Math.min(2.75, intBase * 1.18);
    const durM = Math.min(2.5, durBase * 1.22);
    const oscCount = Math.min(200, Math.round(68 * durM + 18));
    const stepSec = 0.125 / Math.max(0.68, Math.sqrt(intM));
    const pulseStop = 0.88;
    const tailPadSec = 0.55;
    const totalSec = (oscCount - 1) * stepSec + pulseStop + tailPadSec;
    return {
      intM,
      durM,
      oscCount,
      stepSec,
      pulseStop,
      pulseAttack: 0.02,
      pulseDecayEnd: 0.74,
      totalMs: Math.min(130000, Math.ceil(totalSec * 1000)),
    };
  }

  /**
   * @description Kritik düşüş için en uzun ve keskin alarm zamanlaması (uyanma profili).
   */
  function sub3000SevereSynthTiming(intensityMul, durationMul) {
    const intBase = Math.min(2.5, Math.max(0.5, Number(intensityMul) || 1));
    const durBase = Math.min(2.2, Math.max(0.85, Number(durationMul) || 1));
    const intM = Math.min(2.88, intBase * 1.32);
    const durM = Math.min(2.58, durBase * 1.38);
    const oscCount = Math.min(280, Math.round(96 * durM + 32));
    const stepSec = 0.088 / Math.max(0.58, Math.sqrt(intM));
    const pulseStop = 0.98;
    const tailPadSec = 0.65;
    const totalSec = (oscCount - 1) * stepSec + pulseStop + tailPadSec;
    return {
      intM,
      durM,
      oscCount,
      stepSec,
      pulseStop,
      pulseAttack: 0.024,
      pulseDecayEnd: 0.86,
      totalMs: Math.min(180000, Math.ceil(totalSec * 1000)),
    };
  }

  function recordPriceSample(price) {
    if (price == null || !Number.isFinite(price)) return;
    const t = Date.now();
    state.priceHistory.push({ t, p: price });
    const cutoff = t - PRICE_ROLLING_WINDOW_MS - 5000;
    state.priceHistory = state.priceHistory.filter((row) => row.t >= cutoff);
  }

  function resetWalletFlatWatch() {
    state.walletFlatAnchorPrice = null;
    state.walletFlatAnchorAt = 0;
    state.walletFlatAlarmed = false;
  }

  /**
   * @description Cüzdan USD değeri WALLET_FLAT_STALE_MS boyunca aynı kalırsa bir kez ses (fiyat değişince sıfırlanır).
   */
  function checkWalletFlatStale(currentPrice) {
    if (currentPrice == null || !Number.isFinite(currentPrice)) {
      resetWalletFlatWatch();
      return;
    }
    const now = Date.now();
    if (state.walletFlatAnchorPrice == null) {
      state.walletFlatAnchorPrice = currentPrice;
      state.walletFlatAnchorAt = now;
      state.walletFlatAlarmed = false;
      return;
    }
    if (currentPrice !== state.walletFlatAnchorPrice) {
      state.walletFlatAnchorPrice = currentPrice;
      state.walletFlatAnchorAt = now;
      state.walletFlatAlarmed = false;
      return;
    }
    if (state.walletFlatAlarmed) return;
    if (now - state.walletFlatAnchorAt < WALLET_FLAT_STALE_MS) return;
    state.walletFlatAlarmed = true;
    debugAlarmTrigger('FLAT_WALLET', {
      price: currentPrice,
      staleMs: now - state.walletFlatAnchorAt,
    });
    if (settings.smallDownEnabled || settings.bigDownEnabled || settings.criticalDropEnabled) {
      emitPlaySound('severe', {
        tier: 'simple',
        quickRepeatCooldown: true,
        skipRecoveryStopWindow: true,
        intensityMul: 1,
        durationMul: 0.95,
        volumeOverride: alarmVolumeFor('small'),
      });
    } else if (settings.smallUpEnabled || settings.bigUpEnabled) {
      const play = { type: MSG.PLAY, sound: 'happy', force: true, volumeOverride: alarmVolumeFor('small') };
      if (state.popupPollsOpener) state.pendingSounds.push(play);
      else if ((settings.hudSurface || 'popup') === 'inline') playLocalSound(play);
      else postToPopup(play);
    }
  }

  /**
   * @description Alarm sesi: popup kendi poll’unda iken kuyruğa alınır, aksi halde postMessage ile gönderilir.
   * @param sound - severe
   * @param meta - Ölçekleme + `tier`: sub3000 | critical | simple; `skipRecoveryStopWindow` isteğe bağlı
   */
  function emitPlaySound(sound, meta = {}) {
    if (sound !== 'severe') return;

    const durationMul = meta.durationMul ?? 1;
    const tier = meta.tier === 'sub3000' ? 'sub3000' : meta.tier === 'critical' ? 'critical' : 'simple';
    const quickRepeat = !!meta.quickRepeatCooldown;
    let skipRecoveryStopWindow;
    if (meta.skipRecoveryStopWindow === true) skipRecoveryStopWindow = true;
    else if (meta.skipRecoveryStopWindow === false) skipRecoveryStopWindow = false;
    else skipRecoveryStopWindow = quickRepeat || tier === 'simple';

    if (tier === 'critical' || tier === 'sub3000') {
      const crit =
        tier === 'sub3000'
          ? sub3000SevereSynthTiming(meta.intensityMul ?? 1, durationMul)
          : criticalSevereSynthTiming(meta.intensityMul ?? 1, durationMul);
      state.criticalVoiceUntil = performance.now() + crit.totalMs + 400;
      state.severePlaybackUntil = state.criticalVoiceUntil;
    } else if (skipRecoveryStopWindow) {
      state.criticalVoiceUntil = 0;
      state.severePlaybackUntil = 0;
    } else {
      state.criticalVoiceUntil = 0;
      state.severePlaybackUntil = performance.now() + SEVERE_PLAYBACK_WINDOW_MS * durationMul;
    }
    const play = {
      sound: 'severe',
      intensityMul: meta.intensityMul ?? 1,
      durationMul,
      volumeOverride: meta.volumeOverride,
      skipRecoveryStopWindow,
      quickRepeatCooldown: quickRepeat,
      tier,
    };
    debugAlarmTrigger('PLAY', {
      tier,
      intensityMul: Number((play.intensityMul ?? 1).toFixed(3)),
      durationMul: Number((play.durationMul ?? 1).toFixed(3)),
      skipRecoveryStopWindow,
      popupPollsOpener: !!state.popupPollsOpener,
      criticalVoiceUntil: Math.round(state.criticalVoiceUntil || 0),
      severePlaybackUntil: Math.round(state.severePlaybackUntil || 0),
    });
    if ((settings.hudSurface || 'popup') === 'inline' && !state.popupPollsOpener) {
      playLocalSound({ type: MSG.PLAY, ...play });
    } else if (state.popupPollsOpener) {
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
      if ((settings.hudSurface || 'popup') === 'inline') {
        stopLocalSevereVoicesNow();
        return;
      }
      if (state.popupPollsOpener && state.popupWinRef && !state.popupWinRef.closed) {
        state.popupWinRef.postMessage({ type: MSG.STOP_SEVERE }, '*');
      } else if (state.hudWindow && !state.hudWindow.closed) {
        state.hudWindow.postMessage({ type: MSG.STOP_SEVERE }, '*');
      }
    } catch (e) {}
  }

  /**
   * @description Alarm tetik nedenini tek yerde standart loglar.
   */
  function debugAlarmTrigger(tag, detail) {
    try {
      console.log(`[SAFE_HUD][ALARM][${tag}]`, detail);
    } catch (e) {}
  }

  function numSetting(key, fallback, min, max) {
    const n = Number(settings[key]);
    const safe = Number.isFinite(n) ? n : fallback;
    return Math.min(max, Math.max(min, safe));
  }

  function profileCooldownMs(profileKey) {
    if (profileKey === 'critical') return numSetting('criticalAlarmCooldownMs', 45000, 5000, 10 * 60 * 1000);
    if (profileKey === 'big') return numSetting('bigAlarmCooldownMs', 14000, 1000, 5 * 60 * 1000);
    return numSetting('smallAlarmCooldownMs', 5000, 0, 2 * 60 * 1000);
  }

  function alarmVolumeFor(profileKey) {
    if (profileKey === 'critical') return numSetting('criticalAlarmVolume', 0.16, 0, 1);
    if (profileKey === 'big') return numSetting('bigAlarmVolume', 0.08, 0, 1);
    return numSetting('smallAlarmVolume', 0.06, 0, 1);
  }

  function getMovementProfiles() {
    return [
      {
        key: 'small-up',
        group: 'small',
        label: 'Ufak yükseliş',
        direction: 'up',
        enabled: !!settings.smallUpEnabled,
        step: numSetting('smallUpUsd', 25, 1, 100000),
        sound: 'happy',
      },
      {
        key: 'small-down',
        group: 'small',
        label: 'Ufak düşüş',
        direction: 'down',
        enabled: !!settings.smallDownEnabled,
        step: numSetting('smallDownUsd', 25, 1, 100000),
        sound: 'severe',
        tier: 'simple',
      },
      {
        key: 'big-up',
        group: 'big',
        label: 'Büyük yükseliş',
        direction: 'up',
        enabled: !!settings.bigUpEnabled,
        step: numSetting('bigUpUsd', 100, 1, 100000),
        sound: 'happy',
        force: true,
      },
      {
        key: 'big-down',
        group: 'big',
        label: 'Büyük düşüş',
        direction: 'down',
        enabled: !!settings.bigDownEnabled,
        step: numSetting('bigDownUsd', 100, 1, 100000),
        sound: 'severe',
        tier: 'critical',
      },
    ];
  }

  function resetMovementLatchesAroundPrice(price) {
    const rear = numSetting('rearmOffset', 5, 0, 500);
    for (const raw of [...state.movementLatchedLevels]) {
      const parts = String(raw).split(':');
      const dir = parts[1];
      const level = Number(parts[2]);
      if (!Number.isFinite(level)) {
        state.movementLatchedLevels.delete(raw);
        continue;
      }
      if (dir === 'up' && price <= level - rear) state.movementLatchedLevels.delete(raw);
      if (dir === 'down' && price >= level + rear) state.movementLatchedLevels.delete(raw);
    }
  }

  function emitSystematicAlarm(profile, level, detail = {}) {
    const now = performance.now();
    const cooldownKey = profile.group || profile.key;
    const until = state.alarmCooldownUntil[cooldownKey] || 0;
    if (until > now && !detail.force) return false;
    state.alarmCooldownUntil[cooldownKey] = now + profileCooldownMs(cooldownKey);

    const vol = alarmVolumeFor(cooldownKey);
    const base = {
      profile: profile.key,
      label: profile.label,
      direction: profile.direction,
      level,
      price: detail.price,
      delta: detail.delta,
    };
    debugAlarmTrigger('SYSTEMATIC', base);

    if (profile.sound === 'happy') {
      const play = { type: MSG.PLAY, sound: 'happy', force: !!profile.force, volumeOverride: vol };
      if (state.popupPollsOpener) state.pendingSounds.push(play);
      else if ((settings.hudSurface || 'popup') === 'inline') playLocalSound(play);
      else postToPopup(play);
      return true;
    }

    const intensityMul = cooldownKey === 'critical' ? 2.35 : cooldownKey === 'big' ? 1.45 : Math.max(0.7, Math.min(1.1, vol / 0.06));
    const durationMul = cooldownKey === 'critical' ? 2.1 : cooldownKey === 'big' ? 1.3 : 0.75;
    const tier = profile.tier || (cooldownKey === 'critical' ? 'sub3000' : cooldownKey === 'big' ? 'critical' : 'simple');
    if ((settings.hudSurface || 'popup') === 'inline' && !state.popupPollsOpener) {
      playLocalSound({
        type: MSG.PLAY,
        sound: 'severe',
        force: cooldownKey === 'critical',
        tier,
        intensityMul,
        durationMul,
        volumeOverride: vol,
      });
    } else {
      emitPlaySound('severe', {
        tier,
        intensityMul,
        durationMul,
        volumeOverride: vol,
        quickRepeatCooldown: cooldownKey === 'small',
        skipRecoveryStopWindow: cooldownKey === 'small',
      });
    }
    return true;
  }

  function crossedMovementLevels(prevPrice, currentPrice, step, direction) {
    const levels = [];
    if (direction === 'up') {
      const first = Math.floor(prevPrice / step) * step + step;
      for (let level = first; level <= currentPrice; level += step) levels.push(level);
    } else {
      const first = Math.ceil(prevPrice / step) * step - step;
      for (let level = first; level >= currentPrice; level -= step) levels.push(level);
    }
    return levels.slice(0, 8);
  }

  function checkSystematicMovementAlarms(prevPrice, currentPrice) {
    if (prevPrice == null || currentPrice == null || prevPrice === currentPrice) return;
    resetMovementLatchesAroundPrice(currentPrice);
    const dir = currentPrice > prevPrice ? 'up' : 'down';
    const profiles = getMovementProfiles().filter((p) => p.enabled && p.direction === dir);
    for (const profile of profiles) {
      const levels = crossedMovementLevels(prevPrice, currentPrice, profile.step, dir);
      for (const level of levels) {
        const latchKey = `${profile.key}:${dir}:${level}`;
        if (state.movementLatchedLevels.has(latchKey)) continue;
        if (emitSystematicAlarm(profile, level, { price: currentPrice, delta: currentPrice - prevPrice })) {
          state.movementLatchedLevels.add(latchKey);
        }
      }
    }
  }

  function checkCriticalRollingDrop(currentPrice) {
    if (!settings.criticalDropEnabled) return;
    if (currentPrice == null || !Number.isFinite(currentPrice)) return;
    const windowMs = numSetting('criticalRollingWindowMs', 60000, 5000, 10 * 60 * 1000);
    const dropUsd = getDropUsdInRollingWindow(currentPrice, windowMs);
    const threshold = numSetting('criticalDropUsd', 180, 1, 100000);
    const rear = Math.max(5, numSetting('rearmOffset', 5, 0, 500));
    if (state.criticalDropLatched && dropUsd <= Math.max(0, threshold - rear)) {
      state.criticalDropLatched = false;
    }
    if (state.criticalDropLatched || dropUsd < threshold) return;
    state.criticalDropLatched = true;
    emitSystematicAlarm(
      {
        key: 'critical-drop',
        group: 'critical',
        label: 'Kritik düşüş',
        direction: 'down',
        sound: 'severe',
        tier: 'sub3000',
      },
      Math.round(currentPrice),
      { price: currentPrice, delta: -dropUsd, force: true },
    );
  }

  window.safeHudInvalidateDom = () => {
    /* Ayarlar / seçici değişince bir sonraki tick yeniden okur */
  };

  window.safeHudGetWalletPrice = () => getWalletPrice();

  /**
   * @description Popup’tan “ölçekli uyarı” testi: opener’daki son 1 dk fiyat geçmişi + anlık cüzdan ile aynı çarpanlar.
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
      #sh-app { min-height:100vh; background:var(--sh-bg); color:var(--sh-text); color-scheme:dark;
        font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif; -webkit-font-smoothing:antialiased; }
      #sh-app.sh-popup-compact { min-height:0; background:#080d12; }
      #sh-app.sh-privacy { --sh-up:#9aa3b2; --sh-down:#9aa3b2; }
      :root {
        --sh-bg:#0b0f14;
        --sh-card:#121922;
        --sh-card2:#161d28;
        --sh-line:#243044;
        --sh-text:#e6e9ef;
        --sh-muted:#8b95a8;
        --sh-accent:#3d7dd6;
        --sh-up:#45d483;
        --sh-down:#f08080;
        --sh-row-hover:rgba(255,255,255,0.03);
      }
      @media (prefers-reduced-motion: reduce) {
        .sh-btn { transition:none; }
      }
      .sh-top { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; padding:12px 16px;
        background:linear-gradient(165deg,#151d2a 0%,#0d121a 100%); border-bottom:1px solid var(--sh-line);
        box-shadow:inset 0 1px 0 rgba(255,255,255,0.035); }
      .sh-top-left { display:flex; align-items:center; gap:10px; min-width:0; }
      .sh-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; background:linear-gradient(135deg,#5ad48f,var(--sh-accent));
        box-shadow:0 0 12px rgba(61,125,214,0.28); }
      .sh-top-title { font-size:14px; font-weight:650; letter-spacing:-0.02em; }
      .sh-top-hint { font-size:11px; color:var(--sh-muted); max-width:min(380px,92vw); line-height:1.4; }
      .sh-btn { border:0; border-radius:8px; padding:8px 12px; font-size:12px; font-weight:700; cursor:pointer;
        transition:opacity .15s, transform .12s; }
      .sh-btn:focus-visible { outline:2px solid var(--sh-accent); outline-offset:2px; }
      .sh-btn:active { transform:scale(0.98); }
      .sh-btn-primary { background:linear-gradient(180deg,#4588e0,#2f6ab8); color:#fff; box-shadow:0 4px 16px rgba(47,106,184,0.32); }
      .sh-btn-quiet { background:#202a38; color:var(--sh-text); border:1px solid #314056; }
      .sh-btn-danger { background:#3a2026; color:#ffd6dc; border:1px solid #5b303b; }
      .sh-btn-good { background:#173424; color:#d8ffe8; border:1px solid #285f41; }
      .sh-test-actions { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px; margin:0 0 14px; }
      .sh-test-actions .sh-btn { width:100%; min-height:34px; }
      .sh-section { margin:0 0 12px; padding:10px; border:1px solid var(--sh-line); border-radius:10px; background:#0d141d; }
      .sh-section-head { display:flex; justify-content:space-between; gap:10px; align-items:center; margin-bottom:10px; }
      .sh-section-title { font-size:13px; font-weight:800; color:var(--sh-text); }
      .sh-alarm-grid { display:grid; grid-template-columns:minmax(104px,1fr) auto 92px; gap:7px 9px; align-items:center; font-size:12px; }
      .sh-alarm-grid label { color:var(--sh-muted); }
      .sh-card { margin:12px 14px; background:var(--sh-card); border:1px solid var(--sh-line); border-radius:12px; overflow:hidden;
        box-shadow:0 12px 40px rgba(0,0,0,0.28); }
      .sh-card-h { padding:10px 12px; background:rgba(255,255,255,0.025); border-bottom:1px solid var(--sh-line);
        display:flex; justify-content:space-between; align-items:center; gap:8px; }
      .sh-card-h strong { font-size:14px; letter-spacing:-0.01em; }
      .sh-card-body { padding:12px; }
      .sh-grid { display:grid; grid-template-columns:1fr auto; gap:10px 12px; align-items:center; font-size:13px; }
      .sh-grid label { color:var(--sh-muted); }
      .sh-inp, .sh-select { width:100%; max-width:100%; padding:7px 9px; border-radius:7px; border:1px solid var(--sh-line);
        background:#0a1018; color:var(--sh-text); box-sizing:border-box; font-size:12px; }
      .sh-hud { margin:0 auto 20px; padding:0; background:transparent; border:0; border-radius:0; box-sizing:border-box;
        overflow:visible; box-shadow:none; max-width:100%; }
      .sh-hud-inner { padding:18px 18px 16px; background:linear-gradient(180deg,#131b26 0%,#0e141c 100%);
        border:1px solid var(--sh-line); border-radius:18px; box-shadow:0 10px 40px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04); }
      .sh-hud-label { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:var(--sh-muted);
        margin:0 0 10px; }
      .sh-hud-wallet-wrap { margin-bottom:14px; padding:12px 14px; border-radius:14px; background:rgba(0,0,0,0.22);
        border:1px solid rgba(255,255,255,0.06); }
      .sh-hud-wallet { font-weight:800; line-height:1.06; letter-spacing:-0.03em; font-variant-numeric:tabular-nums; }
      #safe-hud-positions { width:100%; max-width:100%; min-width:0; box-sizing:border-box; }
      .sh-row { display:flex; justify-content:space-between; align-items:flex-end; gap:10px; padding:9px 10px; margin:0 -6px;
        border-radius:10px; width:calc(100% + 12px); max-width:calc(100% + 12px); min-width:0; box-sizing:border-box; overflow:hidden; }
      .sh-row + .sh-row { margin-top:2px; }
      @media (prefers-reduced-motion: no-preference) {
        .sh-row { transition:background .12s ease; }
      }
      .sh-row:hover { background:var(--sh-row-hover); }
      .sh-row-coin { font-weight:800; line-height:1; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .sh-row-right { display:flex; flex-direction:column; align-items:flex-end; gap:3px; flex:0 1 auto; min-width:0; max-width:58%; }
      .sh-row-pnl { font-weight:700; line-height:1; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        font-variant-numeric:tabular-nums; }
      .sh-row-pct { font-weight:600; opacity:0.9; line-height:1; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
        font-variant-numeric:tabular-nums; }
      .sh-tone-up { color:var(--sh-up); }
      .sh-tone-down { color:var(--sh-down); }
      .sh-tone-neu { color:rgba(255,255,255,0.9); }
      .sh-tone-office { color:#aeb4c8; }
      .sh-tone-office-pos { color:#8daf9e; }
      .sh-tone-office-neg { color:#b89a9a; }
      .sh-status { margin-top:14px; padding-top:12px; border-top:1px solid rgba(255,255,255,0.06); font-size:10px; color:var(--sh-muted);
        letter-spacing:0.02em; }
      .sh-popup-compact .sh-hud { width:100% !important; margin:0 !important; }
      .sh-popup-compact .sh-hud-inner { padding:6px; border:0; border-radius:0; box-shadow:none; min-height:100vh; background:#080d12; }
      .sh-popup-compact .sh-hud-wallet-wrap { margin:0 0 4px; padding:4px 5px; border-radius:6px; background:#0e151e; }
      .sh-popup-compact .sh-row { padding:4px 5px; margin:0; width:100%; max-width:100%; border-radius:5px; gap:6px; }
      .sh-popup-compact .sh-row + .sh-row { margin-top:1px; }
      .sh-popup-compact .sh-row-right { gap:1px; max-width:62%; }
      .sh-popup-compact .sh-status { margin-top:5px; padding-top:5px; font-size:9px; }
      #safe-hud-inline-root #sh-app { min-height:0; }
      #safe-hud-inline-root .sh-popup-compact .sh-hud-inner { min-height:0; border:1px solid var(--sh-line); border-top:0; }
      @media (max-width:430px) {
        .sh-test-actions { grid-template-columns:1fr; }
        .sh-alarm-grid { grid-template-columns:minmax(92px,1fr) auto 78px; }
      }
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

    <div class="sh-section">
      <div class="sh-section-head">
        <strong class="sh-section-title">Alarm sistemi</strong>
        <span style="font-size:11px;color:var(--sh-muted);">Ufak / büyük / kritik</span>
      </div>
      <div class="sh-alarm-grid">
        <label>Ufak yükseliş</label>
        <input id="safe-small-up-enabled" type="checkbox" ${s.smallUpEnabled ? 'checked' : ''}>
        <input id="safe-small-up-usd" class="sh-inp" type="number" min="1" step="1" value="${Number.isFinite(s.smallUpUsd) ? s.smallUpUsd : 25}" title="Her kaç USD yükselişte çalsın">
        <label>Ufak düşüş</label>
        <input id="safe-small-down-enabled" type="checkbox" ${s.smallDownEnabled ? 'checked' : ''}>
        <input id="safe-small-down-usd" class="sh-inp" type="number" min="1" step="1" value="${Number.isFinite(s.smallDownUsd) ? s.smallDownUsd : 25}" title="Her kaç USD düşüşte çalsın">
        <label>Büyük yükseliş</label>
        <input id="safe-big-up-enabled" type="checkbox" ${s.bigUpEnabled ? 'checked' : ''}>
        <input id="safe-big-up-usd" class="sh-inp" type="number" min="1" step="1" value="${Number.isFinite(s.bigUpUsd) ? s.bigUpUsd : 100}">
        <label>Büyük düşüş</label>
        <input id="safe-big-down-enabled" type="checkbox" ${s.bigDownEnabled ? 'checked' : ''}>
        <input id="safe-big-down-usd" class="sh-inp" type="number" min="1" step="1" value="${Number.isFinite(s.bigDownUsd) ? s.bigDownUsd : 100}">
        <label>Kritik düşüş</label>
        <input id="safe-critical-drop-enabled" type="checkbox" ${s.criticalDropEnabled ? 'checked' : ''}>
        <input id="safe-critical-drop-usd" class="sh-inp" type="number" min="1" step="1" value="${Number.isFinite(s.criticalDropUsd) ? s.criticalDropUsd : 180}">
      </div>
      <div id="safe-alarm-summary" style="margin-top:10px;padding-top:10px;border-top:1px solid rgba(255,255,255,0.08);font-size:11px;color:var(--sh-muted);line-height:1.45;"></div>
    </div>

    <div class="sh-grid" style="margin-bottom:14px;">
      <label>HUD konumu</label>
      <select id="safe-hud-surface" class="sh-select" style="max-width:240px;">
        <option value="popup" ${(s.hudSurface || 'popup') === 'popup' ? 'selected' : ''}>Ayrı pencere</option>
        <option value="inline" ${s.hudSurface === 'inline' ? 'selected' : ''}>Aynı sayfada hareketli div</option>
      </select>
      <label>Ufak ses</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-small-alarm-volume" type="range" min="0" max="1" step="0.01" value="${Number.isFinite(s.smallAlarmVolume) ? s.smallAlarmVolume : 0.06}">
        <span id="safe-small-alarm-volume-val">${(Number.isFinite(s.smallAlarmVolume) ? s.smallAlarmVolume : 0.06).toFixed(2)}</span>
      </div>
      <label>Büyük ses</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-big-alarm-volume" type="range" min="0" max="1" step="0.01" value="${Number.isFinite(s.bigAlarmVolume) ? s.bigAlarmVolume : 0.08}">
        <span id="safe-big-alarm-volume-val">${(Number.isFinite(s.bigAlarmVolume) ? s.bigAlarmVolume : 0.08).toFixed(2)}</span>
      </div>
      <label>Kritik ses</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-critical-alarm-volume" type="range" min="0" max="1" step="0.01" value="${Number.isFinite(s.criticalAlarmVolume) ? s.criticalAlarmVolume : 0.16}">
        <span id="safe-critical-alarm-volume-val">${(Number.isFinite(s.criticalAlarmVolume) ? s.criticalAlarmVolume : 0.16).toFixed(2)}</span>
      </div>
      <label>Kritik pencere (sn)</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-critical-window" type="range" min="10" max="180" step="5" value="${Math.round((Number.isFinite(s.criticalRollingWindowMs) ? s.criticalRollingWindowMs : 60000) / 1000)}">
        <span id="safe-critical-window-val">${Math.round((Number.isFinite(s.criticalRollingWindowMs) ? s.criticalRollingWindowMs : 60000) / 1000)}</span>
      </div>
    </div>

    <div class="sh-test-actions">
      <button type="button" class="sh-btn sh-btn-good" id="safe-test-happy">Yükseliş testi</button>
      <button type="button" class="sh-btn sh-btn-quiet" id="safe-test-severe" title="50 USD kademesi — kısa / hafif">Basit düşüş</button>
      <button type="button" class="sh-btn sh-btn-danger" id="safe-test-severe-critical" title="100 USD kademesi — uzun / güçlü">Kritik düşüş</button>
      <button type="button" class="sh-btn sh-btn-danger" id="safe-test-severe-sub3000" title="Alt limit altı kademe — en uzun / en keskin">Uyandıran alarm</button>
      <button type="button" class="sh-btn sh-btn-quiet" id="safe-test-severe-scaled" title="Kaynak sekmede son 1 dk düşüşüne göre, kritik">Ölçekli test</button>
      <button type="button" class="sh-btn sh-btn-quiet" id="safe-test-severe-demo-max" title="Yaklaşık maksimum süre ve şiddet, kritik">Maksimum test</button>
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
      <label>Yeniden silah (USD üstü)</label>
      <div style="display:flex;align-items:center;gap:8px;">
        <input id="safe-rearm-offset" type="range" min="0" max="40" step="1" value="${Number.isFinite(s.rearmOffset) ? s.rearmOffset : 5}">
        <span id="safe-rearm-offset-val">${Number.isFinite(s.rearmOffset) ? s.rearmOffset : 5}</span>
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
    </div>`;
  }

  /**
   * @description Yalnızca canlı özet HUD’u (ikinci pencere).
   */
  function buildHudPopupHtml(s) {
    return `
<div id="sh-app" class="sh-popup-compact ${s.privacyOfficeMode ? 'sh-privacy' : ''}">
  
  <div id="safe-hud-display" class="sh-hud" style="width:${s.hudWidth}px;margin:0;">
    <div class="sh-hud-inner">
      <div class="sh-hud-wallet-wrap">
        <div id="safe-hud-wallet" class="sh-hud-wallet">-</div>
      </div>
      <div id="safe-hud-positions" style="display:flex;flex-direction:column;gap:${s.hudGap}px;width:100%;max-width:100%;min-width:0;box-sizing:border-box;"></div>
      <div id="safe-hud-status" class="sh-status"></div>
    </div>
  </div>
</div>`;
  }

  function createInlineHud() {
    document.getElementById('safe-hud-inline-wrap')?.remove();
    loadSettingsIntoSettings();
    injectMainChromeStyles(document);

    const wrap = document.createElement('div');
    wrap.id = 'safe-hud-inline-wrap';
    wrap.style.cssText = [
      'position:fixed',
      `left:${Number.isFinite(settings.hudLeft) ? settings.hudLeft : 16}px`,
      `top:${Number.isFinite(settings.hudTop) ? settings.hudTop : 16}px`,
      'z-index:2147483644',
      'max-width:calc(100vw - 24px)',
      'max-height:calc(100vh - 24px)',
      'overflow:auto',
      'resize:both',
      'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    ].join(';');
    wrap.innerHTML = `
      <div id="safe-hud-inline-handle" style="height:30px;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:0 10px;background:#182232;color:#dce5f4;border:1px solid #29364b;border-bottom:0;border-radius:12px 12px 0 0;cursor:move;font-size:12px;font-weight:700;user-select:none;">
        <span>Canlı HUD</span>
        <button type="button" id="safe-hud-inline-close" title="HUD'u gizle" style="border:0;background:#26354c;color:#fff;border-radius:7px;width:24px;height:22px;cursor:pointer;">×</button>
      </div>
      <div id="safe-hud-inline-root">${buildHudPopupHtml(settings)}</div>
    `;
    document.body.appendChild(wrap);
    state.inlineHudEl = wrap;

    const closeBtn = wrap.querySelector('#safe-hud-inline-close');
    if (closeBtn) closeBtn.onclick = () => wrap.remove();

    const handle = wrap.querySelector('#safe-hud-inline-handle');
    if (handle) {
      let drag = null;
      handle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        drag = { x: e.clientX, y: e.clientY, left: wrap.offsetLeft, top: wrap.offsetTop };
        handle.setPointerCapture(e.pointerId);
      });
      handle.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const left = Math.max(0, Math.min(window.innerWidth - 80, drag.left + e.clientX - drag.x));
        const top = Math.max(0, Math.min(window.innerHeight - 60, drag.top + e.clientY - drag.y));
        wrap.style.left = `${left}px`;
        wrap.style.top = `${top}px`;
      });
      handle.addEventListener('pointerup', () => {
        if (!drag) return;
        const st = readStoredSettings();
        st.hudLeft = parseInt(wrap.style.left, 10) || 16;
        st.hudTop = parseInt(wrap.style.top, 10) || 16;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
        drag = null;
      });
    }
  }

  function readStoredSettings() {
    try {
      return normalizeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
    } catch {
      return { ...defaults };
    }
  }

  function applyInlineHudUpdate(payload) {
    if ((settings.hudSurface || 'popup') !== 'inline') return;
    if (!document.getElementById('safe-hud-inline-wrap')) createInlineHud();
    const s = readStoredSettings();
    const privacy = !!s.privacyOfficeMode;
    const walletEl = document.getElementById('safe-hud-wallet');
    const positionsEl = document.getElementById('safe-hud-positions');
    const statusEl = document.getElementById('safe-hud-status');
    const hudBox = document.getElementById('safe-hud-display');
    document.getElementById('sh-app')?.classList.toggle('sh-privacy', privacy);
    if (hudBox) {
      hudBox.style.width = `${s.hudWidth}px`;
      hudBox.style.margin = '0';
    }
    if (walletEl) {
      walletEl.textContent = formatHudWalletDisplay(payload.wallet);
      walletEl.style.fontSize = `${s.hudWalletFontSize}px`;
      walletEl.className = `sh-hud-wallet ${privacy ? 'sh-tone-office' : 'sh-tone-neu'}`;
    }
    if (positionsEl) {
      positionsEl.style.gap = `${s.hudGap}px`;
      positionsEl.innerHTML = '';
      const rows = sortPositionsByPnlPreference(payload.positions || [], s.hudPnlSort || 'none');
      rows.forEach((pos, idx) => {
        const row = document.createElement('div');
        row.className = 'sh-row';
        const pnlNum = parseNumber(String(pos.pnl));
        const left = document.createElement('div');
        left.textContent = privacy && s.maskRowLabels ? `Kalem ${idx + 1}` : pos.coin || '-';
        left.className = `sh-row-coin ${privacy ? 'sh-tone-office' : pnlNum > 0 ? 'sh-tone-up' : pnlNum < 0 ? 'sh-tone-down' : 'sh-tone-neu'}`;
        left.style.fontSize = `${s.hudCoinFontSize}px`;
        const rightWrap = document.createElement('div');
        rightWrap.className = 'sh-row-right';
        const pnl = document.createElement('div');
        const tone = privacy
          ? pnlNum > 0
            ? 'sh-tone-office-pos'
            : pnlNum < 0
              ? 'sh-tone-office-neg'
              : 'sh-tone-office'
          : pnlNum > 0
            ? 'sh-tone-up'
            : pnlNum < 0
              ? 'sh-tone-down'
              : 'sh-tone-neu';
        pnl.textContent = formatHudStripSignChars(pos.pnl);
        pnl.className = `sh-row-pnl ${tone}`;
        pnl.style.fontSize = `${s.hudPnlFontSize}px`;
        rightWrap.appendChild(pnl);
        const pctShown = formatHudStripSignChars(pos.pct);
        if (pctShown) {
          const pct = document.createElement('div');
          pct.textContent = pctShown;
          pct.className = `sh-row-pct ${tone}`;
          pct.style.fontSize = `${s.hudPctFontSize}px`;
          rightWrap.appendChild(pct);
        }
        row.appendChild(left);
        row.appendChild(rightWrap);
        positionsEl.appendChild(row);
      });
    }
    if (statusEl) statusEl.textContent = privacy ? '' : payload.debug || '';
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
      if ((settings.hudSurface || 'popup') === 'inline') {
        playLocalSound(playMsg);
        return;
      }
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

  const localAudioState = {
    ctx: null,
    severeStopHandles: [],
    severeCooldownUntil: 0,
  };

  function getLocalAudioCtx() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!localAudioState.ctx) localAudioState.ctx = new AC();
    return localAudioState.ctx;
  }

  function stopLocalSevereVoicesNow() {
    localAudioState.severeStopHandles.forEach((fn) => {
      try {
        fn();
      } catch (e) {}
    });
    localAudioState.severeStopHandles = [];
  }

  function playLocalSound(msg = {}) {
    const ctx = getLocalAudioCtx();
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended') ctx.resume();
    } catch (e) {}
    const s = { ...defaults, ...settings };
    const volOverride = Number(msg.volumeOverride);
    const volume = Number.isFinite(volOverride) ? Math.max(0.0001, Math.min(1, volOverride)) : null;
    const start = ctx.currentTime;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.setValueAtTime(msg.sound === 'severe' ? -8 : -18, start);
    comp.ratio.setValueAtTime(msg.sound === 'severe' ? 18 : 8, start);
    comp.attack.setValueAtTime(0.003, start);
    comp.release.setValueAtTime(0.22, start);
    comp.connect(ctx.destination);

    if (msg.sound === 'happy') {
      const vol = volume ?? Math.max(0.0001, Math.min(1, Number(s.smallAlarmVolume) || 0.06));
      [520, 780, 1120].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const t = start + i * 0.055;
        osc.type = i === 2 ? 'triangle' : 'sine';
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.exponentialRampToValueAtTime(freq * 1.28, t + 0.16);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(Math.min(0.45, vol * 2.1), t + 0.025);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
        osc.connect(g);
        g.connect(comp);
        osc.start(t);
        osc.stop(t + 0.25);
      });
      setTimeout(() => {
        try {
          comp.disconnect();
        } catch (e) {}
      }, 420);
      return;
    }

    const now = performance.now();
    if (!msg.force && localAudioState.severeCooldownUntil > now) {
      try {
        comp.disconnect();
      } catch (e) {}
      return;
    }
    stopLocalSevereVoicesNow();
    const tier = msg.tier === 'sub3000' ? 'sub3000' : msg.tier === 'critical' ? 'critical' : 'simple';
    const vol = volume ?? Math.max(0.0001, Math.min(1, Number(s.bigAlarmVolume) || 0.08));
    const intM = Math.min(2.8, Math.max(0.55, Number(msg.intensityMul) || (tier === 'simple' ? 0.8 : 1.4)));
    const durM = Math.min(2.4, Math.max(0.65, Number(msg.durationMul) || 1));
    const count = tier === 'sub3000' ? Math.round(110 * durM) : tier === 'critical' ? Math.round(58 * durM) : Math.round(16 * durM);
    const step = tier === 'sub3000' ? 0.085 : tier === 'critical' ? 0.12 : 0.13;
    const pulseLen = tier === 'simple' ? 0.28 : tier === 'critical' ? 0.78 : 0.92;
    for (let i = 0; i < count; i++) {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      const t = start + i * step;
      osc.type = tier === 'simple' ? (i % 2 ? 'triangle' : 'square') : i % 2 ? 'sawtooth' : 'square';
      osc.frequency.setValueAtTime(tier === 'simple' ? (i % 2 ? 900 : 1500) : i % 2 ? 260 + (i % 9) * 38 : 620 + (i % 7) * 52, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.min(1.35, vol * intM * (tier === 'sub3000' ? 1.28 : 1)), t + 0.018);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (tier === 'simple' ? 0.22 : 0.68));
      osc.connect(g);
      g.connect(comp);
      osc.start(t);
      osc.stop(t + pulseLen);
      localAudioState.severeStopHandles.push(() => {
        try {
          osc.stop(0);
        } catch (e) {}
        try {
          osc.disconnect();
          g.disconnect();
        } catch (e2) {}
      });
    }
    localAudioState.severeStopHandles.push(() => {
      try {
        comp.disconnect();
      } catch (e) {}
    });
    localAudioState.severeCooldownUntil = now + (tier === 'sub3000' ? 45000 : tier === 'critical' ? 18000 : 2500);
  }

  /**
   * @description Ana sayfada açılır-kapanır ayar paneli (veri sekmesi).
   */
  function createMainSettingsPanel() {
    document.getElementById('safe-hud-main-settings-wrap')?.remove();
    loadSettingsIntoSettings();
    const s = readStoredSettings();
    injectMainChromeStyles(document);

    const wrap = document.createElement('div');
    wrap.id = 'safe-hud-main-settings-wrap';
    wrap.style.cssText = [
      'position:fixed',
      'left:12px',
      'right:12px',
      'bottom:58px',
      'z-index:2147483645',
      'max-width:min(560px,calc(100vw - 24px))',
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
          <button type="button" id="safe-main-panel-toggle" class="sh-btn sh-btn-primary" style="padding:6px 12px;">${collapsed ? 'Ayarları aç' : 'Daralt'}</button>
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
        return normalizeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'));
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
      toggleBtn.textContent = nowCollapsed ? 'Ayarları aç' : 'Daralt';
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
    bindCheckMain('safe-small-up-enabled', 'smallUpEnabled');
    bindCheckMain('safe-small-down-enabled', 'smallDownEnabled');
    bindCheckMain('safe-big-up-enabled', 'bigUpEnabled');
    bindCheckMain('safe-big-down-enabled', 'bigDownEnabled');
    bindCheckMain('safe-critical-drop-enabled', 'criticalDropEnabled');

    const updateAlarmSummary = () => {
      const st = readMainPanelSettings();
      const el = document.getElementById('safe-alarm-summary');
      if (!el) return;
      const small = `Ufak: +${st.smallUpUsd || 25} / -${st.smallDownUsd || 25} USD`;
      const big = `Büyük: +${st.bigUpUsd || 100} / -${st.bigDownUsd || 100} USD`;
      const critical = `Kritik: son ${Math.round((st.criticalRollingWindowMs || 60000) / 1000)} sn içinde -${st.criticalDropUsd || 180} USD`;
      el.textContent = `${small}. ${big}. ${critical}. Aynı eşik, fiyat ${st.rearmOffset || 5} USD geri toparlanmadan tekrar çalmaz.`;
    };

    const bindAlarmNumberMain = (id, key) => {
      const el = document.getElementById(id);
      if (!el) return;
      const commit = () => {
        const st = readMainPanelSettings();
        const n = parseFloat(el.value);
        st[key] = Number.isFinite(n) ? Math.max(1, n) : defaults[key];
        el.value = String(st[key]);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
        state.movementLatchedLevels.clear();
        state.criticalDropLatched = false;
        updateAlarmSummary();
        notifyHudSettingsChanged();
      };
      el.addEventListener('change', commit);
      el.addEventListener('blur', commit);
    };
    bindAlarmNumberMain('safe-small-up-usd', 'smallUpUsd');
    bindAlarmNumberMain('safe-small-down-usd', 'smallDownUsd');
    bindAlarmNumberMain('safe-big-up-usd', 'bigUpUsd');
    bindAlarmNumberMain('safe-big-down-usd', 'bigDownUsd');
    bindAlarmNumberMain('safe-critical-drop-usd', 'criticalDropUsd');

    const hudSurfaceEl = document.getElementById('safe-hud-surface');
    if (hudSurfaceEl) {
      hudSurfaceEl.onchange = () => {
        const st = readMainPanelSettings();
        st.hudSurface = hudSurfaceEl.value;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
        loadSettingsIntoSettings();
        if (st.hudSurface === 'inline') {
          createInlineHud();
          tick();
        } else {
          document.getElementById('safe-hud-inline-wrap')?.remove();
        }
        notifyHudSettingsChanged();
      };
    }

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

    const bindFloatRangeMain = (id, key, digits = 2) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.oninput = (e) => {
        const st = readMainPanelSettings();
        st[key] = parseFloat(e.target.value);
        const val = document.getElementById(`${id}-val`);
        if (val) val.textContent = st[key].toFixed(digits);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
        notifyHudSettingsChanged();
      };
    };
    bindFloatRangeMain('safe-small-alarm-volume', 'smallAlarmVolume');
    bindFloatRangeMain('safe-big-alarm-volume', 'bigAlarmVolume');
    bindFloatRangeMain('safe-critical-alarm-volume', 'criticalAlarmVolume');

    const criticalWindowEl = document.getElementById('safe-critical-window');
    if (criticalWindowEl) {
      criticalWindowEl.oninput = (e) => {
        const st = readMainPanelSettings();
        const sec = parseInt(e.target.value, 10);
        st.criticalRollingWindowMs = Math.max(5, sec) * 1000;
        document.getElementById('safe-critical-window-val').textContent = String(Math.max(5, sec));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
        state.criticalDropLatched = false;
        updateAlarmSummary();
        notifyHudSettingsChanged();
      };
    }
    document.getElementById('safe-rearm-offset').oninput = (e) => {
      const st = readMainPanelSettings();
      st.rearmOffset = parseInt(e.target.value, 10);
      document.getElementById('safe-rearm-offset-val').textContent = String(st.rearmOffset);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(st));
      updateAlarmSummary();
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
      postSoundToHudWindow({
        type: MSG.PLAY,
        sound: 'severe',
        force: true,
        tier: 'simple',
        skipRecoveryStopWindow: true,
      });
    };
    document.getElementById('safe-test-severe-critical').onclick = () => {
      postSoundToHudWindow({ type: MSG.PLAY, sound: 'severe', force: true, tier: 'critical' });
    };
    document.getElementById('safe-test-severe-sub3000').onclick = () => {
      postSoundToHudWindow({
        type: MSG.PLAY,
        sound: 'severe',
        force: true,
        tier: 'sub3000',
        intensityMul: 2.15,
        durationMul: 2,
      });
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
    [
      'safe-small-up-enabled',
      'safe-small-down-enabled',
      'safe-big-up-enabled',
      'safe-big-down-enabled',
      'safe-critical-drop-enabled',
    ].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('change', updateAlarmSummary);
    });
    updateAlarmSummary();
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
        return normalizeSettings(JSON.parse(win.localStorage.getItem(STORAGE_KEY) || '{}'));
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
     * @description Düşüş alarmı: sub3000 = alt limit altı kademe (en uzun/keskin), critical = 100 USD, simple = 50 USD.
     * @param opts.force - Test için soğuma atlanır; yine de önceki ses durdurulur.
     * @param opts.tier - sub3000 | critical | simple (yok + quickRepeat yok → critical)
     */
    function playSevere(s, opts = {}) {
      const ctx = getAudioCtx();
      if (!ctx) return;

      const tier = opts.quickRepeatCooldown
        ? 'simple'
        : opts.tier === 'sub3000'
          ? 'sub3000'
          : opts.tier === 'simple'
            ? 'simple'
            : 'critical';

      const overrideVol = Number(opts.volumeOverride);
      const baseVol = Number.isFinite(overrideVol)
        ? Math.max(0.0001, Math.min(1, overrideVol))
        : opts.useHappyVolume
          ? Math.max(0.0001, Math.min(1, Number(s.smallAlarmVolume) || 0.06))
          : Math.max(0.0001, Math.min(1, Number(s.bigAlarmVolume) || 0.08));

      const intBase = Math.min(2.5, Math.max(0.5, Number(opts.intensityMul) || 1));
      const durBase = Math.min(2.2, Math.max(0.85, Number(opts.durationMul) || 1));
      let intM = intBase;
      let durM = durBase;
      let critSynth = null;
      if (tier === 'simple') {
        intM = Math.min(1.42, intBase * 0.66);
        durM = Math.min(1.22, durBase * 0.7);
      } else if (tier === 'sub3000') {
        critSynth = sub3000SevereSynthTiming(opts.intensityMul || 1, opts.durationMul || 1);
        intM = critSynth.intM;
        durM = critSynth.durM;
      } else {
        critSynth = criticalSevereSynthTiming(opts.intensityMul || 1, opts.durationMul || 1);
        intM = critSynth.intM;
        durM = critSynth.durM;
      }

      const nowWall = performance.now();
      let baseCooldownMs;
      if (opts.quickRepeatCooldown) {
        baseCooldownMs = 2200;
      } else if (tier === 'simple') {
        baseCooldownMs = 4800;
      } else if (tier === 'sub3000') {
        baseCooldownMs = Math.max(32000, (critSynth || sub3000SevereSynthTiming(1, 1)).totalMs + 3500);
      } else {
        baseCooldownMs = Math.max(24000, (critSynth || criticalSevereSynthTiming(1, 1)).totalMs + 2000);
      }
      const cooldownMs = Math.round(baseCooldownMs * (tier === 'critical' || tier === 'sub3000' ? 1 : durM));
      if (!opts.force && audioState.severeCooldownUntil > nowWall) {
        return;
      }

      stopSevereVoicesNow();

      const start = ctx.currentTime;
      let compRatio;
      let compThr;
      let oscCount;
      let stepSec;
      let volPeak;
      let pulseAttack;
      let pulseDecayEnd;
      let pulseStop;
      if (tier === 'sub3000' && critSynth) {
        compRatio = Math.min(22, 20.5 + intM * 2.75);
        compThr = -3.8 - intM * 2.25;
        oscCount = critSynth.oscCount;
        stepSec = critSynth.stepSec;
        pulseAttack = critSynth.pulseAttack;
        pulseDecayEnd = critSynth.pulseDecayEnd;
        pulseStop = critSynth.pulseStop;
        volPeak = Math.max(0.0001, Math.min(1.38, baseVol * intM * 1.18));
      } else if (tier === 'critical' && critSynth) {
        compRatio = Math.min(22, 19.2 + intM * 2.55);
        compThr = -5.2 - intM * 2.05;
        oscCount = critSynth.oscCount;
        stepSec = critSynth.stepSec;
        pulseAttack = critSynth.pulseAttack;
        pulseDecayEnd = critSynth.pulseDecayEnd;
        pulseStop = critSynth.pulseStop;
        volPeak = Math.max(0.0001, Math.min(1.34, baseVol * intM * 1.1));
      } else {
        compRatio = Math.min(22, 13.5 + intM * 1.35);
        compThr = -12 - intM * 1.1;
        oscCount = Math.min(44, Math.round(17 * durM + 4));
        stepSec = 0.125 / Math.max(0.88, Math.sqrt(intM));
        volPeak = Math.max(0.0001, Math.min(1.28, baseVol * intM));
        pulseAttack = 0.011;
        pulseDecayEnd = 0.24;
        pulseStop = 0.3;
      }
      const comp = compressor(ctx, compThr, compRatio);

      for (let i = 0; i < oscCount; i++) {
        const t = start + i * stepSec;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        if (tier === 'sub3000' && critSynth) {
          osc.type = i % 3 === 0 ? 'square' : 'sawtooth';
          const lo = 200 + (i % 12) * 38;
          const hi = 620 + (i % 10) * 58;
          osc.frequency.setValueAtTime(i % 2 === 0 ? hi : lo, t);
        } else if (tier === 'critical' && critSynth) {
          osc.type = i % 2 === 0 ? 'square' : 'sawtooth';
          const lo = 260 + (i % 9) * 40;
          const hi = 500 + (i % 7) * 44;
          osc.frequency.setValueAtTime(i % 2 === 0 ? hi : lo, t);
        } else {
          osc.type = i % 3 === 0 ? 'square' : i % 3 === 1 ? 'sawtooth' : 'triangle';
          osc.frequency.setValueAtTime(i % 2 === 0 ? 1600 : 900, t);
        }
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

    /**
     * @description Yükseliş sesi: kısa, daha yumuşak ve yukarı kayan ton.
     */
    function playHappy(s, opts = {}) {
      const ctx = getAudioCtx();
      if (!ctx) return;

      const overrideVol = Number(opts.volumeOverride);
      const vol = Number.isFinite(overrideVol)
        ? Math.max(0.0001, Math.min(1, overrideVol))
        : Math.max(0.0001, Math.min(1, Number(s.smallAlarmVolume) || 0.06));
      const start = ctx.currentTime;
      const comp = compressor(ctx, -18, 8);
      const master = ctx.createGain();
      master.gain.setValueAtTime(0.0001, start);
      master.gain.exponentialRampToValueAtTime(Math.min(0.35, vol * 1.8), start + 0.025);
      master.gain.exponentialRampToValueAtTime(0.0001, start + 0.28);
      master.connect(comp);

      const tones = [
        { from: 520, to: 700, at: 0.0, len: 0.16, type: 'sine' },
        { from: 780, to: 1060, at: 0.045, len: 0.17, type: 'triangle' },
      ];

      tones.forEach((t) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        const t0 = start + t.at;
        const t1 = t0 + t.len;
        osc.type = t.type;
        osc.frequency.setValueAtTime(t.from, t0);
        osc.frequency.exponentialRampToValueAtTime(t.to, t1);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(1, t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t1);
        osc.connect(g);
        g.connect(master);
        osc.start(t0);
        osc.stop(t1 + 0.02);
      });

      const click = ctx.createOscillator();
      const clickGain = ctx.createGain();
      click.type = 'sine';
      click.frequency.setValueAtTime(1400, start + 0.12);
      click.frequency.exponentialRampToValueAtTime(1750, start + 0.2);
      clickGain.gain.setValueAtTime(0.0001, start + 0.12);
      clickGain.gain.exponentialRampToValueAtTime(Math.min(0.6, vol * 2.8), start + 0.135);
      clickGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      click.connect(clickGain);
      clickGain.connect(master);
      click.start(start + 0.12);
      click.stop(start + 0.24);

      setTimeout(() => {
        try {
          master.disconnect();
          comp.disconnect();
        } catch (e) {}
      }, 420);
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
      d.getElementById('sh-app')?.classList.add('sh-popup-compact');

      const walletEl = d.getElementById('safe-hud-wallet');
      const positionsEl = d.getElementById('safe-hud-positions');
      const statusEl = d.getElementById('safe-hud-status');
      const hudBox = d.getElementById('safe-hud-display');

      if (hudBox) hudBox.style.width = `${s.hudWidth}px`;

      if (walletEl) {
        walletEl.textContent = formatHudWalletDisplay(payload.wallet);
        walletEl.style.fontSize = `${s.hudWalletFontSize}px`;
        walletEl.className = `sh-hud-wallet ${privacy ? 'sh-tone-office' : 'sh-tone-neu'}`;
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
          let coinCls = 'sh-tone-neu';
          if (privacy) coinCls = 'sh-tone-office';
          else if (pnlNum != null) {
            if (pnlNum > 0) coinCls = 'sh-tone-up';
            else if (pnlNum < 0) coinCls = 'sh-tone-down';
          }
          left.className = `sh-row-coin ${coinCls}`;
          left.style.fontSize = `${s.hudCoinFontSize}px`;
          const rightWrap = d.createElement('div');
          rightWrap.className = 'sh-row-right';
          const pnl = d.createElement('div');
          const pnlShown = formatHudStripSignChars(pos.pnl);
          pnl.textContent = pnlShown;
          let pnlCls = 'sh-tone-neu';
          if (privacy) {
            if (pnlNum != null) {
              if (pnlNum > 0) pnlCls = 'sh-tone-office-pos';
              else if (pnlNum < 0) pnlCls = 'sh-tone-office-neg';
              else pnlCls = 'sh-tone-office';
            } else pnlCls = 'sh-tone-office';
          } else if (pnlNum != null) {
            if (pnlNum > 0) pnlCls = 'sh-tone-up';
            else if (pnlNum < 0) pnlCls = 'sh-tone-down';
          }
          pnl.className = `sh-row-pnl ${pnlCls}`;
          pnl.style.fontSize = `${s.hudPnlFontSize}px`;
          const pctShown = formatHudStripSignChars(pos.pct);
          rightWrap.appendChild(pnl);
          if (pctShown) {
            const pct = d.createElement('div');
            pct.textContent = pctShown;
            pct.className = `sh-row-pct ${pnlCls}`;
            pct.style.fontSize = `${s.hudPctFontSize}px`;
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
              volumeOverride: ev.data.volumeOverride,
              quickRepeatCooldown: !!ev.data.quickRepeatCooldown,
              tier: ev.data.tier,
            });
          }
          if (ev.data.sound === 'happy') {
            playHappy(s, { force: !!ev.data.force, volumeOverride: ev.data.volumeOverride });
          }
        });
      }
    };
    win.addEventListener('message', onMessage);
    win.__safeHudPopupOnMessage = onMessage;

    const onClickUnlock = () => unlockAudio();
    win.__safeHudPopupClickUnlock = onClickUnlock;
    win.addEventListener('click', onClickUnlock, { passive: true });

    const focusOpenerBtn = d.getElementById('safe-popup-focus-opener');
    if (focusOpenerBtn) {
      focusOpenerBtn.onclick = () => {
        try {
          if (win.opener && !win.opener.closed) win.opener.focus();
        } catch (e) {}
      };
    }

    try {
      if (win.opener && typeof win.opener.safeHudBeginPopupPolling === 'function') {
        win.opener.safeHudBeginPopupPolling(win);
      }
    } catch (e) {}
  }

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

    const w = window.open('', POPUP_WINDOW_NAME, 'width=300,height=720,scrollbars=yes,resizable=yes');
    if (!w) {
      showPopupBlockedHelp();
      return false;
    }

    state.hudWindow = w;
    const d = w.document;
    d.open();
    d.write(
      `<!DOCTYPE html><html lang="tr"><head><meta charset="utf-8"><title>Çalışma özeti</title></head><body style="margin:0;padding:0;background:#080d12;color:#e8eaed;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;min-height:100vh;overflow:auto;"><div id="safe-popup-root"></div></body></html>`,
    );
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
    loadSettingsIntoSettings();
    const host = document.createElement('div');
    host.id = 'safe-hud-launcher-host';
    host.style.cssText =
      'position:fixed;left:12px;bottom:12px;z-index:2147483646;font-family:Arial,sans-serif;display:flex;gap:8px;flex-wrap:wrap;align-items:center;';
    host.innerHTML = `
      <button type="button" id="safe-hud-open-win" style="background:#1a5f8a;color:#fff;border:0;border-radius:10px;padding:10px 14px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,0.35);">${(settings.hudSurface || 'popup') === 'inline' ? 'HUD divini aç' : 'HUD penceresini aç'}</button>
      <button type="button" id="safe-hud-close-all" style="background:#333;color:#fff;border:0;border-radius:10px;padding:10px 12px;cursor:pointer;">Kapat</button>
    `;
    document.body.appendChild(host);
    const openBtn = document.getElementById('safe-hud-open-win');
    if ((settings.hudSurface || 'popup') === 'inline') {
      openBtn.onclick = () => {
        createInlineHud();
        tick();
      };
    } else {
      bindUserGestureOpen(openBtn);
    }
    document.getElementById('safe-hud-close-all').onclick = () => window.safeHudCleanup();
    createMainSettingsPanel();
    if ((settings.hudSurface || 'popup') === 'inline') createInlineHud();
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
      resetWalletFlatWatch();
      const sounds = [...state.pendingSounds];
      state.pendingSounds.length = 0;
      return { payload, sounds };
    }

    const prevSample = state.lastWalletPrice;
    const recoveryWindow = state.severePlaybackUntil > performance.now() || performance.now() < (state.criticalVoiceUntil || 0);
    if (prevSample != null && currentPrice > prevSample && recoveryWindow) {
      if (performance.now() < (state.criticalVoiceUntil || 0)) {
        /* 100 USD kritik: sekans bitene kadar kesme (uyanma) */
      } else {
        state.severePlaybackUntil = 0;
        state.criticalVoiceUntil = 0;
        notifyStopSevere();
      }
    }

    if (state.lastWalletPrice === null) {
      state.lastWalletPrice = currentPrice;
    } else {
      checkSystematicMovementAlarms(state.lastWalletPrice, currentPrice);
      state.lastWalletPrice = currentPrice;
    }

    recordPriceSample(currentPrice);
    checkCriticalRollingDrop(currentPrice);
    checkWalletFlatStale(currentPrice);

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
          : item.sound === 'happy'
            ? { type: MSG.PLAY, sound: 'happy', force: !!item.force, volumeOverride: item.volumeOverride }
            : {
                type: MSG.PLAY,
                sound: 'severe',
                intensityMul: item.intensityMul,
                durationMul: item.durationMul,
                volumeOverride: item.volumeOverride,
                skipRecoveryStopWindow: item.skipRecoveryStopWindow,
                quickRepeatCooldown: item.quickRepeatCooldown,
                tier: item.tier,
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
              : item.sound === 'happy'
                ? { type: MSG.PLAY, sound: 'happy', force: !!item.force, volumeOverride: item.volumeOverride }
                : {
                    type: MSG.PLAY,
                    sound: 'severe',
                    intensityMul: item.intensityMul,
                    durationMul: item.durationMul,
                    volumeOverride: item.volumeOverride,
                    skipRecoveryStopWindow: item.skipRecoveryStopWindow,
                    quickRepeatCooldown: item.quickRepeatCooldown,
                    tier: item.tier,
                  };
          popupWin.postMessage(msg, '*');
        }
      } catch (e) {}
    };
    run();

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
    state.movementLatchedLevels.clear();
    state.alarmCooldownUntil = {};
    state.criticalDropLatched = false;
    state.criticalVoiceUntil = 0;
    resetWalletFlatWatch();
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
    document.getElementById('safe-hud-inline-wrap')?.remove();
    stopLocalSevereVoicesNow();
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
