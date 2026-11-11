// --- Core Data ---
let participants = {};
let sharedDishes = [];
let dishPrices = {};
let commission = 0;
let payer = null;
let payerWallet = '';

let totalsByParticipant = {};
let totalBill = 0;
let restaurantName = '';
let checkDate = ''; // YYYY-MM-DD
let currentHistoryId = null; // id записи в истории, из которой загружен / в которую сохранён текущий чек

// --- Helpers ---
// Экранирование пользовательского текста перед вставкой в innerHTML
function esc(v) {
    return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Безопасный аргумент для onclick="fn(...)": строка в JSON + экранирование для атрибута
function jsArg(v) {
    return esc(JSON.stringify(v));
}
// Сегодняшняя дата по местному времени (toISOString даёт UTC и после полуночи показывает вчера)
function todayLocal() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
// Кто реально участвует в общем блюде: только существующие участники; пустой список = все
function sharedParticipantsOf(dish, pNames) {
    const dp = (dish.participants || []).filter(n => pNames.includes(n));
    return dp.length > 0 ? dp : pNames;
}
// Убрать удалённого участника из всех общих блюд
function removeFromShared(name) {
    sharedDishes.forEach(d => {
        if (d.participants) d.participants = d.participants.filter(n => n !== name);
    });
}

// Theme Initialization
const savedTheme = localStorage.getItem('foodCalc_theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const target = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', target);
    localStorage.setItem('foodCalc_theme', target);
    updateThemeIcon(target);
    checkImagePromise = null; // картинка в другой теме устарела
    if (document.body.classList.contains('screenshot-mode') && canShareFiles()) {
        setTimeout(() => getCheckImage().catch(() => { }), 600);
    }
}

function updateThemeIcon(theme) {
    const btns = [document.getElementById('themeToggle'), document.getElementById('themeToggleSS')];
    // Show icon of the mode we can switch TO (opposite of current)
    const icon = theme === 'dark' ? '<i class="fas fa-sun"></i>' : '<i class="fas fa-moon"></i>';
    btns.forEach(btn => {
        if (btn) btn.innerHTML = icon;
    });
}

// Initialize icon on startup
window.addEventListener('DOMContentLoaded', () => {
    const currentTheme = document.documentElement.getAttribute('data-theme');
    updateThemeIcon(currentTheme);

    // Set Date
    const dateEl = document.getElementById('dateDisplay');
    if (dateEl) {
        const options = { day: 'numeric', month: 'long', year: 'numeric' };
        dateEl.innerText = new Date().toLocaleDateString('ru-RU', options);
        dateEl.style.display = 'block';
    }
});

// --- Initialization ---
window.onload = function () {
    loadFromStorage();
    updateUI();
};

function loadFromStorage() {
    participants = JSON.parse(localStorage.getItem('gs_participants') || '{}');
    sharedDishes = JSON.parse(localStorage.getItem('gs_sharedDishes') || '[]');
    dishPrices = JSON.parse(localStorage.getItem('gs_dishPrices') || '{}');
    commission = parseFloat(localStorage.getItem('gs_commission') || '0');
    payer = localStorage.getItem('gs_payer') || null;
    payerWallet = localStorage.getItem('gs_payerWallet') || '';
    restaurantName = localStorage.getItem('gs_restaurantName') || '';
    checkDate = localStorage.getItem('gs_checkDate') || todayLocal();
    currentHistoryId = parseInt(localStorage.getItem('gs_currentHistoryId')) || null;

    // Set initial input values
    document.getElementById('commission').value = commission || '';
    document.getElementById('payerWallet').value = payerWallet || '';
    document.getElementById('restaurantName').value = restaurantName;
    document.getElementById('checkDate').value = checkDate;
}

function saveToStorage() {
    localStorage.setItem('gs_participants', JSON.stringify(participants));
    localStorage.setItem('gs_sharedDishes', JSON.stringify(sharedDishes));
    localStorage.setItem('gs_dishPrices', JSON.stringify(dishPrices));
    localStorage.setItem('gs_commission', commission);
    localStorage.setItem('gs_payer', payer || '');
    localStorage.setItem('gs_payerWallet', payerWallet);
    localStorage.setItem('gs_restaurantName', restaurantName);
    localStorage.setItem('gs_checkDate', checkDate);
    localStorage.setItem('gs_currentHistoryId', currentHistoryId || '');
}

// --- History Logic ---
function getHistory() {
    return JSON.parse(localStorage.getItem('gs_history') || '[]');
}

function saveHistoryItem() {
    if (Object.keys(participants).length === 0 && sharedDishes.length === 0) {
        pushToast('error', 'Нет данных для сохранения');
        return;
    }

    const history = getHistory();

    // Format friendly date from checkDate
    const [y, m, d] = checkDate.split('-');
    const dateObj = new Date(y, m - 1, d);
    const dateStr = dateObj.toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

    const title = restaurantName || 'Без названия';

    const item = {
        id: Date.now(),
        date: dateStr,
        rawDate: checkDate,
        title: title,
        total: totalBill,
        data: {
            participants, sharedDishes, dishPrices, commission, payer, payerWallet, restaurantName, checkDate
        }
    };

    // Если этот чек уже есть в истории — обновляем запись, а не создаём дубликат
    const existing = history.findIndex(i => i.id === currentHistoryId);
    if (existing !== -1) {
        item.id = currentHistoryId;
        history.splice(existing, 1);
    }
    history.unshift(item); // Add to top
    currentHistoryId = item.id;
    localStorage.setItem('gs_history', JSON.stringify(history));
    saveToStorage();
    pushToast('success', existing !== -1 ? 'Чек обновлён в истории' : 'Чек сохранен в историю');
    renderHistoryList();
}

function openHistory() {
    renderHistoryList();
    openModal('historyModal');
}

function renderHistoryList() {
    const list = document.getElementById('historyList');
    const history = getHistory();

    const label = document.getElementById('saveHistoryLabel');
    if (label) {
        label.textContent = history.some(i => i.id === currentHistoryId)
            ? 'Обновить чек в истории'
            : 'Сохранить текущий чек';
    }

    if (history.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>История пуста</p></div>';
        return;
    }

    list.innerHTML = history.map(item => `
        <div class="item-card" style="margin-bottom: 10px; cursor: pointer;" onclick="loadHistoryItem(${item.id})">
            <div class="item-header">
                <div>
                    <span class="item-name">${esc(item.title)}</span>
                    <div style="font-size: 0.8rem; color: var(--text-muted);">${esc(item.date)}</div>
                </div>
                <div style="text-align: right;">
                    <div style="font-weight: bold; color: var(--primary);">${item.total.toFixed(2)} SM</div>
                    <button class="icon-btn delete" onclick="deleteHistoryItem(event, ${item.id})"><i class="fas fa-trash"></i></button>
                </div>
            </div>
        </div>
    `).join('');
}

function loadHistoryItem(id) {
    if (!confirm('Загрузить этот чек? Текущие несохраненные данные будут заменены.')) return;

    const history = getHistory();
    const item = history.find(i => i.id === id);

    if (item) {
        const d = item.data;
        participants = d.participants || {};
        sharedDishes = d.sharedDishes || [];
        dishPrices = d.dishPrices || {};
        commission = d.commission || 0;
        payer = d.payer || null;
        payerWallet = d.payerWallet || '';
        restaurantName = d.restaurantName || '';
        checkDate = d.checkDate || todayLocal();
        currentHistoryId = item.id;

        // Update inputs
        document.getElementById('commission').value = commission;
        document.getElementById('payerWallet').value = payerWallet;
        document.getElementById('restaurantName').value = restaurantName;
        document.getElementById('checkDate').value = checkDate;

        updateUI();
        closeModal('historyModal');
        pushToast('success', 'Чек загружен');
    }
}

function deleteHistoryItem(e, id) {
    e.stopPropagation(); // Prevent loading
    if (!confirm('Удалить эту запись из истории?')) return;

    let history = getHistory();
    history = history.filter(i => i.id !== id);
    localStorage.setItem('gs_history', JSON.stringify(history));
    renderHistoryList();
}

// --- Logic Functions ---
function addDish() {
    const name = document.getElementById('participantName').value.trim();
    const dish = document.getElementById('dishName').value.trim();
    const cost = parseFloat(document.getElementById('dishCost').value);
    const qty = parseInt(document.getElementById('dishQuantity').value) || 1;

    if (!name || !dish || isNaN(cost)) {
        pushToast('error', 'Заполните все поля правильно');
        return;
    }

    if (!participants[name]) participants[name] = [];
    participants[name].push({ dishName: dish, dishCost: cost, dishQuantity: qty });

    dishPrices[dish] = cost;

    closeModal('participantModal');
    pushToast('success', `Добавлено: ${dish} для ${name}`);

    // Clear inputs
    document.getElementById('participantName').value = '';
    document.getElementById('dishName').value = '';
    document.getElementById('dishCost').value = '';
    document.getElementById('dishQuantity').value = '1';

    updateUI();
}

function openSharedModal() {
    const container = document.getElementById('sharedParticipantsCheckboxes');
    const pNames = Object.keys(participants);
    if (pNames.length === 0) {
        container.innerHTML = '<p style="font-size: 0.85rem; color: var(--text-muted);">Сначала добавьте участников</p>';
    } else {
        container.innerHTML = pNames.map(n =>
            '<label><input type="checkbox" value="' + esc(n) + '" checked> ' + esc(n) + '</label>'
        ).join('');
    }
    openModal('sharedModal');
}

function addSharedDish() {
    const dish = document.getElementById('sharedDishName').value.trim();
    const cost = parseFloat(document.getElementById('sharedDishCost').value);
    const qty = parseInt(document.getElementById('sharedDishQuantity').value) || 1;

    if (!dish || isNaN(cost)) {
        pushToast('error', 'Заполните все поля');
        return;
    }

    const checked = document.querySelectorAll('#sharedParticipantsCheckboxes input[type="checkbox"]:checked');
    const selectedParticipants = Array.from(checked).map(cb => cb.value);
    if (Object.keys(participants).length > 0 && selectedParticipants.length === 0) {
        pushToast('error', 'Отметьте хотя бы одного участника');
        return;
    }
    sharedDishes.push({ sharedDishName: dish, sharedDishCost: cost, sharedDishQuantity: qty, participants: selectedParticipants });
    dishPrices[dish] = cost;

    closeModal('sharedModal');
    pushToast('success', `Добавлено общее блюдо: ${dish}`);

    document.getElementById('sharedDishName').value = '';
    document.getElementById('sharedDishCost').value = '';
    document.getElementById('sharedDishQuantity').value = '1';

    updateUI();
}

function calculateTotals() {
    const pNames = Object.keys(participants);
    const participantCount = pNames.length;
    totalBill = 0;
    totalsByParticipant = {};

    pNames.forEach(name => {
        const personal = participants[name].reduce((acc, d) => acc + (d.dishCost * d.dishQuantity), 0);
        const personalCommission = personal * (commission / 100);
        let sharedForPerson = 0;
        sharedDishes.forEach(d => {
            const dp = sharedParticipantsOf(d, pNames);
            if (dp.includes(name)) {
                sharedForPerson += (d.sharedDishCost * d.sharedDishQuantity) / dp.length;
            }
        });
        const sharedCommission = sharedForPerson * (commission / 100);
        const final = personal + personalCommission + sharedForPerson + sharedCommission;
        totalsByParticipant[name] = final;
        totalBill += final;
    });

    if (participantCount === 0) {
        const subtotalShared = sharedDishes.reduce((acc, d) => acc + (d.sharedDishCost * d.sharedDishQuantity), 0);
        totalBill = subtotalShared + (subtotalShared * (commission / 100));
    }

    roundTotals();
}

// Округление до дирамов так, чтобы суммы сходились:
// общий счёт округляется один раз, а недостающие дирамы раздаются
// участникам с наибольшими отброшенными остатками (метод наибольшего остатка).
// Тогда сумма долгов всегда равна «К возврату», а сумма всех — общему счёту.
function roundTotals() {
    const totalCents = Math.round(totalBill * 100 + 1e-6);
    totalBill = totalCents / 100;

    const names = Object.keys(totalsByParticipant);
    if (names.length === 0) return;

    const parts = names.map(name => {
        const exact = totalsByParticipant[name] * 100;
        const floor = Math.floor(exact + 1e-6);
        return { name, cents: floor, rest: exact - floor };
    });
    let left = totalCents - parts.reduce((acc, p) => acc + p.cents, 0);
    parts.slice().sort((a, b) => b.rest - a.rest).forEach(p => {
        if (left > 0) { p.cents++; left--; }
    });
    parts.forEach(p => { totalsByParticipant[p.name] = p.cents / 100; });
}

function updateUI() {
    calculateTotals();
    saveToStorage();

    document.getElementById('totalCostDisplay').innerText = `Общая Стоимость: ${totalBill.toFixed(2)} SM`;
    document.getElementById('screenshotTotalAmount').innerText = `${totalBill.toFixed(2)} SM`;

    const commSpan = document.getElementById('screenshotCommission');
    if (commSpan) {
        commSpan.innerText = commission > 0 ? ` (+${commission}%)` : '';
    }

    renderSharedList();
    renderParticipantsList();
    updateDatalists();
    updatePayerSelect();
    updatePayerUI();

    renderRestaurantBadge();

    // Update Screenshot Date & Header Date
    const [y, m, d] = checkDate.split('-');
    const dateObj = new Date(y, m - 1, d);
    const friendlyDate = dateObj.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

    const screenshotBadge = document.getElementById('screenshotDateBadge');
    if (screenshotBadge) screenshotBadge.innerText = friendlyDate;

    const headerBadge = document.getElementById('dateDisplay');
    if (headerBadge) {
        headerBadge.innerText = friendlyDate;
        headerBadge.style.display = 'block';
    }
}

function updateDate() {
    checkDate = document.getElementById('checkDate').value;
    updateUI();
}

function updateRestaurantName() {
    restaurantName = document.getElementById('restaurantName').value;
    saveToStorage();
    renderRestaurantBadge();
}

function renderRestaurantBadge() {
    const badge = document.getElementById('restaurantBadge');
    const display = document.getElementById('restaurantNameDisplay');
    badge.style.display = restaurantName ? 'flex' : 'none';
    badge.classList.toggle('is-empty', !restaurantName);
    display.innerText = restaurantName ? `📍 ${restaurantName}` : '';
}

function renderSharedList() {
    const container = document.getElementById('sharedList');
    if (sharedDishes.length === 0) {
        container.innerHTML = `
            <div class="empty-state" onclick="openModal('sharedModal')">
                <i class="fas fa-pizza-slice"></i>
                <p>Общих блюд пока нет</p>
                <span class="cta-text">Нажмите, чтобы добавить угощения</span>
            </div>`;
        return;
    }

    const allPNames = Object.keys(participants);
    container.innerHTML = sharedDishes.map((d, i) => {
        const dp = sharedParticipantsOf(d, allPNames);
        const label = allPNames.length > 0 && allPNames.every(n => dp.includes(n))
            ? 'все участники'
            : dp.length > 0 ? dp.map(esc).join(', ') : 'нет участников';
        return `<div class="dish-item" style="flex-direction:column;align-items:stretch;padding:6px 8px;gap:2px;">
            <div style="display:flex;justify-content:space-between;align-items:center;">
                <span><strong>${d.sharedDishQuantity}х</strong> ${esc(d.sharedDishName)} — ${(d.sharedDishCost * d.sharedDishQuantity).toFixed(2)} SM</span>
                <div class="dish-controls">
                    <button class="icon-btn" onclick="openEdit('shared', ${i})"><i class="fas fa-edit"></i></button>
                    <button class="icon-btn delete" onclick="deleteItem('shared', ${i})"><i class="fas fa-trash"></i></button>
                </div>
            </div>
            <div style="font-size:0.75rem;color:var(--text-muted);padding-left:2px;">
                <i class="fas fa-users" style="font-size:0.7rem;margin-right:4px;"></i>` + label + `
            </div>
        </div>`;
    }).join('');
}

function renderParticipantsList() {
    const container = document.getElementById('participantsList');
    const pNames = Object.keys(participants);

    if (pNames.length === 0) {
        container.innerHTML = `
            <div class="empty-state" onclick="openModal('participantModal')">
                <i class="fas fa-user-plus"></i>
                <p>Список участников пуст</p>
                <span class="cta-text">Нажмите, чтобы добавить первого</span>
            </div>`;
        return;
    }

    container.innerHTML = pNames.map(name => {
        const dishes = participants[name];
        const personalSubtotal = dishes.reduce((acc, d) => acc + (d.dishCost * d.dishQuantity), 0);
        const isPayer = (name === payer);

        return `
            <div class="item-card ${isPayer ? 'payer-card' : ''}">
                <div class="item-header">
                    <span class="item-name">${esc(name)}</span>
                    <button class="icon-btn delete" onclick="deleteParticipant(${jsArg(name)})"><i class="fas fa-user-minus"></i></button>
                </div>
                <div class="dish-list">
                    ${dishes.map((d, idx) => `
                        <div class="dish-item">
                            <span>${d.dishQuantity}х ${esc(d.dishName)} — ${(d.dishCost * d.dishQuantity).toFixed(2)} SM</span>
                            <div class="dish-controls">
                                <button class="icon-btn" onclick="openEdit('personal', ${idx}, ${jsArg(name)})"><i class="fas fa-edit"></i></button>
                                <button class="icon-btn delete" onclick="deleteItem('personal', ${idx}, ${jsArg(name)})"><i class="fas fa-trash"></i></button>
                            </div>
                        </div>
                    `).join('')}
                </div>
                <div class="summary-badge">
                    <div class="summary-row"><span>Промежуточный итог:</span><span>${personalSubtotal.toFixed(2)} SM</span></div>
                    <div class="summary-row"><span>Доля общих + комиссия:</span><span>${(totalsByParticipant[name] - personalSubtotal * (1 + commission / 100)).toFixed(2)} SM</span></div>
                    ${sharedDishes.map(d => {
                        const dp = sharedParticipantsOf(d, Object.keys(participants));
                        if (!dp.includes(name)) return '';
                        const share = (d.sharedDishCost * d.sharedDishQuantity) / dp.length * (1 + commission / 100);
                        return '<div class="summary-row" style="padding-left:10px;font-size:0.8rem;opacity:0.75;"><span>└ ' + esc(d.sharedDishName) + ' (1/' + dp.length + ')</span><span>' + share.toFixed(2) + ' SM</span></div>';
                    }).join('')}
                    <div class="summary-total"><span>Итого к оплате:</span><span>${totalsByParticipant[name].toFixed(2)} SM</span></div>
                </div>
            </div>
        `;
    }).join('');
}

function updateDatalists() {
    const pList = document.getElementById('participantsDatalist');
    const dList = document.getElementById('dishNamesDatalist');

    pList.innerHTML = Object.keys(participants).map(n => `<option value="${esc(n)}">`).join('');
    dList.innerHTML = Object.keys(dishPrices).map(d => `<option value="${esc(d)}">`).join('');
}

// Автозаполнение цены при изменении названия блюда
document.getElementById('dishName').addEventListener('input', function (e) {
    const val = e.target.value;
    if (dishPrices[val]) {
        document.getElementById('dishCost').value = dishPrices[val];
    }
});

// --- Payer Logic ---
function updatePayerSelect() {
    const select = document.getElementById('payerSelect');
    const current = select.value || payer;
    select.innerHTML = '<option value="">Кто платил?</option>';
    Object.keys(participants).forEach(n => {
        const opt = document.createElement('option');
        opt.value = n;
        opt.innerText = n;
        select.appendChild(opt);
    });
    select.value = current || "";
}

function updatePayer() {
    payer = document.getElementById('payerSelect').value || null;
    updateUI();
}

document.getElementById('payerWallet').addEventListener('input', (e) => {
    payerWallet = e.target.value;
    saveToStorage();
    updatePayerUI();
});

function updatePayerUI() {
    const box = document.getElementById('payerInfoBox');
    if (!payer) {
        box.classList.add('hidden');
        return;
    }

    box.classList.remove('hidden');
    document.getElementById('payerNameDisplay').innerText = payer;

    // Show/Hide wallet
    const walletBox = document.getElementById('walletDisplayBox');
    walletBox.classList.toggle('is-empty', !payerWallet);
    if (payerWallet) {
        walletBox.style.display = 'flex';
        document.getElementById('payerWalletDisplay').innerText = payerWallet;
    } else {
        walletBox.style.display = 'none';
    }

    const payerDue = totalsByParticipant[payer] || 0;
    const reimbursement = Math.round((totalBill - payerDue) * 100) / 100;
    const reimEl = document.getElementById('payerReimbursement');
    if (reimEl) reimEl.innerText = `${reimbursement.toFixed(2)} SM`;

    // Debts Grid (Ultra-Compact)
    const debtsContainer = document.getElementById('debtsContainer');
    if (!debtsContainer) return;

    const pNames = Object.keys(participants).filter(n => n !== payer);

    if (pNames.length === 0) {
        debtsContainer.innerHTML = `<p style="font-size: 0.85rem; color: var(--text-muted); opacity: 0.6;">Других участников пока нет</p>`;
    } else {
        debtsContainer.innerHTML = `
            <div class="only-screenshot debts-label">К оплате другими участниками:</div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin-top: 4px;">
                ${pNames.map(n => `
                    <div class="debt-pill" style="background: var(--bg-item); padding: 5px 10px; border-radius: 6px; border: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; line-height: 1;">
                        <span class="debt-name" style="font-size: 0.8rem; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 90px;">${esc(n)}</span>
                        <span class="debt-amount" style="font-weight: 700; color: var(--primary); font-size: 0.8rem;">${totalsByParticipant[n].toFixed(2)} <small style="font-size: 0.65rem; opacity: 0.8;">SM</small></span>
                    </div>
                `).join('')}
            </div>
        `;
    }
}

function applyCommissionLive() {
    commission = parseFloat(document.getElementById('commission').value) || 0;
    updateUI();
}

function setCommission() {
    commission = parseFloat(document.getElementById('commission').value) || 0;
    pushToast('success', `Комиссия установлена: ${commission}%`);
    updateUI();
}

// --- Editing ---
function openEdit(type, id, pName = '') {
    const modal = document.getElementById('editModal');
    document.getElementById('editType').value = type;
    document.getElementById('editId').value = id;
    document.getElementById('editParticipant').value = pName;

    let data;
    const editParticipantsField = document.getElementById('editParticipantsField');
    if (type === 'shared') {
        data = sharedDishes[id];
        document.getElementById('editName').value = data.sharedDishName;
        document.getElementById('editCost').value = data.sharedDishCost;
        document.getElementById('editQuantity').value = data.sharedDishQuantity;
        document.getElementById('editModalTitle').innerText = 'Редактировать общее';
        const pNames = Object.keys(participants);
        const saved = sharedParticipantsOf(data, pNames);
        const cont = document.getElementById('editParticipantsCheckboxes');
        cont.innerHTML = pNames.length === 0
            ? '<p style="font-size:0.85rem;color:var(--text-muted);">Нет участников</p>'
            : pNames.map(n => '<label><input type="checkbox" value="' + esc(n) + '"' + (saved.includes(n) ? ' checked' : '') + '> ' + esc(n) + '</label>').join('');
        editParticipantsField.classList.remove('hidden');
    } else {
        editParticipantsField.classList.add('hidden');
        data = participants[pName][id];
        document.getElementById('editName').value = data.dishName;
        document.getElementById('editCost').value = data.dishCost;
        document.getElementById('editQuantity').value = data.dishQuantity;
        document.getElementById('editModalTitle').innerText = `Для ${pName}`;
    }

    openModal('editModal');
}

function saveEdit() {
    const type = document.getElementById('editType').value;
    const id = document.getElementById('editId').value;
    const pName = document.getElementById('editParticipant').value;

    const newName = document.getElementById('editName').value.trim();
    const newCost = parseFloat(document.getElementById('editCost').value);
    const newQty = parseInt(document.getElementById('editQuantity').value) || 1;

    if (type === 'shared') {
        const editChecked = document.querySelectorAll('#editParticipantsCheckboxes input[type="checkbox"]:checked');
        const selectedParticipants = Array.from(editChecked).map(cb => cb.value);
        if (Object.keys(participants).length > 0 && selectedParticipants.length === 0) {
            pushToast('error', 'Отметьте хотя бы одного участника');
            return;
        }
        sharedDishes[id] = { sharedDishName: newName, sharedDishCost: newCost, sharedDishQuantity: newQty, participants: selectedParticipants };
    } else {
        participants[pName][id] = { dishName: newName, dishCost: newCost, dishQuantity: newQty };
    }

    closeModal('editModal');
    updateUI();
    pushToast('success', 'Изменения сохранены');
}

function deleteItem(type, id, pName = '') {
    if (type === 'shared') {
        sharedDishes.splice(id, 1);
    } else {
        participants[pName].splice(id, 1);
        if (participants[pName].length === 0) {
            delete participants[pName];
            removeFromShared(pName);
            if (payer === pName) payer = null;
        }
    }
    updateUI();
}

function deleteParticipant(name) {
    if (confirm(`Удалить участника ${name} и все его блюда?`)) {
        delete participants[name];
        removeFromShared(name);
        if (payer === name) payer = null;
        updateUI();
    }
}

function confirmClearAll() {
    if (Object.keys(participants).length > 0 || sharedDishes.length > 0) {
        if (confirm('Сохранить текущий чек в историю перед очисткой?')) {
            saveHistoryItem();
        }
    }

    if (confirm('Вы уверены, что хотите очистить все данные?')) {
        participants = {};
        sharedDishes = [];
        dishPrices = {};
        commission = 0;
        payer = null;
        payerWallet = '';
        restaurantName = ''; // Fixed: Reset restaurant name
        checkDate = todayLocal(); // Reset to today
        currentHistoryId = null;

        document.getElementById('commission').value = '';
        document.getElementById('payerWallet').value = '';
        document.getElementById('restaurantName').value = ''; // Clear input
        document.getElementById('checkDate').value = checkDate;

        updateUI();
        pushToast('success', 'Все данные очищены');
    }
}

// --- Modals & Toasts ---
function openModal(id) {
    document.getElementById(id).style.display = 'flex';
}

function closeModal(id) {
    document.getElementById(id).style.display = 'none';
}

function pushToast(type, message) {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icon = type === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle';
    toast.innerHTML = `<i class="fas ${icon}"></i> <span></span>`;
    toast.querySelector('span').textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(20px)';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function toggleScreenshotMode() {
    const on = document.body.classList.toggle('screenshot-mode');
    window.scrollTo(0, 0);
    checkImagePromise = null;
    if (on) {
        setupShareButton();
        // Готовим картинку заранее: iPhone разрешает «Поделиться» только сразу после нажатия
        if (canShareFiles()) setTimeout(() => getCheckImage().catch(() => { }), 600);
    }
}

// --- Картинка чека: скачать / поделиться ---
let checkImagePromise = null; // кэш готовой картинки для текущего вида экрана

function checkFileName() {
    return `check_food_calc_${checkDate || todayLocal()}.png`;
}

function canShareFiles() {
    // Только телефоны и планшеты: на компьютерах браузеры иногда заявляют поддержку,
    // но отправка не работает, а «Скачать» там и так удобнее
    if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return false;
    try {
        return !!(navigator.canShare && navigator.canShare({
            files: [new File([''], 'check.png', { type: 'image/png' })]
        }));
    } catch (e) {
        return false;
    }
}

function setupShareButton() {
    const supported = canShareFiles();
    document.getElementById('shareBtn').classList.toggle('is-hidden', !supported);
    document.getElementById('screenshotExit').classList.toggle('has-share', supported);
}

function renderCheckCanvas() {
    return html2canvas(document.body, {
        backgroundColor: getComputedStyle(document.body).backgroundColor,
        scale: 2, // Better quality
        onclone: (clonedDoc) => {
            // Hide controls ONLY in the screenshot, not in the real DOM
            const exitControls = clonedDoc.querySelector('.screenshot-exit');
            if (exitControls) {
                // Use setProperty with 'important' to override the CSS !important
                exitControls.style.setProperty('display', 'none', 'important');
            }
        }
    });
}

// Возвращает Promise<File> с картинкой чека (из кэша, если уже готова)
function getCheckImage() {
    if (!checkImagePromise) {
        checkImagePromise = renderCheckCanvas()
            .then(canvas => new Promise((resolve, reject) =>
                canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png')))
            .then(blob => new File([blob], checkFileName(), { type: 'image/png' }))
            .catch(err => {
                checkImagePromise = null;
                throw err;
            });
    }
    return checkImagePromise;
}

function setBusy(btn, busy) {
    if (busy) {
        btn.dataset.html = btn.innerHTML;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>';
        btn.style.opacity = '0.8';
    } else if (btn.dataset.html) {
        btn.innerHTML = btn.dataset.html;
        btn.style.opacity = '1';
    }
}

function shareImage(e) {
    const btn = e.currentTarget;
    setBusy(btn, true);
    getCheckImage().then(file => {
        setBusy(btn, false);
        const title = restaurantName ? `Чек — ${restaurantName}` : 'Чек';
        return navigator.share({ files: [file], title }).catch(err => {
            if (err.name === 'AbortError') return; // пользователь закрыл меню
            if (err.name === 'NotAllowedError') {
                // Картинка готовилась слишком долго — теперь она в кэше, второе нажатие сработает сразу
                pushToast('success', 'Картинка готова — нажмите «Поделиться» ещё раз');
                return;
            }
            // Поделиться не вышло — просто скачиваем картинку
            console.error(err);
            saveFile(file);
            pushToast('success', 'Поделиться не получилось — картинка скачана');
        });
    }).catch(err => {
        console.error(err);
        setBusy(btn, false);
        pushToast('error', 'Ошибка при создании картинки');
    });
}

function saveFile(file) {
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.download = file.name;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Add Escape key listener to exit screenshot mode
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('screenshot-mode')) {
        toggleScreenshotMode();
    }
});

function downloadImage(e) {
    const btn = e.currentTarget;
    setBusy(btn, true);
    getCheckImage().then(file => {
        setBusy(btn, false);
        saveFile(file);
        pushToast('success', 'Чек сохранен!');
    }).catch(err => {
        console.error(err);
        setBusy(btn, false);
        pushToast('error', 'Ошибка при создании картинки');
    });
}

function copyWallet() {
    const val = document.getElementById('payerWallet').value;
    if (!val) {
        pushToast('error', 'Номер кошелька пуст');
        return;
    }
    navigator.clipboard.writeText(val);
    pushToast('success', 'Номер скопирован в буфер');
}

// Close modal on click outside
window.onclick = function (event) {
    if (event.target.className === 'modal') {
        event.target.style.display = 'none';
    }
};
