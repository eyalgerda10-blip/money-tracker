(function () {
  'use strict';

  var MONTHS = ['ינואר','פברואר','מרץ','אפריל','מאי','יוני','יולי','אוגוסט','ספטמבר','אוקטובר','נובמבר','דצמבר'];
  var MSHORT = ['ינו','פבר','מרץ','אפר','מאי','יונ','יול','אוג','ספט','אוק','נוב','דצמ'];

  function fmt(n) { return Math.round(Math.abs(Number(n) || 0)).toLocaleString('en-US'); }
  function parseDate(s) { var p = String(s).split('-').map(Number); return { y: p[0], m: (p[1] || 1) - 1, d: p[2] || 1 }; }
  function dateDisp(s) { var p = parseDate(s); return p.d + ' ב' + MONTHS[p.m]; }
  function todayStr() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function inMonth(dateStr, y, m) { var p = parseDate(dateStr); return p.y === y && p.m === m; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  var CONFIGURED = window.SUPABASE_URL && window.SUPABASE_URL.indexOf('PASTE_YOUR') !== 0 &&
                   window.SUPABASE_ANON_KEY && window.SUPABASE_ANON_KEY.indexOf('PASTE_YOUR') !== 0;
  var sb = CONFIGURED ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY) : null;

  var state = {
    screen: 'dashboard',
    ym: null,
    hiddenCats: [],
    debtTab: 'owedToMe',
    modal: null,
    editingId: null,
    fabOpen: false,
    catMgrOpen: false,
    form: {},
    data: { transactions: [], debts: [], categories: { expense: [], income: [] } },
    budget: 0,
    currency: '₪',
    userId: null,
  };

  var el = {}; // cached DOM refs, filled in init()
  function q(id) { return document.getElementById(id); }

  // ===================== AUTH =====================

  function showAuthErr(msg) { el.authErr.textContent = msg || ''; }

  var authMode = 'signin';
  function setAuthMode(mode) {
    authMode = mode;
    if (mode === 'signin') {
      el.authSubmit.textContent = 'כניסה';
      el.authSwitchLine.innerHTML = 'אין לך חשבון? <span id="authSwitch">להרשמה</span>';
    } else {
      el.authSubmit.textContent = 'הרשמה';
      el.authSwitchLine.innerHTML = 'כבר יש לך חשבון? <span id="authSwitch">להתחברות</span>';
    }
    q('authSwitch').onclick = function () { setAuthMode(authMode === 'signin' ? 'signup' : 'signin'); showAuthErr(''); };
  }

  async function handleAuthSubmit(e) {
    e.preventDefault();
    showAuthErr('');
    var email = el.authEmail.value.trim();
    var password = el.authPassword.value;
    if (!email || !password) return;
    el.authSubmit.disabled = true;
    try {
      if (authMode === 'signup') {
        var r = await sb.auth.signUp({ email: email, password: password });
        if (r.error) { showAuthErr(r.error.message); return; }
        if (!r.data.session) {
          showAuthErr('נשלח מייל אישור — אשר ואז התחבר.');
          setAuthMode('signin');
          return;
        }
        await onLoggedIn(r.data.session);
      } else {
        var r2 = await sb.auth.signInWithPassword({ email: email, password: password });
        if (r2.error) { showAuthErr(r2.error.message); return; }
        await onLoggedIn(r2.data.session);
      }
    } finally {
      el.authSubmit.disabled = false;
    }
  }

  async function onLoggedIn(session) {
    state.userId = session.user.id;
    el.authScreen.classList.add('hidden');
    await loadData();
    el.app.classList.remove('hidden');
    el.app.style.display = 'flex';
    render();
  }

  async function handleLogout() {
    if (sb) await sb.auth.signOut();
    location.reload();
  }

  // ===================== DATA LOADING =====================

  async function loadData() {
    var results = await Promise.all([
      sb.from('transactions').select('*').order('date', { ascending: false }),
      sb.from('debts').select('*').order('date', { ascending: false }),
      sb.from('categories').select('*'),
      sb.from('settings').select('*').eq('user_id', state.userId).maybeSingle(),
    ]);
    var txRes = results[0], debtRes = results[1], catRes = results[2], settRes = results[3];

    state.data.transactions = txRes.data || [];
    state.data.debts = debtRes.data || [];
    var cats = { expense: [], income: [] };
    (catRes.data || []).forEach(function (c) { if (cats[c.type]) cats[c.type].push(c.name); });
    state.data.categories = cats;

    if (settRes.data) {
      state.budget = Number(settRes.data.budget) || 0;
      state.currency = settRes.data.currency || '₪';
    } else {
      await sb.from('settings').insert({ user_id: state.userId, budget: 0, currency: '₪' });
      state.budget = 0;
      state.currency = '₪';
    }

    var now = new Date();
    state.ym = { y: now.getFullYear(), m: now.getMonth() };
  }

  // ===================== MUTATIONS =====================

  async function ensureCategory(type, name) {
    if (!name) return;
    if ((state.data.categories[type] || []).indexOf(name) >= 0) return;
    var r = await sb.from('categories').insert({ user_id: state.userId, type: type, name: name }).select().maybeSingle();
    if (!r.error) state.data.categories[type] = (state.data.categories[type] || []).concat([name]);
  }

  async function saveTransaction() {
    var f = state.form;
    var amount = parseFloat(f.amount) || 0;
    if (!f.desc || !amount) return;
    var cat = f.category || 'שונות';
    var type = state.modal;
    if (state.editingId) {
      var r = await sb.from('transactions').update({ type: type, description: f.desc, amount: amount, date: f.date, category: cat, note: f.note || '' }).eq('id', state.editingId).select().maybeSingle();
      if (r.error) { alert(r.error.message); return; }
      var i = state.data.transactions.findIndex(function (t) { return t.id === state.editingId; });
      if (i >= 0) state.data.transactions[i] = r.data;
    } else {
      var row = { user_id: state.userId, type: type, description: f.desc, amount: amount, date: f.date, category: cat, note: f.note || '' };
      var r2 = await sb.from('transactions').insert(row).select().maybeSingle();
      if (r2.error) { alert(r2.error.message); return; }
      state.data.transactions.unshift(r2.data);
    }
    await ensureCategory(type, cat);
    closeModal();
  }

  async function saveDebt() {
    var f = state.form;
    var amount = parseFloat(f.amount) || 0;
    if (!f.name || !amount) return;
    if (state.editingId) {
      var r = await sb.from('debts').update({ name: f.name, amount: amount, date: f.date, direction: f.direction, note: f.note || '' }).eq('id', state.editingId).select().maybeSingle();
      if (r.error) { alert(r.error.message); return; }
      var i = state.data.debts.findIndex(function (d) { return d.id === state.editingId; });
      if (i >= 0) state.data.debts[i] = r.data;
    } else {
      var row = { user_id: state.userId, name: f.name, amount: amount, date: f.date, direction: f.direction || 'owedToMe', note: f.note || '', paid: false };
      var r2 = await sb.from('debts').insert(row).select().maybeSingle();
      if (r2.error) { alert(r2.error.message); return; }
      state.data.debts.unshift(r2.data);
    }
    closeModal();
  }

  async function removeCurrent() {
    if (!state.editingId) return;
    if (state.modal === 'debt') {
      await sb.from('debts').delete().eq('id', state.editingId);
      state.data.debts = state.data.debts.filter(function (d) { return d.id !== state.editingId; });
    } else {
      await sb.from('transactions').delete().eq('id', state.editingId);
      state.data.transactions = state.data.transactions.filter(function (t) { return t.id !== state.editingId; });
    }
    closeModal();
  }

  async function toggleDebtPaid(id) {
    var d = state.data.debts.find(function (x) { return x.id === id; });
    if (!d) return;
    var r = await sb.from('debts').update({ paid: !d.paid }).eq('id', id).select().maybeSingle();
    if (!r.error) {
      var i = state.data.debts.findIndex(function (x) { return x.id === id; });
      state.data.debts[i] = r.data;
      render();
    }
  }

  async function addCatFromModal() {
    var name = (q('formNewCat').value || '').trim();
    if (!name) return;
    var type = state.modal === 'income' ? 'income' : 'expense';
    await ensureCategory(type, name);
    state.form.category = name;
    state.form.newCat = '';
    renderModal();
  }

  async function deleteCatFromModal(type, name) {
    await sb.from('categories').delete().eq('user_id', state.userId).eq('type', type).eq('name', name);
    state.data.categories[type] = (state.data.categories[type] || []).filter(function (c) { return c !== name; });
    if (state.form.category === name) state.form.category = '';
    if (type === 'expense') await moveTransactionsToMisc(name);
    renderModal();
  }

  async function moveTransactionsToMisc(categoryName) {
    var ids = state.data.transactions.filter(function (t) { return t.type === 'expense' && t.category === categoryName; }).map(function (t) { return t.id; });
    if (!ids.length) return;
    await sb.from('transactions').update({ category: 'שונות' }).in('id', ids);
    state.data.transactions = state.data.transactions.map(function (t) {
      return ids.indexOf(t.id) >= 0 ? Object.assign({}, t, { category: 'שונות' }) : t;
    });
  }

  async function addMgrCat() {
    var name = (q('mgrNewCat').value || '').trim();
    if (!name) return;
    await ensureCategory('expense', name);
    q('mgrNewCat').value = '';
    renderCatMgr();
  }

  async function delMgrCat(name) {
    await sb.from('categories').delete().eq('user_id', state.userId).eq('type', 'expense').eq('name', name);
    state.data.categories.expense = (state.data.categories.expense || []).filter(function (c) { return c !== name; });
    state.hiddenCats = state.hiddenCats.filter(function (c) { return c !== name; });
    await moveTransactionsToMisc(name);
    renderCatMgr();
    render();
  }

  async function editBudget() {
    var val = prompt('תקציב חודשי (' + state.currency + ')', state.budget || '');
    if (val === null) return;
    var budget = Math.max(0, Number(val) || 0);
    var r = await sb.from('settings').upsert({ user_id: state.userId, budget: budget, currency: state.currency });
    if (!r.error) { state.budget = budget; render(); }
  }

  // ===================== NAV / SCREEN STATE =====================

  function setScreen(s) { state.screen = s; state.fabOpen = false; render(); }
  function stepMonth(dir) {
    var y = state.ym.y, m = state.ym.m + dir;
    while (m < 0) { m += 12; y--; }
    while (m > 11) { m -= 12; y++; }
    state.ym = { y: y, m: m };
    state.hiddenCats = [];
    render();
  }
  function toggleCat(cat) {
    var i = state.hiddenCats.indexOf(cat);
    if (i >= 0) state.hiddenCats.splice(i, 1); else state.hiddenCats.push(cat);
    render();
  }
  function toggleFab() { state.fabOpen = !state.fabOpen; render(); }

  function openAdd(type) {
    if (type === 'debt') {
      state.modal = 'debt'; state.editingId = null; state.fabOpen = false;
      state.form = { date: todayStr(), direction: state.debtTab, name: '', amount: '', note: '' };
    } else {
      state.modal = type; state.editingId = null; state.fabOpen = false;
      state.form = { date: todayStr(), desc: '', amount: '', category: '', note: '', newCat: '' };
    }
    render();
  }
  function openEditTx(tx) {
    state.modal = tx.type; state.editingId = tx.id; state.fabOpen = false;
    state.form = { desc: tx.description, amount: String(tx.amount), date: tx.date, category: tx.category, note: tx.note || '', newCat: '' };
    render();
  }
  function openEditDebt(d) {
    state.modal = 'debt'; state.editingId = d.id; state.fabOpen = false;
    state.form = { name: d.name, amount: String(d.amount), date: d.date, direction: d.direction, note: d.note || '' };
    render();
  }
  function closeModal() { state.modal = null; state.editingId = null; state.form = {}; render(); }
  function openCatMgr() { state.catMgrOpen = true; state.fabOpen = false; render(); }
  function closeCatMgr() { state.catMgrOpen = false; render(); }

  // ===================== RENDER =====================

  var TITLES = { dashboard: 'בית', expenses: 'הוצאות', income: 'הכנסות', debts: 'חובות' };

  function render() {
    el.screenTitle.textContent = TITLES[state.screen];
    ['dashboard', 'expenses', 'income', 'debts'].forEach(function (s) {
      q('screen-' + s).classList.toggle('hidden', state.screen !== s);
    });
    Array.prototype.forEach.call(el.bottomNav.querySelectorAll('button'), function (b) {
      b.classList.toggle('active', b.dataset.screen === state.screen);
    });

    if (state.screen === 'dashboard') renderDashboard();
    if (state.screen === 'expenses') renderExpenses();
    if (state.screen === 'income') renderIncome();
    if (state.screen === 'debts') renderDebts();

    el.fabOverlay.classList.toggle('hidden', !state.fabOpen);
    el.fabMenu.classList.toggle('hidden', !state.fabOpen);
    el.fabBtn.textContent = state.fabOpen ? '×' : '+';

    renderModal();
    renderCatMgr();
  }

  function sumMonth(type, y, m) {
    return state.data.transactions
      .filter(function (t) { return t.type === type; })
      .filter(function (t) { return inMonth(t.date, y, m); })
      .reduce(function (a, t) { return a + Number(t.amount); }, 0);
  }

  function byDateDesc(a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; }

  function renderDashboard() {
    var ym = state.ym, cur = state.currency;
    q('dashMonthLabel').textContent = MONTHS[ym.m] + ' ' + ym.y;

    var monthExpenses = state.data.transactions.filter(function (t) { return t.type === 'expense' && inMonth(t.date, ym.y, ym.m); }).sort(byDateDesc);
    var monthIncomes = state.data.transactions.filter(function (t) { return t.type === 'income' && inMonth(t.date, ym.y, ym.m); }).sort(byDateDesc);
    var totalExpenseN = monthExpenses.reduce(function (a, t) { return a + Number(t.amount); }, 0);
    var totalIncomeN = monthIncomes.reduce(function (a, t) { return a + Number(t.amount); }, 0);
    var net = totalIncomeN - totalExpenseN;

    q('dashTotalExpense').textContent = fmt(totalExpenseN);
    q('dashCur1').textContent = cur;
    q('dashTotalIncome').textContent = fmt(totalIncomeN);
    q('dashCur2').textContent = cur;
    var netEl = q('dashNet');
    netEl.style.color = net >= 0 ? 'var(--inc)' : 'var(--exp)';
    netEl.innerHTML = (net >= 0 ? '+' : '−') + fmt(net) + ' <span>' + cur + '</span>';

    // budget
    var budget = state.budget;
    var budgetCard = q('budgetCard');
    if (budget > 0) {
      var rawPct = totalExpenseN / budget;
      var pct = Math.min(100, Math.round(rawPct * 100));
      var over = totalExpenseN > budget;
      var color = rawPct > 1 ? 'var(--exp)' : rawPct > 0.8 ? '#8A6D3B' : 'var(--inc)';
      budgetCard.innerHTML =
        '<div class="row1"><span class="title" id="budgetEditBtn">תקציב חודשי</span>' +
        '<span class="amt mono">' + fmt(totalExpenseN) + ' / ' + fmt(budget) + ' ' + cur + '</span></div>' +
        '<div class="budgetBar"><div style="width:' + pct + '%; background:' + color + '"></div></div>' +
        '<div class="row2"><span class="lbl">' + (over ? 'חריגה' : 'נותרו') + '</span>' +
        '<span class="remain mono" style="color:' + color + '">' + fmt(Math.abs(budget - totalExpenseN)) + ' ' + cur + '</span></div>';
    } else {
      budgetCard.innerHTML = '<div class="noBudgetRow"><span class="title" id="budgetEditBtn">תקציב חודשי</span><button type="button" id="budgetEditBtn2">קבע תקציב</button></div>';
      q('budgetEditBtn2').onclick = editBudget;
    }
    q('budgetEditBtn').onclick = editBudget;

    // breakdown
    var catTotals = {};
    monthExpenses.forEach(function (t) { catTotals[t.category] = (catTotals[t.category] || 0) + Number(t.amount); });
    var bd = Object.keys(catTotals).map(function (k) { return { name: k, amount: catTotals[k] }; }).sort(function (a, b) { return b.amount - a.amount; });
    var bdMax = bd.length ? bd[0].amount : 1;
    var breakdown = bd.slice(0, 5);
    var breakdownWrap = q('breakdownWrap');
    if (breakdown.length) {
      var rows = breakdown.map(function (b) {
        var pctOf = totalExpenseN ? Math.round(b.amount / totalExpenseN * 100) : 0;
        var barPct = Math.round(b.amount / bdMax * 100);
        return '<button type="button" class="breakdownRow" data-cat="' + esc(b.name) + '">' +
          '<div class="top"><span class="name">' + esc(b.name) + ' <span class="pct">· ' + pctOf + '%</span></span>' +
          '<span class="amt mono">' + fmt(b.amount) + ' ' + cur + '</span></div>' +
          '<div class="breakdownBar"><div style="width:' + barPct + '%"></div></div></button>';
      }).join('');
      breakdownWrap.innerHTML = '<div style="margin-bottom:22px;"><div class="breakdownHead"><div class="title">לאן הלך הכסף</div>' +
        '<button type="button" class="mgrBtn" id="openCatMgrBtn">ניהול קטגוריות</button></div>' + rows + '</div>';
      q('openCatMgrBtn').onclick = openCatMgr;
      Array.prototype.forEach.call(breakdownWrap.querySelectorAll('.breakdownRow'), function (btn) {
        btn.onclick = function () { setScreen('expenses'); };
      });
    } else {
      breakdownWrap.innerHTML = '';
    }

    // chart: last 6 months ending at ym
    var max = 1, raw = [];
    for (var i = 5; i >= 0; i--) {
      var m = ym.m - i, y = ym.y;
      while (m < 0) { m += 12; y--; }
      var e = sumMonth('expense', y, m), inc = sumMonth('income', y, m);
      max = Math.max(max, e, inc);
      raw.push({ label: MSHORT[m], e: e, inc: inc, y: y, m: m });
    }
    var chartRows = q('chartRows');
    chartRows.innerHTML = raw.map(function (b) {
      var isCur = (b.y === ym.y && b.m === ym.m);
      var ePct = Math.max(b.e > 0 ? 3 : 0, Math.round(b.e / max * 100));
      var iPct = Math.max(b.inc > 0 ? 3 : 0, Math.round(b.inc / max * 100));
      return '<button type="button" class="chartRow" data-y="' + b.y + '" data-m="' + b.m + '">' +
        '<div class="lbl ' + (isCur ? 'current' : 'notcurrent') + '">' + b.label + '</div>' +
        '<div class="bars">' +
        '<div class="barLine"><div class="track"><div style="width:' + ePct + '%; background:var(--exp)"></div></div><span class="val mono" style="color:var(--exp)">' + fmt(b.e) + '</span></div>' +
        '<div class="barLine"><div class="track"><div style="width:' + iPct + '%; background:var(--inc)"></div></div><span class="val mono" style="color:var(--inc)">' + fmt(b.inc) + '</span></div>' +
        '</div></button>';
    }).join('');
    Array.prototype.forEach.call(chartRows.querySelectorAll('.chartRow'), function (btn) {
      btn.onclick = function () {
        state.ym = { y: Number(btn.dataset.y), m: Number(btn.dataset.m) };
        state.hiddenCats = [];
        render();
      };
    });
  }

  function renderExpenses() {
    var ym = state.ym, cur = state.currency;
    q('expMonthLabel').textContent = MONTHS[ym.m] + ' ' + ym.y;
    var monthExpenses = state.data.transactions.filter(function (t) { return t.type === 'expense' && inMonth(t.date, ym.y, ym.m); }).sort(byDateDesc);
    var totalExpenseN = monthExpenses.reduce(function (a, t) { return a + Number(t.amount); }, 0);
    q('expTotal').innerHTML = '−' + fmt(totalExpenseN) + ' <span style="font-size:15px;">' + cur + '</span>';

    var cats = [];
    monthExpenses.forEach(function (t) { if (cats.indexOf(t.category) < 0) cats.push(t.category); });
    var chipsEl = q('expChips');
    chipsEl.innerHTML = cats.map(function (c) {
      var active = state.hiddenCats.indexOf(c) < 0;
      return '<button type="button" class="chip ' + (active ? 'active' : 'inactive') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>';
    }).join('');
    Array.prototype.forEach.call(chipsEl.querySelectorAll('.chip'), function (btn) {
      btn.onclick = function () { toggleCat(btn.dataset.cat); };
    });

    var visible = monthExpenses.filter(function (t) { return state.hiddenCats.indexOf(t.category) < 0; });
    var listEl = q('expList');
    if (monthExpenses.length === 0) {
      listEl.innerHTML = '<div class="emptyState">אין הוצאות בחודש זה.<br>הקש על + כדי להוסיף.</div>';
    } else {
      listEl.innerHTML = visible.map(txRowHtml('exp')).join('');
      attachTxRowHandlers(listEl, monthExpenses);
    }
  }

  function renderIncome() {
    var ym = state.ym, cur = state.currency;
    q('incMonthLabel').textContent = MONTHS[ym.m] + ' ' + ym.y;
    var monthIncomes = state.data.transactions.filter(function (t) { return t.type === 'income' && inMonth(t.date, ym.y, ym.m); }).sort(byDateDesc);
    var totalIncomeN = monthIncomes.reduce(function (a, t) { return a + Number(t.amount); }, 0);
    q('incTotal').innerHTML = '+' + fmt(totalIncomeN) + ' <span style="font-size:15px;">' + cur + '</span>';

    var listEl = q('incList');
    if (monthIncomes.length === 0) {
      listEl.innerHTML = '<div class="emptyState">אין הכנסות בחודש זה.<br>הקש על + כדי להוסיף.</div>';
    } else {
      listEl.innerHTML = monthIncomes.map(txRowHtml('inc')).join('');
      attachTxRowHandlers(listEl, monthIncomes);
    }
  }

  function txRowHtml(kind) {
    return function (t) {
      var sign = t.type === 'income' ? '+' : '−';
      return '<button type="button" class="txRow" data-id="' + t.id + '">' +
        '<div class="info"><div class="desc">' + esc(t.description) + '</div>' +
        '<div class="meta"><span class="cat ' + kind + '">' + esc(t.category) + '</span><span class="date mono">' + dateDisp(t.date) + '</span></div></div>' +
        '<div class="amt" style="color:var(--' + kind + ')">' + sign + fmt(t.amount) + ' ' + state.currency + '</div></button>';
    };
  }
  function attachTxRowHandlers(container, list) {
    Array.prototype.forEach.call(container.querySelectorAll('.txRow'), function (btn) {
      var tx = list.find(function (t) { return String(t.id) === btn.dataset.id; });
      btn.onclick = function () { openEditTx(tx); };
    });
  }

  function renderDebts() {
    var cur = state.currency;
    var owedOpen = state.data.debts.filter(function (d) { return d.direction === 'owedToMe' && !d.paid; });
    var iOweOpen = state.data.debts.filter(function (d) { return d.direction === 'iOwe' && !d.paid; });
    var totalOwedToMeN = owedOpen.reduce(function (a, d) { return a + Number(d.amount); }, 0);
    var totalIOweN = iOweOpen.reduce(function (a, d) { return a + Number(d.amount); }, 0);
    var debtNet = totalOwedToMeN - totalIOweN;

    q('debtOwedToMe').textContent = fmt(totalOwedToMeN) + ' ' + cur;
    q('debtIOwe').textContent = fmt(totalIOweN) + ' ' + cur;
    var netEl = q('debtNet');
    netEl.style.color = debtNet >= 0 ? 'var(--inc)' : 'var(--exp)';
    netEl.textContent = (debtNet >= 0 ? '+' : '−') + fmt(debtNet) + ' ' + cur;

    Array.prototype.forEach.call(el.debtTabs.querySelectorAll('button'), function (b) {
      var isActive = b.dataset.tab === state.debtTab;
      b.classList.toggle('active', isActive);
      b.classList.toggle('inactive', !isActive);
    });

    var isOwedTab = state.debtTab === 'owedToMe';
    var openList = (isOwedTab ? owedOpen : iOweOpen).slice().sort(byDateDesc);
    var archiveList = state.data.debts.filter(function (d) { return d.direction === state.debtTab && d.paid; }).sort(byDateDesc);
    var color = isOwedTab ? 'var(--inc)' : 'var(--exp)';

    var listEl = q('debtList');
    if (openList.length === 0) {
      listEl.innerHTML = '<div class="emptyState">אין חובות פתוחים כאן.</div>';
    } else {
      listEl.innerHTML = openList.map(function (d) {
        return '<div class="debtRow"><div class="checkbox" data-toggle="' + d.id + '"></div>' +
          '<div class="info" data-edit="' + d.id + '"><div class="name">' + esc(d.name) + '</div><div class="date mono">' + dateDisp(d.date) + '</div></div>' +
          '<div class="amt mono" style="color:' + color + '" data-edit="' + d.id + '">' + fmt(d.amount) + ' ' + cur + '</div></div>';
      }).join('');
      Array.prototype.forEach.call(listEl.querySelectorAll('[data-toggle]'), function (elm) {
        elm.onclick = function () { toggleDebtPaid(elm.dataset.toggle); };
      });
      Array.prototype.forEach.call(listEl.querySelectorAll('[data-edit]'), function (elm) {
        elm.onclick = function () {
          var d = state.data.debts.find(function (x) { return String(x.id) === elm.dataset.edit; });
          if (d) openEditDebt(d);
        };
      });
    }

    var archEl = q('debtArchive');
    if (archiveList.length) {
      var rows = archiveList.map(function (d) {
        return '<div class="archiveRow"><div class="checkbox" data-untoggle="' + d.id + '">✓</div>' +
          '<div class="name">' + esc(d.name) + '</div><div class="amt mono">' + fmt(d.amount) + ' ' + cur + '</div></div>';
      }).join('');
      archEl.innerHTML = '<div class="archiveHead">נפרעו (' + archiveList.length + ')</div>' + rows;
      Array.prototype.forEach.call(archEl.querySelectorAll('[data-untoggle]'), function (elm) {
        elm.onclick = function () { toggleDebtPaid(elm.dataset.untoggle); };
      });
    } else {
      archEl.innerHTML = '';
    }
  }

  function renderModal() {
    var open = !!state.modal;
    el.modalOverlay.classList.toggle('hidden', !open);
    if (!open) return;

    var isTx = state.modal === 'expense' || state.modal === 'income';
    var isDebt = state.modal === 'debt';
    var f = state.form;

    q('modalTitle').textContent = (state.editingId ? 'עריכת ' : 'הוספת ') + (state.modal === 'expense' ? 'הוצאה' : state.modal === 'income' ? 'הכנסה' : 'חוב');
    q('fieldDesc').classList.toggle('hidden', !isTx);
    q('fieldName').classList.toggle('hidden', !isDebt);
    q('fieldCatPicker').classList.toggle('hidden', !isTx);
    q('fieldDir').classList.toggle('hidden', !isDebt);
    q('removeBtn').classList.toggle('hidden', !state.editingId);

    if (q('formDesc').value !== (f.desc || '')) q('formDesc').value = f.desc || '';
    if (q('formName').value !== (f.name || '')) q('formName').value = f.name || '';
    if (q('formAmount').value !== (f.amount || '')) q('formAmount').value = f.amount || '';
    if (q('formDate').value !== (f.date || '')) q('formDate').value = f.date || '';
    if (q('formNote').value !== (f.note || '')) q('formNote').value = f.note || '';
    if (q('formNewCat').value !== (f.newCat || '')) q('formNewCat').value = f.newCat || '';

    var saveBtn = q('saveBtn');
    saveBtn.style.background = state.modal === 'expense' ? 'var(--exp)' : state.modal === 'income' ? 'var(--inc)' : '#8A6D3B';

    if (isTx) {
      var type = state.modal;
      var stored = (state.data.categories[type] || []).slice();
      var used = [];
      state.data.transactions.filter(function (t) { return t.type === type; }).forEach(function (t) {
        if (t.category && stored.indexOf(t.category) < 0 && used.indexOf(t.category) < 0) used.push(t.category);
      });
      var allCats = stored.concat(used);
      var listEl = q('modalCatList');
      listEl.innerHTML = allCats.map(function (c) {
        var selected = f.category === c;
        var deletable = stored.indexOf(c) >= 0;
        return '<span class="catPill ' + (selected ? 'sel' : 'unsel') + '">' +
          '<span class="name" data-sel="' + esc(c) + '">' + esc(c) + '</span>' +
          (deletable ? '<span class="del" data-del="' + esc(c) + '">×</span>' : '') + '</span>';
      }).join('');
      Array.prototype.forEach.call(listEl.querySelectorAll('[data-sel]'), function (s) {
        s.onclick = function () { state.form.category = s.dataset.sel; renderModal(); };
      });
      Array.prototype.forEach.call(listEl.querySelectorAll('[data-del]'), function (s) {
        s.onclick = function (e) { e.stopPropagation(); deleteCatFromModal(type, s.dataset.del); };
      });
    }

    if (isDebt) {
      var dir = f.direction || 'owedToMe';
      Array.prototype.forEach.call(q('dirRow').querySelectorAll('button'), function (b) {
        var active = b.dataset.dir === dir;
        b.classList.toggle('active', active);
        b.classList.toggle('inactive', !active);
      });
    }
  }

  function renderCatMgr() {
    var open = state.catMgrOpen;
    el.catMgrOverlay.classList.toggle('hidden', !open);
    if (!open) return;
    var expStored = (state.data.categories.expense || []).slice();
    var used = [];
    state.data.transactions.filter(function (t) { return t.type === 'expense'; }).forEach(function (t) {
      if (t.category && expStored.indexOf(t.category) < 0 && used.indexOf(t.category) < 0) used.push(t.category);
    });
    var mgrCats = expStored.concat(used).map(function (name) {
      var count = state.data.transactions.filter(function (t) { return t.type === 'expense' && t.category === name; }).length;
      return { name: name, countLabel: count === 0 ? 'ללא רשומות' : count + ' רשומות' };
    });
    var listEl = q('mgrList');
    if (!mgrCats.length) {
      listEl.innerHTML = '<div class="emptyState">עדיין אין קטגוריות.<br>הוסף אחת למעלה.</div>';
    } else {
      listEl.innerHTML = mgrCats.map(function (c) {
        return '<div class="mgrRow"><div><div class="name">' + esc(c.name) + '</div><div class="count mono">' + c.countLabel + '</div></div>' +
          '<button type="button" data-del="' + esc(c.name) + '">מחק</button></div>';
      }).join('');
      Array.prototype.forEach.call(listEl.querySelectorAll('[data-del]'), function (b) {
        b.onclick = function () { delMgrCat(b.dataset.del); };
      });
    }
  }

  // ===================== INIT =====================

  function cacheEls() {
    ['splash', 'authScreen', 'authEmail', 'authPassword', 'authErr', 'authSubmit', 'authSwitchLine',
     'app', 'screenTitle', 'bottomNav', 'fabOverlay', 'fabMenu', 'fabBtn', 'modalOverlay', 'catMgrOverlay', 'debtTabs']
      .forEach(function (id) { el[id] = q(id); });
  }

  function wireStaticHandlers() {
    q('authForm').addEventListener('submit', handleAuthSubmit);
    q('logoutBtn').onclick = handleLogout;

    q('dashPrevMonth').onclick = function () { stepMonth(-1); };
    q('dashNextMonth').onclick = function () { stepMonth(1); };
    q('expPrevMonth').onclick = function () { stepMonth(-1); };
    q('expNextMonth').onclick = function () { stepMonth(1); };
    q('incPrevMonth').onclick = function () { stepMonth(-1); };
    q('incNextMonth').onclick = function () { stepMonth(1); };

    q('goExpensesBtn').onclick = function () { setScreen('expenses'); };
    q('goIncomeBtn').onclick = function () { setScreen('income'); };
    q('goDebtsBtn').onclick = function () { setScreen('debts'); };

    Array.prototype.forEach.call(el.bottomNav.querySelectorAll('button'), function (b) {
      b.onclick = function () { setScreen(b.dataset.screen); };
    });

    el.fabBtn.onclick = toggleFab;
    el.fabOverlay.onclick = toggleFab;
    q('fabAddIncome').onclick = function () { openAdd('income'); };
    q('fabAddExpense').onclick = function () { openAdd('expense'); };

    Array.prototype.forEach.call(el.debtTabs.querySelectorAll('button'), function (b) {
      b.onclick = function () { state.debtTab = b.dataset.tab; render(); };
    });
    q('addDebtBtn').onclick = function () { openAdd('debt'); };

    el.modalOverlay.onclick = function (e) { if (e.target === el.modalOverlay) closeModal(); };
    q('modalSheet').onclick = function (e) { e.stopPropagation(); };
    q('modalClose').onclick = closeModal;
    q('removeBtn').onclick = removeCurrent;
    q('addCatBtn').onclick = addCatFromModal;
    Array.prototype.forEach.call(q('dirRow').querySelectorAll('button'), function (b) {
      b.onclick = function () { state.form.direction = b.dataset.dir; renderModal(); };
    });

    ['formDesc', 'formName', 'formAmount', 'formDate', 'formNote'].forEach(function (id) {
      var key = { formDesc: 'desc', formName: 'name', formAmount: 'amount', formDate: 'date', formNote: 'note' }[id];
      q(id).addEventListener('input', function () { state.form[key] = this.value; });
    });

    q('txForm').addEventListener('submit', function (e) {
      e.preventDefault();
      state.form.desc = q('formDesc').value;
      state.form.name = q('formName').value;
      state.form.amount = q('formAmount').value;
      state.form.date = q('formDate').value;
      state.form.note = q('formNote').value;
      if (state.modal === 'debt') saveDebt(); else saveTransaction();
    });
    q('formNewCat').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); state.form.newCat = q('formNewCat').value; addCatFromModal(); }
    });

    el.catMgrOverlay.onclick = function (e) { if (e.target === el.catMgrOverlay) closeCatMgr(); };
    q('catMgrSheet').onclick = function (e) { e.stopPropagation(); };
    q('catMgrClose').onclick = closeCatMgr;
    q('mgrAddBtn').onclick = addMgrCat;
    q('mgrNewCat').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addMgrCat(); } });
  }

  function showSetupNotice() {
    el.splash.classList.add('hidden');
    el.authScreen.classList.remove('hidden');
    q('authForm').classList.add('hidden');
    el.authSwitchLine.textContent = '';
    showAuthErr('צריך לחבר את Supabase — מלא את config.js עם ה-URL וה-anon key מהפרויקט שלך, ואז רענן.');
  }

  document.addEventListener('DOMContentLoaded', function () {
    cacheEls();
    wireStaticHandlers();
    setAuthMode('signin');

    if (!CONFIGURED) { showSetupNotice(); return; }

    var splashDone = new Promise(function (resolve) {
      var t = setTimeout(resolve, 2000);
      el.splash.onclick = function () { clearTimeout(t); resolve(); };
    });
    var sessionCheck = sb.auth.getSession();

    Promise.all([splashDone, sessionCheck]).then(function (results) {
      var sessionRes = results[1];
      el.splash.classList.add('hidden');
      var session = sessionRes.data && sessionRes.data.session;
      if (session) { onLoggedIn(session); } else { el.authScreen.classList.remove('hidden'); }
    });
  });
})();
