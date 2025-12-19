/* script.js
   Güncelleme: admin tarafından chat banı özelliği eklendi (kullanıcılar yalnızca chat yazamaz / medya gönderemez),
   chat fotoğraf/video yükleme düzeltildi (Firebase Storage kullanımı),
   kullanıcı menüsüne boş href'li buton desteği eklendi.
   Tüm önceki özellikler korunmuştur.

   2025-12-03 - Yeni güncelleme:
   - Bakım / sunucu kapalı durumlarında tam ekran, görsel ağırlıklı ve güçlü bir overlay gösterme eklendi (xxx.png arkaplan).
   - Ana ekranda çapraz köşeye mini bir buton eklendi; tıklayınca hızlı tıklama/bet menüsü açılıyor.
   - Mevcut tüm fonksiyonellik korunmuş, yeni UI elemanları mevcut iş akışına entegre edilmiştir.
   - 2025-12-03+ : Kromatik (chromatic) parlayan isimler eklendi: siyah, mavi, yeşil, mor, kan-kırmızısı.
*/

(function(){
  // ########################### SABİTLER ###########################
  const LOGGED_IN_KEY = 'bio_logged_in_user_v9';
  const ADMIN_LOGGED_IN_KEY = 'bio_admin_logged_in_v9';
  const PRICE = 0.10;
  const COOLDOWN_MS = 1500;
  const DEFAULT_MIN_WITHDRAWAL = 2500.00; // güncellendi: 2500$
  const DEFAULT_DAILY_CLICK_LIMIT = 100;
  const DEFAULT_DAILY_EARNINGS_LIMIT = 20.00;
  const ONLINE_THRESHOLD_MS = 90 * 1000; // son 90s içinde görünen => çevrimiçi

  // Firebase global (init in HTML)
  // Ensure storage variable exists safely (some pages may not include storage SDK)
  if (typeof storage === 'undefined') {
    try {
      // avoid redeclaring const/let in environments where storage is defined
      // use var to create in global scope if missing
      if (typeof firebase !== 'undefined' && firebase.storage) {
        var storage = firebase.storage();
      } else {
        var storage = null;
      }
    } catch (e) {
      var storage = null;
    }
  }

  // ########################### GENEL YARDIMCILAR ###########################
  async function hashPassword(pass) {
    const encoder = new TextEncoder();
    const data = encoder.encode(pass);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // --- Yeni yardımcı: chromatic renk çözümleyici ---
  // Accepts flashyColor tokens like 'chrom-blue' or hex/normal color.
  function parseFlashyColorToken(colorToken) {
    if (!colorToken || typeof colorToken !== 'string') return { isChromatic: false, cssColor: colorToken || '#00A3FF', chromaType: null };
    const t = colorToken.trim().toLowerCase();
    if (t.startsWith('chrom-')) {
      const chromaType = t.slice(6);
      // fallback base colors for non-visual css fallback
      const fallbackMap = {
        'black': '#0b0b0b',
        'blue': '#00A3FF',
        'green': '#00FF8C',
        'purple': '#9a59ff',
        'red': '#8B0000'
      };
      return { isChromatic: true, cssColor: fallbackMap[chromaType] || '#00A3FF', chromaType };
    }
    // not chromatic, treat as color hex or name
    return { isChromatic: false, cssColor: colorToken, chromaType: null };
  }

  async function getUsers() {
    try {
      const snapshot = await db.collection('users').get();
      const users = {};
      snapshot.forEach(doc => {
        users[doc.id] = doc.data();
      });
      Object.keys(users).forEach(k => {
        const u = users[k] || {};
        if (typeof u.role !== 'string') u.role = 'user';
        if (!Array.isArray(u.withdrawalRequests)) u.withdrawalRequests = [];
        if (!Array.isArray(u.betRequests)) u.betRequests = []; // new: bet requests
        u.balance = typeof u.balance === 'number' ? u.balance : 0;
        u.clicks = typeof u.clicks === 'number' ? u.clicks : 0;
        u.dailyClicks = typeof u.dailyClicks === 'number' ? u.dailyClicks : 0;
        u.dailyEarnings = typeof u.dailyEarnings === 'number' ? u.dailyEarnings : 0;
        if (!u.dailyDate) u.dailyDate = todayDateKey();
        if (typeof u.premium !== 'boolean') u.premium = false;
        if (typeof u.isBanned !== 'boolean') u.isBanned = false;
        if (typeof u.isChatBanned !== 'boolean') u.isChatBanned = false; // chat-ban flag
        if (typeof u.appliedCoupon !== 'string') u.appliedCoupon = '';
        if (!u.activeCoupon) u.activeCoupon = null;
        // new: persist appliedCouponPercent on user (helps show percent on withdraw requests)
        if (typeof u.appliedCouponPercent !== 'number') u.appliedCouponPercent = 0;
        if (typeof u.profileName !== 'string') u.profileName = u.username || '';
        if (typeof u.profileColor !== 'string') u.profileColor = '#00A3FF';
        if (typeof u.flashyName !== 'string') u.flashyName = '';
        if (typeof u.flashyColor !== 'string') u.flashyColor = '';
        if (typeof u.flashyAnimated !== 'boolean') u.flashyAnimated = false;
        if (typeof u.lastSeen !== 'number') u.lastSeen = 0;
      });
      return users;
    } catch (e) {
      console.error("Kullanıcı verisi yüklenirken hata oluştu:", e);
      return {};
    }
  }

  async function saveUser(username, userData) {
    try {
      await db.collection('users').doc(username).set(userData);
    } catch (e) {
      console.error("Kullanıcı kaydedilirken hata:", e);
    }
  }

  async function getLoggedInUser() {
    const username = localStorage.getItem(LOGGED_IN_KEY);
    if (!username) return null;
    try {
      const userDoc = await db.collection('users').doc(username).get();
      if (!userDoc.exists) return null;
      const ud = userDoc.data();
      // Ensure username exists on object for later usage
      if (!ud.username) ud.username = username;
      if (typeof ud.profileName !== 'string') ud.profileName = username;
      if (typeof ud.profileColor !== 'string') ud.profileColor = '#00A3FF';
      if (typeof ud.flashyName !== 'string') ud.flashyName = '';
      if (typeof ud.flashyColor !== 'string') ud.flashyColor = '';
      if (typeof ud.flashyAnimated !== 'boolean') ud.flashyAnimated = false;
      if (typeof ud.lastSeen !== 'number') ud.lastSeen = 0;
      if (typeof ud.appliedCouponPercent !== 'number') ud.appliedCouponPercent = 0;
      if (!Array.isArray(ud.betRequests)) ud.betRequests = [];
      if (typeof ud.isChatBanned !== 'boolean') ud.isChatBanned = false;
      return ud;
    } catch (e) {
      console.error('getLoggedInUser hata:', e);
      return null;
    }
  }

  function setLoggedInUser(user) {
      localStorage.setItem(LOGGED_IN_KEY, user ? (user.username || '') : '');
  }

  async function getSettings() {
    try {
      const doc = await db.collection('meta').doc('settings').get();
      if (!doc.exists) {
        const defaults = {
          dailyClickLimit: DEFAULT_DAILY_CLICK_LIMIT,
          dailyEarningsLimit: DEFAULT_DAILY_EARNINGS_LIMIT,
          minWithdrawalAmount: DEFAULT_MIN_WITHDRAWAL,
          coupons: [],
          maintenance: { enabled: false, reason: '', since: null, scheduledAt: null },
          announcements: [],
          server: { closed: false, reason: '', since: null, scheduledAt: null } // server control
        };
        await saveSettings(defaults);
        return defaults;
      }
      let parsed = doc.data();
      if (typeof parsed.dailyClickLimit !== 'number') parsed.dailyClickLimit = DEFAULT_DAILY_CLICK_LIMIT;
      if (typeof parsed.dailyEarningsLimit !== 'number') parsed.dailyEarningsLimit = DEFAULT_DAILY_EARNINGS_LIMIT;
      if (typeof parsed.minWithdrawalAmount !== 'number') parsed.minWithdrawalAmount = DEFAULT_MIN_WITHDRAWAL;
      if (!Array.isArray(parsed.coupons)) parsed.coupons = [];
      if (!parsed.maintenance) parsed.maintenance = { enabled: false, reason: '', since: null, scheduledAt: null };
      if (!Array.isArray(parsed.announcements)) parsed.announcements = [];
      if (!parsed.server) parsed.server = { closed: false, reason: '', since: null, scheduledAt: null };
      return parsed;
    } catch (e) {
      console.error("Ayarlar yüklenirken hata:", e);
      return {
        dailyClickLimit: DEFAULT_DAILY_CLICK_LIMIT,
        dailyEarningsLimit: DEFAULT_DAILY_EARNINGS_LIMIT,
        minWithdrawalAmount: DEFAULT_MIN_WITHDRAWAL,
        coupons: [],
        maintenance: { enabled: false, reason: '', since: null, scheduledAt: null },
        announcements: [],
        server: { closed: false, reason: '', since: null, scheduledAt: null }
      };
    }
  }

  async function saveSettings(s) {
    try { await db.collection('meta').doc('settings').set(s); } catch (e) { console.error("Ayarlar kaydedilirken hata:", e); }
  }

  async function getDefaultDailyClickLimit() {
    try {
      const s = await getSettings();
      return typeof s.dailyClickLimit === 'number' ? s.dailyClickLimit : DEFAULT_DAILY_CLICK_LIMIT;
    } catch (e) {
      return DEFAULT_DAILY_CLICK_LIMIT;
    }
  }
  async function getDefaultDailyEarningsLimit() {
    try {
      const s = await getSettings();
      return typeof s.dailyEarningsLimit === 'number' ? s.dailyEarningsLimit : DEFAULT_DAILY_EARNINGS_LIMIT;
    } catch (e) {
      return DEFAULT_DAILY_EARNINGS_LIMIT;
    }
  }
  async function getMinWithdrawalAmount() {
    try {
      const s = await getSettings();
      return typeof s.minWithdrawalAmount === 'number' ? s.minWithdrawalAmount : DEFAULT_MIN_WITHDRAWAL;
    } catch (e) {
      return DEFAULT_MIN_WITHDRAWAL;
    }
  }
  async function getMaintenanceInfo() {
    try {
      const s = await getSettings();
      // If a scheduledAt is set and the time is reached, enable maintenance automatically.
      if (s.maintenance && s.maintenance.scheduledAt) {
        try {
          const scheduled = Number(s.maintenance.scheduledAt);
          if (!isNaN(scheduled) && scheduled <= Date.now()) {
            s.maintenance.enabled = true;
            s.maintenance.since = s.maintenance.scheduledAt;
            s.maintenance.scheduledAt = null;
            await saveSettings(s);
          }
        } catch(e){}
      }
      // If server scheduledAt is set and the time is reached, apply server closed
      if (s.server && s.server.scheduledAt) {
        try {
          const scheduled = Number(s.server.scheduledAt);
          if (!isNaN(scheduled) && scheduled <= Date.now()) {
            s.server.closed = true;
            s.server.since = s.server.scheduledAt;
            s.server.scheduledAt = null;
            await saveSettings(s);
          }
        } catch(e){}
      }
      return s.maintenance || { enabled: false, reason: '', since: null, scheduledAt: null };
    } catch (e) {
      return { enabled: false, reason: '', since: null, scheduledAt: null };
    }
  }

  function formatMoney(n){ return '$' + Number(n || 0).toFixed(2); }
  function pulse(el){ if (!el || !el.animate) return; el.animate([{ transform:'scale(1)' },{ transform:'scale(1.07)', opacity:0.95 },{ transform:'scale(1)' }],{ duration:260, easing:'cubic-bezier(.2,.8,.2,1)' }); }

  function todayDateKey(){ return new Date().toISOString().slice(0,10); }

  const IBAN_REGEX = /^[A-Z]{2}\d{2}[A-Z0-9]{1,30}$/i;
  const TR_IBAN_REGEX = /^TR\d{24}$/i;
  function normalizeIban(raw){ return raw ? raw.replace(/\s+/g, '').toUpperCase() : ''; }
  function prettyIban(raw){
    const s = normalizeIban(raw);
    if (s.length === 0) return '';
    let formatted = s.match(/.{1,4}/g).join(' ');
    return formatted.trim();
  }
  function ibanMod97(iban) {
    const rearranged = iban.slice(4) + iban.slice(0,4);
    let expanded = '';
    for (let i=0;i<rearranged.length;i++){
      const ch = rearranged[i];
      if (ch >= 'A' && ch <= 'Z') {
        expanded += (ch.charCodeAt(0) - 55).toString();
      } else {
        expanded += ch;
      }
    }
    let remainder = 0;
    let str = expanded;
    while (str.length) {
      const piece = (remainder.toString() + str.slice(0, 9));
      remainder = parseInt(piece, 10) % 97;
      str = str.slice(9);
    }
    return remainder === 1;
  }
  function validateIban(raw){
    const n = normalizeIban(raw);
    if (!n) return false;
    if (n.startsWith('TR')) {
        if (!TR_IBAN_REGEX.test(n)) return false;
        if (n.length !== 26) return false;
        try { return ibanMod97(n); } catch(e) { return false; }
    }
    if (!IBAN_REGEX.test(n) || n.length < 15 || n.length > 34) return false;
    try { return ibanMod97(n); } catch(e) { return false; }
  }

  async function getAnnouncements(){ const s = await getSettings(); return Array.isArray(s.announcements) ? s.announcements : []; }
  async function saveAnnouncements(arr){ const s = await getSettings(); s.announcements = arr; await saveSettings(s); }
  function generateId(prefix=''){ return prefix + Date.now().toString(36) + Math.random().toString(36).substring(2,8); }

  // localUserKey fixed: do not call async getLoggedInUser here
  function localUserKey() {
    const username = localStorage.getItem(LOGGED_IN_KEY);
    if (username) return username;
    let deviceId = localStorage.getItem('bio_device_id_v1');
    if (!deviceId) { deviceId = 'dev_' + generateId(); localStorage.setItem('bio_device_id_v1', deviceId); }
    return deviceId;
  }

  // Improved findCoupon: case-insensitive and always returns coupon object from fresh settings
  async function findCoupon(code){
    if (!code) return null;
    const s = await getSettings();
    if (!Array.isArray(s.coupons)) return null;
    const upper = code.toString().trim().toUpperCase();
    return s.coupons.find(c => (c.code || '').toString().toUpperCase() === upper) || null;
  }
  function isCouponValid(coupon){
    if (!coupon) return false;
    if (coupon.uses !== null && typeof coupon.uses === 'number' && coupon.uses <= 0) return false;
    return true;
  }

  function showToast(message, isSuccess = true, timeout = 3800) {
    const toastContainer = document.getElementById('toastContainer');
    if (!toastContainer) return;
    const t = document.createElement('div');
    t.className = 'toast ' + (isSuccess ? 'success' : 'error');
    t.innerHTML = `<div style="font-size:1.2rem">${isSuccess ? '✅' : '⚠️'}</div><div style="flex:1">${message}</div>`;
    toastContainer.appendChild(t);
    setTimeout(() => {
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0';
      t.style.transform = 'translateY(10px)';
      setTimeout(() => t.remove(), 300);
    }, timeout);
  }

  function ensureUserFields(user) {
    if (!user) return;
    if (typeof user.role !== 'string') user.role = 'user';
    if (typeof user.appliedCoupon !== 'string') user.appliedCoupon = '';
    if (!user.withdrawalRequests) user.withdrawalRequests = [];
    if (!user.betRequests) user.betRequests = [];
    if (typeof user.activeCoupon === 'undefined') user.activeCoupon = null;
    if (typeof user.appliedCouponPercent !== 'number') user.appliedCouponPercent = 0;
    if (typeof user.profileName !== 'string') user.profileName = user.username || '';
    if (typeof user.profileColor !== 'string') user.profileColor = '#00A3FF';
    if (typeof user.flashyName !== 'string') user.flashyName = '';
    if (typeof user.flashyColor !== 'string') user.flashyColor = '';
    if (typeof user.flashyAnimated !== 'boolean') user.flashyAnimated = false;
    if (typeof user.lastSeen !== 'number') user.lastSeen = 0;
    if (typeof user.isChatBanned !== 'boolean') user.isChatBanned = false;
  }
  function ensureDailyFields(user) {
    if (!user) return;
    if (!user.dailyDate) user.dailyDate = todayDateKey();
    if (typeof user.dailyClicks !== 'number') user.dailyClicks = 0;
    if (typeof user.dailyEarnings !== 'number') user.dailyEarnings = 0;
    if (typeof user.premium !== 'boolean') user.premium = false;
  }
  async function resetDailyIfNeeded(user) {
    if (!user) return;
    ensureDailyFields(user);
    const today = todayDateKey();
    if (user.dailyDate !== today) {
      user.dailyDate = today;
      user.dailyClicks = 0;
      user.dailyEarnings = 0;
      await saveUser(user.username, user);
    }
  }
  function calculateMoney(user){ return Number(user.balance || 0); }

  function clearExpiredUserCoupon(user) {
    if (!user || !user.activeCoupon) return;
    if (user.activeCoupon.expiresAt && user.activeCoupon.expiresAt <= Date.now()) {
      saveUserSpecificData('activeCoupon', null);
    }
  }

  async function saveUserSpecificData(key, value) {
      const user = await getLoggedInUser();
      if (!user) return;
      user[key] = value;
      await saveUser(user.username, user);
  }

  // Presence heartbeat to show online users
  let presenceInterval = null;
  async function markPresence(username) {
    if (!username) return;
    try {
      const docRef = db.collection('users').doc(username);
      await docRef.update({ lastSeen: Date.now() }).catch(async () => {
        await docRef.set({ lastSeen: Date.now() }, { merge: true });
      });
    } catch (e) { console.warn('presence error', e); }
  }
  function startPresence(username) {
    if (!username) return;
    if (presenceInterval) clearInterval(presenceInterval);
    markPresence(username);
    presenceInterval = setInterval(() => markPresence(username), 20000);
    window.addEventListener('beforeunload', () => {
      try { db.collection('users').doc(username).update({ lastSeen: Date.now() }); } catch(e){}
    });
  }

  // Announcement animation: full screen attention overlay
  function showAnnouncementAnimation(title, message, durationMs = 1600) {
    try {
      const container = document.getElementById('announceAnimContainer');
      if (!container) return;
      const wrapper = document.createElement('div');
      wrapper.className = 'announce-anim show';
      wrapper.innerHTML = `<div class="announce-anim-inner" role="dialog" aria-live="assertive" aria-atomic="true" style="padding:18px 22px; text-align:center;">
        <h2 style="margin:0; font-size:1.8rem; font-weight:900;">${escapeHtml(title)}</h2>
        <p style="margin:8px 0 0 0; font-size:1rem;">${escapeHtml(message)}</p>
      </div>`;
      container.appendChild(wrapper);
      setTimeout(() => {
        wrapper.classList.remove('show');
        wrapper.classList.add('hide');
        setTimeout(() => wrapper.remove(), 600);
      }, durationMs);
    } catch (e) { console.warn('announceAnim error', e); }
  }
  window.showAnnouncementAnimation = showAnnouncementAnimation;

  // ------------------ Chat (improved: support flashy RGB/rainbow & media & chromatic) -------------------
  let chatUnsubscribe = null;

  // helper: find user by display name if raw lookup failed
  function findUserByDisplayNameOrFlashy(rawName, usersMap) {
    if (!rawName || !usersMap) return null;
    const keys = Object.keys(usersMap);
    rawName = (rawName || '').toString();
    for (const k of keys) {
      const u = usersMap[k] || {};
      if ((u.profileName && u.profileName === rawName) || (u.flashyName && u.flashyName === rawName)) return u;
    }
    return null;
  }

  async function initChat(userObj) {
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput') || document.getElementById('chatMessage');
    const chatSendBtn = document.getElementById('chatSendBtn') || document.getElementById('sendChatBtn');

    if (!chatMessages || !chatInput || !chatSendBtn) return;

    if (chatUnsubscribe) {
      try { chatUnsubscribe(); } catch(e){}
    }

    chatUnsubscribe = db.collection('chat')
      .orderBy('timestamp', 'asc')
      .limitToLast(400)
      .onSnapshot(async (snapshot) => {
        chatMessages.innerHTML = '';
        const usersMap = await getUsers(); // map by username
        snapshot.forEach(doc => {
          const msg = doc.data() || {};
          const rawUsername = msg.user || msg.username || 'Anon';
          const text = msg.text || msg.message || '';
          const ts = msg.timestamp && msg.timestamp.toDate ? msg.timestamp.toDate() : (msg.timestamp ? new Date(msg.timestamp) : null);
          // try lookup by raw username (username key), else attempt to find by display name or flashyName
          let u = usersMap[rawUsername] || findUserByDisplayNameOrFlashy(rawUsername, usersMap);
          // Sometimes chat docs carry username as profileName; if msg.user exists, prefer that mapping
          if (!u && msg.user) u = usersMap[msg.user] || null;

          // fallback to empty object
          u = u || {};

          const displayName = (u.flashyName && u.flashyName.length) ? u.flashyName : (msg.username || u.profileName || rawUsername);

          // parse flashy color tokens (including new 'chrom-...' values)
          const parsed = parseFlashyColorToken((u.flashyColor && u.flashyColor.length) ? u.flashyColor : (msg.usernameColor || u.profileColor || '#00A3FF'));
          const color = parsed.cssColor;
          const isChromatic = parsed.isChromatic;
          const chromaType = parsed.chromaType;

          const isMe = (userObj && (rawUsername === userObj.username || displayName === (userObj.profileName || userObj.username)));
          const div = document.createElement('div');
          div.className = 'chat-message' + (isMe ? ' me' : '');

          if (isChromatic) {
            // Chromatic (kromatik) special handling: add classes and animated gradient styles via CSS
            let inner = `<span class="username chromatic chrom-${escapeHtml(chromaType)}">${escapeHtml(displayName)}:</span> ${escapeHtml(text)}`;
            if (msg.mediaUrl) {
              if ((msg.mediaType || '').startsWith('image')) {
                inner += `<div class="chat-media" style="margin-top:8px;"><img src="${escapeHtml(msg.mediaUrl)}" alt="image" /></div>`;
              } else if ((msg.mediaType || '').startsWith('video')) {
                inner += `<div class="chat-media" style="margin-top:8px;"><video controls src="${escapeHtml(msg.mediaUrl)}"></video></div>`;
              } else {
                inner += `<div class="chat-media" style="margin-top:8px;"><a href="${escapeHtml(msg.mediaUrl)}" target="_blank" rel="noopener">Medya</a></div>`;
              }
            }
            inner += ts ? ` <span class="msg-time">${ts.toLocaleTimeString()}</span>` : '';
            div.innerHTML = inner;
            if (u.flashyAnimated) {
              div.classList.add('glow','chromatic');
              // set a CSS var fallback color to maintain glow intensity
              div.style.setProperty('--glow-color', color);
            }
          } else if (u.flashyColor === 'rgb' || (u.flashyColor && u.flashyColor.toLowerCase() === 'rgb')) {
            // rainbow animated text (legacy 'rgb' token)
            let inner = `<span class="username rainbow-text">${escapeHtml(displayName)}:</span> ${escapeHtml(text)}`;
            if (msg.mediaUrl) {
              if ((msg.mediaType || '').startsWith('image')) {
                inner += `<div class="chat-media" style="margin-top:8px;"><img src="${escapeHtml(msg.mediaUrl)}" alt="image" /></div>`;
              } else if ((msg.mediaType || '').startsWith('video')) {
                inner += `<div class="chat-media" style="margin-top:8px;"><video controls src="${escapeHtml(msg.mediaUrl)}"></video></div>`;
              } else {
                inner += `<div class="chat-media" style="margin-top:8px;"><a href="${escapeHtml(msg.mediaUrl)}" target="_blank" rel="noopener">Medya</a></div>`;
              }
            }
            inner += ts ? ` <span class="msg-time">${ts.toLocaleTimeString()}</span>` : '';
            div.innerHTML = inner;
          } else {
            // regular colored name (may be animated glow)
            const safeColor = escapeHtml(color);
            const nameStyle = `color:${safeColor}; font-weight:800;`;
            let inner = `<span class="username" style="${nameStyle}">${escapeHtml(displayName)}:</span> ${escapeHtml(text)}`;
            if (msg.mediaUrl) {
              if ((msg.mediaType || '').startsWith('image')) {
                inner += `<div class="chat-media" style="margin-top:8px;"><img src="${escapeHtml(msg.mediaUrl)}" alt="image" /></div>`;
              } else if ((msg.mediaType || '').startsWith('video')) {
                inner += `<div class="chat-media" style="margin-top:8px;"><video controls src="${escapeHtml(msg.mediaUrl)}"></video></div>`;
              } else {
                inner += `<div class="chat-media" style="margin-top:8px;"><a href="${escapeHtml(msg.mediaUrl)}" target="_blank" rel="noopener">Medya</a></div>`;
              }
            }
            inner += ts ? ` <span class="msg-time">${ts.toLocaleTimeString()}</span>` : '';
            div.innerHTML = inner;
            if (u.flashyAnimated) {
              div.classList.add('glow');
              div.style.setProperty('--glow-color', color);
            }
          }

          chatMessages.appendChild(div);
        });
        chatMessages.scrollTop = chatMessages.scrollHeight;
      });

    const sendMessage = () => {
      const text = (chatInput.value || '').trim();
      if (userObj && userObj.isChatBanned) {
        showToast('Sohbete yazma izniniz engellendi.', false);
        return;
      }
      if (!text || !userObj) return;
      const payload = {
        username: userObj.profileName || userObj.username,
        usernameColor: userObj.profileColor || '#00A3FF',
        text: text,
        user: userObj.username,
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      };
      db.collection('chat').add(payload).catch(err => console.error('chat send error', err));
      chatInput.value = '';
    };

    // remove previous listeners safely
    chatSendBtn.removeEventListener('click', sendMessage);
    chatSendBtn.addEventListener('click', sendMessage);
    chatInput.removeEventListener('keypress', handleKey);
    function handleKey(e){ if (e.key === 'Enter') sendMessage(); }
    chatInput.addEventListener('keypress', handleKey);
  }

  // -------------- Yeni: Fullscreen maintenance overlay ve diagonal mini buton + hızlı tıklama menüsü --------------
  // Not: Mevcut yapı bozulmasın diye DOM elementleri varsa kullanılır, yoksa dinamik eklenir.

  // Show or hide full-screen maintenance overlay based on settings
  async function updateFullScreenMaintenance() {
    try {
      const s = await getSettings();
      const overlay = ensureFullScreenOverlay();
      const diagBtn = ensureDiagMiniBtn();
      // If server closed or maintenance enabled => show overlay prominently
      const showForMaintenance = !!(s.maintenance && s.maintenance.enabled);
      const showForServerClosed = !!(s.server && s.server.closed);
      if (showForMaintenance || showForServerClosed) {
        const info = showForMaintenance ? s.maintenance : s.server;
        const title = showForServerClosed ? 'SUNUCU KAPALI' : 'SİSTEM BAKIMDA';
        const message = (info && info.reason) ? info.reason : (showForServerClosed ? 'Sunucu şu anda kapalı. Lütfen daha sonra tekrar deneyin.' : 'Sistem üzerinde bakım çalışması yapılıyor. Bir süre sonra tekrardan deneyiniz.');
        overlay.querySelector('.fsm-title').textContent = title;
        overlay.querySelector('.fsm-msg').textContent = message;
        // set since text
        overlay.querySelector('.fsm-meta').textContent = info && info.since ? `Başlangıç: ${new Date(info.since).toLocaleString()}` : '';
        overlay.classList.add('show');
        // also make maintenanceBanner visible (existing UI) and keep them consistent
        const maintenanceBanner = document.getElementById('maintenanceBanner');
        if (maintenanceBanner) {
          maintenanceBanner.style.display = 'flex';
          // enhance banner with icon when showing
          const mr = maintenanceBanner.querySelector('.maintenance-reason');
          if (mr) mr.style.fontWeight = '900';
        }
        // show diagonal mini button but disable quick menu actions (if server closed force disabled)
        if (diagBtn) {
          diagBtn.style.display = 'block';
          if (showForServerClosed) {
            diagBtn.classList.add('disabled');
            diagBtn.title = 'Sunucu kapalı - eylemler devre dışı';
          } else {
            diagBtn.classList.remove('disabled');
            diagBtn.title = 'Hızlı tıklama menüsünü aç';
          }
        }
      } else {
        overlay.classList.remove('show');
        const maintenanceBanner = document.getElementById('maintenanceBanner');
        if (maintenanceBanner) maintenanceBanner.style.display = 'none';
        if (diagBtn) diagBtn.style.display = 'none';
        // ensure quick menu closed
        const q = document.getElementById('quickClickMenu');
        if (q) q.classList.remove('open');
      }
    } catch (e) {
      console.warn('updateFullScreenMaintenance error', e);
    }
  }

  // Ensure overlay element exists in DOM and return it
  function ensureFullScreenOverlay() {
    let overlay = document.getElementById('fullScreenMaintOverlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'fullScreenMaintOverlay';
    overlay.className = 'fullscreen-maintenance-overlay';
    overlay.innerHTML = `
      <div class="fsm-inner" role="dialog" aria-live="assertive" aria-atomic="true">
        <div class="fsm-content">
          <div class="fsm-left">
            <div style="display:flex; align-items:center; gap:14px;">
              <div style="width:68px;height:68px;border-radius:14px;background:linear-gradient(90deg,#ff9a00,#ffd400);display:flex;align-items:center;justify-content:center;color:#021122;font-weight:900;font-size:2.2rem;">🔧</div>
              <div>
                <h1 class="fsm-title">SİSTEM BAKIMDA</h1>
                <div class="fsm-meta" style="margin-top:6px;color:var(--text-muted);font-size:0.95rem;"></div>
              </div>
            </div>
            <p class="fsm-msg" style="margin-top:12px;">Sistem bakımı nedeniyle kısıtlı. Geri dönüşte size haber verilecektir.</p>
            <div style="margin-top:18px; display:flex; gap:8px;">
              <button id="fsmContactBtn" class="fsm-cta">Destek İletişim</button>
              <button id="fsmCloseBtn" class="fsm-close" aria-hidden="true">Kapat</button>
              <button id="fsmMoreBtn" class="fsm-close" aria-hidden="true" title="Detaylı Durum">Detay</button>
            </div>
          </div>
          <div class="fsm-right" aria-hidden="true">
            <!-- görsel arka plan için xxx.png kullanılıyor -->
            <div class="fsm-visual" style="background-image:url('xxx.png');"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    // Hook buttons
    const c = document.getElementById('fsmContactBtn');
    if (c) c.addEventListener('click', () => showToast('Lütfen yönetici ile iletişime geçin.', true, 5000));
    const close = document.getElementById('fsmCloseBtn');
    if (close) close.addEventListener('click', () => { overlay.classList.remove('show'); });
    const more = document.getElementById('fsmMoreBtn');
    if (more) more.addEventListener('click', async () => {
      const s = await getSettings();
      const info = (s.maintenance && s.maintenance.enabled) ? s.maintenance : s.server;
      showAnnouncementAnimation(info && info.reason ? (info.reason) : 'Durum bilgisi yok', 'Bu bildiri daha ayrıntılı durumu gösterir.', 2400);
    });

    return overlay;
  }

  // Ensure diagonal mini button exists
  function ensureDiagMiniBtn() {
    let btn = document.getElementById('diagMiniBtn');
    if (btn) return btn;
    btn = document.createElement('button');
    btn.id = 'diagMiniBtn';
    btn.className = 'diag-mini-btn';
    btn.title = 'Hızlı tıklamalar';
    btn.innerHTML = `<span class="diag-ico">⚡</span>`;
    document.body.appendChild(btn);
    // quick menu container
    const menu = document.createElement('div');
    menu.id = 'quickClickMenu';
    menu.className = 'quick-click-menu';
    menu.innerHTML = `
      <div class="qcm-inner">
        <button id="qcmClickBtn" class="qcm-action">Tıkla ve Kazan</button>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button id="qcmOddBtn" class="qcm-action qcm-small">TEK</button>
          <button id="qcmEvenBtn" class="qcm-action qcm-small">ÇİFT</button>
        </div>
      </div>`;
    document.body.appendChild(menu);

    // Toggle behavior
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.classList.contains('disabled')) {
        showToast('Bu işlem şu anda devre dışı.', false);
        return;
      }
      menu.classList.toggle('open');
      // position menu near button (already styled via CSS), but ensure menu closed on outside click
      setTimeout(() => {
        document.addEventListener('click', handleOutsideQuickMenu, { once: true });
      }, 30);
    });

    function handleOutsideQuickMenu(ev) {
      const target = ev.target;
      if (!menu.contains(target) && target !== btn) {
        menu.classList.remove('open');
      }
    }

    // Hook quick menu buttons to actual actions (if available)
    menu.querySelector('#qcmClickBtn').addEventListener('click', async () => {
      const mainClick = document.getElementById('clickBtn');
      if (mainClick && !mainClick.disabled) mainClick.click();
      else showToast('Tıklama şu anda mümkün değil.', false);
    });
    menu.querySelector('#qcmOddBtn').addEventListener('click', async () => {
      const odd = document.getElementById('betOddBtn');
      const stake = document.getElementById('betAmountInput');
      if (stake && (!stake.value || Number(stake.value) <= 0)) {
        // try set default
        stake.value = Math.max(1, Number(stake.value) || 10);
      }
      if (odd) odd.click();
    });
    menu.querySelector('#qcmEvenBtn').addEventListener('click', async () => {
      const even = document.getElementById('betEvenBtn');
      const stake = document.getElementById('betAmountInput');
      if (stake && (!stake.value || Number(stake.value) <= 0)) {
        stake.value = Math.max(1, Number(stake.value) || 10);
      }
      if (even) even.click();
    });

    return btn;
  }

  // -------------- End: Fullscreen maintenance + quick menu --------------

  function todayKey(){ return todayDateKey(); }

  // ... (the rest of the original code continues unchanged) ...
  // For readability we keep the original functions below exactly as before but we also call updateFullScreenMaintenance at key points.

  async function initApp(){
    const mainContent = document.getElementById('mainContent');
    const authView = document.getElementById('authView');

    const clickBtn = document.getElementById('clickBtn');
    const cooldownText = document.getElementById('cooldownText');
    const displayName = document.getElementById('displayName');
    const avatar = document.getElementById('avatar');
    const logoutBtn = document.getElementById('logoutBtn');
    const logoutUsername = document.getElementById('logoutUsername');
    const clickFill = document.getElementById('clickFill');
    const earnFill = document.getElementById('earnFill');
    const clickRemainText = document.getElementById('clickRemainText');
    const earnRemainText = document.getElementById('earnRemainText');
    const profilePremiumBadge = document.getElementById('profilePremiumBadge');
    const activeCouponArea = document.getElementById('activeCouponArea');

    const authForm = document.getElementById('authForm');
    const authUsernameInput = document.getElementById('authUsername');
    const authPasswordInput = document.getElementById('authPassword');
    const authMessage = document.getElementById('authMessage');

    const maintenanceBanner = document.getElementById('maintenanceBanner');
    const maintenanceReasonText = document.getElementById('maintenanceReasonText');
    const maintenanceSinceText = document.getElementById('maintenanceSinceText');

    const announcementBanner = document.getElementById('announcementBanner');
    const announcementTitleText = document.getElementById('announcementTitleText');
    const announcementMsgText = document.getElementById('announcementMsgText');

    const firstname = document.getElementById('firstname');
    const lastname = document.getElementById('lastname');
    const bankSelect = document.getElementById('bankSelect');
    const ibanInput = document.getElementById('ibanInput');
    const ibanInvalid = document.getElementById('ibanInvalid');
    const clearIban = document.getElementById('clearIban');
    const couponInput = document.getElementById('couponInput');
    const applyCouponBtn = document.getElementById('applyCouponBtn');
    const couponInfo = document.getElementById('couponInfo');
    const withdrawBtn = document.getElementById('withdrawBtn');
    const minWithdrawalText = document.getElementById('minWithdrawalText');

    const successOverlay = document.getElementById('successOverlay');
    const successDetails = document.getElementById('successDetails');

    // Profile modal elements
    const profileEditBtn = document.getElementById('profileEditBtn');
    const profileModal = document.getElementById('profileModal');
    const profileNameInput = document.getElementById('profileNameInput');
    const profileColorInputs = document.getElementsByName('profileColor');
    const saveProfileBtn = document.getElementById('saveProfileBtn');
    const closeProfileBtn = document.getElementById('closeProfileBtn');

    // Chat toggles
    const chatCloseBtn = document.getElementById('chatClose');
    const chatOpenBtn = document.getElementById('chatOpenBtn');
    const chatWidget = document.getElementById('chatMessages') ? document.getElementById('chatMessages').parentElement : null;
    const chatFileInput = document.getElementById('chatFileInput');

    // Tek/Çift elements
    const betAmountInput = document.getElementById('betAmountInput');
    const betOddBtn = document.getElementById('betOddBtn');
    const betEvenBtn = document.getElementById('betEvenBtn');

    let isAuthModeLogin = true;
    let cooldownTimer = null;
    let user = await getLoggedInUser();
    let isCooldown = false;
    let prevAnnouncementId = null;

    // Ban overlay element reference
    let banOverlayEl = null;

    window.switchAuthMode = () => {
      isAuthModeLogin = !isAuthModeLogin;
      const authTitle = document.getElementById('authTitle');
      const authSubmitBtn = document.getElementById('authSubmitBtn');
      const switchText = document.getElementById('switchText');
      authTitle.textContent = isAuthModeLogin ? 'Kullanıcı Girişi' : 'Kullanıcı Kayıt';
      authSubmitBtn.textContent = isAuthModeLogin ? 'Giriş Yap' : 'Kayıt Ol';
      switchText.innerHTML = isAuthModeLogin ? 'Hesabınız yok mu? <button type="button" onclick="window.switchAuthMode()" style="background:none;border:none;color:var(--accent-primary);cursor:pointer;">Kayıt Ol</button>' : 'Hesabınız var mı? <button type="button" onclick="window.switchAuthMode()" style="background:none;border:none;color:var(--accent-primary);cursor:pointer;">Giriş Yap</button>';
    };
couponInfo
    function createBanOverlay(reason, by, at) {
      const overlay = document.createElement('div');
      overlay.id = 'banOverlay';
      overlay.style.position = 'fixed';
      overlay.style.left = '0';
      overlay.style.top = '0';
      overlay.style.right = '0';
      overlay.style.bottom = '0';
      overlay.style.display = 'flex';
      overlay.style.justifyContent = 'center';
      overlay.style.alignItems = 'center';
      overlay.style.zIndex = '6000';
      overlay.style.background = 'linear-gradient(180deg, rgba(8,10,14,0.96), rgba(2,6,12,0.98))';
      overlay.style.backdropFilter = 'blur(4px)';
      overlay.innerHTML = `
        <div style="text-align:center; max-width:860px; margin: 0 20px; padding:28px; border-radius:14px; border:1px solid rgba(255,255,255,0.04); animation: banPop .7s cubic-bezier(.2,.9,.3,1);">
          <div style="font-size:4.6rem; color:var(--accent-danger); margin-bottom:8px;">⛔</div>
          <h2 style="margin:0; font-size:2.0rem; color:var(--text-high); font-weight:900;">HESABINIZ ASKIYA ALINDI</h2>
          <p style="margin-top:10px; color:var(--text-muted); font-size:1rem; line-height:1.4;">${escapeHtml(reason || 'Yönetici tarafından bir işlem nedeniyle kısıtlandı.')}</p>
          <div style="margin-top:12px; color:var(--text-muted); font-size:0.9rem;">Yetkili: ${escapeHtml(by || 'admin')} • ${at ? new Date(at).toLocaleString() : ''}</div>
          <div style="margin-top:18px;">
            <button id="banOverlayContact" style="padding:10px 14px; border-radius:8px; border:none; background:var(--accent-primary); color:#021122;">Destek ile İletişime Geç</button>
          </div>
        </div>
      `;
      return overlay;
    }

    function showBanOverlayUI(banInfo) {
      removeBanOverlayUI();
      banOverlayEl = createBanOverlay(banInfo?.reason, banInfo?.by, banInfo?.at);
      document.body.appendChild(banOverlayEl);
      // disable interactive controls
      if (clickBtn) clickBtn.disabled = true;
      if (withdrawBtn) withdrawBtn.disabled = true;
      const chatInput = document.getElementById('chatInput');
      if (chatInput) chatInput.disabled = true;
      const chatSend = document.getElementById('chatSendBtn');
      if (chatSend) chatSend.disabled = true;
      const fileInput = document.getElementById('chatFileInput');
      if (fileInput) fileInput.disabled = true;
      // hook contact button to maybe open support or show toast
      const contact = document.getElementById('banOverlayContact');
      if (contact) contact.onclick = () => { showToast('Lütfen yönetici ile iletişime geçin.', false); };
    }

    function removeBanOverlayUI() {
      const existing = document.getElementById('banOverlay');
      if (existing) existing.remove();
      banOverlayEl = null;
      // re-enable clickable items if user exists and not banned
      if (user && !user.isBanned) {
        if (clickBtn) clickBtn.disabled = false;
        if (withdrawBtn) withdrawBtn.disabled = user.balance < (getMinWithdrawalAmount || DEFAULT_MIN_WITHDRAWAL);
        const chatInput = document.getElementById('chatInput');
        if (chatInput) chatInput.disabled = false;
        const chatSend = document.getElementById('chatSendBtn');
        if (chatSend) chatSend.disabled = false;
        const fileInput = document.getElementById('chatFileInput');
        if (fileInput) fileInput.disabled = !!(user.isChatBanned);
      }
    }

    async function loadUser() {
      user = await getLoggedInUser();
      if (user) {
        ensureUserFields(user);
        ensureDailyFields(user);
        await resetDailyIfNeeded(user);
        clearExpiredUserCoupon(user);
        await updateUI();
        mainContent.style.display = 'grid';
        authView.style.display = 'none';
        startPresence(user.username);
        try { await initChat(user); } catch(e){ console.warn('initChat failed', e); }
      } else {
        mainContent.style.display = 'none';
        authView.style.display = 'block';
      }
      renderOnlineUsers(); // refresh online users list
    }

    async function updateUI() {
      if (!user) return;
      const display = (user.flashyName && user.flashyName.length) ? user.flashyName : (user.profileName || user.username);
      displayName.textContent = display;
      const initials = (display.split(' ').map(s => s[0] || '').join('').slice(0,2)).toUpperCase();
      avatar.textContent = initials || (user.username.slice(0,2)).toUpperCase();
      try {
        const rawColor = (user.flashyColor && user.flashyColor.length) ? user.flashyColor : (user.profileColor || '#00A3FF');
        const parsed = parseFlashyColorToken(rawColor);
        const c = parsed.cssColor;
        const isChromatic = parsed.isChromatic;
        const chromaType = parsed.chromaType;

        // reset classes
        avatar.classList.remove('glow-avatar');
        avatar.classList.remove('chromatic','chrom-black','chrom-blue','chrom-green','chrom-purple','chrom-red');

        if (isChromatic) {
          avatar.classList.add('chromatic', `chrom-${chromaType}`);
          avatar.style.removeProperty('background');
          avatar.style.removeProperty('border');
          // set fallback variable for glow
          avatar.style.setProperty('--glow-color', c);
          avatar.classList.add('chromatic');
        } else {
          avatar.style.background = `linear-gradient(135deg, ${c}22, ${c}10)`;
          avatar.style.border = `1px solid ${c}33`;
        }

        if (user.flashyColor === 'rgb' || user.flashyAnimated) {
          avatar.classList.add('glow-avatar');
          avatar.style.setProperty('--glow-color', (user.flashyColor === 'rgb' ? '#FFD400' : c));
        } else {
          if (!isChromatic) {
            avatar.classList.remove('glow-avatar');
            avatar.style.removeProperty('--glow-color');
          }
        }
      } catch(e){}
      logoutUsername.textContent = user.username;
      const clickCountEl = document.getElementById('clickCount');
      const moneyEl = document.getElementById('moneyEarned');
      clickCountEl.textContent = user.clicks;
      moneyEl.textContent = formatMoney(user.balance);
      profilePremiumBadge.style.display = user.premium ? 'inline-block' : 'none';

      const clickLimit = await getDefaultDailyClickLimit();
      const earnLimit = await getDefaultDailyEarningsLimit();

      const clickPercent = Math.min((user.dailyClicks || 0) / clickLimit * 100, 100);
      const earnPercent = Math.min((user.dailyEarnings || 0) / earnLimit * 100, 100);

      if (clickFill) clickFill.style.width = `${isFinite(clickPercent) ? clickPercent : 0}%`;
      if (earnFill) earnFill.style.width = `${isFinite(earnPercent) ? earnPercent : 0}%`;

      clickRemainText.textContent = `${user.dailyClicks}/${user.premium ? '∞' : clickLimit}`;
      earnRemainText.textContent = `${formatMoney(user.dailyEarnings)}/${user.premium ? '∞' : formatMoney(earnLimit)}`;

      const s = await getSettings();
      if (s.server && s.server.closed) {
        // show server closed banner on top as announcement-like
        const reason = s.server.reason || 'Sunucu kapalı.';
        const since = s.server.since ? `Başlangıç: ${new Date(s.server.since).toLocaleString()}` : '';
        const banner = document.getElementById('announcementBanner');
        if (banner) {
          banner.style.display = 'flex';
          announcementTitleText.innerText = 'SUNUCU KAPALI';
          announcementMsgText.innerText = `${reason} ${since}`;
        }
      }

      const min = await getMinWithdrawalAmount();
      if (withdrawBtn) withdrawBtn.disabled = user.balance < min || (await isServerClosed());
      if (withdrawBtn) withdrawBtn.textContent = `${formatMoney(user.balance)} Çekim Talep Et`;
      if (minWithdrawalText) minWithdrawalText.textContent = formatMoney(min);

      if (user.activeCoupon) {
        activeCouponArea.innerHTML = `<span class="badge coupon-active-badge">Aktif Bonus: ${user.activeCoupon.multiplier}x (${Math.max(0, Math.floor((user.activeCoupon.expiresAt - Date.now()) / 1000))}s kalan)</span>`;
      } else if (user.appliedCoupon) {
        // if a balance coupon was applied earlier, show it in UI with percent
        activeCouponArea.innerHTML = `<span class="badge coupon-active-badge">Uygulanan Kupon: ${escapeHtml(user.appliedCoupon)} ${user.appliedCouponPercent>0?`(+${user.appliedCouponPercent}%)`:''}</span>`;
      } else {
        activeCouponArea.innerHTML = '';
      }

      // Check ban state and show overlay if needed
      if (user.isBanned) {
        const info = user.banInfo || {};
        showBanOverlayUI(info);
      } else {
        removeBanOverlayUI();
      }

      // Also ensure chat file input disabled state if user is chat-banned
      const fileInput = document.getElementById('chatFileInput');
      if (fileInput) fileInput.disabled = !!(user.isChatBanned);

      // Update full-screen maintenance overlay visibility using current settings
      try { updateFullScreenMaintenance(); } catch(e){}
    }

    async function isServerClosed() {
      const s = await getSettings();
      return !!(s.server && s.server.closed);
    }

    async function handleClick() {
      const maint = await getMaintenanceInfo();
      const s = await getSettings();
      if (s.server && s.server.closed) { showToast('Sunucu kapalı — tıklamalar devre dışı.', false); return; }
      if (maint.enabled) { showToast('Şu anda bakım var — tıklamalar devre dışı.', false); return; }
      if (isCooldown || !user || user.isBanned) return;
      const limits = await getUserLimits(user);
      if (!limits.isUnlimited && (user.dailyClicks >= limits.clickLimit || user.dailyEarnings >= limits.earnLimit)) {
        showToast('Günlük limit aşıldı.', false);
        return;
      }
      isCooldown = true;
      if (clickBtn) clickBtn.disabled = true;
      if (cooldownText) cooldownText.style.display = 'inline';
      let earn = PRICE;
      if (user.activeCoupon && user.activeCoupon.type === 'click_bonus' && user.activeCoupon.expiresAt > Date.now()) {
        earn *= user.activeCoupon.multiplier;
      }
      user.clicks += 1;
      user.dailyClicks += 1;
      user.balance += earn;
      user.dailyEarnings += earn;
      pulse(clickBtn);
      await saveUser(user.username, user);
      await updateUI();
      cooldownTimer = setTimeout(() => {
        isCooldown = false;
        if (clickBtn) clickBtn.disabled = false;
        if (cooldownText) cooldownText.style.display = 'none';
      }, COOLDOWN_MS);
    }

    if (clickBtn) clickBtn.addEventListener('click', handleClick);

    // helper: getUserLimits considering premium
    async function getUserLimits(u) {
      const clickLimit = await getDefaultDailyClickLimit();
      const earnLimit = await getDefaultDailyEarningsLimit();
      return {
        isUnlimited: !!u.premium,
        clickLimit,
        earnLimit
      };
    }

    if (authForm) authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = authUsernameInput.value.trim().toLowerCase();
      const password = authPasswordInput.value;
      if (!username || !password) { authMessage.style.display = 'block'; authMessage.textContent = 'Tüm alanlar zorunlu.'; return; }
      const hashedPass = await hashPassword(password);
      // login or signup depending on current auth mode (reliable)
      const isLogin = !!isAuthModeLogin;
      if (isLogin) {
        const userDoc = await db.collection('users').doc(username).get();
        if (!userDoc.exists || userDoc.data().hashedPassword !== hashedPass) {
          authMessage.style.display = 'block';
          authMessage.textContent = 'Yanlış kullanıcı adı veya şifre.';
          return;
        }
        setLoggedInUser({username});
        await loadUser();
      } else {
        const userDoc = await db.collection('users').doc(username).get();
        if (userDoc.exists) {
          authMessage.style.display = 'block';
          authMessage.textContent = 'Kullanıcı adı zaten alınmış.';
          return;
        }
        const newUser = {
          username,
          hashedPassword: hashedPass,
          balance: 0,
          clicks: 0,
          dailyClicks: 0,
          dailyEarnings: 0,
          dailyDate: todayDateKey(),
          premium: false,
          isBanned: false,
          isChatBanned: false,
          role: 'user',
          appliedCoupon: '',
          appliedCouponPercent: 0,
          withdrawalRequests: [],
          betRequests: [],
          activeCoupon: null,
          profileName: username,
          profileColor: '#FFD400',
          flashyName: '',
          flashyColor: '',
          flashyAnimated: false,
          lastSeen: Date.now()
        };
        await saveUser(username, newUser);
        setLoggedInUser(newUser);
        await loadUser();
      }
    });

    if (logoutBtn) logoutBtn.addEventListener('click', async () => {
      localStorage.removeItem(LOGGED_IN_KEY);
      if (chatUnsubscribe) try { chatUnsubscribe(); } catch(e){}
      if (presenceInterval) clearInterval(presenceInterval);
      await loadUser();
    });

    if (clearIban) {
      clearIban.addEventListener('click', () => {
        ibanInput.value = '';
        ibanInvalid.style.display = 'none';
      });
    }

    if (ibanInput) {
      ibanInput.addEventListener('input', () => {
        const valid = validateIban(ibanInput.value);
        ibanInvalid.style.display = valid ? 'none' : 'block';
        ibanInvalid.textContent = valid ? '' : 'Geçersiz IBAN formatı.';
      });
    }

    // Chat file upload handling (uses Firebase Storage if available)
    if (chatFileInput) {
      chatFileInput.addEventListener('change', async (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        // refresh current user
        user = await getLoggedInUser();
        if (!user) { showToast('Önce giriş yapın', false); chatFileInput.value = ''; return; }
        if (user.isChatBanned) { showToast('Sohbete yazma/medya yükleme izniniz engellendi.', false); chatFileInput.value = ''; return; }
        if (!storage) {
          showToast('Dosya yükleme yapılamıyor (storage yapılandırılmamış).', false);
          chatFileInput.value = '';
          return;
        }
        try {
          showToast('Medya yükleniyor...', true, 10000);
          const path = `chat_media/${Date.now()}_${(file.name || 'upload').replace(/[^\w.\-]/g,'_')}`;
          const ref = storage.ref().child(path);
          const uploadTask = ref.put(file);
          uploadTask.on('state_changed', snapshot => {
            // optional: could show progress
          }, err => {
            console.error('upload error', err);
            showToast('Yükleme başarısız: ' + (err.message || err), false);
            chatFileInput.value = '';
          }, async () => {
            const url = await uploadTask.snapshot.ref.getDownloadURL();
            const type = (file.type || '').split('/')[0];
            await db.collection('chat').add({
              username: user.profileName || user.username,
              usernameColor: user.profileColor || '#00A3FF',
              text: '',
              mediaUrl: url,
              mediaType: file.type || (type === 'image' ? 'image/*' : 'file'),
              user: user.username,
              timestamp: firebase.firestore.FieldValue.serverTimestamp()
            });
            showToast('Medya gönderildi.', true);
            chatFileInput.value = '';
          });
        } catch (err) {
          console.error('chat file send error', err);
          showToast('Medya gönderilemedi.', false);
          chatFileInput.value = '';
        }
      });
      // Add drag & drop support for mobile/desktop (progressive)
      const chatCard = document.getElementById('publicChatCard');
      if (chatCard) {
        ['dragenter','dragover'].forEach(evt => {
          chatCard.addEventListener(evt, (e) => { e.preventDefault(); chatCard.classList.add('dragover'); }, false);
        });
        ['dragleave','drop'].forEach(evt => {
          chatCard.addEventListener(evt, (e) => { e.preventDefault(); chatCard.classList.remove('dragover'); }, false);
        });
        chatCard.addEventListener('drop', (e) => {
          const dt = e.dataTransfer;
          if (dt && dt.files && dt.files[0]) {
            const f = dt.files[0];
            // set file input and trigger change
            try {
              const dataTransfer = new DataTransfer();
              dataTransfer.items.add(f);
              chatFileInput.files = dataTransfer.files;
              const ev = new Event('change', { bubbles: true });
              chatFileInput.dispatchEvent(ev);
            } catch (err) {
              console.warn('drop to input failed', err);
            }
          }
        });
      }
    }

    if (withdrawBtn) withdrawBtn.addEventListener('click', async () => {
      // withdraw handler (checks server closed)
      const s = await getSettings();
      if (s.server && s.server.closed) { showToast('Sunucu kapalı — çekimler devre dışı.', false); return; }
      // rest handled in handleWithdraw function
      await handleWithdrawInternal();
    });

    async function handleWithdrawInternal() {
      if (!user) { showToast('Giriş yapın', false); return; }
      const amount = user.balance;
      const s = await getSettings();
      const min = s.minWithdrawalAmount || DEFAULT_MIN_WITHDRAWAL;
      if (amount < min) { showToast('Yeterli bakiye yok.', false); return; }
      const first = firstname.value.trim();
      const last = lastname.value.trim();
      const bank = bankSelect.value;
      const iban = normalizeIban(ibanInput.value);
      if (!first || !last || !bank || !validateIban(iban)) {
        showToast('Tüm çekim bilgileri zorunlu ve IBAN geçerli olmalı.', false);
        return;
      }
      // Determine coupon bonus percent for this withdraw:
      let couponBonusPercent = 0;
      // If user has an active balance coupon applied earlier, use its percent stored on user
      if (user.appliedCoupon && typeof user.appliedCouponPercent === 'number' && user.appliedCouponPercent > 0) {
        couponBonusPercent = user.appliedCouponPercent;
      } else {
        // Fallback: try to find coupon object by applied code (in case percent wasn't stored)
        if (user.appliedCoupon) {
          const cp = await findCoupon(user.appliedCoupon);
          if (cp && cp.type === 'balance') couponBonusPercent = cp.percent || 0;
        }
      }

      const id = generateId('req_');
      const req = {
        id,
        username: user.username,
        amount,
        originalBalance: amount,
        bank,
        iban,
        firstName: first,
        lastName: last,
        createdAt: new Date().toISOString(),
        status: 'pending',
        couponApplied: user.appliedCoupon || '',
        couponBonusPercent: couponBonusPercent
      };
      user.withdrawalRequests.push(req);
      user.balance = 0;
      // Clear applied coupon after withdraw so it isn't reused accidentally
      user.appliedCoupon = '';
      user.appliedCouponPercent = 0;
      await saveUser(user.username, user);
      successDetails.innerHTML = `ID: ${id}<br>Kullanıcı: ${user.username}<br>Tutar: ${formatMoney(amount)}${couponBonusPercent>0?` (+${couponBonusPercent}% kupon)`:''}<br>Banka: ${bank}<br>IBAN: ${prettyIban(iban)}<br>Tarih: ${new Date().toLocaleString()}`;
      successOverlay.style.display = 'flex';
      await updateUI();
    }

    window.closeSuccessOverlay = () => { successOverlay.style.display = 'none'; };

    // Improved applyCoupon: load latest settings, validate and atomically decrement usage in settings
    async function applyCoupon() {
      const codeRaw = (couponInput.value || '').trim();
      const code = codeRaw.toUpperCase();
      if (!code) { couponInfo.textContent = 'Kupon kodu boş.'; return; }
      // fetch latest settings (we'll update settings if needed)
      const s = await getSettings();
      if (!Array.isArray(s.coupons) || s.coupons.length === 0) {
        couponInfo.textContent = 'Kupon bulunamadı.'; return;
      }
      const idx = s.coupons.findIndex(c => (c.code || '').toString().toUpperCase() === code);
      if (idx === -1) { couponInfo.textContent = 'Geçersiz kupon.'; return; }
      const coupon = s.coupons[idx];

      // validate uses
      if (coupon.uses !== null && typeof coupon.uses === 'number' && coupon.uses <= 0) {
        couponInfo.textContent = 'Kupon kullanım hakkı dolmuş.'; return;
      }

      // Refresh current user data (in case it changed)
      user = await getLoggedInUser();
      if (!user) { couponInfo.textContent = 'Giriş yapın.'; return; }
      ensureUserFields(user);

      try {
        if (coupon.type === 'balance') {
          // persist coupon on user so withdraw uses it and also apply immediate bonus to current balance (if any)
          const pct = Number(coupon.percent) || 0;
          user.appliedCoupon = code;
          user.appliedCouponPercent = pct;
          if (pct > 0 && user.balance > 0) {
            // give immediate bonus to current balance (UX-friendly)
            const bonus = user.balance * (pct / 100);
            user.balance += bonus;
          }
        } else if (coupon.type === 'click_bonus') {
          const multiplier = Number(coupon.multiplier) || 1;
          const durationSeconds = parseInt(coupon.durationSeconds || 0, 10) || 0;
          if (multiplier <= 1 || durationSeconds <= 0) {
            couponInfo.textContent = 'Geçersiz tıklama bonusu ayarları.'; return;
          }
          user.activeCoupon = {
            type: 'click_bonus',
            multiplier: multiplier,
            expiresAt: Date.now() + durationSeconds * 1000,
            originCode: code
          };
        } else {
          couponInfo.textContent = 'Bilinmeyen kupon tipi.'; return;
        }

        // decrement uses in settings if applicable and persist settings
        if (coupon.uses !== null && typeof coupon.uses === 'number') {
          s.coupons[idx].uses = Math.max(0, coupon.uses - 1);
        }
        await saveSettings(s);

        // save user
        await saveUser(user.username, user);
        await updateUI();
        couponInfo.textContent = 'Kupon uygulandı!';
        couponInput.value = '';
        showToast('Kupon başarıyla uygulandı.', true);
      } catch (err) {
        console.error('applyCoupon error', err);
        couponInfo.textContent = 'Kupon uygulanırken hata oluştu.';
      }
    }

    if (applyCouponBtn) applyCouponBtn.addEventListener('click', applyCoupon);

    async function renderMaintenanceBanner() {
      const maint = await getMaintenanceInfo();
      if (maint.enabled) {
        if (maintenanceReasonText) maintenanceReasonText.textContent = maint.reason || 'Bakım devam ediyor.';
        if (maintenanceSinceText) maintenanceSinceText.textContent = maint.since ? `Başlangıç: ${new Date(maint.since).toLocaleString()}` : '';
        if (maintenanceBanner) maintenanceBanner.style.display = 'block';
      } else {
        if (maintenanceBanner) maintenanceBanner.style.display = 'none';
      }
      // Update the powerful overlay too
      try { updateFullScreenMaintenance(); } catch(e){}
    }

    if (document.getElementById('closeMaintBannerBtn')) document.getElementById('closeMaintBannerBtn').addEventListener('click', () => maintenanceBanner.style.display = 'none');

    async function renderAnnouncementsInApp() {
      const anns = await getAnnouncements();
      const visibleAnns = anns.filter(a => a.visible && (!a.expiresAt || a.expiresAt > Date.now()));
      if (visibleAnns.length > 0) {
        const newActive = visibleAnns[0];
        if (announcementBanner) {
          announcementBanner.style.display = 'flex';
          const stickyHtml = newActive.sticky ? `<span style="background:var(--accent-primary); color:#021122; padding:4px 8px; border-radius:8px; margin-right:8px; font-weight:700;">STICKY</span>` : '';
          announcementTitleText.innerHTML = `${stickyHtml}${newActive.title}`;
          announcementMsgText.innerHTML = newActive.message;
        }
        if (!prevAnnouncementId || prevAnnouncementId !== newActive.id) {
          try { showAnnouncementAnimation(newActive.title, newActive.message, 1600); } catch(e){}
          prevAnnouncementId = newActive.id;
        }
      } else {
        if (announcementBanner) announcementBanner.style.display = 'none';
        prevAnnouncementId = null;
      }
    }

    if (document.getElementById('closeAnnouncementBtn')) document.getElementById('closeAnnouncementBtn').addEventListener('click', () => announcementBanner.style.display = 'none');

    // PROFILE EDIT handling
    if (profileEditBtn && profileModal) {
      profileEditBtn.addEventListener('click', async () => {
        if (!user) { showToast('Lütfen önce giriş yapın.', false); return; }
        profileNameInput.value = user.profileName || user.username;
        // set radios
        const color = user.profileColor || '#FFD400';
        for (const r of profileColorInputs) r.checked = (r.value.toLowerCase() === color.toLowerCase());
        profileModal.style.display = 'flex';
      });
    }
    if (closeProfileBtn && profileModal) {
      closeProfileBtn.addEventListener('click', () => profileModal.style.display = 'none');
    }
    if (saveProfileBtn) {
      saveProfileBtn.addEventListener('click', async () => {
        if (!user) return;
        const newName = (profileNameInput.value || '').trim();
        let newColor = null;
        for (const r of profileColorInputs) { if (r.checked) { newColor = r.value; break; } }
        if (!newColor) newColor = '#FFD400';
        if (!newName) { showToast('İsim boş olamaz', false); return; }
        user.profileName = newName;
        user.profileColor = newColor;
        await saveUser(user.username, user);
        await updateUI();
        profileModal.style.display = 'none';
        showToast('Profil güncellendi', true);
      });
    }

    // Chat toggle show/hide
    if (chatCloseBtn && chatWidget) {
      chatCloseBtn.addEventListener('click', () => {
        const wrapper = document.getElementById('publicChatCard') || chatWidget.parentElement;
        if (wrapper) wrapper.style.display = 'none';
        if (chatOpenBtn) chatOpenBtn.style.display = 'block';
      });
    }
    if (chatOpenBtn && chatWidget) {
      chatOpenBtn.addEventListener('click', () => {
        const wrapper = document.getElementById('publicChatCard') || chatWidget.parentElement;
        if (wrapper) wrapper.style.display = 'block';
        chatOpenBtn.style.display = 'none';
      });
      chatOpenBtn.style.display = 'none';
    }

    // Online users list (small UI)
    async function renderOnlineUsers() {
      try {
        const users = await getUsers();
        const now = Date.now();
        const arr = Object.values(users).filter(u => (now - (u.lastSeen || 0)) <= ONLINE_THRESHOLD_MS);
        arr.sort((a,b) => (b.lastSeen||0) - (a.lastSeen||0));
        const el = document.getElementById('onlineUsersList');
        if (!el) return;
        if (arr.length === 0) { el.innerHTML = '<div style="color:var(--text-muted)">Kimse çevrimiçi değil.</div>'; return; }
        let out = '<ul style="list-style:none; padding-left:0; margin:0;">';
        arr.forEach(u => {
          const name = escapeHtml(u.profileName || u.username);
          const color = u.profileColor || '#FFD400';
          out += `<li style="display:flex; align-items:center; gap:10px; padding:8px; border-bottom:1px solid rgba(255,255,255,0.02);">
                    <div style="width:36px;height:36px;border-radius:8px;background:${color}22; display:flex; align-items:center; justify-content:center; font-weight:700; color:${color};">${escapeHtml((u.profileName||u.username).slice(0,2).toUpperCase())}</div>
                    <div style="flex:1;"><div style="font-weight:700;">${name}</div><div style="font-size:0.85rem; color:var(--text-muted);">Son: ${new Date(u.lastSeen).toLocaleTimeString()}</div></div>
                    <div><button onclick="window.startPrivateChat('${u.username}')" style="padding:6px 8px; border-radius:8px; background:var(--accent-primary); color:#021122; border:none;">Özel Sohbet</button></div>
                  </li>`;
        });
        out += '</ul>';
        el.innerHTML = out;
      } catch(e){ console.warn('renderOnlineUsers', e); }
    }
    window.startPrivateChat = async (targetUsername) => {
      if (!user) { showToast('Önce giriş yapın', false); return; }
      const doc = await db.collection('users').doc(targetUsername).get();
      if (!doc.exists) { showToast('Kullanıcı bulunamadı', false); return; }
      const target = doc.data();
      openPrivateChat(user, target);
    };
    setInterval(renderOnlineUsers, 15000);

    await loadUser();
    await renderMaintenanceBanner();
    await renderAnnouncementsInApp();

    // listen for server scheduled activation (safety)
    setInterval(async () => {
      const s = await getSettings();
      if (s.server && s.server.scheduledAt) {
        if (Number(s.server.scheduledAt) <= Date.now()) {
          s.server.closed = true;
          s.server.since = s.server.scheduledAt;
          s.server.scheduledAt = null;
          await saveSettings(s);
          showToast('Planlı sunucu kapanışı gerçekleşti.', true);
          // Ensure overlay updated
          try { updateFullScreenMaintenance(); } catch(e){}
        }
      }
    }, 30000);

    // Watch meta settings for realtime changes (announcements/server)
    db.collection('meta').doc('settings').onSnapshot(async () => {
      await renderMaintenanceBanner();
      await renderAnnouncementsInApp();
      await updateUI();
      // Make sure overlay is synced
      try { updateFullScreenMaintenance(); } catch(e){}
    });

    // watch user's doc for live updates
    if (user) {
      db.collection('users').doc(user.username).onSnapshot((doc) => {
        if (doc.exists) {
          user = doc.data();
          updateUI();
        }
      });
    }

    // ----------------- Tek/Çift Oyunu Handlers -----------------
    async function placeBet(choice) {
      if (!user) { showToast('Önce giriş yapın.', false); return; }
      if (user.isBanned) { showToast('Hesabınız banlı.', false); return; }
      const s = await getSettings();
      if (s.server && s.server.closed) { showToast('Sunucu kapalı — bahis devre dışı.', false); return; }
      const val = parseFloat((betAmountInput && betAmountInput.value) || '0');
      if (!isFinite(val) || val <= 0) { showToast('Geçerli bir bahis miktarı girin.', false); return; }
      if (val > user.balance) { showToast('Yeterli bakiye yok.', false); return; }

      // Deduct stake immediately
      user.balance = Number(user.balance) - Number(val);
      // persist deduction
      await saveUser(user.username, user);
      await updateUI();

      // determine random number 0..99 inclusive, parity: even => 'even', odd => 'odd'
      const rand = Math.floor(Math.random() * 100);
      const resultParity = (rand % 2 === 0) ? 'even' : 'odd';
      const won = (choice === resultParity);

      if (!won) {
        showToast(`Kaybettiniz! (Sayı: ${rand} — ${resultParity}) Bahis tutarı düşüldü.`, false);
        // record a losing bet entry locally for audit (optional)
        const bet = {
          id: generateId('bet_'),
          username: user.username,
          stake: val,
          choice,
          result: resultParity,
          resultNumber: rand,
          status: 'lost',
          createdAt: new Date().toISOString()
        };
        user.betRequests = user.betRequests || [];
        user.betRequests.push(bet);
        await saveUser(user.username, user);
        await updateUI();
        return;
      } else {
        // create pending bet request for admin approval; payout is stake * 2
        const payout = Number(val) * 2;
        const betReq = {
          id: generateId('bet_'),
          username: user.username,
          stake: val,
          payout: payout,
          choice,
          result: resultParity,
          resultNumber: rand,
          status: 'pending',
          createdAt: new Date().toISOString()
        };
        user.betRequests = user.betRequests || [];
        user.betRequests.push(betReq);
        await saveUser(user.username, user);
        showToast(`Tebrikler! Kazandınız (Sayı: ${rand}). Ödeme admin onayı bekliyor.`, true);
        await updateUI();
        return;
      }
    }

    if (betOddBtn) betOddBtn.addEventListener('click', async () => placeBet('odd'));
    if (betEvenBtn) betEvenBtn.addEventListener('click', async () => placeBet('even'));

    // ---------------- Admin realtime watch for settings end ----------------

    // (the rest of initApp continues unchanged)
  } // end initApp

  document.addEventListener('DOMContentLoaded', () => {
    const isApp = !!document.getElementById('mainContent');
    try {
      if (isApp) initApp();
    } catch (e) {
      console.error('Init error', e);
    }
  });

  async function renderRequestsTable() {
    const requestsBody = document.getElementById('requestsBody');
    if (!requestsBody) return;

    const users = await getUsers();
    const allRequests = [];

    Object.entries(users).forEach(([username, u]) => {
      if (Array.isArray(u.withdrawalRequests)) {
        u.withdrawalRequests.forEach(r => {
          allRequests.push({ ...r, username });
        });
      }
    });

    if (allRequests.length === 0) {
      requestsBody.innerHTML = '<tr><td colspan="8" style="text-align:center; color:var(--text-muted); padding:20px;">Henüz çekim talebi yok.</td></tr>';
      return;
    }

    allRequests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    let rows = '';
    allRequests.forEach(r => {
      const statusColor = r.status === 'approved' ? 'var(--accent-success)' :
                         r.status === 'rejected' ? 'var(--accent-danger)' :
                         'orange';
      const statusText = r.status === 'pending' ? 'Bekliyor' :
                        r.status === 'approved' ? 'Onaylandı' :
                        r.status === 'rejected' ? 'Reddedildi' : 'Kaldırıldı';

      const bonusText = r.couponBonusPercent > 0 ? ` (+${r.couponBonusPercent}% bonus)` : '';

      rows += `
        <tr style="font-size:0.92rem;">
          <td><code style="font-size:0.8rem;">${(r.id||'').slice(0, 12)}</code></td>
          <td><strong>${r.username}</strong></td>
          <td style="color:var(--accent-success); font-weight:600;">
            ${formatMoney(r.amount)}${bonusText}
          </td>
          <td>${r.firstName || ''} ${r.lastName || ''}</td>
          <td>${r.bank || ''}<br><small style="color:#00ffb2;">${prettyIban(r.iban || '')}</small></td>
          <td style="font-size:0.8rem;">${new Date(r.createdAt).toLocaleString('tr-TR')}</td>
          <td><span style="color:${statusColor}; font-weight:600;">${statusText}</span></td>
          <td>
            ${r.status === 'pending' ? `
              <button onclick="handleRequestAction('${r.id}', 'approve')" style="padding:5px 9px; font-size:0.8rem; background:var(--accent-success); color:#000; border:none; border-radius:6px; cursor:pointer;">Onayla</button>
              <button onclick="handleRequestAction('${r.id}', 'reject')" style="padding:5px 9px; font-size:0.8rem; background:var(--accent-danger); color:white; border:none; border-radius:6px; margin-left:4px; cursor:pointer;">Reddet</button>
            ` : `

              <button onclick="handleRequestAction('${r.id}', 'remove')" style="padding:5px 9px; font-size:0.8rem; background:rgba(255,255,255,0.1); color:var(--text-muted); border:1px solid var(--border-soft); border-radius:6px; cursor:pointer;">Kaldır</button>
            `}
          </td>
        </tr>
      `;
    });

    requestsBody.innerHTML = rows;
  }

  async function renderLeaderboard() {
    const leaderboardList = document.getElementById('leaderboardList');
    if (!leaderboardList) return;

    const users = Object.values(await getUsers());
    if (users.length === 0) {
      leaderboardList.innerHTML = '<li style="color:var(--text-muted);">Henüz kullanıcı yok.</li>';
      return;
    }

    users.sort((a, b) => (b.balance || 0) - (a.balance || 0));

    const top15 = users.slice(0, 15);
    let html = '';

    top15.forEach((u, i) => {
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '';
      const premiumBadge = u.premium ? ' <span style="background:#FFD400; color:#000; padding:2px 8px; border-radius:6px; font-size:0.7rem; margin-left:6px;">PREMIUM</span>' : '';
      const bannedBadge = u.isBanned ? ' <span style="background:#FF4080; color:white; padding:2px 8px; border-radius:6px; font-size:0.7rem; margin-left:6px;">BANLI</span>' : '';

      const displayName = (u.flashyName && u.flashyName.length) ? u.flashyName : (u.profileName || u.username);

      html += `<li style="margin-bottom:8px;">
        <strong>${i+1}. ${escapeHtml(displayName)}</strong>${premiumBadge}${bannedBadge} → <strong style="color:var(--accent-success);">${formatMoney(u.balance)}</strong>
        ${medal ? `<span style="margin-left:8px; font-size:1.4rem;">${medal}</span>` : ''}
      </li>`;
    });

    leaderboardList.innerHTML = html || '<li style="color:var(--text-muted);">Veri yok.</li>';
  }

  window.handleRequestAction = async (requestId, action) => {
    if (!confirm(`${action === 'approve' ? 'Onayla' : action === 'reject' ? 'Reddet' : 'Kaldır'} mı?`)) return;

    const users = await getUsers();
    let found = false;

    for (const username in users) {
      const u = users[username];
      if (!Array.isArray(u.withdrawalRequests)) continue;

      u.withdrawalRequests = u.withdrawalRequests.map(req => {
        if (req.id !== requestId) return req;
        found = true;

        if (action === 'approve') {
          req.status = 'approved';
          req.approvedAt = new Date().toISOString();
        } else if (action === 'reject') {
          req.status = 'rejected';
          req.rejectedAt = new Date().toISOString();
          u.balance = (req.originalBalance || 0) + (u.balance || 0);
        } else if (action === 'remove') {
          return null;
        }
        return req;
      }).filter(Boolean);

      users[username] = u;
    }

    if (!found) {
      showToast('Talep bulunamadı!', false);
      return;
    }

    for (const username in users) {
      await saveUser(username, users[username]);
    }

    showToast(`Talep ${action === 'approve' ? 'onaylandı' : action === 'reject' ? 'reddedildi' : 'kaldırıldı'}!`, true);
    renderRequestsTable();
    renderLeaderboard();
  };

  // Private DM implementation (kept from previous)
  let currentDmUnsub = null;
  function dmIdFor(a, b) { const pair = [a,b].sort(); return 'dm_' + pair.join('__'); }
  async function openPrivateChat(currentUser, targetUserObj) {
    const dmModal = document.getElementById('privateChatModal');
    if (!dmModal) { showToast('DM modal mevcut değil', false); return; }
    const dmTitle = document.getElementById('dmTitle');
    const dmMessages = document.getElementById('dmMessages');
    const dmInput = document.getElementById('dmInput');
    const dmSendBtn = document.getElementById('dmSendBtn');
    const chatId = dmIdFor(currentUser.username, targetUserObj.username);
    dmTitle.textContent = `Özel: ${targetUserObj.profileName || targetUserObj.username}`;
    dmMessages.innerHTML = '<div style="color:var(--text-muted)">Yükleniyor...</div>';
    dmModal.style.display = 'flex';

    if (currentDmUnsub) try { currentDmUnsub(); } catch(e){}
    currentDmUnsub = db.collection('privateChats').doc(chatId).collection('messages').orderBy('timestamp','asc').limitToLast(500)
      .onSnapshot(snap => {
        dmMessages.innerHTML = '';
        snap.forEach(doc => {
          const m = doc.data() || {};
          const who = m.fromName || m.from || 'Anon';
          const color = m.fromColor || '#00A3FF';
          const div = document.createElement('div');
          div.className = 'chat-message' + (m.from === currentUser.username ? ' me' : '');
          div.innerHTML = `<span class="username" style="color:${escapeHtml(color)}">${escapeHtml(who)}:</span> ${escapeHtml(m.text || '')}`;
          dmMessages.appendChild(div);
        });
        dmMessages.scrollTop = dmMessages.scrollHeight;
      });

    const sendDm = async () => {
      const text = (dmInput.value || '').trim();
      if (!text) return;
      const payload = {
        from: currentUser.username,
        fromName: currentUser.profileName || currentUser.username,
        fromColor: currentUser.profileColor || '#00A3FF',
        to: targetUserObj.username,
        text,
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      };
      await db.collection('privateChats').doc(chatId).collection('messages').add(payload).catch(e => console.error(e));
      dmInput.value = '';
    };

    dmSendBtn.onclick = sendDm;
    dmInput.onkeypress = (e) => { if (e.key === 'Enter') sendDm(); };
    document.getElementById('closeDmBtn').onclick = () => {
      dmModal.style.display = 'none';
      if (currentDmUnsub) try { currentDmUnsub(); } catch(e){}
    };
  }
const snowContainer = document.getElementById('snow-container');

 // --- KAR TANELERİ AYARLARI ---
const numberOfSnowflakes = 80; // Daha az kar tanesi
const snowflakeChars = ['❄', '❅', '❆', '✨']; // Farklı kar tanesi veya parıltı karakterleri

function createSnowflake() {
    const snowflake = document.createElement('div');
    snowflake.classList.add('falling-item', 'snowflake');
    snowflake.innerHTML = snowflakeChars[Math.floor(Math.random() * snowflakeChars.length)];

    const startX = Math.random() * 100;
    snowflake.style.left = `${startX}vw`; 

    const size = Math.random() * 0.7 + 0.3; // 0.3 ile 1.0 arasında bir değer
    snowflake.style.fontSize = `${size}em`;
    snowflake.style.opacity = Math.random() * 0.7 + 0.3; // Daha az opak

    const duration = Math.random() * 12 + 6; // 6 ile 18 saniye arası
    snowflake.style.animationDuration = `${duration}s`;

    const delay = Math.random() * 12;
    snowflake.style.animationDelay = `-${delay}s`;

    snowContainer.appendChild(snowflake);

    setTimeout(() => {
        snowflake.remove();
        createSnowflake();
    }, (duration + delay) * 1000); 
}

// Kar tanelerini oluştur
for (let i = 0; i < numberOfSnowflakes; i++) {
    createSnowflake();
}

// --- PARA TANELERİ AYARLARI ---
const numberOfMoney = 20; // Daha az para (hafif yağmur için)
const moneyChars = ['💲', '💰', '$', '€', '£', '¥']; // Farklı para birimi sembolleri

function createMoney() {
    const moneyItem = document.createElement('div');
    moneyItem.classList.add('falling-item', 'money');
    moneyItem.innerHTML = moneyChars[Math.floor(Math.random() * moneyChars.length)];

    const startX = Math.random() * 100;
    moneyItem.style.left = `${startX}vw`; 

    const size = Math.random() * 0.8 + 0.7; // 0.7 ile 1.5 arasında daha büyük
    moneyItem.style.fontSize = `${size}em`;
    moneyItem.style.opacity = Math.random() * 0.8 + 0.4; // Biraz daha opak

    const duration = Math.random() * 10 + 7; // 7 ile 17 saniye arası (kar tanelerinden biraz daha yavaş olabilir)
    moneyItem.style.animationDuration = `${duration}s`;

    const delay = Math.random() * 15;
    moneyItem.style.animationDelay = `-${delay}s`;

    snowContainer.appendChild(moneyItem);

    setTimeout(() => {
        moneyItem.remove();
        createMoney();
    }, (duration + delay) * 1000); 
}
// Minimal JS kontrol (banner-strong.js)
// Kullanım: sayfanın sonuna ekle. Mevcut UI ile entegre et.
// Bu kod DOM yoksa zarar vermez; id="strongBanner" kullandım örnekteki markup için.

(() => {
  const id = 'strongBanner';
  const el = document.getElementById(id);
  if (!el) return;

  // Close buton
  const closeBtn = el.querySelector('.sb-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      el.classList.add('hidden');
      // istersen localStorage ile kullanıcı kapattı bilgisi tutabilirsin
      try { localStorage.setItem('strongBannerClosed', '1'); } catch (e) {}
      setTimeout(()=> el.remove(), 420);
    });
  }

  // CTA örneği (bildirim açma vs.)
  const cta = el.querySelector('.sb-cta');
  if (cta) {
    cta.addEventListener('click', (e) => {
      e.preventDefault();
      // Örnek: bildirim modalini aç veya yönlendir
      // window.location.href = '/notifications';
      // küçük feedback
      cta.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-3px)' }, { transform: 'translateY(0)' }], { duration: 220 });
    });
  }

  // progress örneği: data-progress attribute'u ile width güncellenir
  const progressFill = el.querySelector('.sb-progress .sb-progress-fill');
  if (progressFill) {
    const p = el.dataset.progress;
    if (p) progressFill.style.width = Math.max(0, Math.min(100, Number(p))) + '%';
  }

  // Eğer localStorage ile daha önce kapatılmışsa gösterme
  try {
    if (localStorage.getItem('strongBannerClosed') === '1') {
      el.classList.add('hidden');
    }
  } catch (e) {}

  // Harici kontrol API (global) — örnek
  window.strongBanner = {
    show: (opts = {}) => {
      if (opts.variant) {
        el.classList.remove('strong-danger','strong-info');
        if (opts.variant === 'danger') el.classList.add('strong-danger');
        if (opts.variant === 'info') el.classList.add('strong-info');
      }
      if (typeof opts.progress !== 'undefined' && progressFill) {
        progressFill.style.width = Math.max(0, Math.min(100, Number(opts.progress))) + '%';
        el.dataset.progress = Number(opts.progress);
      }
      el.classList.remove('hidden','collapsed');
      if (opts.emphasize) el.classList.add('emphasized');
    },
    hide: () => { el.classList.add('hidden'); },
    collapse: () => { el.classList.add('collapsed'); },
    remove: () => { el.remove(); }
  };
})();
// Para tanelerini oluştur
for (let i = 0; i < numberOfMoney; i++) {
    createMoney();
}
    window.handleBetRequestAction = async (betId, action) => {
      if (!confirm(`${action === 'approve' ? 'Onayla' : action === 'reject' ? 'Reddet' : 'Kaldır'} mı?`)) return;
      const users = await getUsers();
      let found = false;
      for (const username in users) {
        const u = users[username];
        if (!Array.isArray(u.betRequests)) continue;
        u.betRequests = u.betRequests.map(b => {
          if (b.id !== betId) return b;
          found = true;
          if (action === 'approve') {
            b.status = 'approved';
            b.approvedAt = new Date().toISOString();
            // credit payout to user's balance
            u.balance = (u.balance || 0) + (b.payout || 0);
          } else if (action === 'reject') {
            b.status = 'rejected';
            b.rejectedAt = new Date().toISOString();
            // no credit (stake already deducted at bet time)
          } else if (action === 'remove') {
            return null;
          }
          return b;
        }).filter(Boolean);
        users[username] = u;
      }
      if (!found) {
        showToast('Talep bulunamadı!', false);
        return;
      }
      for (const username in users) {
        await saveUser(username, users[username]);
      }
      showToast(`Talep ${action === 'approve' ? 'onaylandı' : action === 'reject' ? 'reddedildi' : 'kaldırıldı'}!`, true);
      renderBetRequestsTable();
      renderRequestsTable();
      renderUsersTable();
      renderLeaderboard();
    };

  // small utility to escape html
  function escapeHtml(s) {
    if (s === null || typeof s === 'undefined') return '';
    return String(s).replace(/[&<>"'`=\/]/g, function (c) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
        '/': '&#x2F;',
        '=': '&#x3D;',
        '`': '&#x60;'
      }[c];
    });
  }
/* PATCH: small, safe changes to prefer username/password (no e‑mail) auth by default
   - Add a flag window.ENABLE_FIREBASE_AUTH (default false).
   - Only enable Firebase-based auth handlers when that flag is true.
   - Provide a no-op global switchAuthMode early so the inline onclick won't throw before init.
   Replace the top-of-file flag lines and the setupFirebaseAuthHandlers block with the code below.
*/

/* --- Add near the top of script.js (replace the previous window.USE_FIREBASE_AUTH line) --- */
window.USE_FIREBASE_AUTH = false;
// By default we DO NOT ENABLE Firebase email-based auth for signups/logins.
// Set window.ENABLE_FIREBASE_AUTH = true (from a trusted place) if you explicitly want email-based Firebase auth.
window.ENABLE_FIREBASE_AUTH = false;

// Provide a safe noop so onclick handlers in HTML don't error before initApp runs
if (typeof window.switchAuthMode !== 'function') {
  window.switchAuthMode = function(){ /* stub, real handler attached in initApp */ };
}

/* --- Replace the entire setupFirebaseAuthHandlers() block with the following --- */
(function setupFirebaseAuthHandlers(){
  // Only wire Firebase email/password auth if:
  //  - firebase SDK is present AND
  //  - caller explicitly allowed it via window.ENABLE_FIREBASE_AUTH === true
  if (typeof firebase === 'undefined' || !firebase.auth || !window.ENABLE_FIREBASE_AUTH) return;

  // enable usage flag so legacy handler is skipped
  window.USE_FIREBASE_AUTH = true;

  const authForm = document.getElementById('authForm');
  const switchTextEl = document.getElementById('switchText');
  const authSubmitBtn = document.getElementById('authSubmitBtn');
  const authMessage = document.getElementById('authMessage');

  // Başlangıç modu: login
  let mode = 'login'; // 'login' veya 'register'
  // Expose switchAuthMode global olarak (index.html'da onclick kullanılıyor)
  window.switchAuthMode = function() {
    mode = (mode === 'login') ? 'register' : 'login';
    updateAuthUI();
  };

  function updateAuthUI() {
    if (!switchTextEl) return;
    if (mode === 'register') {
      switchTextEl.innerHTML = 'Zaten hesabın var mı? <b>Giriş Yap</b>';
      if (authSubmitBtn) authSubmitBtn.textContent = 'KAYIT OL';
    } else {
      switchTextEl.innerHTML = 'Hesabın yok mu? <b>Kayıt Ol</b>';
      if (authSubmitBtn) authSubmitBtn.textContent = 'GİRİŞ';
    }
    if (authMessage) {
      authMessage.style.display = 'none';
      authMessage.textContent = '';
    }
  }
 async function initApp(){
    // (initApp body is long — earlier code remains unchanged.)
    // The original snippet already contains the initApp implementation and calls to it.
    // We only need to ensure weekly award and notifications support are wired up after load.
    // To avoid duplicating huge code here, we'll attach extra listeners/behaviors now.

    // Run weekly award check now and every 12 hours to be safe
    try {
      await runWeeklyLeaderboardAward();
      setInterval(runWeeklyLeaderboardAward, 12 * 60 * 60 * 1000);
    } catch (e) { console.warn('weekly award setup error', e); }

    // Keep notification badge updated periodically
    setInterval(() => {
      try { refreshNotificationBadgeForUser(); } catch(e){ }
    }, 60 * 1000); // every minute
  }

  document.addEventListener('DOMContentLoaded', () => {
    const isApp = !!document.getElementById('mainContent');
    try {
      if (isApp) initApp();
    } catch (e) {
      console.error('Init error', e);
    }
  });

  // ----------------- Complete chat file upload (already in snippet but ensure closure) -----------------
  // (The primary file upload handling is already present in initApp earlier. No duplication needed.)

  // ----------------- Notifications (admin -> users) -----------------
  // Admin/moderator can call window.adminAddNotification({ title, message, sticky }) to add a notification.
  window.adminAddNotification = async function(notification) {
    if (!notification || typeof notification !== 'object') {
      console.warn('adminAddNotification: invalid payload');
      return;
    }
    const payload = {
      title: notification.title || 'Bildirim',
      message: notification.message || '',
      sticky: !!notification.sticky,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      visible: true
    };
    try {
      await db.collection('notifications').add(payload);
      showToast('Bildirim eklendi.', true);
      // update badge immediately for current user
      refreshNotificationBadgeForUser();
    } catch (e) {
      console.error('adminAddNotification error', e);
      showToast('Bildirim eklenirken hata oluştu.', false);
    }
  };

  async function renderNotificationsList() {
    const listEl = document.getElementById('notifList');
    if (!listEl) return;
    try {
      const snap = await db.collection('notifications').orderBy('createdAt', 'desc').limit(200).get();
      if (snap.empty) {
        listEl.innerHTML = '<div style="color:var(--text-muted)">Henüz bildirim yok.</div>';
        return;
      }
      let html = '';
      snap.forEach(doc => {
        const n = doc.data();
        const created = n.createdAt && n.createdAt.toDate ? n.createdAt.toDate() : null;
        html += `<div class="notif-item"><div style="display:flex; justify-content:space-between; gap:8px;"><div><strong>${escapeHtml(n.title||'')}</strong><div style="color:var(--text-muted); font-size:0.9rem;">${escapeHtml(n.message||'')}</div></div><div style="text-align:right;"><div style="font-size:0.82rem; color:var(--text-muted)">${created?created.toLocaleString() : ''}</div></div></div></div>`;
      });
      listEl.innerHTML = html;
    } catch (e) {
      console.error('renderNotificationsList error', e);
      listEl.innerHTML = '<div style="color:var(--text-muted)">Bildirimler yüklenemiyor.</div>';
    }
  }

  async function markAllNotificationsRead() {
    const userObj = await getLoggedInUser();
    if (!userObj) return;
    try {
      userObj.notificationsReadAt = Date.now();
      await saveUser(userObj.username, userObj);
      refreshNotificationBadgeForUser();
      showToast('Tüm bildirimler okundu olarak işaretlendi.', true, 2000);
    } catch (e) {
      console.error('markAllNotificationsRead error', e);
    }
  }

  async function refreshNotificationBadgeForUser() {
    try {
      const userObj = await getLoggedInUser();
      const badge = document.getElementById('notifBadge');
      if (!badge) return;
      if (!userObj) {
        badge.classList.add('hidden');
        return;
      }
      const lastRead = Number(userObj.notificationsReadAt || 0);
      // Count notifications with createdAt > lastRead (serverTimestamp requires querying)
      let q = db.collection('notifications').orderBy('createdAt', 'desc').limit(20);
      const snap = await q.get();
      let hasNew = false;
      snap.forEach(doc => {
        const n = doc.data();
        const created = n.createdAt && n.createdAt.toMillis ? n.createdAt.toMillis() : (n.createdAt ? new Date(n.createdAt).getTime() : 0);
        if (created > lastRead) hasNew = true;
      });
      if (hasNew) badge.classList.remove('hidden'); else badge.classList.add('hidden');
    } catch (e) {
      console.warn('refreshNotificationBadgeForUser error', e);
    }
  }

  // ----------------- Leaderboards & Weekly Award -----------------
  async function renderActivityLeaderboard() {
    const cont = document.getElementById('lbContent');
    if (!cont) return;
    try {
      const users = Object.values(await getUsers());
      // sort by weeklyClicks desc
      users.sort((a,b) => (b.weeklyClicks || 0) - (a.weeklyClicks || 0));
      const top = users.slice(0, 30);
      let html = `<div style="margin-top:8px;">`;
      top.forEach((u, i) => {
        const place = i + 1;
        const medal = place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : '';
        html += `<div class="lb-entry ${place===1 ? 'top' : ''}" title="${escapeHtml(u.username || '')}">
          <div style="display:flex;align-items:center;gap:8px;"><span class="xmas-acc">❄️</span><strong>${place}. ${escapeHtml(u.profileName || u.username)}</strong></div>
          <div style="font-weight:800;">${(u.weeklyClicks||0)} tıklama ${medal}</div>
        </div>`;
      });
      if (top.length === 0) html += '<div style="color:var(--text-muted)">Veri yok.</div>';
      html += `</div><div style="margin-top:10px; color:var(--text-muted); font-size:0.9rem;">Ödül: 1.'ye ${formatMoney(WEEKLY_TOP_PRIZE)} (haftalık)</div>`;
      cont.innerHTML = html;
    } catch (e) {
      console.error('renderActivityLeaderboard', e);
      cont.innerHTML = '<div style="color:var(--text-muted)">Sıralama yüklenemedi.</div>';
    }
  }

  async function renderFameLeaderboard() {
    const cont = document.getElementById('lbContent');
    if (!cont) return;
    try {
      const users = Object.values(await getUsers());
      users.sort((a,b) => (b.balance || 0) - (a.balance || 0));
      const top = users.slice(0, 30);
      let html = `<div style="margin-top:8px;">`;
      top.forEach((u, i) => {
        const place = i + 1;
        const medal = place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : '';
        html += `<div class="lb-entry ${place===1 ? 'top' : ''}">
          <div style="display:flex;align-items:center;gap:8px;"><span class="xmas-acc">🎁</span><strong>${place}. ${escapeHtml(u.profileName || u.username)}</strong></div>
          <div style="font-weight:800; color:var(--accent-success)">${formatMoney(u.balance||0)} ${medal}</div>
        </div>`;
      });
      if (top.length === 0) html += '<div style="color:var(--text-muted)">Veri yok.</div>';
      html += `</div>`;
      cont.innerHTML = html;
    } catch (e) {
      console.error('renderFameLeaderboard', e);
      cont.innerHTML = '<div style="color:var(--text-muted)">Sıralama yüklenemedi.</div>';
    }
  }

  // Weekly award: runs if last run older than a week; awards WEEKLY_TOP_PRIZE to top weeklyClicks and resets weeklyClicks
  async function runWeeklyLeaderboardAward() {
    try {
      const settings = await getSettings();
      const lastRun = Number(settings.weeklyAwardLastRun || 0);
      const now = Date.now();
      if (lastRun && (now - lastRun) < WEEK_MS) {
        return; // not yet a week
      }
      const usersMap = await getUsers();
      const users = Object.values(usersMap);
      if (users.length === 0) {
        settings.weeklyAwardLastRun = now;
        await saveSettings(settings);
        return;
      }
      users.sort((a,b) => (b.weeklyClicks || 0) - (a.weeklyClicks || 0));
      const top = users[0];
      if (!top) {
        settings.weeklyAwardLastRun = now;
        await saveSettings(settings);
        return;
      }
      // Award top user
      try {
        const username = top.username;
        const doc = await db.collection('users').doc(username).get();
        if (doc.exists) {
          const u = doc.data();
          u.balance = (u.balance || 0) + WEEKLY_TOP_PRIZE;
          // reset weeklyClicks for all users
          const batch = db.batch();
          Object.keys(usersMap).forEach(k => {
            const ref = db.collection('users').doc(k);
            batch.update(ref, { weeklyClicks: 0 });
          });
          // update winner balance and reset their weeklyClicks to 0 in the batch as well
          // (we already included all refs)
          await batch.commit();
          // separately ensure winner's balance updated (can't be in batch if we used same refs above unsafely) — do as set
          const winner = await db.collection('users').doc(username).get();
          if (winner.exists) {
            const winObj = winner.data();
            winObj.balance = (winObj.balance || 0) + WEEKLY_TOP_PRIZE;
            winObj.weeklyClicks = 0;
            await saveUser(username, winObj);
          }
          // update settings last run
          settings.weeklyAwardLastRun = now;
          await saveSettings(settings);
          showToast(`Haftanın birincisi ${username} - Ödül ${formatMoney(WEEKLY_TOP_PRIZE)} verildi.`, true, 7000);
        }
      } catch (e) {
        console.error('error awarding weekly prize', e);
      }
    } catch (e) {
      console.error('runWeeklyLeaderboardAward error', e);
    }
  }

  // ----------------- Helper stubs to avoid undefined calls in admin flows -----------------
  async function renderBetRequestsTable() {
    // stub: admin panel should provide its own full implementation
    const el = document.getElementById('betRequestsBody');
    if (!el) return;
    el.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:20px;">(Bet istekleri burada gösterilir)</td></tr>';
  }
  async function renderUsersTable() {
    // stub: admin panel may implement its own UI
    const el = document.getElementById('usersTableBody');
    if (!el) return;
    el.innerHTML = '<tr><td colspan="6" style="text-align:center; color:var(--text-muted); padding:20px;">(Kullanıcı listesi burada)</td></tr>';
  }
(function(){
  // ensure these helpers don't collide with existing functions
  async function uploadAvatarFileForUser(username, file) {
    if (!file || !username) return null;
    if (typeof storage === 'undefined' || !storage) {
      console.warn('Storage not configured; avatar upload skipped.');
      return null;
    }
    try {
      const safeName = file.name.replace(/[^\w.\-]/g,'_');
      const path = `profile_avatars/${username}_${Date.now()}_${safeName}`;
      const ref = storage.ref().child(path);
      const uploadTask = await ref.put(file);
      const url = await uploadTask.ref.getDownloadURL();
      // also save url in user doc
      const u = (await db.collection('users').doc(username).get()).data() || {};
      u.avatarUrl = url;
      await db.collection('users').doc(username).set(u, { merge: true });
      return url;
    } catch (e) {
      console.error('avatar upload failed', e);
      return null;
    }
  }

  // update header avatar element based on user data
  async function setHeaderAvatar(user) {
    try {
      const avatarDiv = document.getElementById('avatar');
      const avatarImg = document.getElementById('avatarImg');
      if (!avatarDiv || !avatarImg) return;
      if (user && user.avatarUrl) {
        avatarImg.src = user.avatarUrl;
        avatarImg.classList.remove('hidden');
        avatarImg.classList.add('visible');
        avatarDiv.style.display = 'none';
      } else {
        // fallback to initials inside avatar div
        avatarImg.classList.add('hidden');
        avatarImg.classList.remove('visible');
        avatarImg.src = '';
        avatarDiv.style.display = 'flex';
        const display = (user && (user.flashyName && user.flashyName.length)) ? user.flashyName : (user && (user.profileName || user.username)) || 'US';
        const initials = (display.split(' ').map(s => s[0] || '').join('').slice(0,2)).toUpperCase();
        avatarDiv.textContent = initials || 'US';
      }
    } catch(e){ console.warn('setHeaderAvatar error', e); }
  }

  // open readonly view profile modal for given username
  async function openViewProfile(username) {
    if (!username) return;
    try {
      const doc = await db.collection('users').doc(username).get();
      if (!doc.exists) return;
      const u = doc.data();
      const modal = document.getElementById('viewProfileModal');
      if (!modal) return;
      const avatar = document.getElementById('viewProfileAvatar');
      const nameEl = document.getElementById('viewProfileName');
      const roleEl = document.getElementById('viewProfileRole');
      const balanceEl = document.getElementById('viewProfileBalance');
      const badgesEl = document.getElementById('viewProfileBadges');
      const lastSeenEl = document.getElementById('viewProfileLastSeen');
      avatar.src = u.avatarUrl || '';
      nameEl.textContent = u.profileName || u.username || 'Anon';
      // Apply flashy/chromatic class to highlight name if needed
      nameEl.classList.remove('chromatic','chrom-black','chrom-blue','chrom-green','chrom-purple','chrom-red');
      const parsed = (typeof parseFlashyColorToken === 'function') ? parseFlashyColorToken(u.flashyColor || u.profileColor || '#00A3FF') : { isChromatic:false, chromaType:null };
      if (parsed.isChromatic && parsed.chromaType) {
        nameEl.classList.add('chromatic', `chrom-${parsed.chromaType}`);
      } else if ((u.flashyColor || '').toLowerCase() === 'rgb') {
        nameEl.classList.add('rainbow-text');
      } else {
        nameEl.style.color = parsed.cssColor || (u.profileColor || '#00A3FF');
      }
      roleEl.textContent = (u.role ? u.role.toUpperCase() : 'USER');
      balanceEl.textContent = formatMoney(u.balance || 0);
      badgesEl.innerHTML = '';
      if (u.premium) badgesEl.innerHTML += '<span class="level-badge platinum">PREM</span> ';
      if (u.isBanned) badgesEl.innerHTML += '<span class="level-badge" style="background:linear-gradient(90deg,#FF6B6B,#D62828);">BANLI</span> ';
      if (u.streak) badgesEl.innerHTML += `<span class="streak-badge">Streak: ${u.streak}</span>`;
      lastSeenEl.textContent = u.lastSeen ? new Date(u.lastSeen).toLocaleString() : 'Bilinmiyor';
      modal.style.display = 'flex';
      document.getElementById('viewProfileClose').onclick = () => { modal.style.display = 'none'; };
    } catch (e) {
      console.error('openViewProfile error', e);
    }
  }

  // Expose globally
  window.openViewProfile = openViewProfile;
  window.setHeaderAvatar = setHeaderAvatar;
  window.uploadAvatarFileForUser = uploadAvatarFileForUser;
})();

/* --- Integrations into existing initApp flow --- */
/* We'll attach file handlers when profile edit modal is used and ensure chat message rendering shows avatars and click-to-open-profile. */

/* Inject small patch inside existing initApp (at profile editing and chat rendering phases).
   Since the repo's initApp() is long and already present, we hook into DOMContentLoaded to attach our handlers safely.
*/
document.addEventListener('DOMContentLoaded', () => {
  // Profile avatar input flow
  const profileAvatarInput = document.getElementById('profileAvatarInput');
  const profileAvatarPreview = document.getElementById('profileAvatarPreview');

  if (profileAvatarInput) {
    profileAvatarInput.addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) { if (profileAvatarPreview) profileAvatarPreview.innerHTML = ''; return; }
      // show preview
      try {
        const url = URL.createObjectURL(f);
        if (profileAvatarPreview) profileAvatarPreview.innerHTML = `<img src="${url}" style="width:80px;height:80px;object-fit:cover;border-radius:10px;border:1px solid rgba(255,255,255,0.06);" />`;
      } catch(e){}
    });
  }

  // Save profile handler enhancement: attempt to upload avatar and save avatarUrl to user before closing
  const saveProfileBtn = document.getElementById('saveProfileBtn');
  if (saveProfileBtn) {
    saveProfileBtn.addEventListener('click', async (ev) => {
      try {
        // get currently logged user via helper
        const u = await getLoggedInUser();
        if (!u) { showToast('Önce giriş yapın', false); return; }
        const newName = (document.getElementById('profileNameInput') || {}).value || u.profileName || u.username;
        let newColor = '#FFD400';
        const radios = document.getElementsByName('profileColor');
        for (const r of radios) if (r.checked) newColor = r.value;
        // If there's a chosen file, upload it
        const fileInput = document.getElementById('profileAvatarInput');
        let uploadedUrl = null;
        if (fileInput && fileInput.files && fileInput.files[0]) {
          uploadedUrl = await uploadAvatarFileForUser(u.username, fileInput.files[0]);
        }
        // update user fields
        u.profileName = newName;
        u.profileColor = newColor;
        if (uploadedUrl) u.avatarUrl = uploadedUrl;
        await saveUser(u.username, u);
        await setHeaderAvatar(u);
        // update UI by invoking existing updateUI if present
        if (typeof updateUI === 'function') await updateUI();
        document.getElementById('profileModal').style.display = 'none';
        showToast('Profil güncellendi', true);
      } catch (e) {
        console.error('save profile avatar error', e);
        showToast('Profil kaydedilemedi', false);
      }
    });
  }

  // Hook into chat rendering to make avatars clickable and small
  // If initChat function re-renders chat from onSnapshot, we need to patch it by wrapping original initChat or by listening DOM mutations.
  // Simpler: monkeypatch db.collection('chat').onSnapshot consumer by overriding initChat if present.
  // But we don't want to rewrite big initChat. Instead, we add a delegated click listener for avatar clicks inside #chatMessages.
  const chatMessages = document.getElementById('chatMessages');
  if (chatMessages) {
    chatMessages.addEventListener('click', (e) => {
      const targ = e.target;
      // if clicking an avatar image inside chat
      if (targ && targ.classList && targ.classList.contains('chat-avatar')) {
        const username = targ.getAttribute('data-username');
        if (username) window.openViewProfile(username);
      }
      // also if clicking a username span
      if (targ && targ.classList && targ.classList.contains('username')) {
        const username = targ.getAttribute('data-username');
        if (username) window.openViewProfile(username);
      }
    }, false);
  }

  // Ensure header avatar is clickable to open own profile
  const headerAvatarImg = document.getElementById('avatarImg');
  const headerAvatarDiv = document.getElementById('avatar');
  function handleHeaderClick() {
    const uPromise = getLoggedInUser();
    uPromise.then(u => {
      if (!u) return;
      window.openViewProfile(u.username);
    }).catch(()=>{});
  }
  if (headerAvatarImg) headerAvatarImg.addEventListener('click', handleHeaderClick);
  if (headerAvatarDiv) headerAvatarDiv.addEventListener('click', handleHeaderClick);

  // When chat messages are re-rendered (by initChat), we want avatars included.
  // We'll monkey-patch the previously defined initChat if it exists to enhance message markup.
  try {
    if (typeof initChat === 'function') {
      const originalInitChat = initChat;
      window.initChat = async function(userObj) {
        // call original but afterwards attach a MutationObserver to enrich each message (in case server snapshot uses different structure)
        await originalInitChat(userObj);
        // After original sets up the listener, we observe the chatMessages container to rewrite each .chat-message to include avatar and data-username attributes.
        const container = document.getElementById('chatMessages');
        if (!container) return;
        const enrich = async () => {
          try {
            const usersMap = await getUsers();
            container.querySelectorAll('.chat-message').forEach(msgEl => {
              // skip if already processed
              if (msgEl.dataset.enriched === '1') return;
              // Attempt to find username from inner text metadata or data attributes
              // Prefer a data attribute if present
              let username = msgEl.getAttribute('data-username') || '';
              // Some chat renderers have a .username span inside, try to read it
              const nameSpan = msgEl.querySelector('.username');
              if (nameSpan && nameSpan.getAttribute('data-username')) username = username || nameSpan.getAttribute('data-username');
              // If still not available, try to parse from innerText (last fallback)
              if (!username) {
                // attempt naive parse "Name: message"
                const t = (msgEl.textContent || '').trim();
                const idx = t.indexOf(':');
                if (idx > 0) username = t.slice(0, idx).trim();
              }
              let avatarUrl = '';
              if (username && usersMap[username] && usersMap[username].avatarUrl) avatarUrl = usersMap[username].avatarUrl;
              // Build wrapper row with avatar and message body
              if (!msgEl.parentElement || msgEl.parentElement.classList.contains('chat-msg-row')) {
                msgEl.dataset.enriched = '1';
                return;
              }
              const row = document.createElement('div');
              row.className = 'chat-msg-row';
              // avatar image element
              const img = document.createElement('img');
              img.className = 'chat-avatar';
              img.alt = username || 'u';
              img.src = avatarUrl || (usersMap[username] && usersMap[username].avatarUrl) || '';
              img.setAttribute('data-username', username || '');
              // ensure a small fallback if no avatar url (use generated data url? - keep blank)
              if (!img.src) {
                img.src = ''; // leave empty: border and initials are handled by viewProfile modal
              }
              // set username on name spans for click handling
              if (nameSpan) nameSpan.setAttribute('data-username', username || '');
              // move existing message element into wrapper
              const wrapperMsg = msgEl.cloneNode(true);
              // mark wrapperMsg as processed so we don't reprocess clones
              wrapperMsg.dataset.enriched = '1';
              wrapperMsg.classList.add('with-avatar');
              // Replace original message element with new row
              row.appendChild(img);
              row.appendChild(wrapperMsg);
              msgEl.parentNode.replaceChild(row, msgEl);
            });
          } catch (e) {
            console.warn('chat enrich failed', e);
          }
        }; // enrich

        // run once immediately
        enrich();

        // observe for future messages
        const mo = new MutationObserver((mutations) => {
          enrich();
        });
        mo.observe(container, { childList: true, subtree: true });
      };
    }
  } catch (e) {
    console.warn('patching initChat failed', e);
  }
  // Eklemeniz gereken kod parçası — script.js içinde mevcut auth/register handling'i REPLACE etmek veya
// bu bloğu ekleyip eski submit handler'ları kaldırmak için authForm.onsubmit ve registerForm.onsubmit kullanın.

// Utility: küçük temizleme/sanitize

// Eklemeniz veya mevcut register/login handler'larını REPLACE etmeniz gereken kod.
// Amaç: E-posta istememek (kullanıcı adı ile kayıt/giriş) ve Kayıtta davet kodunu ZORUNLU yapmak.

// Helper: normalize username
function sanitizeUsername(u) {
  return (u || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
}

// Kullanıcıyı usernameLower üzerinden getir
async function getUserByUsername(username) {
  if (!db) return null;
  const unameLower = sanitizeUsername(username);
  const q = await db.collection('users').where('usernameLower', '==', unameLower).limit(1).get();
  if (q.empty) return null;
  return q.docs[0]; // DocumentSnapshot
}

// Firebase Auth için sentetik e-posta (kullanıcıdan e-posta istenmeyecek)
function synthEmailForUsername(username) {
  const clean = sanitizeUsername(username);
  return `${clean}@noemail.lilemir.local`;
}
const MARKET_ITEMS = [
  // Coin paketi (gerçek para ile satın alınır, sonra kullanıcıya coin eklenir)
  {
    id: 'coins_1000_pack',
    name: '1000 Coin Paketi',
    type: 'coins',
    purchaseType: 'real',
    price: 20,
    currency: 'USD',
    meta: { amount: 1000 },
    desc: '1000 coin kazanırsınız. (Ödeme: 20 USD)'
  },

  // İsim renkleri (sadece coin ile alınır)
  {
    id: 'color_chromatic_black',
    name: 'Kromatik Siyah İsim Rengi',
    type: 'name_color',
    purchaseType: 'coins',
    priceCoins: 10000,
    meta: { color: '#0b0b0b' },
    desc: 'Kullanıcı adınızı kromatik siyah renge çevirir.'
  },
  {
    id: 'color_kan_kirmizi',
    name: 'Kan Kırmızı RGB İsim Rengi',
    type: 'name_color',
    purchaseType: 'coins',
    priceCoins: 10000,
    meta: { color: '#8B0000' },
    desc: 'Kullanıcı adınızı kan kırmızı (RGB) renge çevirir.'
  },
  {
    id: 'color_krom_yesil',
    name: 'Krom Yeşil RGB İsim Rengi',
    type: 'name_color',
    purchaseType: 'coins',
    priceCoins: 10000,
    meta: { color: '#00FF44' },
    desc: 'Kullanıcı adınızı krom yeşil (RGB) renge çevirir.'
  },
  {
    id: 'color_rgb_mavi',
    name: 'RGB Mavi İsim Rengi',
    type: 'name_color',
    purchaseType: 'coins',
    priceCoins: 10000,
    meta: { color: '#00A3FF' },
    desc: 'Kullanıcı adınızı RGB mavi renge çevirir.'
  },
  {
    id: 'color_rgb_mor',
    name: 'RGB Mor İsim Rengi',
    type: 'name_color',
    purchaseType: 'coins',
    priceCoins: 25000,
    meta: { color: '#8A2BE2' },
    desc: 'Kullanıcı adınızı RGB mor renge çevirir.'
  },
  {
    id: 'color_rengarenk_yonetici',
    name: 'Rengarenk Yönetici İsim Rengi',
    type: 'name_color',
    purchaseType: 'coins',
    priceCoins: 50000,
    meta: { rainbow: true, specialRoleColor: true },
    desc: 'Kullanıcı adınız rengarenk (animasyonlu/çok renkli) görünür.'
  },

  // Gerçek parayla rol / premium satın alımları (ödeme entegrasyonu gerektirir)
  {
    id: 'premium_75_try',
    name: 'Premium Üyelik (30 gün)',
    type: 'premium',
    purchaseType: 'real',
    price: 75,
    currency: 'TRY',
    meta: { days: 30 },
    desc: '30 gün premium erişim (ödeme: 75 TL).'
  },
  {
    id: 'become_admin_150_try',
    name: 'Admin Ol',
    type: 'role',
    purchaseType: 'real',
    price: 150,
    currency: 'TRY',
    meta: { role: 'admin' },
    desc: 'Hesabınıza "Admin" rolü verilir (ödeme: 150 TL).'
  },
  {
    id: 'become_manager_300_try',
    name: 'Yönetici Ol',
    type: 'role',
    purchaseType: 'real',
    price: 300,
    currency: 'TRY',
    meta: { role: 'manager' },
    desc: 'Hesabınıza "Yönetici" rolü verilir (ödeme: 300 TL).'
  },
  {
    id: 'takeover_server_500_try',
    name: 'Sunucuyu DEVR AL',
    type: 'server_takeover',
    purchaseType: 'real',
    price: 500,
    currency: 'TRY',
    meta: { takeover: true },
    desc: 'Sunucunun kontrolünü devralma teklifi (ödeme: 500 TL).'
  }
];
(function () {
  // ---------------- helpers ----------------
  function sanitizeUsername(u) {
    return (u || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
  }

  async function getUserByUsername(username) {
    if (!window.db) return null;
    const unameLower = sanitizeUsername(username);
    const q = await db.collection('users').where('usernameLower', '==', unameLower).limit(1).get();
    if (q.empty) return null;
    return q.docs[0]; // DocumentSnapshot
  }

  function synthEmailForUsername(username) {
    const clean = sanitizeUsername(username);
    return `${clean}@noemail.lilemir.local`;
  }

  // ---------------- UI yardımcıları ----------------
  function showElement(el) { if (!el) return; el.style.display = ''; }
  function hideElement(el) { if (!el) return; el.style.display = 'none'; }
  function setText(id, text) { const el = document.getElementById(id); if (el) el.textContent = text; }

  // ---------------- login logic ----------------
  async function loginWithUsername(username, password, opts = {}) {
    // opts: { showErrors: true, source: 'market'|'index' }
    const showErrors = opts.showErrors !== false;
    try {
      if (!username || !password) throw new Error('Kullanıcı adı ve şifre girin.');

      const userDocSnap = await getUserByUsername(username);
      if (!userDocSnap) {
        throw new Error('Kullanıcı bulunamadı. Kullanıcı adınızı kontrol edin veya kayıt olun.');
      }
      const userData = userDocSnap.data();
      // Eğer users dokümanında gerçek email varsa onu kullan; yoksa synth email ile giriş dene
      const emailToUse = userData.email || userData.registeredEmail || synthEmailForUsername(username);

      await auth.signInWithEmailAndPassword(emailToUse, password);
      // onAuthStateChanged tarafından UI güncellenecek
      return { ok: true };
    } catch (err) {
      if (showErrors) {
        return Promise.reject(err);
      }
      throw err;
    }
  }

  // ---------------- auth state handling ----------------
  // Bu fonksiyon index/market sayfalarında oturum açıldığında UI güncelleme işlerini yapar.
  async function handleUserSignedIn(user) {
    if (!user) return;
    try {
      const uid = user.uid;
      const snap = await db.collection('users').doc(uid).get();
      const data = snap.exists ? snap.data() : {};

      // Genel UI alanları (varsa)
      setText('displayName', data.displayName || data.username || user.displayName || 'Kullanıcı');
      setText('meName', data.displayName || data.username || user.displayName || 'Kullanıcı');
      setText('myCoins', (typeof data.coins === 'number') ? data.coins : (typeof data.coins === 'string' ? data.coins : 0));
      const bal = (typeof data.balance === 'number') ? data.balance : (typeof data.money === 'number' ? data.money : 0);
      setText('myBalance', bal);

      // authView / mainContent görünürlüğü (index.html için)
      const authView = document.getElementById('authView');
      const mainContent = document.getElementById('mainContent');
      if (authView && mainContent) {
        hideElement(authView);
        showElement(mainContent);
      }

      // Market login modal varsa kapat
      const loginModal = document.getElementById('loginModal');
      if (loginModal) hideElement(loginModal);

      // Profil çerçevesi / premium badge gibi anlık UI güncellemeleri
      if (data.myFrame && document.getElementById('avatarFrame')) {
        const af = document.getElementById('avatarFrame');
        af.src = data.myFrame;
        af.style.display = '';
      }
      if (data.isPremium && document.getElementById('profilePremiumBadge')) {
        document.getElementById('profilePremiumBadge').style.display = '';
      }
      // Chat listener veya diğer şeyleri burada başlatabilirsiniz (eğer script.js farklıysa kontrol edin)
      if (typeof window.startChatListener === 'function') {
        try { window.startChatListener(); } catch (e) { /* ignore */ }
      }
    } catch (err) {
      console.error('handleUserSignedIn hata', err);
    }
  }

  function handleUserSignedOut() {
    // index.html görünüm yönetimi
    const authView = document.getElementById('authView');
    const mainContent = document.getElementById('mainContent');
    if (authView && mainContent) {
      showElement(authView);
      hideElement(mainContent);
    }
    // market modal'ı göster (kullanıcının markete girince tekrar login olmasını istemiştiniz)
    const loginModal = document.getElementById('loginModal');
    if (loginModal) showElement(loginModal);

    // Temiz UI alanları
    setText('displayName', 'Yükleniyor...');
    setText('meName', 'Giriş yok');
    setText('myCoins', 0);
    setText('myBalance', 0);

    if (typeof window.stopChatListener === 'function') {
      try { window.stopChatListener(); } catch (e) {}
    }
  }

  // ---------------- attach handlers to DOM elements ----------------
  function attachHandlers() {
    // index.html authForm (kullanıcı adı ile giriş)
    const authForm = document.getElementById('authForm');
    if (authForm) {
      // remove any existing handler to avoid duplicates
      authForm.onsubmit = async (e) => {
        e.preventDefault();
        const username = (document.getElementById('authUsername') || {}).value || '';
        const password = (document.getElementById('authPassword') || {}).value || '';
        const authMessage = document.getElementById('authMessage');
        if (authMessage) { authMessage.style.display = 'none'; authMessage.textContent = ''; }
        try {
          await loginWithUsername(username, password, { showErrors: true, source: 'index' });
          // success handled by onAuthStateChanged
        } catch (err) {
          if (authMessage) {
            authMessage.style.display = '';
            authMessage.textContent = err.message || 'Giriş başarısız';
          } else {
            alert(err.message || 'Giriş başarısız');
          }
        }
      };
    }

    // market.html modal login
    const loginBtn = document.getElementById('loginBtn');
    if (loginBtn) {
      loginBtn.onclick = async () => {
        const username = (document.getElementById('loginUsername') || {}).value || '';
        const password = (document.getElementById('loginPassword') || {}).value || '';
        const loginError = document.getElementById('loginError');
        if (loginError) { loginError.style.display = 'none'; loginError.textContent = ''; }
        try {
          loginBtn.disabled = true;
          await loginWithUsername(username, password, { showErrors: true, source: 'market' });
          // success -> onAuthStateChanged will fire
        } catch (err) {
          if (loginError) {
            loginError.style.display = '';
            loginError.textContent = err.message || 'Giriş başarısız';
          } else {
            alert(err.message || 'Giriş başarısız');
          }
        } finally {
          loginBtn.disabled = false;
        }
      };
    }

    // market.html: modal close if exists (allow closing only if user is logged in)
    const loginModalClose = document.querySelector('#loginModal .login-actions .btn-secondary');
    if (loginModalClose) {
      loginModalClose.onclick = () => {
        const lmodal = document.getElementById('loginModal');
        if (lmodal) hideElement(lmodal);
      };
    }
  }

  // ---------------- setup auth state listener ----------------
  if (window && window.auth) {
    auth.onAuthStateChanged(async (user) => {
      if (user) {
        await handleUserSignedIn(user);
      } else {
        handleUserSignedOut();
      }
    });
  } else {
    console.warn('auth-fix: window.auth bulunamadı. Bu dosyayı firebase auth init edildikten sonra include edin.');
  }

  // Attach handlers on DOM ready (defer recommended)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', attachHandlers);
  } else {
    attachHandlers();
  }

  // Export helpers for other scripts if needed
  window.authFix = {
    loginWithUsername,
    getUserByUsername,
    sanitizeUsername,
    synthEmailForUsername,
    handleUserSignedIn,
    handleUserSignedOut
  };
})();
// REPLACE mevcut loginBtn handler ile veya ekle (firebase init'ten sonra).
// Bu fonksiyon username-only login için daha sağlam hata mesajı ve log verir.

(function(){
  // helper (aynı fonksiyonlar varsa çakışma olabilir; uyarlayın)
  function sanitizeUsername(u) {
    return (u || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
  }
  function synthEmailForUsername(username) {
    const clean = sanitizeUsername(username);
    return `${clean}@noemail.lilemir.local`;
  }
  async function getUserByUsername(username) {
    if (!window.db) throw new Error('Firestore (db) bulunamadı.');
    const unameLower = sanitizeUsername(username);
    const q = await db.collection('users').where('usernameLower', '==', unameLower).limit(1).get();
    if (q.empty) return null;
    return q.docs[0]; // DocumentSnapshot
  }

  // DOM elemanları (market.html içindeki id'ler)
  const loginBtn = document.getElementById('loginBtn');
  const loginUsername = document.getElementById('loginUsername');
  const loginPassword = document.getElementById('loginPassword');
  const loginError = document.getElementById('loginError');

  if (!loginBtn) {
    console.warn('fix_login_handler: loginBtn bulunamadı (market.html id uyuşuyor mu?).');
    return;
  }

  loginBtn.addEventListener('click', async () => {
    const username = (loginUsername.value || '').trim();
    const password = loginPassword.value || '';
    loginError.style.display = 'none';
    loginError.textContent = '';

    if (!username || !password) {
      loginError.style.display = '';
      loginError.textContent = 'Kullanıcı adı ve şifre girin.';
      return;
    }

    loginBtn.disabled = true;
    try {
      // 1) users koleksiyonunda usernameLower ile ara
      const userDocSnap = await getUserByUsername(username);
      if (!userDocSnap) {
        // açık, kullanıcı yok
        const msg = 'Kullanıcı bulunamadı. Kullanıcı adınızı kontrol edin veya kayıt olun.';
        loginError.style.display = '';
        loginError.textContent = msg;
        console.warn('Login failed: no userDoc for username=', username);
        return;
      }

      const userData = userDocSnap.data();
      // 2) hangi e-posta ile auth yapılacak?
      const emailToUse = userData.email || userData.authEmail || synthEmailForUsername(username);
      // Log: hangi email ile denendiğini görmek için konsola yaz
      console.log('Attempting signInWithEmailAndPassword for username=', username, 'using email=', emailToUse);

      // 3) Firebase Auth ile deneme
      await auth.signInWithEmailAndPassword(emailToUse, password);

      // başarılı olursa onAuthStateChanged tetiklenir ve UI güncellenir
      console.log('Giriş başarılı (username):', username);
    } catch (err) {
      // Hata ayrıntılarını temiz göster ve konsola detay yaz
      console.error('Giriş hatası detay:', err);
      let msg = 'Giriş başarısız.';
      if (err && err.code) {
        // yaygın hatalar
        switch (err.code) {
          case 'auth/wrong-password':
            msg = 'Şifre yanlış.';
            break;
          case 'auth/user-not-found':
            msg = 'Hesap bulunamadı (auth tarafında).';
            break;
          case 'auth/too-many-requests':
            msg = 'Çok fazla başarısız giriş denemesi. Bir süre sonra tekrar deneyin.';
            break;
          case 'auth/invalid-email':
            msg = 'Geçersiz e-posta formatı (internal).';
            break;
          default:
            msg = err.message || msg;
        }
      } else if (err && err.message) {
        msg = err.message;
      }
      loginError.style.display = '';
      loginError.textContent = msg;
    } finally {
      loginBtn.disabled = false;
    }
  });
})();
// Eğer script.js içindeki loadMarketItems/purchaseItem MARKET_ITEMS bekliyorsa bu isimle koymanız yeterli.
// Not: "real" tipindeki ürünleri satın almak için Stripe/PayPal vb. bir ödeme entegrasyonu eklemelisiniz.
// Satın alma sonrası Firestore'da kullanıcıya uygulanacak işlemler (ör. role atama, premiumExpires, coins artışı)
// purchaseItem fonksiyonunda hem purchaseType === 'coins' hem de 'real' durumlarını ele alacak şekilde güncelleme yapın.

/* --------------------- LOGIN (Kullanıcı adı ile) --------------------- */
const authForm = document.getElementById('authForm');
if (authForm) {
  // Kendi handler'ımızı atıyoruz (varsa eski handler'ı geçersiz kılar)
  authForm.onsubmit = async (e) => {
    e.preventDefault();
    const usernameEl = document.getElementById('authUsername') || document.getElementById('authEmail') || null;
    const passEl = document.getElementById('authPassword');
    const authMessage = document.getElementById('authMessage');
    if (authMessage) { authMessage.style.display = 'none'; authMessage.textContent = ''; }

    if (!usernameEl || !passEl) {
      if (authMessage) { authMessage.style.display = ''; authMessage.textContent = 'Giriş alanı bulunamadı.'; }
      return;
    }

    const username = usernameEl.value.trim();
    const password = passEl.value;

    if (!username || !password) {
      if (authMessage) { authMessage.style.display = ''; authMessage.textContent = 'Kullanıcı adı ve şifre gerekli.'; }
      return;
    }

    try {
      // Kullanıcı adıyla DB'den kullanıcıyı bul
      const userDocSnap = await getUserByUsername(username);
      if (!userDocSnap) {
        if (authMessage) { authMessage.style.display = ''; authMessage.textContent = 'Kullanıcı bulunamadı.'; }
        return;
      }
      const userData = userDocSnap.data();
      // users dokümanında kayıtlı email alanını kullan (register sırasında synth email kaydediliyor)
      const emailToUse = userData.email || synthEmailForUsername(username);

      // Giriş denemesi
      await auth.signInWithEmailAndPassword(emailToUse, password);
      // onAuthStateChanged listener'ı UI'ı halleder
    } catch (err) {
      console.error('Login hata:', err);
      if (authMessage) { authMessage.style.display = ''; authMessage.textContent = err.message || 'Giriş başarısız.'; }
    }
  };
}

/* --------------------- REGISTER (Kullanıcı adı + şifre + DAVET KODU ZORUNLU) --------------------- */
const registerForm = document.getElementById('registerForm');
if (registerForm) {
  registerForm.onsubmit = async (e) => {
    e.preventDefault();
    // Beklenen input id'leri: regUsername (veya regDisplayName), regPassword, regInviteCode
    const usernameEl = document.getElementById('regUsername') || document.getElementById('regDisplayName') || null;
    const passEl = document.getElementById('regPassword');
    const inviteEl = document.getElementById('regInviteCode');
    const registerMessage = document.getElementById('registerMessage');
    if (registerMessage) { registerMessage.style.display = 'none'; registerMessage.textContent = ''; }

    if (!usernameEl || !passEl || !inviteEl) {
      if (registerMessage) { registerMessage.style.display = ''; registerMessage.textContent = 'Kayıt formu tam değil.'; }
      return;
    }

    const username = usernameEl.value.trim();
    const password = passEl.value;
    const inviteCode = inviteEl.value.trim();

    if (!username) {
      if (registerMessage) { registerMessage.style.display = ''; registerMessage.textContent = 'Kullanıcı adı gerekli.'; }
      return;
    }
    if (!password || password.length < 6) {
      if (registerMessage) { registerMessage.style.display = ''; registerMessage.textContent = 'Şifre en az 6 karakter olmalı.'; }
      return;
    }
    if (!inviteCode) {
      if (registerMessage) { registerMessage.style.display = ''; registerMessage.textContent = 'Davet kodu zorunludur.'; }
      return;
    }

    try {
      // Davet kodunun geçerli olup olmadığını kontrol et
      const invRef = db.collection('inviteCodes').doc(inviteCode);
      const invSnap = await invRef.get();
      if (!invSnap.exists) {
        if (registerMessage) { registerMessage.style.display = ''; registerMessage.textContent = 'Geçersiz davet kodu.'; }
        return;
      }
      // (Opsiyonel) invite kodunda kullanım limiti varsa kontrol et
      const invData = invSnap.data();
      if (invData && typeof invData.maxUses === 'number' && typeof invData.uses === 'number') {
        if (invData.uses >= invData.maxUses) {
          if (registerMessage) { registerMessage.style.display = ''; registerMessage.textContent = 'Bu davet kodunun kullanımı dolmuş.'; }
          return;
        }
      }

      // Kullanıcı adı benzersiz mi?
      const existing = await getUserByUsername(username);
      if (existing) {
        if (registerMessage) { registerMessage.style.display = ''; registerMessage.textContent = 'Bu kullanıcı adı zaten alınmış.'; }
        return;
      }

      // Auth için synth email oluştur (kullanıcıdan email istenmiyor)
      const emailForAuth = synthEmailForUsername(username);

      // Firebase Auth ile kullanıcı oluştur
      const cred = await auth.createUserWithEmailAndPassword(emailForAuth, password);
      const uid = cred.user.uid;

      // users dokümanını kaydet
      const userDoc = {
        uid,
        username: username,
        usernameLower: sanitizeUsername(username),
        displayName: username,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        inviteCodeUsed: inviteCode,
        email: emailForAuth
      };
      await db.collection('users').doc(uid).set(userDoc);

      // inviteCodes dokümanında uses sayısını arttır
      await invRef.set({
        ...invData,
        uses: firebase.firestore.FieldValue.increment(1),
        lastUsedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      // Kayıt başarılı; onAuthStateChanged ile UI otomatik güncellenecek
    } catch (err) {
      console.error('Register hata:', err);
      if (registerMessage) { registerMessage.style.display = ''; registerMessage.textContent = err.message || 'Kayıt başarısız.'; }
    }
  };
}
// === EK: Sohbet butonuna tıklandığında nokta gizleme ===
document.getElementById('chatActionCard')?.addEventListener('click', () => {
  hideChatNotifDot();
});
  // Keep header avatar in sync whenever the user's doc changes (existing onSnapshot watchers should call updateUI which in turn will call setHeaderAvatar if integrated).
  // But to be safe, listen to meta/user docs change for current logged user and update header avatar
  (async function watchMyAvatar() {
    const u = await getLoggedInUser();
    if (!u || !u.username) return;
    try {
      db.collection('users').doc(u.username).onSnapshot(doc => {
        if (!doc.exists) return;
        const data = doc.data();
        if (data) setHeaderAvatar(data);
      });
    } catch(e){}
  })();

}); // DOMContentLoaded
  // Form submit handler
  if (authForm) {
    authForm.addEventListener('submit', async function(ev){
      ev.preventDefault();
      if (!authSubmitBtn || !authMessage) return;

      // NOTE: We still accept username/password only here.
      // If you want to use Firebase email auth, set window.ENABLE_FIREBASE_AUTH = true before this script runs.
      // For username-only flow we will map username -> synthetic email internally to keep Firebase optional,
      // but by default we prefer the site's legacy hashed-password / Firestore user collection flow.
      const usernameOrEmail = (document.getElementById('authUsername') || {}).value || '';
      const password = (document.getElementById('authPassword') || {}).value || '';

      if (!usernameOrEmail.trim() || !password) {
        authMessage.style.display = 'block';
        authMessage.style.color = '#FF4080';
        authMessage.textContent = 'Lütfen kullanıcı adı ve şifre girin.';
        return;
      }

      // If caller explicitly enabled Firebase email auth and input looks like an email -> use Firebase auth
      const looksLikeEmail = usernameOrEmail.includes('@') && usernameOrEmail.indexOf(' ') === -1;
      if (window.ENABLE_FIREBASE_AUTH && looksLikeEmail) {
        authSubmitBtn.disabled = true;
        authMessage.style.display = 'none';
        try {
          if (mode === 'register') {
            const userCred = await firebase.auth().createUserWithEmailAndPassword(usernameOrEmail, password);
            const user = userCred.user;
            try {
              const displayName = (usernameOrEmail.split('@')[0]) || usernameOrEmail;
              await user.updateProfile({ displayName });
            } catch (uErr) { console.warn('updateProfile failed', uErr); }
            try {
              await db.collection('users').doc(user.uid).set({
                displayName: user.displayName || '',
                email: user.email || '',
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
              });
            } catch (dbErr) { console.warn('Failed to create user document:', dbErr); }
            authMessage.style.display = 'block';
            authMessage.style.color = '#00FF8C';
            authMessage.textContent = 'Kayıt başarılı — yönlendiriliyorsunuz...';
            setTimeout(()=> location.reload(), 800);
          } else {
            await firebase.auth().signInWithEmailAndPassword(usernameOrEmail, password);
            authMessage.style.display = 'block';
            authMessage.style.color = '#00FF8C';
            authMessage.textContent = 'Giriş başarılı — yönlendiriliyorsunuz...';
            setTimeout(()=> location.reload(), 600);
          }
        } catch (err) {
          console.error('Auth error', err);
          authMessage.style.display = 'block';
          authMessage.style.color = '#FFB4C6';
          if (err && err.code) {
            switch(err.code) {
              case 'auth/email-already-in-use':
                authMessage.textContent = 'Bu e-posta zaten kayıtlı. Giriş yapmayı deneyin.';
                break;
              case 'auth/invalid-email':
                authMessage.textContent = 'Geçersiz e-posta adresi.';
                break;
              case 'auth/weak-password':
                authMessage.textContent = 'Şifre çok zayıf. En az 6 karakter girin.';
                break;
              case 'auth/wrong-password':
                authMessage.textContent = 'Hatalı şifre.';
                break;
              case 'auth/user-not-found':
                authMessage.textContent = 'Kullanıcı bulunamadı. Önce kayıt olun.';
                break;
              default:
                authMessage.textContent = err.message || 'Bir hata oluştu. Tekrar deneyin.';
            }
          } else {
            authMessage.textContent = 'Bir hata oluştu. Tekrar deneyin.';
          }
        } finally {
          authSubmitBtn.disabled = false;
        }
        return;
      }

      // Otherwise: username-only flow using Firestore users collection + local hashed password
      authSubmitBtn.disabled = true;
      try {
        // normalize username (keep as-is; site expects lowercase usernames)
        const username = usernameOrEmail.trim().toLowerCase();

        // If register mode
        if (mode === 'register') {
          const userDoc = await db.collection('users').doc(username).get();
          if (userDoc.exists) {
            authMessage.style.display = 'block';
            authMessage.textContent = 'Kullanıcı adı zaten alınmış.';
            return;
          }
          const hashedPass = await hashPassword(password);
          const newUser = {
            username,
            hashedPassword: hashedPass,
            balance: 0,
            clicks: 0,
            dailyClicks: 0,
            dailyEarnings: 0,
            dailyDate: todayDateKey(),
            premium: false,
            isBanned: false,
            isChatBanned: false,
            role: 'user',
            appliedCoupon: '',
            appliedCouponPercent: 0,
            withdrawalRequests: [],
            betRequests: [],
            activeCoupon: null,
            profileName: username,
            profileColor: '#FFD400',
            flashyName: '',
            flashyColor: '',
            flashyAnimated: false,
            lastSeen: Date.now()
          };
          await saveUser(username, newUser);
          setLoggedInUser({ username });
          await loadUser();
          return;
        }

        // Login mode
        const userDoc = await db.collection('users').doc(username).get();
        if (!userDoc.exists) {
          authMessage.style.display = 'block';
          authMessage.textContent = 'Kullanıcı bulunamadı. Önce kayıt olun.';
          return;
        }
        const stored = userDoc.data() || {};
        const hashedPass = await hashPassword(password);
        if (stored.hashedPassword !== hashedPass) {
          authMessage.style.display = 'block';
          authMessage.textContent = 'Yanlış kullanıcı adı veya şifre.';
          return;
        }
        setLoggedInUser({ username });
        await loadUser();
      } catch (err) {
        console.error('Legacy auth error', err);
        authMessage.style.display = 'block';
        authMessage.textContent = 'Giriş/Kayıt sırasında hata oluştu.';
      } finally {
        authSubmitBtn.disabled = false;
      }
    });
  }
// Node.js script - Admin SDK ile çalıştır.
// Çalıştırmak için: node migrate_usernameLower_node.js
// Önce firebase-admin initialization yapmalısın (service account JSON).
/* Kullanıcının nameColor alanına göre stil ve sınıf döndüren helper fonksiyon */
function getStyledUsernameHtml(username, colorCode) {
    let style = '';
    let classList = 'username-glow'; // Tüm renkli isimlere genel parlama ekle

    if (colorCode) {
        const lowerColor = colorCode.toLowerCase();
        
        if (lowerColor === 'rainbow') {
            classList = 'username-rainbow';
            style = ''; // Rainbow için stil inline değil, sadece class yeterli
        } else if (lowerColor === 'chromatic_black') {
            classList = 'username-chromatic-black';
            style = ''; // Chromatic Black için stil inline değil, sadece class yeterli
        } else {
            // Hex kodlu renkler için (örn: #8B0000, #00FF00)
            style = `color: ${colorCode};`;
        }
    } else {
        // Renk yoksa parlama sınıfı ekleme
        classList = ''; 
    }

    // `<span>` etiketi ile kullanıcı adını sarar
    return `<span class="${classList}" style="${style}">${username}</span>`;
}
// Örnek: coin ile alınan bir renk
if (product.type === 'coin_buy') {
  if (currentCoins < product.price) throw "Yetersiz Coin!";
  transaction.update(userRef, {
    coins: currentCoins - product.price,
    nameColor: product.meta.color, // İşte önemli satır
    inventory: firebase.firestore.FieldValue.arrayUnion(product.id)
  });
}
// Menüye "Rank Sıralaması" ekleyen ve leaderboard modalını açıp tiplere göre render eden küçük eklenti.
// Bu dosyayı index.html'den sonra veya script.js'ten sonra include edin (defer/DOMContentLoaded ile güvenli çalışır).

(function(){
  // Güvenli DOM hazır olunca çalıştır
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(() => {
    try {
      // 1) SideMenu içine yeni bir link ekle (eğer zaten yoksa)
      const sideMenu = document.getElementById('sideMenu');
      if (sideMenu) {
        // ensure container for content exists
        const content = sideMenu.querySelector('.side-menu-content') || sideMenu;
        if (content && !document.getElementById('menuRankBtn')) {
          const a = document.createElement('a');
          a.href = '#';
          a.id = 'menuRankBtn';
          a.className = 'menu-link';
          a.innerHTML = `<i class="fa-solid fa-ranking-star"></i> Rank Sıralaması`;
          a.addEventListener('click', (e) => {
            e.preventDefault();
            // close side menu for nicer UX, if toggle exists
            try { toggleSideMenu(); } catch(e){}
            if (typeof window.openLeaderboard === 'function') {
              window.openLeaderboard('rank');
            } else {
              // fallback: open modal and call renderFameLeaderboard if available
              const lb = document.getElementById('leaderboardModal');
              if (lb) lb.style.display = 'flex';
              if (typeof renderFameLeaderboard === 'function') renderFameLeaderboard();
            }
          });
          // insert after fame/menuFameBtn if present, otherwise append
          const fameBtn = document.getElementById('menuFameBtn');
          if (fameBtn && fameBtn.parentElement) fameBtn.parentElement.insertBefore(a, fameBtn.nextSibling);
          else content.appendChild(a);
        }
      }

      // 2) Açma fonksiyonu: openLeaderboard(type)
      window.openLeaderboard = function(type) {
        try {
          const modal = document.getElementById('leaderboardModal');
          if (!modal) return;
          modal.style.display = 'flex';
          // set title and active button styles
          const titleEl = modal.querySelector('h3') || modal.querySelector('.modal-box h3');
          const subtitle = modal.querySelector('div[style*="Yılbaşı temalı arka plan"]') || null;
          if (titleEl) {
            if (type === 'activity') titleEl.textContent = '🎄 Haftalık Sıralamalar - Aktiflik';
            else if (type === 'fame') titleEl.textContent = '🎄 Haftalık Sıralamalar - Şöhret';
            else titleEl.textContent = '🎄 Rank Sıralaması';
          }
          // highlight selected button in modal
          try {
            const btnA = document.getElementById('lbActiveBtn');
            const btnF = document.getElementById('lbFameBtn');
            if (btnA) btnA.classList.toggle('active', type === 'activity');
            if (btnF) btnF.classList.toggle('active', type === 'fame');
          } catch(e){}

          // call appropriate renderer
          if (type === 'activity' && typeof renderActivityLeaderboard === 'function') {
            renderActivityLeaderboard();
          } else if (type === 'fame' && typeof renderFameLeaderboard === 'function') {
            renderFameLeaderboard();
          } else {
            // rank: sort by balance (desc) and show ranks (with current user highlighted)
            renderRankLeaderboard();
          }
        } catch (e) {
          console.warn('openLeaderboard error', e);
        }
      };

      // lbCloseBtn hooking (if not already)
      const lbClose = document.getElementById('lbCloseBtn');
      if (lbClose) lbClose.addEventListener('click', () => {
        const m = document.getElementById('leaderboardModal');
        if (m) m.style.display = 'none';
      });

      // Ensure modal buttons open correct types
      const lbActiveBtn = document.getElementById('lbActiveBtn');
      if (lbActiveBtn) lbActiveBtn.addEventListener('click', () => window.openLeaderboard('activity'));
      const lbFameBtn = document.getElementById('lbFameBtn');
      if (lbFameBtn) lbFameBtn.addEventListener('click', () => window.openLeaderboard('fame'));

      // 3) renderRankLeaderboard implementation
      async function renderRankLeaderboard() {
        const cont = document.getElementById('lbContent');
        if (!cont) return;
        try {
          // getUsers() is defined in script.js; fall back to simple fetch if not
          let usersArr = [];
          if (typeof getUsers === 'function') {
            const usersMap = await getUsers();
            usersArr = Object.values(usersMap || {});
          } else if (window.db) {
            const snap = await db.collection('users').get();
            snap.forEach(d => usersArr.push(d.data()));
          } else {
            cont.innerHTML = '<div style="color:var(--text-muted)">Sıralama verisi alınamıyor.</div>';
            return;
          }

          usersArr.sort((a,b) => (b.balance || 0) - (a.balance || 0));
          const top = usersArr.slice(0, 50);
          const me = await (typeof getLoggedInUser === 'function' ? getLoggedInUser() : Promise.resolve(null));
          let html = `<div style="margin-top:8px;">`;
          if (top.length === 0) {
            html += '<div style="color:var(--text-muted)">Henüz kullanıcı yok.</div>';
          } else {
            html += '<ol style="padding-left:18px; margin:0;">';
            top.forEach((u, i) => {
              const place = i + 1;
              const medal = place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : '';
              const displayName = (u.flashyName && u.flashyName.length) ? u.flashyName : (u.profileName || u.username || 'Anon');
              const isMe = me && u.username && me.username && (u.username === me.username);
              html += `<li style="margin-bottom:10px; padding:8px; border-radius:8px; ${isMe ? 'background:linear-gradient(90deg,#00121a,#00222f); box-shadow:0 6px 18px rgba(0,0,0,0.6);' : 'background:transparent'}">
                        <div style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
                          <div style="display:flex; align-items:center; gap:10px;">
                            <div style="width:44px;height:44px;border-radius:8px;display:flex;align-items:center;justify-content:center;font-weight:800;color:var(--text-high);background:rgba(255,255,255,0.02)">${escapeHtml((displayName||'').slice(0,2).toUpperCase())}</div>
                            <div>
                              <div style="font-weight:800;">${escapeHtml(displayName)} ${medal}</div>
                              <div style="font-size:0.85rem;color:var(--text-muted)">${escapeHtml(u.username || '')}</div>
                            </div>
                          </div>
                          <div style="text-align:right;">
                            <div style="font-weight:900; color:var(--accent-success)">${formatMoney(u.balance||0)}</div>
                            <div style="font-size:0.85rem; color:var(--text-muted)">#${place}</div>
                          </div>
                        </div>
                      </li>`;
            });
            html += '</ol>';
          }
          html += '</div>';
          // show current user rank if not in top
          if (me && me.username) {
            const allIndex = usersArr.findIndex(u => u.username === me.username);
            if (allIndex >= 0 && allIndex >= 50) {
              const rank = allIndex + 1;
              html += `<div style="margin-top:12px; padding:12px; border-radius:10px; background:linear-gradient(90deg,#071428,#0b2236);">
                         <div style="font-size:0.95rem; color:var(--text-muted)">Sizin sıralamanız</div>
                         <div style="display:flex; justify-content:space-between; align-items:center; margin-top:8px;">
                           <div style="font-weight:800;">${escapeHtml(me.profileName || me.username)}</div>
                           <div style="font-weight:900; color:var(--accent-success)">${formatMoney(me.balance||0)} • #${rank}</div>
                         </div>
                       </div>`;
            }
          }
          cont.innerHTML = html;
        } catch (e) {
          console.error('renderRankLeaderboard error', e);
          const cont = document.getElementById('lbContent');
          if (cont) cont.innerHTML = '<div style="color:var(--text-muted)">Sıralama yüklenemedi.</div>';
        }
      } // renderRankLeaderboard

      // small helpers used above (if not globally available, define minimal ones)
      function formatMoney(n){ return '$' + Number(n || 0).toFixed(2); }
      function escapeHtml(s) {
        if (s === null || typeof s === 'undefined') return '';
        return String(s).replace(/[&<>"'`=\/]/g, function (c) {
          return {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
            '/': '&#x2F;',
            '=': '&#x3D;',
            '`': '&#x60;'
          }[c];
        });
      }

    } catch (err) {
      console.warn('menu-rank init error', err);
    }
  });
})();
// ... Sohbet render kodunun olduğu yerde:
const userColor = u.nameColor || u.profileColor || u.flashyColor || '#00A3FF';
const nameStyle = `color:${userColor}; font-weight:800;`;
// ...

div.innerHTML = `<span class="username" style="${nameStyle}">${escapeHtml(displayName)}:</span> ${escapeHtml(text)}`;
// Yeni kodunuzda:
function renderChatMessage(msgData) {
    const user = msgData.user; // Firestore'dan çekilen kullanıcı verileri
    const username = user.username;
    const nameColor = user.nameColor; // Kullanıcının renk kodunu al
    
    // Yeni helper fonksiyonunu kullanarak parlak ismi oluştur
    const styledName = getStyledUsernameHtml(username, nameColor);

    // ...
    // Ekrana basarken stil uygulanmış değişkeni kullan
    const messageHTML = `<div>${styledName}: ${msgData.text}</div>`; 
    // ...
}
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); // path to your service account

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function migrate() {
  const usersRef = db.collection('users');
  const snapshot = await usersRef.get();
  console.log('Users to process:', snapshot.size);
  let count = 0;
  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (!data.usernameLower && data.username) {
      const usernameLower = data.username.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
      await doc.ref.update({ usernameLower });
      count++;
      console.log('Updated', doc.id, '->', usernameLower);
    } else if (!data.usernameLower && data.displayName) {
      const usernameLower = data.displayName.trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, '');
      await doc.ref.update({ usernameLower });
      count++;
      console.log('Updated from displayName', doc.id, '->', usernameLower);
    }
  }
  console.log('Migration done. updated count:', count);
}
// --- START: Coupon admin overlay helper (paste into script.js inside the same IIFE) ---
// Adds a full-screen, animated, closable overlay using admin message from settings.
// Safe: uses existing getSettings() and showAnnouncementAnimation / showToast helpers if present.

async function showCouponAdminOverlay(title, message, opts = {}) {
  try {
    // If already present, just update content and re-show
    let existing = document.getElementById('couponAdminOverlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'couponAdminOverlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.zIndex = '12000';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.background = 'rgba(2,6,12,0.88)';
    overlay.style.backdropFilter = 'blur(6px)';
    overlay.style.webkitBackdropFilter = 'blur(6px)';
    overlay.style.opacity = '0';
    overlay.style.transition = 'opacity .28s ease, transform .36s cubic-bezier(.2,.9,.25,1)';
    overlay.style.transform = 'translateY(8px)';
    overlay.style.padding = '22px';

    const box = document.createElement('div');
    box.className = 'coupon-admin-box';
    box.style.maxWidth = '960px';
    box.style.width = 'min(96%, 900px)';
    box.style.borderRadius = '14px';
    box.style.padding = '22px';
    box.style.boxSizing = 'border-box';
    box.style.background = 'linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01))';
    box.style.border = '1px solid rgba(255,255,255,0.04)';
    box.style.boxShadow = '0 30px 90px rgba(0,0,0,0.65)';
    box.style.color = '#fff';
    box.style.position = 'relative';
    box.style.overflow = 'hidden';
    box.style.transform = 'translateY(10px)';
    box.style.transition = 'transform .34s cubic-bezier(.2,.9,.25,1), opacity .28s ease';

    // header area
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.alignItems = 'center';
    header.style.justifyContent = 'space-between';
    header.style.gap = '12px';

    const left = document.createElement('div');
    left.style.display = 'flex';
    left.style.alignItems = 'center';
    left.style.gap = '12px';

    const sigil = document.createElement('div');
    sigil.textContent = '🔔';
    sigil.style.width = '56px';
    sigil.style.height = '56px';
    sigil.style.borderRadius = '12px';
    sigil.style.display = 'inline-flex';
    sigil.style.alignItems = 'center';
    sigil.style.justifyContent = 'center';
    sigil.style.fontSize = '28px';
    sigil.style.fontWeight = '900';
    sigil.style.background = 'linear-gradient(135deg,#00D4FF,#00FF8C)';
    sigil.style.color = '#021122';
    sigil.style.flexShrink = '0';
    sigil.style.border = '1px solid rgba(255,255,255,0.06)';

    const titleEl = document.createElement('div');
    titleEl.innerHTML = `<div style="font-size:1.2rem; font-weight:900; line-height:1;">${escapeHtml(title || 'Bilgi')}</div>
                         <div style="font-size:0.9rem; color:rgba(255,255,255,0.88); margin-top:6px;">${escapeHtml(opts.sub || '')}</div>`;
    left.appendChild(sigil);
    left.appendChild(titleEl);

    const actions = document.createElement('div');
    actions.style.display = 'flex';
    actions.style.gap = '8px';
    actions.style.alignItems = 'center';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'coupon-admin-close';
    closeBtn.innerHTML = 'Kapat ✕';
    closeBtn.style.padding = '10px 12px';
    closeBtn.style.borderRadius = '10px';
    closeBtn.style.border = 'none';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.background = 'rgba(255,255,255,0.06)';
    closeBtn.style.color = '#fff';
    closeBtn.style.fontWeight = '800';

    actions.appendChild(closeBtn);
    header.appendChild(left);
    header.appendChild(actions);

    const hr = document.createElement('div');
    hr.style.height = '1px';
    hr.style.background = 'rgba(255,255,255,0.03)';
    hr.style.margin = '14px 0';
    hr.style.borderRadius = '2px';

    const body = document.createElement('div');
    body.style.fontSize = '0.98rem';
    body.style.color = 'rgba(255,255,255,0.95)';
    body.style.lineHeight = '1.45';
    body.innerHTML = (message || '').split('\n').map(l => `<div>${escapeHtml(l)}</div>`).join('');

    // optional footer CTA area (if provided)
    const footer = document.createElement('div');
    footer.style.display = 'flex';
    footer.style.justifyContent = 'flex-end';
    footer.style.marginTop = '18px';
    if (opts.ctaText && opts.ctaHref) {
      const cta = document.createElement('a');
      cta.href = opts.ctaHref;
      cta.textContent = opts.ctaText;
      cta.style.padding = '10px 14px';
      cta.style.borderRadius = '10px';
      cta.style.background = 'linear-gradient(90deg,#00D4FF,#00FF8C)';
      cta.style.color = '#021122';
      cta.style.fontWeight = '900';
      cta.style.textDecoration = 'none';
      footer.appendChild(cta);
    }

    box.appendChild(header);
    box.appendChild(hr);
    box.appendChild(body);
    box.appendChild(footer);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // show animation (microtask)
    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      overlay.style.transform = 'translateY(0)';
      box.style.transform = 'translateY(0)';
      box.style.opacity = '1';
    });

    // close handler
    const doClose = () => {
      overlay.style.opacity = '0';
      overlay.style.transform = 'translateY(6px)';
      box.style.transform = 'translateY(10px)';
      setTimeout(() => {
        try { overlay.remove(); } catch(e){}
      }, 340);
    };
    closeBtn.addEventListener('click', doClose);

    // optional: clicking outside the box closes unless sticky true
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay && !opts.sticky) doClose();
    });

    // focus management
    closeBtn.focus();
  } catch (e) {
    console.warn('showCouponAdminOverlay error', e);
  }
}

// Hook into applyCoupon success: call this function when coupon applied.
// Find the applyCoupon() function in your script.js and after successful application (where you call showToast('Kupon başarıyla uygulandı.', true); )
// add the following two lines (exactly):
//    const _s = await getSettings();
//    if (_s && _s.couponOverlay && _s.couponOverlay.enabled) await showCouponAdminOverlay(_s.couponOverlay.title, _s.couponOverlay.message, { sticky: !!_s.couponOverlay.sticky, ctaText: _s.couponOverlay.ctaText, ctaHref: _s.couponOverlay.ctaHref });
// --- END: Coupon admin overlay helper ---
// market.html'deki kritik satır:
function sanitizeUsername(u) { return (u || '').trim().toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_-]/g, ''); }
migrate().catch(console.error);
// Replace the existing handleWithdrawInternal function inside initApp with this updated implementation.
// (Search for "async function handleWithdrawInternal()" in script.js and replace the function body.)
async function handleWithdrawInternal() {
  if (!user) { showToast('Giriş yapın', false); return; }

  // Refresh settings & min
  const s = await getSettings();
  const min = s.minWithdrawalAmount || DEFAULT_MIN_WITHDRAWAL;

  // Read requested amount from the new input field
  const amountInputEl = document.getElementById('withdrawAmountInput');
  let requestedAmount = null;
  if (amountInputEl && amountInputEl.value !== '') {
    requestedAmount = parseFloat(String(amountInputEl.value).replace(',', '.'));
  }

  // If the input is empty, inform user to enter an amount
  if (requestedAmount === null || !isFinite(requestedAmount)) {
    showToast(`Lütfen çekmek istediğiniz tutarı girin (Min ${formatMoney(min)}).`, false);
    return;
  }

  // Round to 2 decimals
  requestedAmount = Math.round(requestedAmount * 100) / 100;

  // Basic validations
  if (requestedAmount < min) {
    showToast(`Minimum çekim tutarı ${formatMoney(min)} olmalıdır.`, false);
    return;
  }
  if (requestedAmount > (user.balance || 0)) {
    showToast('Çekilecek tutar bakiyenizden fazla olamaz.', false);
    return;
  }
  if (requestedAmount <= 0) {
    showToast('Geçerli bir tutar girin.', false);
    return;
  }

  // Check server state
  if ((await getSettings()).server && (await getSettings()).server.closed) {
    showToast('Sunucu kapalı — çekimler devre dışı.', false);
    return;
  }

  // Validate personal & IBAN fields as before
  const first = (document.getElementById('firstname') || {}).value.trim();
  const last = (document.getElementById('lastname') || {}).value.trim();
  const bank = (document.getElementById('bankSelect') || {}).value;
  const ibanRaw = (document.getElementById('ibanInput') || {}).value;
  const iban = normalizeIban(ibanRaw);

  if (!first || !last || !bank || !validateIban(iban)) {
    showToast('Tüm çekim bilgileri zorunlu ve IBAN geçerli olmalı.', false);
    return;
  }

  // Determine coupon bonus percent for this withdraw
  let couponBonusPercent = 0;
  if (user.appliedCoupon && typeof user.appliedCouponPercent === 'number' && user.appliedCouponPercent > 0) {
    couponBonusPercent = user.appliedCouponPercent;
  } else if (user.appliedCoupon) {
    const cp = await findCoupon(user.appliedCoupon);
    if (cp && cp.type === 'balance') couponBonusPercent = cp.percent || 0;
  }

  // Create request using the requested amount (NOT the entire balance)
  const id = generateId('req_');
  const req = {
    id,
    username: user.username,
    amount: requestedAmount,
    originalBalanceAtRequest: user.balance,
    bank,
    iban,
    firstName: first,
    lastName: last,
    createdAt: new Date().toISOString(),
    status: 'pending',
    couponApplied: user.appliedCoupon || '',
    couponBonusPercent: couponBonusPercent
  };

  // Deduct requested amount from user's balance (preserve remaining balance)
  user.withdrawalRequests = user.withdrawalRequests || [];
  user.withdrawalRequests.push(req);
  user.balance = Math.max(0, Number(user.balance) - Number(requestedAmount));

  // Clear applied coupon after withdraw so it isn't reused accidentally
  user.appliedCoupon = '';
  user.appliedCouponPercent = 0;

  // Persist
  await saveUser(user.username, user);

  // Show success overlay/details (similar to previous behavior)
  const successOverlay = document.getElementById('successOverlay');
  const successDetails = document.getElementById('successDetails');
  if (successDetails) {
    successDetails.innerHTML = `ID: ${id}<br>Kullanıcı: ${user.username}<br>Tutar: ${formatMoney(requestedAmount)}${couponBonusPercent>0?` (+${couponBonusPercent}% kupon)`:''}<br>Banka: ${bank}<br>IBAN: ${prettyIban(iban)}<br>Tarih: ${new Date().toLocaleString()}`;
  }
  if (successOverlay) successOverlay.style.display = 'flex';

  // Update UI and any dependent state
  await updateUI();
}

(function(){
  // Config
  const STORAGE_PREFIX = 'shown_maintenance_warn_';
  const WARN_ID = 'scheduledMaintenanceWarning';
  const SHOW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000; // optional: show if maintenance within 7 days (adjust if needed)

  // Build and show modal
  function showScheduledMaintenanceModal(scheduledTs, infoText) {
    if (document.getElementById(WARN_ID)) return;
    const human = new Date(scheduledTs).toLocaleString();
    const overlay = document.createElement('div');
    overlay.id = WARN_ID;
    overlay.className = 'smw-overlay';
    overlay.innerHTML = `
      <div class="smw-box" role="dialog" aria-live="polite" aria-atomic="true">
        <div class="smw-inner">
          <div class="smw-title">BAKIM YAKLAŞIYOR</div>
          <div class="smw-sub">Planlı bakım zamanı</div>
          <div class="smw-when">${human}</div>
          <div class="smw-msg">${escapeHtml(infoText || 'Sistem için planlı bir bakım yapılacaktır. Lütfen işlemlerinizi buna göre planlayın.')}</div>
          <div class="smw-actions">
            <button id="smwAcknowledge" class="smw-btn">TAMAM, ANLADIM</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const btn = document.getElementById('smwAcknowledge');
    const storageKey = STORAGE_PREFIX + scheduledTs;
    if (btn) {
      btn.addEventListener('click', () => {
        try { localStorage.setItem(storageKey, '1'); } catch (e) {}
        overlay.remove();
      });
    }
  }

  // Escape helper (small)
  function escapeHtml(s) {
    if (s === null || typeof s === 'undefined') return '';
    return String(s).replace(/[&<>"'`=\/]/g, function (c) {
      return {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
        '/': '&#x2F;',
        '=': '&#x3D;',
        '`': '&#x60;'
      }[c];
    });
  }

  // Decide whether to show: scheduledAt must be a future timestamp, optional window check,
  // and must not have been shown before for that exact scheduled timestamp.
  function maybeShowForScheduled(scheduledAt, infoText) {
    if (!scheduledAt) return;
    const ts = Number(scheduledAt);
    if (isNaN(ts) || ts <= Date.now()) return;
    // optional: only show if maintenance is within SHOW_BEFORE_MS
    if (typeof SHOW_BEFORE_MS === 'number' && SHOW_BEFORE_MS > 0) {
      if (ts - Date.now() > SHOW_BEFORE_MS) return;
    }
    const storageKey = STORAGE_PREFIX + ts;
    try {
      if (localStorage.getItem(storageKey)) return; // already shown for this scheduled occurrence
    } catch (e) {
      // ignore storage errors and continue to show once per session
    }
    showScheduledMaintenanceModal(ts, infoText);
  }

  // Watch settings in realtime (if db is available) and run once at startup via getSettings()
  async function initScheduledMaintenanceWatcher() {
    try {
      // initial check from settings getter if available
      if (typeof getSettings === 'function') {
        try {
          const s = await getSettings();
          // prefer server.scheduledAt, fallback to maintenance.scheduledAt
          const scheduled = (s && s.server && s.server.scheduledAt) ? s.server.scheduledAt : (s && s.maintenance && s.maintenance.scheduledAt ? s.maintenance.scheduledAt : null);
          const info = (s && s.server && s.server.reason) ? s.server.reason : (s && s.maintenance && s.maintenance.reason ? s.maintenance.reason : '');
          maybeShowForScheduled(scheduled, info);
        } catch(e){}
      }

      // if Firestore db exists, listen to meta/settings changes to show upcoming one-time notice
      if (typeof db !== 'undefined' && db && db.collection) {
        db.collection('meta').doc('settings').onSnapshot(doc => {
          if (!doc || !doc.exists) return;
          const s = doc.data() || {};
          const scheduled = (s.server && s.server.scheduledAt) ? s.server.scheduledAt : (s.maintenance && s.maintenance.scheduledAt ? s.maintenance.scheduledAt : null);
          const info = (s.server && s.server.reason) ? s.server.reason : (s.maintenance && s.maintenance.reason ? s.maintenance.reason : '');
          maybeShowForScheduled(scheduled, info);
        }, err => {
          // no-op on error
        });
      }
    } catch (e) {
      // ignore initialization errors
      console.warn('scheduled-maint init error', e);
    }
  }

  // Start after DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initScheduledMaintenanceWatcher);
  } else {
    initScheduledMaintenanceWatcher();
  }
  // KUTU - FULL ENTEGRE - Tek Script, UI ile Tam Uyumlu
try {
  // Export helpers expected by features.js (sadece tanımlıysa)
  if (typeof getLoggedInUser === 'function') window.getLoggedInUser = getLoggedInUser;
  if (typeof saveUser === 'function') window.saveUser = saveUser;
  if (typeof getUsers === 'function') window.getUsers = getUsers;
  if (typeof showToast === 'function') window.showToast = showToast;
  if (typeof todayDateKey === 'function') window.todayDateKey = todayDateKey;
  if (typeof generateId === 'function') window.generateId = generateId;
  if (typeof formatMoney === 'function') window.formatMoney = formatMoney;
  if (typeof updateUI === 'function') window.updateUI = updateUI;
} catch (e) {
  console.warn('helper export failed', e);
}

// Eğer kullanıcının yüklenmesi sonrası features yeniden başlatmak istersen,
// loadUser() fonksiyonunda (kullanıcı başarılı yüklendikten sonra) aşağıdaki satırı çağır:
if (typeof window.initFeatures === 'function') {
  try { window.initFeatures(); } catch(e){ /* ignore */ }
}
// Chat mesajı oluşturulurken:
function renderMessage(msg) {
    const isSpotlight = msg.userSpotlight === true; // Kullanıcı o an spotlight'taysa
    return `
    <div class="flex gap-3 items-start ${isSpotlight ? 'border-l-2 border-purple-500 pl-2' : ''}">
        <img src="${msg.avatar}" class="w-8 h-8 rounded-lg cursor-pointer hover:scale-110 transition" 
             onclick="openMiniProfile('${msg.user}')">
        <div>
            <div class="flex items-center gap-2">
                <span class="font-bold text-sm cursor-pointer hover:underline" 
                      onclick="window.location.href='avatar.html?u=${msg.user}'">
                      ${msg.user}
                </span>
                ${msg.title ? `<span class="title-badge">${msg.title}</span>` : ''}
            </div>
            <p class="text-sm opacity-90">${msg.text}</p>
        </div>
    </div>
    `;
}
function getUserBonuses(userData){
  // userData: kullanıcı dokümanı alanları (obj)
  // geri döner: { clickMultiplier, perClickDollar, withdrawBonusPercent, priorityWithdraw }
  if(!userData) return { clickMultiplier: 1, perClickDollar: 0, withdrawBonusPercent: 0, priorityWithdraw:false };
  return {
    clickMultiplier: Number(userData.clickMultiplier) || 1,
    perClickDollar: Number(userData.perClickDollar) || 0,
    withdrawBonusPercent: Number(userData.withdrawBonusPercent) || 0,
    priorityWithdraw: !!userData.priorityWithdraw
  };
}

// Örnek: tıklama ödülü hesaplama
// baseAmount: normalde bu tıklamada verilecek baz miktar ($ veya coin gibi)
function computeClickReward(userData, baseAmount){
  const b = getUserBonuses(userData);
  if(b.perClickDollar && b.perClickDollar > 0){
    // mvp+ tarzı: sabit $/tıklama
    return { amount: Number(b.perClickDollar), type: 'dollar' };
  }
  const amount = Number(baseAmount) * Number(b.clickMultiplier || 1);
  return { amount, type: 'dollar' }; // ya da 'coin' uygulamanıza göre değiştirin
}

// Örnek: çekim bonus uygulanması
// baseWithdraw: talep edilen/hesaplanan çekim miktarı
function computeWithdrawFinal(userData, baseWithdraw){
  const b = getUserBonuses(userData);
  const bonusPercent = Number(b.withdrawBonusPercent || 0);
  const bonusAmount = (Number(baseWithdraw) * bonusPercent) / 100;
  const finalAmount = Number(baseWithdraw) + bonusAmount;
  return { finalAmount, bonusAmount, priority: b.priorityWithdraw };
}

// Kullanım (örnek):
// const reward = computeClickReward(userData, 0.10); // baz 0.10$ ise
// // ödülü ver: userDoc.balance += reward.amount (bunu Firestore transaction ile yapın)
// const withdraw = computeWithdrawFinal(userData, requestedAmount);
// // withdraw.finalAmount ödenecek değer; withdraw.priority true ise öncelik atayın.

})(); // end scheduled-maint IIFE
updateAuthUI();

})();
})();
