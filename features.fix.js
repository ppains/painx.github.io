/* features.fix.js
   Küçük güvenli düzeltmeler: arkadaş istekleri, günlük ödül (transaction), clan katılma güncellemesi.
   Ek: bildirim oluşturma, daha sağlam kullanıcı arama.
   INCLUDE after script.js and features.js
*/
(function(){
  if (typeof window === 'undefined') return;
  const LOGGED_KEY = 'bio_logged_in_user_v9';
  const HAS_DB = (typeof db !== 'undefined' && db);
  const HAS_FIREBASE = (typeof firebase !== 'undefined' && firebase && firebase.firestore);
  // host helpers (fall back to existing features module or window)
  const host = {
    getLoggedInUser: (typeof window.getLoggedInUser === 'function') ? window.getLoggedInUser : (typeof window.getLoggedInUser === 'undefined' ? null : window.getLoggedInUser),
    saveUser: (typeof window.saveUser === 'function') ? window.saveUser : null,
    todayDateKey: (typeof window.todayDateKey === 'function') ? window.todayDateKey : (() => new Date().toISOString().slice(0,10)),
    generateId: (typeof window.generateId === 'function') ? window.generateId : ((p='id_')=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,8)),
    formatMoney: (typeof window.formatMoney === 'function') ? window.formatMoney : (n => '$' + Number(n||0).toFixed(2)),
    updateUI: (typeof window.updateUI === 'function') ? window.updateUI : null,
    showToast: (typeof window.showToast === 'function') ? window.showToast : ((m,ok=true,t=3500)=>{ try{ console.log('toast:',m); alert(m);}catch(e){} })
  };

  const toast = host.showToast;
  const genId = host.generateId;
  const todayKey = host.todayDateKey;
  const fmtMoney = host.formatMoney;

  async function _getLogged() {
    try {
      if (host.getLoggedInUser) {
        const u = await host.getLoggedInUser();
        if (u && u.username) return u;
      }
      const username = localStorage.getItem(LOGGED_KEY);
      if (username && HAS_DB) {
        const doc = await db.collection('users').doc(username).get();
        if (doc.exists) {
          const data = doc.data();
          if (!data.username) data.username = username;
          return data;
        }
      }
      if (HAS_FIREBASE && firebase.auth && firebase.auth().currentUser) {
        const au = firebase.auth().currentUser;
        if (au && au.email && HAS_DB) {
          const q = await db.collection('users').where('email','==',au.email).limit(1).get();
          if (!q.empty) {
            const d = q.docs[0].data();
            if (!d.username && q.docs[0].id) d.username = q.docs[0].id;
            return d;
          }
        }
        return { username: au.uid, profileName: au.displayName || (au.email||'').split('@')[0], profileColor:'#00A3FF', balance:0, clicks:0, dailyClicks:0 };
      }
    } catch(e){ console.warn('_getLogged fix err', e); }
    return null;
  }

  // robust saveUser: honor host.saveUser signature if present
  async function _saveUser(u) {
    if (!u) return;
    try {
      if (host.saveUser) {
        if (host.saveUser.length >= 2 && u.username) return await host.saveUser(u.username, u);
        return await host.saveUser(u);
      }
      if (HAS_DB && u.username) return await db.collection('users').doc(u.username).set(u, { merge:true });
    } catch(e){ console.warn('_saveUser fix err', e); throw e; }
  }

  // Improved user lookup: try doc id, usernameLower, username, profileName (case-insensitive where possible)
  async function findUserDocByIdentifier(identifier) {
    if (!HAS_DB) return null;
    const idRaw = (identifier||'').toString().trim();
    if (!idRaw) return null;
    // 1) exact doc id
    try {
      const doc = await db.collection('users').doc(idRaw).get();
      if (doc.exists) return { id: doc.id, data: doc.data() };
    } catch(e){}
    // 2) try lower-case doc id (some setups store lowercase)
    try {
      const doc2 = await db.collection('users').doc(idRaw.toLowerCase()).get();
      if (doc2.exists) return { id: doc2.id, data: doc2.data() };
    } catch(e){}
    // 3) usernameLower field
    try {
      const q = await db.collection('users').where('usernameLower','==', idRaw.toLowerCase()).limit(1).get();
      if (!q.empty) return { id: q.docs[0].id, data: q.docs[0].data() };
    } catch(e){}
    // 4) username field exact
    try {
      const q2 = await db.collection('users').where('username','==', idRaw).limit(1).get();
      if (!q2.empty) return { id: q2.docs[0].id, data: q2.docs[0].data() };
    } catch(e){}
    // 5) profileName exact
    try {
      const q3 = await db.collection('users').where('profileName','==', idRaw).limit(1).get();
      if (!q3.empty) return { id: q3.docs[0].id, data: q3.docs[0].data() };
    } catch(e){}
    // 6) last resort: fuzzy by usernameLower contains (costly, used only if necessary)
    try {
      const q4 = await db.collection('users').orderBy('usernameLower').startAt(idRaw.toLowerCase()).endAt(idRaw.toLowerCase()+'\uf8ff').limit(3).get();
      if (!q4.empty) return { id: q4.docs[0].id, data: q4.docs[0].data() };
    } catch(e){}
    return null;
  }

  // FRIEND REQUEST: arrayUnion approach + create notifications entry
  async function sendFriendRequest(targetIdentifier) {
    if (!HAS_DB) { toast('Sunucu bağlantısı yok', false); return; }
    const me = await _getLogged(); if (!me) { toast('Önce giriş yapın', false); return; }
    const found = await findUserDocByIdentifier(targetIdentifier);
    if (!found) { toast('Kullanıcı bulunamadı', false); return; }
    const targetUsername = found.id;
    if (me.username === targetUsername) { toast('Kendinize istek gönderemezsiniz', false); return; }
    try {
      const meRef = db.collection('users').doc(me.username);
      const tarRef = db.collection('users').doc(targetUsername);
      // use update with arrayUnion; if field missing, catch and set
      await meRef.update({ friendRequestsSent: firebase.firestore.FieldValue.arrayUnion(targetUsername) })
        .catch(async () => await meRef.set({ friendRequestsSent: [targetUsername] }, { merge:true }));
      await tarRef.update({ friendRequestsReceived: firebase.firestore.FieldValue.arrayUnion(me.username) })
        .catch(async () => await tarRef.set({ friendRequestsReceived: [me.username] }, { merge:true }));
      // create notification for recipient (use notifications collection)
      await db.collection('notifications').add({
        to: targetUsername,
        type: 'friend_request',
        from: me.username,
        message: `${me.profileName || me.username} size arkadaşlık isteği gönderdi.`,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        visible: true
      });
      toast('Davet gönderildi', true);
    } catch(e){ console.warn('sendFriendRequest fix err', e); toast(e.message || 'Davet gönderilemedi', false); }
  }

  // Accept friend: atomic update with arrayRemove/arrayUnion and notification
  async function acceptFriendRequest(fromUsername) {
    if (!HAS_DB) { toast('Sunucu bağlantısı yok', false); return; }
    const me = await _getLogged(); if (!me) { toast('Önce giriş yapın', false); return; }
    try {
      const meRef = db.collection('users').doc(me.username);
      const fromRef = db.collection('users').doc(fromUsername);
      await meRef.update({
        friendRequestsReceived: firebase.firestore.FieldValue.arrayRemove(fromUsername),
        friends: firebase.firestore.FieldValue.arrayUnion(fromUsername)
      }).catch(async ()=> await meRef.set({ friendRequestsReceived: [], friends: [fromUsername] }, { merge:true }));
      await fromRef.update({
        friendRequestsSent: firebase.firestore.FieldValue.arrayRemove(me.username),
        friends: firebase.firestore.FieldValue.arrayUnion(me.username)
      }).catch(async ()=> await fromRef.set({ friendRequestsSent: [], friends: [me.username] }, { merge:true }));
      // notification to requester
      await db.collection('notifications').add({
        to: fromUsername, type:'friend_accept', from: me.username,
        message: `${me.profileName || me.username} arkadaşlık isteğini kabul etti.`, createdAt: firebase.firestore.FieldValue.serverTimestamp(), visible:true
      });
      toast('Arkadaş eklendi', true);
    } catch(e){ console.warn('acceptFriendRequest fix err', e); toast(e.message || 'İşlem başarısız', false); }
  }

  // DAILY reward: atomic transaction to avoid races
  async function claimDailyRewardSafe() {
    if (!HAS_DB) { toast('Sunucu bağlantısı yok', false); return; }
    const meLocal = await _getLogged(); if (!meLocal) { toast('Önce giriş yapın', false); return; }
    const userRef = db.collection('users').doc(meLocal.username);
    try {
      await db.runTransaction(async (t) => {
        const snap = await t.get(userRef);
        if (!snap.exists) throw new Error('Kullanıcı bulunamadı');
        const u = snap.data();
        const TODAY = todayKey();
        if (u.lastDailyClaim === TODAY) throw new Error('Bugün zaten aldınız');
        const yesterday = (()=>{const d=new Date(); d.setDate(d.getDate()-1); return d.toISOString().slice(0,10);})();
        const newStreak = (u.lastDailyClaim === yesterday) ? (Number(u.streak||0)+1) : 1;
        const streakCap = Math.min(7, newStreak);
        const reward = Number((1 + (streakCap - 1) * 0.5).toFixed(2));
        // optional: compute earnFactor (if computeDynamicCooldown available)
        let earnFactor = 1.0;
        if (typeof window.computeDynamicCooldown === 'function') {
          try { const r = window.computeDynamicCooldown(u); earnFactor = r.earnFactor || 1.0; } catch(e){}
        }
        const actual = Math.round(reward * earnFactor * 100) / 100;
        t.set(userRef, { lastDailyClaim: TODAY, streak: newStreak, balance: firebase.firestore.FieldValue.increment(actual) }, { merge:true });
      });
      // After transaction, fetch latest and update UI
      const updated = await userRef.get();
      if (updated.exists) {
        const u2 = updated.data();
        // try to call host.saveUser to sync local if available
        try { await _saveUser(u2); } catch(e){}
        if (host.updateUI) try { host.updateUI(); } catch(e){}
        toast(`Günlük ödül alındı (günlük ${fmtMoney((u2.balance||0))} değil)`, true);
      } else {
        toast('İşlem tamamlandı', true);
      }
    } catch(e) {
      if (e && e.message) toast(e.message, false);
      else { console.warn('claimDailyRewardSafe err', e); toast('Günlük ödül alınamadı', false); }
    }
  }

  // JOIN CLAN: ensure user doc updated and optional notification to owner
  async function joinClanByIdSafe(clanId) {
    if (!HAS_DB) { toast('Sunucu bağlantısı yok', false); return; }
    const me = await _getLogged(); if (!me) { toast('Giriş yap', false); return; }
    try {
      await db.runTransaction(async (t) => {
        const clanRef = db.collection('clans').doc(clanId);
        const clanSnap = await t.get(clanRef);
        if (!clanSnap.exists) throw new Error('Clan bulunamadı');
        const clan = clanSnap.data() || {};
        if ((clan.members||[]).includes(me.username)) throw new Error('Zaten üyesiniz');
        t.update(clanRef, { members: firebase.firestore.FieldValue.arrayUnion(me.username) });
        const meRef = db.collection('users').doc(me.username);
        t.update(meRef, { clanId: clanId });
      });
      // notify owner
      const clanDoc = await db.collection('clans').doc(clanId).get();
      if (clanDoc.exists) {
        const c = clanDoc.data();
        if (c.owner && c.owner !== me.username) {
          await db.collection('notifications').add({
            to: c.owner, from: me.username, type:'clan_join', message: `${me.profileName||me.username} clana katıldı: ${c.name}`, createdAt: firebase.firestore.FieldValue.serverTimestamp(), visible:true
          });
        }
      }
      // update local copy
      const newUserDoc = await db.collection('users').doc(me.username).get();
      if (newUserDoc.exists) await _saveUser(newUserDoc.data());
      if (host.updateUI) try { host.updateUI(); } catch(e){}
      toast('Clana katıldınız', true);
    } catch(e){ console.warn('joinClanByIdSafe err', e); toast(e.message || 'Katılma başarısız', false); }
  }

  // expose fixes
  window.featuresFix = {
    findUserDocByIdentifier,
    sendFriendRequest,
    acceptFriendRequest,
    claimDailyRewardSafe,
    joinClanByIdSafe,
    _getLogged,
    _saveUser
  };

  // auto-run: attach to global features if present
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ()=>{ try{ if (window.features && window.features.initFeatures) window.features.initFeatures(); }catch(e){} });
  else { try{ if (window.features && window.features.initFeatures) window.features.initFeatures(); }catch(e){} }

})(); 