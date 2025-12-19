/* features.js (düzeltilmiş)
   Fix: _saveUser uyumu, sendFriendRequest arama/esneklik,
   claimDailyReward persist ve birkaç robustness iyileştirmesi.
   Replace your existing features.js with this file.
*/

(function () {
  if (typeof window === 'undefined') return;

  // ---------- Config ----------
  const LOGGED_KEY = 'bio_logged_in_user_v9';
  const BEHAVIOR_WINDOW_MS = 10000;
  const BEHAVIOR_FAST_CLICK_THRESHOLD = 12;
  const SPIN_COOLDOWN_MS = 6 * 60 * 60 * 1000;
  const GEM_CONVERT_DAILY_LIMIT = 3;

  // ---------- Host helpers (from script.js) or fallbacks ----------
  const host = {
    getLoggedInUser: (typeof window.getLoggedInUser === 'function') ? window.getLoggedInUser : null,
    saveUser: (typeof window.saveUser === 'function') ? window.saveUser : null,
    getUsers: (typeof window.getUsers === 'function') ? window.getUsers : null,
    showToast: (typeof window.showToast === 'function') ? window.showToast : null,
    todayDateKey: (typeof window.todayDateKey === 'function') ? window.todayDateKey : null,
    generateId: (typeof window.generateId === 'function') ? window.generateId : null,
    formatMoney: (typeof window.formatMoney === 'function') ? window.formatMoney : null,
    updateUI: (typeof window.updateUI === 'function') ? window.updateUI : null
  };
  const genId = host.generateId || ((p='id_') => p + Date.now().toString(36) + Math.random().toString(36).slice(2,8));
  const todayKey = host.todayDateKey || (() => new Date().toISOString().slice(0,10));
  const fmtMoney = host.formatMoney || (n => '$' + Number(n||0).toFixed(2));
  const toast = host.showToast || ((m,ok=true,t=3500) => { try { alert(m); } catch(e){} });

  const HAS_DB = (typeof db !== 'undefined' && db);
  const HAS_FIREBASE = (typeof firebase !== 'undefined' && firebase && firebase.firestore);

  // ---------- Small safe wrappers ----------
  async function _getLogged() {
    try {
      if (host.getLoggedInUser) {
        const u = await host.getLoggedInUser();
        if (u) return u;
      }
      // fallback: localStorage username -> users collection doc
      try {
        const username = localStorage.getItem(LOGGED_KEY);
        if (username && HAS_DB) {
          const doc = await db.collection('users').doc(username).get();
          if (doc.exists) {
            const data = doc.data();
            if (!data.username) data.username = username;
            return data;
          }
        }
      } catch(e){}
      // firebase auth fallback
      try {
        if (HAS_FIREBASE && firebase.auth && firebase.auth().currentUser) {
          const au = firebase.auth().currentUser;
          if (au && au.email && HAS_DB) {
            const q = await db.collection('users').where('email','==',au.email).limit(1).get();
            if (!q.empty) return q.docs[0].data();
          }
          // synthetic fallback
          return {
            username: au.uid,
            profileName: au.displayName || (au.email||'').split('@')[0],
            profileColor: '#00A3FF',
            balance: 0, clicks:0, dailyClicks:0
          };
        }
      } catch(e){}
    } catch (e) { console.warn('features._getLogged error', e); }
    return null;
  }

  // Robust _saveUser: detect host.saveUser signature (username,userData) OR accept single-object
  async function _saveUser(u) {
    if (!u) return;
    try {
      if (host.saveUser) {
        // two-arg variant expected in original script.js: saveUser(username, userData)
        if (host.saveUser.length >= 2) {
          return await host.saveUser(u.username, u);
        } else {
          // one-arg variant (some implementations)
          return await host.saveUser(u);
        }
      }
      // fallback: direct firestore write (safe merge)
      if (HAS_DB && u.username) {
        const copy = Object.assign({}, u);
        // remove any large or non-serializable fields if necessary (keep minimal)
        return await db.collection('users').doc(u.username).set(copy, { merge: true });
      }
    } catch (e) {
      console.warn('_saveUser failed', e);
      throw e;
    }
  }

  // ---------- Internal state ----------
  const state = {
    behaviorLocal: { clicks: [] },
    listeners: { dmNotifUnsub: null, userDocUnsub: null, clanChatUnsub: null }
  };

  // ---------- Utility ----------
  function escapeHtml(s) {
    if (s === null || typeof s === 'undefined') return '';
    return String(s).replace(/[&<>"'`=\/]/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','/':'&#x2F;','=':'&#x3D;','`':'&#x60;' }[c];
    });
  }

  // ---------- Behavior analytics (kept minimal) ----------
  function noteClickEvent() {
    try {
      const now = Date.now();
      const arr = state.behaviorLocal.clicks;
      arr.push(now);
      while (arr.length && (now - arr[0]) > BEHAVIOR_WINDOW_MS) arr.shift();
      if (arr.length >= BEHAVIOR_FAST_CLICK_THRESHOLD) {
        reportSuspicious('fast_clicks', { count: arr.length, windowMs: BEHAVIOR_WINDOW_MS }).catch(()=>{});
      }
    } catch (e) { console.warn('noteClickEvent err', e); }
  }
  async function reportSuspicious(type, meta={}) {
    try {
      const u = await _getLogged();
      if (!u || !HAS_DB) return;
      const payload = { user: u.username, type, meta, at: firebase.firestore.FieldValue.serverTimestamp() };
      await db.collection('moderationLogs').add(payload);
      await db.collection('users').doc(u.username).set({ 'behavior.suspiciousEvents': firebase.firestore.FieldValue.increment(1) }, { merge:true });
    } catch (e) { console.warn('reportSuspicious err', e); }
  }

  // ---------- Dynamic cooldown / earn factor ----------
  function computeDynamicCooldown(userObj) {
    const base = (typeof COOLDOWN_MS !== 'undefined') ? COOLDOWN_MS : 1500;
    let multiplier = 1;
    let earnFactor = 1.0;
    try {
      const suspicious = Number((userObj && userObj.behavior && userObj.behavior.suspiciousEvents) || (userObj && userObj.suspiciousEvents) || 0);
      if (suspicious > 0) {
        multiplier += Math.floor(suspicious / 3) * 0.5;
        earnFactor = Math.max(0.05, 1 - (suspicious * 0.12));
      }
      const localClicks = state.behaviorLocal && state.behaviorLocal.clicks ? state.behaviorLocal.clicks.length : 0;
      if (localClicks >= 8) { multiplier += 1.0; earnFactor *= 0.6; }
      if (userObj && userObj.shadowBanned) return { cooldown: base * 8, earnFactor: 0.0 };
      if (userObj && userObj.softBan && userObj.softBan.active) return { cooldown: base * 100, earnFactor: 0.0 };
    } catch(e){ console.warn('computeDynamicCooldown err', e); }
    return { cooldown: Math.max(100, Math.round(base * multiplier)), earnFactor: Math.max(0, earnFactor) };
  }

  window.noteClickEvent = noteClickEvent;
  window.computeDynamicCooldown = computeDynamicCooldown;

  // ---------- Boxes logic (same as before but using _saveUser) ----------
  async function initBoxesLogic() {
    try {
      const openNormalBtn = document.getElementById('openNormalBoxBtn');
      const openBigBtn = document.getElementById('openBigBoxBtn');
      const normalBar = document.getElementById('normalBoxProgressBar');
      const bigBar = document.getElementById('bigBoxProgressBar');
      const normalCount = document.getElementById('normalBoxCount');
      const bigCount = document.getElementById('bigBoxCount');
      if (!openNormalBtn && !openBigBtn) return;

      async function refresh() {
        const u = await _getLogged();
        if (!u) {
          if (normalBar) normalBar.style.width = '0%';
          if (bigBar) bigBar.style.width = '0%';
          if (normalCount) normalCount.textContent = '0';
          if (bigCount) bigCount.textContent = '0';
          if (openNormalBtn) openNormalBtn.disabled = true;
          if (openBigBtn) openBigBtn.disabled = true;
          return;
        }
        const normalThreshold = 400;
        const bigThreshold = 700;
        const clicks = Number(u.dailyClicks || 0);
        if (normalBar) normalBar.style.width = `${Math.min(100,(clicks/normalThreshold)*100)}%`;
        if (bigBar) bigBar.style.width = `${Math.min(100,(clicks/bigThreshold)*100)}%`;
        if (normalCount) normalCount.textContent = `${clicks}/${normalThreshold}`;
        if (bigCount) bigCount.textContent = `${clicks}/${bigThreshold}`;
        if (openNormalBtn) openNormalBtn.disabled = clicks < normalThreshold;
        if (openBigBtn) openBigBtn.disabled = clicks < bigThreshold;
      }

      async function openBox(kind) {
        const u = await _getLogged();
        if (!u) { toast('Önce giriş yapın', false); return; }
        const id = genId('box_');
        let reward = (kind === 'normal') ? (1 + Math.floor(Math.random() * 5)) : (5 + Math.floor(Math.random() * 40));
        const { earnFactor } = computeDynamicCooldown(u);
        const actual = Math.round(reward * earnFactor * 100) / 100;
        u.balance = (u.balance || 0) + actual;
        const deduct = kind === 'normal' ? 400 : 700;
        u.dailyClicks = Math.max(0, (u.dailyClicks || 0) - deduct);
        u.boxes = u.boxes || [];
        u.boxes.push({ id, kind, reward: actual, createdAt: new Date().toISOString() });
        await _saveUser(u);
        toast(`Kutu açıldı: ${fmtMoney(actual)} kazandınız!`, true);
        if (host.updateUI) try { host.updateUI(); } catch(e){}
        await refresh();
      }

      if (openNormalBtn) openNormalBtn.addEventListener('click', () => openBox('normal'));
      if (openBigBtn) openBigBtn.addEventListener('click', () => openBox('big'));
      await refresh();
      setInterval(refresh, 60000);
    } catch(e){ console.warn('initBoxesLogic error', e); }
  }

  // ---------- Friends (improved) ----------
  function ensureFriendsModal() {
    if (document.getElementById('friendsModal')) return;
    const modal = document.createElement('div');
    modal.id = 'friendsModal';
    modal.className = 'overlay-center';
    modal.style.display = 'none';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:560px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3 style="margin:0;">👥 Arkadaşlar</h3>
          <div><button id="friendsClose" class="secondary">Kapat</button></div>
        </div>
        <div style="margin-top:12px; display:flex; gap:12px;">
          <div style="flex:1;">
            <div style="margin-bottom:8px;"><strong>Arkadaş Listesi</strong></div>
            <div id="friendsList" style="max-height:260px; overflow:auto;"></div>
          </div>
          <div style="width:260px;">
            <div style="margin-bottom:8px;"><strong>İstekler</strong></div>
            <div id="friendRequests" style="max-height:120px; overflow:auto; margin-bottom:12px;"></div>
            <div style="margin-bottom:8px;"><strong>Kullanıcı Ekle</strong></div>
            <input id="friendAddInput" placeholder="Kullanıcı adı veya görünür isim" style="width:100%; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.06)" />
            <button id="friendSendBtn" class="qcm-action qcm-small" style="margin-top:8px;">Davet Gönder</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('friendsClose').addEventListener('click', () => modal.style.display = 'none');
    document.getElementById('friendSendBtn').addEventListener('click', async () => {
      const raw = (document.getElementById('friendAddInput').value || '').trim();
      if (!raw) return toast('Kullanıcı adı girin', false);
      await sendFriendRequest(raw);
      document.getElementById('friendAddInput').value = '';
      await renderFriendsModal();
    });
  }

  // Helper: find user doc by possible identifiers (doc id, usernameLower, profileName)
  async function findUserDocByIdentifier(identifier) {
    if (!HAS_DB) return null;
    const id = (identifier || '').toString().trim();
    if (!id) return null;
    // try exact doc id
    try {
      const doc = await db.collection('users').doc(id).get();
      if (doc.exists) return { id: doc.id, data: doc.data() };
    } catch(e){}
    // try usernameLower field
    try {
      const q1 = await db.collection('users').where('usernameLower','==', id.toLowerCase()).limit(1).get();
      if (!q1.empty) return { id: q1.docs[0].id, data: q1.docs[0].data() };
    } catch(e){}
    // try profileName exact match
    try {
      const q2 = await db.collection('users').where('profileName','==', identifier).limit(1).get();
      if (!q2.empty) return { id: q2.docs[0].id, data: q2.docs[0].data() };
    } catch(e){}
    // not found
    return null;
  }

  async function sendFriendRequest(targetIdentifier) {
    if (!HAS_DB) return toast('Sunucu bağlantısı yok', false);
    const me = await _getLogged();
    if (!me) return toast('Önce giriş yapın', false);
    const found = await findUserDocByIdentifier(targetIdentifier);
    if (!found) return toast('Kullanıcı bulunamadı', false);
    const targetUsername = found.id;
    if (me.username === targetUsername) return toast('Kendinize istek gönderemezsiniz', false);
    try {
      // use arrayUnion for safe concurrent writes and ensure friend request recorded both sides
      const meRef = db.collection('users').doc(me.username);
      const tarRef = db.collection('users').doc(targetUsername);
      await meRef.update({
        friendRequestsSent: firebase.firestore.FieldValue.arrayUnion(targetUsername)
      }).catch(async (e) => {
        // if field does not exist, set merge
        await meRef.set({ friendRequestsSent: [targetUsername] }, { merge:true });
      });
      await tarRef.update({
        friendRequestsReceived: firebase.firestore.FieldValue.arrayUnion(me.username)
      }).catch(async (e) => {
        await tarRef.set({ friendRequestsReceived: [me.username] }, { merge:true });
      });
      toast('Davet gönderildi', true);
    } catch(e) {
      console.warn('sendFriendRequest error', e);
      toast(e.message || 'Davet gönderilemedi', false);
    }
  }

  async function acceptFriendRequest(fromUsername) {
    if (!HAS_DB) return toast('Sunucu bağlantısı yok', false);
    const me = await _getLogged(); if (!me) return toast('Önce giriş yapın', false);
    try {
      const meRef = db.collection('users').doc(me.username);
      const fromRef = db.collection('users').doc(fromUsername);
      await meRef.update({
        friendRequestsReceived: firebase.firestore.FieldValue.arrayRemove(fromUsername),
        friends: firebase.firestore.FieldValue.arrayUnion(fromUsername)
      }).catch(async ()=> {
        await meRef.set({ friendRequestsReceived: [], friends: [fromUsername] }, { merge:true });
      });
      await fromRef.update({
        friendRequestsSent: firebase.firestore.FieldValue.arrayRemove(me.username),
        friends: firebase.firestore.FieldValue.arrayUnion(me.username)
      }).catch(async ()=> {
        await fromRef.set({ friendRequestsSent: [], friends: [me.username] }, { merge:true });
      });
      toast('Arkadaş eklendi', true);
      await renderFriendsModal();
    } catch(e){ console.warn(e); toast(e.message || 'İşlem başarısız', false); }
  }

  async function removeFriend(targetUsername) {
    if (!HAS_DB) return toast('Sunucu bağlantısı yok', false);
    const me = await _getLogged(); if (!me) return toast('Önce giriş yapın', false);
    try {
      const meRef = db.collection('users').doc(me.username);
      const otherRef = db.collection('users').doc(targetUsername);
      await meRef.update({ friends: firebase.firestore.FieldValue.arrayRemove(targetUsername) }).catch(()=>{});
      await otherRef.update({ friends: firebase.firestore.FieldValue.arrayRemove(me.username) }).catch(()=>{});
      toast('Arkadaş kaldırıldı', true);
      await renderFriendsModal();
    } catch(e){ console.warn(e); toast(e.message || 'İşlem başarısız', false); }
  }

  async function renderFriendsModal() {
    ensureFriendsModal();
    const modal = document.getElementById('friendsModal');
    const listEl = document.getElementById('friendsList');
    const reqEl = document.getElementById('friendRequests');
    if (!modal || !listEl || !reqEl) return;
    const me = await _getLogged();
    if (!me) { listEl.innerHTML = '<div style="color:var(--text-muted)">Giriş yapın.</div>'; modal.style.display = 'flex'; return; }
    const friends = Array.isArray(me.friends) ? me.friends : [];
    if (friends.length === 0) listEl.innerHTML = '<div style="color:var(--text-muted)">Henüz arkadaş yok.</div>';
    else {
      listEl.innerHTML = friends.map(f => {
        return `<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 0;">
          <div style="font-weight:700;">${escapeHtml(f)}</div>
          <div><button class="qcm-small" data-username="${escapeHtml(f)}" data-action="remove" style="padding:6px 8px; border-radius:8px;">Kaldır</button>
              <button class="qcm-small" data-username="${escapeHtml(f)}" data-action="dm" style="margin-left:6px; padding:6px 8px; border-radius:8px;">DM</button></div>
        </div>`;
      }).join('');
      listEl.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          const u = btn.getAttribute('data-username');
          const a = btn.getAttribute('data-action');
          if (a === 'remove') removeFriend(u);
          if (a === 'dm' && window.startPrivateChat) window.startPrivateChat(u);
        });
      });
    }
    const incoming = Array.isArray(me.friendRequestsReceived) ? me.friendRequestsReceived : [];
    if (incoming.length === 0) reqEl.innerHTML = '<div style="color:var(--text-muted)">Yeni istek yok.</div>';
    else {
      reqEl.innerHTML = incoming.map(f => {
        return `<div style="display:flex; gap:8px; align-items:center; justify-content:space-between; padding:6px 0;">
          <div style="font-weight:700;">${escapeHtml(f)}</div>
          <div><button class="qcm-small" data-from="${escapeHtml(f)}" data-action="accept" style="padding:6px 8px; border-radius:8px;">Kabul</button>
              <button class="qcm-small" data-from="${escapeHtml(f)}" data-action="reject" style="margin-left:6px; padding:6px 8px; border-radius:8px;">Reddet</button></div>
        </div>`;
      }).join('');
      reqEl.querySelectorAll('button[data-action]').forEach(b => {
        b.addEventListener('click', async () => {
          const from = b.getAttribute('data-from');
          const act = b.getAttribute('data-action');
          if (act === 'accept') await acceptFriendRequest(from);
          if (act === 'reject') {
            try {
              const me = await _getLogged();
              const meRef = db.collection('users').doc(me.username);
              const fromRef = db.collection('users').doc(from);
              await meRef.update({ friendRequestsReceived: firebase.firestore.FieldValue.arrayRemove(from) }).catch(()=>{});
              await fromRef.update({ friendRequestsSent: firebase.firestore.FieldValue.arrayRemove(me.username) }).catch(()=>{});
              toast('İstek reddedildi', true);
            } catch(e){ toast('İşlem başarısız', false); console.warn(e); }
            await renderFriendsModal();
          }
        });
      });
    }
    modal.style.display = 'flex';
  }

  // ---------- DM notifications ----------
  async function initDmNotifications() {
    try {
      if (!HAS_DB) return;
      const me = await _getLogged();
      if (!me || !me.username) return;
      if (state.listeners.dmNotifUnsub) try { state.listeners.dmNotifUnsub(); } catch(e){}
      state.listeners.dmNotifUnsub = db.collectionGroup('messages').where('to','==',me.username).onSnapshot(snap => {
        let newCount = 0;
        snap.docChanges().forEach(ch => {
          if (ch.type === 'added') {
            const m = ch.doc.data() || {};
            newCount++;
            const fromName = m.fromName || m.from || 'Anon';
            toast(`Yeni DM: ${fromName}: ${String(m.text || '').slice(0,120)}`, true, 4000);
          }
        });
        const badge = document.getElementById('notifBadge');
        if (badge) { if (newCount>0) badge.classList.remove('hidden'); else badge.classList.add('hidden'); }
        if (typeof refreshNotificationBadgeForUser === 'function') { try { refreshNotificationBadgeForUser(); } catch(e){} }
      }, err => { console.warn('dm notif err', err); });
    } catch(e){ console.warn('initDmNotifications err', e); }
  }

  // ---------- Clans (uses _saveUser) ----------
  function ensureClanModal() {
    if (document.getElementById('clanModal')) return;
    const modal = document.createElement('div');
    modal.id = 'clanModal';
    modal.className = 'overlay-center';
    modal.style.display = 'none';
    modal.innerHTML = `
      <div class="modal-box" style="max-width:820px;">
        <div style="display:flex; justify-content:space-between; align-items:center;">
          <h3 style="margin:0;">🛡️ Clans / Guilds</h3>
          <div><button id="clanClose" class="secondary">Kapat</button></div>
        </div>
        <div style="margin-top:12px; display:grid; grid-template-columns: 1fr 320px; gap:12px;">
          <div>
            <div style="display:flex; gap:8px; align-items:center; margin-bottom:8px;">
              <input id="clanSearch" placeholder="Clan ara veya id" style="flex:1; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.06)" />
              <button id="clanSearchBtn" class="qcm-action qcm-small">Ara</button>
            </div>
            <div id="clanList" style="max-height:380px; overflow:auto;"></div>
          </div>
          <div>
            <div style="margin-bottom:8px;"><strong>Benim Clanım</strong></div>
            <div id="myClanArea" style="margin-bottom:12px;"></div>
            <div style="margin-bottom:8px;"><strong>Yeni Clan Oluştur</strong></div>
            <input id="newClanName" placeholder="Clan adı" style="width:100%; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.06)" />
            <button id="createClanBtn" class="qcm-action qcm-small" style="margin-top:8px;">Oluştur</button>
          </div>
        </div>
        <div style="margin-top:12px;">
          <h4>Clan Chat (Seçili clan için)</h4>
          <div id="clanChatMessages" style="max-height:180px; overflow:auto; background:rgba(255,255,255,0.02); padding:8px; border-radius:8px;"></div>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <input id="clanChatInput" placeholder="Mesaj..." style="flex:1; padding:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.06)"/>
            <button id="clanChatSend" class="qcm-action qcm-small">Gönder</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    document.getElementById('clanClose').addEventListener('click', () => modal.style.display = 'none');
    document.getElementById('createClanBtn').addEventListener('click', async () => {
      const name = (document.getElementById('newClanName').value || '').trim();
      if (!name) return toast('Bir isim girin', false);
      await createClan(name);
      document.getElementById('newClanName').value = '';
      await renderClanModal();
    });
    document.getElementById('clanSearchBtn').addEventListener('click', renderClanModal);
    document.getElementById('clanChatSend').addEventListener('click', sendClanChatMessage);
  }

  async function createClan(name) {
    if (!HAS_DB) return toast('Sunucu yok', false);
    const me = await _getLogged(); if (!me) return toast('Giriş yap', false);
    const id = genId('clan_');
    const clanDoc = { id, name, owner: me.username, members: [me.username], createdAt: new Date().toISOString(), invites: [], tasks: [], taskClaims: [] };
    try {
      await db.collection('clans').doc(id).set(clanDoc);
      me.clanId = id;
      await _saveUser(me);
      toast('Clan oluşturuldu', true);
    } catch(e){ console.warn(e); toast('Clan oluşturulamadı', false); }
  }

  async function joinClanById(clanId) {
    if (!HAS_DB) return toast('Sunucu yok', false);
    const me = await _getLogged(); if (!me) return toast('Giriş yap', false);
    try {
      await db.runTransaction(async (t) => {
        const clanRef = db.collection('clans').doc(clanId);
        const clanSnap = await t.get(clanRef);
        if (!clanSnap.exists) throw new Error('Clan bulunamadı');
        const clanData = clanSnap.data() || {};
        if ((clanData.members || []).includes(me.username)) throw new Error('Zaten clan üyesisiniz');
        clanData.members = Array.isArray(clanData.members) ? clanData.members : [];
        clanData.members.push(me.username);
        t.set(clanRef, clanData, { merge:true });
        const meRef = db.collection('users').doc(me.username);
        const meSnap = await t.get(meRef);
        const meData = meSnap.data() || {};
        meData.clanId = clanId;
        t.set(meRef, meData, { merge:true });
      });
      // refresh local copy by saving user (some flows expect local save)
      const me2 = await _getLogged();
      if (me2) { me2.clanId = clanId; await _saveUser(me2); }
      toast('Clana katıldınız', true);
      await renderClanModal();
    } catch(e){ console.warn(e); toast(e.message || 'Katılma başarısız', false); }
  }

  async function leaveClan(clanId) {
    if (!HAS_DB) return toast('Sunucu yok', false);
    const me = await _getLogged(); if (!me) return toast('Giriş yap', false);
    try {
      await db.runTransaction(async (t) => {
        const clanRef = db.collection('clans').doc(clanId);
        const clanSnap = await t.get(clanRef);
        if (!clanSnap.exists) throw new Error('Clan bulunamadı');
        const clanData = clanSnap.data() || {};
        clanData.members = Array.isArray(clanData.members) ? clanData.members.filter(x => x !== me.username) : [];
        if (clanData.owner === me.username) {
          if (clanData.members.length === 0) t.delete(clanRef);
          else { clanData.owner = clanData.members[0]; t.set(clanRef, clanData, { merge:true }); }
        } else t.set(clanRef, clanData, { merge:true });
        const meRef = db.collection('users').doc(me.username);
        const meSnap = await t.get(meRef);
        const meData = meSnap.data() || {};
        delete meData.clanId;
        t.set(meRef, meData, { merge:true });
      });
      // update local
      const me2 = await _getLogged();
      if (me2) { delete me2.clanId; await _saveUser(me2); }
      toast("Clan'dan ayrıldınız", true);
      await renderClanModal();
    } catch(e){ console.warn(e); toast(e.message || 'Ayrılma başarısız', false); }
  }

  async function renderClanChat(clanId) {
    const container = document.getElementById('clanChatMessages');
    if (!container) return; container.innerHTML = '';
    if (!HAS_DB || !clanId) return;
    if (state.listeners.clanChatUnsub) try { state.listeners.clanChatUnsub(); } catch(e){}
    state.listeners.clanChatUnsub = db.collection('clans').doc(clanId).collection('chat').orderBy('timestamp','asc').limitToLast(500).onSnapshot(snap => {
      container.innerHTML = '';
      snap.forEach(doc => {
        const m = doc.data() || {};
        const who = escapeHtml(m.fromName || m.from || 'Anon');
        const text = escapeHtml(m.text || '');
        const ts = m.timestamp && m.timestamp.toDate ? new Date(m.timestamp.toDate()).toLocaleTimeString() : '';
        const div = document.createElement('div');
        div.style.padding = '6px 8px'; div.style.borderBottom = '1px solid rgba(255,255,255,0.02)';
        div.innerHTML = `<div style="font-weight:700;">${who} <span style="font-size:0.78rem;color:var(--text-muted); margin-left:8px;">${ts}</span></div><div style="margin-top:4px;">${text}</div>`;
        container.appendChild(div);
      });
      container.scrollTop = container.scrollHeight;
    });
  }

  async function sendClanChatMessage() {
    try {
      const input = document.getElementById('clanChatInput'); if (!input) return;
      const text = (input.value||'').trim(); if (!text) return;
      const me = await _getLogged(); if (!me || !me.clanId) { toast('Önce clana katılın', false); return; }
      await db.collection('clans').doc(me.clanId).collection('chat').add({
        from: me.username, fromName: me.profileName||me.username, fromColor: me.profileColor||'#00A3FF', text,
        timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });
      input.value = ''; toast('Mesaj gönderildi', true);
    } catch(e){ console.warn(e); toast('Gönderilemedi', false); }
  }

  // ---------- Daily streak ----------
  function ensureDailyUi() {
    const header = document.querySelector('.app-header'); if (!header) return;
    if (document.getElementById('dailyClaimBtn')) return;
    const btn = document.createElement('button'); btn.id='dailyClaimBtn'; btn.className='icon-btn'; btn.title='Günlük Ödülü Al'; btn.innerHTML='🎁'; btn.style.marginRight='8px';
    btn.addEventListener('click', claimDailyReward);
    const menuBtn = header.querySelector('.menu-toggle-btn'); if (menuBtn) header.insertBefore(btn, menuBtn); else header.appendChild(btn);
    const badge = document.createElement('span'); badge.id='dailyStreakBadge'; badge.style.marginLeft='8px'; badge.style.fontSize='0.85rem'; badge.style.color='var(--text-muted)'; header.appendChild(badge);
    refreshDailyUi();
  }

  async function refreshDailyUi() {
    const me = await _getLogged();
    const badge = document.getElementById('dailyStreakBadge'); const btn = document.getElementById('dailyClaimBtn');
    if (!me) { if (badge) badge.textContent=''; if (btn) btn.disabled=true; return; }
    const last = me.lastDailyClaim || ''; const streak = Number(me.streak || 0);
    if (badge) badge.textContent = `Seri: ${streak||0}`; const today = todayKey(); if (btn) btn.disabled = (last === today);
  }

  async function claimDailyReward() {
    const me = await _getLogged(); if (!me) return toast('Önce giriş yapın', false);
    const today = todayKey(); const yesterday = (() => { const d = new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10); })();
    if (me.lastDailyClaim === today) return toast('Bugün zaten aldınız', false);
    me.streak = (me.lastDailyClaim === yesterday) ? (Number(me.streak||0)+1) : 1;
    me.lastDailyClaim = today;
    const streakCap = Math.min(7, Number(me.streak || 1)); const reward = Number((1 + (streakCap - 1) * 0.5).toFixed(2));
    const { earnFactor } = computeDynamicCooldown(me);
    const actual = Math.round(reward * earnFactor * 100) / 100;
    me.balance = (Number(me.balance)||0) + actual;
    await _saveUser(me); // <--- IMPORTANT: use robust save
    toast(`Günlük ödül alındı: ${fmtMoney(actual)} (Seri: ${me.streak})`, true);
    if (host.updateUI) try { host.updateUI(); } catch(e){}
    refreshDailyUi();
  }

  // ---------- Init wiring ----------
  async function initFeatures() {
    try {
      if (state.listeners.dmNotifUnsub) try { state.listeners.dmNotifUnsub(); } catch(e){} state.listeners.dmNotifUnsub = null;
      if (state.listeners.userDocUnsub) try { state.listeners.userDocUnsub(); } catch(e){} state.listeners.userDocUnsub = null;
      if (state.listeners.clanChatUnsub) try { state.listeners.clanChatUnsub(); } catch(e){} state.listeners.clanChatUnsub = null;

      await initBoxesLogic();

      const side = document.getElementById('sideMenu');
      if (side) {
        if (!document.getElementById('menuFriendsBtn')) {
          const a = document.createElement('a'); a.href='#'; a.id='menuFriendsBtn'; a.className='menu-link';
          a.innerHTML = `<i class="fa-solid fa-user-group"></i> Arkadaşlar`; a.addEventListener('click', (e)=>{ e.preventDefault(); renderFriendsModal(); });
          const notif = document.getElementById('notifMenuLink'); if (notif && notif.parentElement) notif.parentElement.insertBefore(a, notif.nextSibling); else side.querySelector('.side-menu-content').appendChild(a);
        }
        if (!document.getElementById('menuClanBtn')) {
          const a = document.createElement('a'); a.href='#'; a.id='menuClanBtn'; a.className='menu-link';
          a.innerHTML = `<i class="fa-solid fa-shield-halved"></i> Clans`; a.addEventListener('click', (e)=>{ e.preventDefault(); renderClanModal(); });
          side.querySelector('.side-menu-content').appendChild(a);
        }
      }

      ensureFriendsModal(); ensureClanModal(); ensureDailyUi();

      const me = await _getLogged();
      if (me && me.username && HAS_DB) {
        state.listeners.userDocUnsub = db.collection('users').doc(me.username).onSnapshot(doc => {
          if (!doc.exists) return;
          refreshDailyUi();
          initBoxesLogic();
          if (document.getElementById('friendsModal') && document.getElementById('friendsModal').style.display === 'flex') renderFriendsModal();
          if (document.getElementById('clanModal') && document.getElementById('clanModal').style.display === 'flex') renderClanModal();
        });
        await initDmNotifications();
      } else {
        if (HAS_FIREBASE && firebase.auth) {
          firebase.auth().onAuthStateChanged(async (u)=>{ if (u) { try{ await initFeatures(); } catch(e){} } });
        }
      }
    } catch(e){ console.warn('initFeatures err', e); }
  }

  // Expose
  window.features = {
    initFeatures,
    noteClickEvent,
    computeDynamicCooldown,
    initBoxesLogic,
    renderFriendsModal,
    sendFriendRequest,
    acceptFriendRequest,
    removeFriend,
    createClan,
    joinClanById,
    leaveClan,
    renderClanModal,
    claimDailyReward
    // other helpers can be added as needed
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initFeatures);
  else initFeatures();

  // convenience
  window.spinWheel = async function(){ toast('Spin: kullanılabilir değil (örnek).', true); };
})();