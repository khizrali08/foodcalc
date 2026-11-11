// Экран «Чек»: фото → распознавание (Gemini или Tesseract) → проверка позиций → разметка «кто что ел».
// Зависит от app.js: participants, sharedDishes, dishPrices, commission, payer, payerWallet,
// restaurantName, checkDate, currentHistoryId, updateUI, saveHistoryItem, getHistory, esc, jsArg,
// pushToast, openModal, closeModal, todayLocal.

const RC_DRAFT_KEY = 'gs_receiptDraft';
const RC_GEMINI_KEY = 'gs_geminiKey';
const RC_GEMINI_MODEL = 'gs_geminiModel';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const TESSERACT_LANG = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/rus/4.0.0_best_int';
const JSQR_URL = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js';

let rc = null;          // черновик чека
let rcOpenId = null;    // раскрытая позиция
let rcBusy = false;

const FLAG_NOTE = {
    check: 'Проверьте количество и цену — распознано неуверенно',
    name: 'Проверьте название',
    price: 'Цена не распознана — впишите её',
    auto: 'Цена вычислена по итогу чека'
};

// ---------- Черновик ----------
function rcNew() {
    return { people: [], items: [], subtotal: null, total: null, service: null, date: '', place: '', nextId: 1, source: '' };
}

function rcLoad() {
    try {
        const d = JSON.parse(localStorage.getItem(RC_DRAFT_KEY) || 'null');
        if (d && Array.isArray(d.items)) return Object.assign(rcNew(), d);
    } catch (e) { /* повреждённый черновик — начать заново */ }
    return rcNew();
}

function rcSave() {
    try { localStorage.setItem(RC_DRAFT_KEY, JSON.stringify(rc)); } catch (e) { /* переполнено — не критично */ }
}

const rcCents = v => Math.round((+v || 0) * 100);
const rcMoney = v => (Math.round((+v || 0) * 100) / 100).toFixed(2);
const rcItemSum = it => (it.price == null ? 0 : rcCents(it.price) * it.qty) / 100;
const rcOwned = it => Object.values(it.own || {}).reduce((a, n) => a + n, 0);
const rcRemaining = it => Math.max(0, it.qty - rcOwned(it));

function rcItem(o) {
    return {
        id: rc.nextId++,
        name: o.name || '',
        price: o.price == null || isNaN(o.price) ? null : Math.round(o.price * 100) / 100,
        qty: Math.max(1, Math.round(o.qty || 1)),
        flag: o.flag || null,
        own: {},
        group: []
    };
}

// ---------- Открытие ----------
function openReceipt() {
    rc = rcLoad();
    if (rc.people.length === 0) rc.people = Object.keys(participants);
    if (!rc.date) rc.date = checkDate || todayLocal();
    if (!rc.place) rc.place = restaurantName || '';
    rcSave();
    renderReceipt();
    openModal('receiptModal');
}

function receiptReset() {
    if (rc.items.length && !confirm('Очистить список позиций чека?')) return;
    const people = rc.people;
    rc = rcNew();
    rc.people = people;
    rc.date = todayLocal();
    rcOpenId = null;
    rcSave();
    renderReceipt();
}

// ---------- Люди ----------
function rcKnownNames() {
    const names = new Set(Object.keys(participants));
    getHistory().forEach(h => Object.keys((h.data && h.data.participants) || {}).forEach(n => names.add(n)));
    return [...names].filter(n => !rc.people.includes(n));
}

function rcAddPerson(name) {
    name = String(name || '').trim();
    if (!name) return;
    if (rc.people.includes(name)) { pushToast('error', `${name} уже в списке`); return; }
    rc.people.push(name);
    rcSave();
    renderReceipt();
    const inp = document.getElementById('rcPersonInput');
    if (inp) inp.focus();
}

function rcPersonKey(e) {
    if (e.key === 'Enter') {
        e.preventDefault();
        rcAddPerson(e.target.value);
    }
}

function rcRemovePerson(name) {
    rc.people = rc.people.filter(n => n !== name);
    rc.items.forEach(it => {
        delete it.own[name];
        it.group = it.group.filter(n => n !== name);
    });
    rcSave();
    renderReceipt();
}

// ---------- Позиции ----------
function rcAddItem() {
    const it = rcItem({ name: '', price: null, qty: 1 });
    rc.items.push(it);
    rcOpenId = it.id;
    rcSave();
    renderReceipt();
    const el = document.getElementById('rcName' + it.id);
    if (el) el.focus();
}

function rcToggle(id) {
    rcOpenId = rcOpenId === id ? null : id;
    renderReceipt();
}

function rcFind(id) { return rc.items.find(i => i.id === id); }

function rcEdit(id, field, value) {
    const it = rcFind(id);
    if (!it) return;
    if (field === 'name') it.name = value.trim();
    if (field === 'price') {
        const v = parseFloat(String(value).replace(',', '.'));
        it.price = isNaN(v) ? null : Math.round(v * 100) / 100;
    }
    if (field === 'qty') {
        it.qty = Math.max(1, parseInt(value) || 1);
        // Если штук стало меньше, чем уже распределено, — сбросить распределение
        if (rcOwned(it) > it.qty) it.own = {};
    }
    it.flag = it.price == null ? 'price' : null;
    rcSave();
    renderReceipt();
}

function rcDelete(id) {
    rc.items = rc.items.filter(i => i.id !== id);
    if (rcOpenId === id) rcOpenId = null;
    rcSave();
    renderReceipt();
}

// Нажатие на имя: +1 штука; когда всё распределено — сброс у этого человека
function rcTapOwner(id, name) {
    const it = rcFind(id);
    if (!it) return;
    const cur = it.own[name] || 0;
    if (rcRemaining(it) > 0) {
        it.own[name] = cur + 1;
    } else if (cur > 0) {
        delete it.own[name];
    } else if (it.qty === 1) {
        it.own = { [name]: 1 }; // одна штука — просто передать другому
    } else {
        pushToast('error', `Все ${it.qty} шт уже распределены — нажмите на имя, чтобы убрать`);
        return;
    }
    rcSave();
    renderReceipt();
}

function rcTapGroup(id, name) {
    const it = rcFind(id);
    if (!it) return;
    if (name === null) it.group = [];
    else if (it.group.includes(name)) it.group = it.group.filter(n => n !== name);
    else it.group.push(name);
    rcSave();
    renderReceipt();
}

// Подпись «чьё» в свёрнутой строке: «👤 Хизрали ×2 · Рачабали ×1», «👥 на всех», «👤 Али · 👥 ост. 2 — на всех»
function rcWho(it) {
    const own = Object.entries(it.own).map(([n, c]) => esc(n) + (it.qty > 1 ? ' ×' + c : ''));
    const rest = rcRemaining(it);
    let shared = '';
    if (rest > 0) {
        const group = it.group.filter(n => rc.people.includes(n));
        const who = group.length ? group.map(esc).join(', ') : 'на всех';
        const icon = group.length === 1 ? '👤' : '👥';
        shared = own.length ? `${icon} ост. ${rest} — ${who}` : `${icon} ${who}`;
    }
    if (!own.length) return shared;
    return '👤 ' + own.join(' · ') + (shared ? ' · ' + shared : '');
}

// ---------- Отрисовка ----------
function renderReceipt() {
    const body = document.getElementById('receiptBody');
    if (!body) return;

    const known = rcKnownNames().slice(0, 14);
    const peopleHtml = rc.people.map(n =>
        `<span class="rc-chip on">${esc(n)}<button class="rc-x" onclick="rcRemovePerson(${jsArg(n)})" title="Убрать">×</button></span>`
    ).join('');
    const suggestHtml = known.map(n =>
        `<button class="rc-chip rc-suggest" onclick="rcAddPerson(${jsArg(n)})">+ ${esc(n)}</button>`
    ).join('');

    const itemsHtml = rc.items.length === 0
        ? `<div class="rc-empty">Сфотографируйте чек или добавьте позиции вручную</div>`
        : rc.items.map(rcItemHtml).join('');

    body.innerHTML = `
        <div class="rc-section">
            <div class="rc-label">Кто был <span class="rc-muted">(${rc.people.length})</span></div>
            <div class="rc-chips">${peopleHtml}
                <input id="rcPersonInput" class="rc-person-input" placeholder="+ имя, Enter" list="rcPeopleList"
                    onkeydown="rcPersonKey(event)" onchange="rcAddPerson(this.value)">
                <datalist id="rcPeopleList">${rcKnownNames().map(n => `<option value="${esc(n)}">`).join('')}</datalist>
            </div>
            ${suggestHtml ? `<div class="rc-chips rc-suggest-row">${suggestHtml}</div>` : ''}
        </div>
        <div class="rc-section">
            <div class="rc-label">Позиции <span class="rc-muted">— нажмите, чтобы указать, чьё</span></div>
            ${itemsHtml}
            <button class="btn btn-secondary rc-add" onclick="rcAddItem()"><i class="fas fa-plus"></i> Позиция</button>
        </div>
        <div class="rc-section rc-meta">
            <div class="field"><label>Дата</label><input type="date" value="${esc(rc.date)}" onchange="rc.date=this.value;rcSave()"></div>
            <div class="field"><label>Место</label><input value="${esc(rc.place)}" placeholder="Где сидели?" onchange="rc.place=this.value.trim();rcSave()"></div>
            <div class="field"><label>Сервис (%)</label><input type="number" min="0" value="${rc.service ?? ''}" placeholder="0" oninput="rc.service=parseFloat(this.value)||0;rcSave();rcRenderSummary()"></div>
            <div class="field"><label>Сумма по чеку</label><input type="number" min="0" step="0.01" value="${rc.subtotal ?? ''}" placeholder="без сервиса" oninput="rc.subtotal=this.value===''?null:parseFloat(this.value);rcSave();rcRenderSummary()"></div>
        </div>`;
    rcRenderSummary();
    rcRenderAiStatus();
}

function rcItemHtml(it) {
    const open = it.id === rcOpenId;
    const flagIcon = it.flag ? `<i class="fas ${it.flag === 'auto' ? 'fa-calculator' : 'fa-exclamation-triangle'} rc-flag-icon"></i> ` : '';
    const sum = it.price == null ? '—' : rcMoney(rcItemSum(it));
    const price = it.price == null ? '?' : rcMoney(it.price).replace(/\.00$/, '');
    let html = `
        <div class="rc-item ${open ? 'open' : ''} ${it.flag ? 'flag-' + it.flag : ''}">
            <div class="rc-item-head" onclick="rcToggle(${it.id})">
                <div class="rc-item-name">${flagIcon}${esc(it.name) || '<span class="rc-muted">без названия</span>'}</div>
                <div class="rc-item-sum">${it.qty > 1 ? `<span class="rc-muted">${it.qty} × ${price}</span> ` : ''}${sum}</div>
                <div class="rc-item-who">${rcWho(it)}</div>
            </div>`;
    if (open) {
        const rest = rcRemaining(it);
        const owners = rc.people.map(n => {
            const c = it.own[n] || 0;
            return `<button class="rc-chip ${c ? 'on' : ''}" onclick="rcTapOwner(${it.id}, ${jsArg(n)})">${esc(n)}${c && it.qty > 1 ? `<span class="rc-cnt">${c}</span>` : ''}</button>`;
        }).join('');
        const group = rest > 0 && rc.people.length > 1 ? `
            <div class="rc-label">${rcOwned(it) ? `Остаток ${rest} шт` : (it.qty > 1 ? `Все ${it.qty} шт` : 'Если ели вместе')} — делят:</div>
            <div class="rc-chips">
                <button class="rc-chip ${it.group.length === 0 ? 'on' : ''}" onclick="rcTapGroup(${it.id}, null)">👥 Все</button>
                ${rc.people.map(n => `<button class="rc-chip ${it.group.includes(n) ? 'on' : ''}" onclick="rcTapGroup(${it.id}, ${jsArg(n)})">${esc(n)}</button>`).join('')}
            </div>` : '';
        html += `
            <div class="rc-item-edit">
                ${it.flag ? `<div class="rc-note">${FLAG_NOTE[it.flag]}</div>` : ''}
                <div class="rc-edit-row">
                    <input id="rcName${it.id}" class="rc-in-name" value="${esc(it.name)}" placeholder="Название" onchange="rcEdit(${it.id}, 'name', this.value)">
                    <input class="rc-in-num" type="number" step="0.01" min="0" value="${it.price ?? ''}" placeholder="Цена" title="Цена за штуку" onchange="rcEdit(${it.id}, 'price', this.value)">
                    <input class="rc-in-qty" type="number" min="1" value="${it.qty}" title="Количество" onchange="rcEdit(${it.id}, 'qty', this.value)">
                    <button class="icon-btn delete" onclick="rcDelete(${it.id})" title="Удалить позицию"><i class="fas fa-trash"></i></button>
                </div>
                ${rc.people.length ? `
                <div class="rc-label">Чьё? ${it.qty > 1 ? '<span class="rc-muted">нажатие на имя — +1 шт</span>' : ''}</div>
                <div class="rc-chips">${owners}</div>
                ${group}` : '<div class="rc-note">Сначала добавьте, кто был</div>'}
            </div>`;
    }
    return html + '</div>';
}

function rcRenderSummary() {
    const el = document.getElementById('receiptSummary');
    if (!el || !rc) return;
    const itemsSum = rc.items.reduce((a, it) => a + rcItemSum(it), 0);
    const svc = rc.service || 0;
    const lines = [];
    let check = '';
    if (rc.subtotal != null) {
        const diff = Math.round((rc.subtotal - itemsSum) * 100) / 100;
        check = diff === 0
            ? ` <span class="rc-ok"><i class="fas fa-check-circle"></i> как в чеке</span>`
            : ` <span class="rc-bad"><i class="fas fa-exclamation-triangle"></i> в чеке ${rcMoney(rc.subtotal)}, ${diff > 0 ? 'не хватает' : 'лишние'} ${rcMoney(Math.abs(diff))}</span>`;
    }
    lines.push(`<div class="rc-sum-row"><span>Позиции (${rc.items.length})${check}</span><b>${rcMoney(itemsSum)}</b></div>`);
    if (svc) lines.push(`<div class="rc-sum-row"><span>Итого с сервисом ${svc}%</span><b>${rcMoney(itemsSum * (1 + svc / 100))}</b></div>`);
    const missing = rc.items.filter(i => i.price == null).length;
    if (missing) lines.push(`<div class="rc-sum-row bad"><span>Без цены: ${missing}</span></div>`);
    if (!rc.people.length) lines.push(`<div class="rc-sum-row bad"><span>Добавьте, кто был</span></div>`);
    el.innerHTML = lines.join('');
}

function rcProgress(text, pct) {
    const box = document.getElementById('receiptProgress');
    if (!box) return;
    if (text == null) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.querySelector('span').textContent = text;
    box.querySelector('.rc-bar').style.width = (pct == null ? 100 : Math.round(pct)) + '%';
    box.classList.toggle('indeterminate', pct == null);
}

// ---------- Перенос в расчёт ----------
function receiptApply() {
    if (!rc.people.length) { pushToast('error', 'Добавьте, кто был'); return; }
    if (!rc.items.length) { pushToast('error', 'Нет позиций'); return; }
    if (rc.items.some(i => i.price == null)) { pushToast('error', 'У некоторых позиций нет цены'); return; }

    const hasData = Object.keys(participants).length > 0 || sharedDishes.length > 0;
    if (hasData) {
        if (!confirm('Текущий расчёт будет заменён этим чеком. Продолжить?')) return;
        if (confirm('Сохранить текущий расчёт в историю перед заменой?')) saveHistoryItem();
    }

    const newParticipants = {};
    rc.people.forEach(n => { newParticipants[n] = []; });
    const newShared = [];
    const prices = {};

    rc.items.forEach(it => {
        const name = it.name || 'Без названия';
        prices[name] = it.price;
        Object.entries(it.own).forEach(([n, c]) => {
            if (newParticipants[n] && c > 0) newParticipants[n].push({ dishName: name, dishCost: it.price, dishQuantity: c });
        });
        const rest = rcRemaining(it);
        if (rest > 0) {
            const group = it.group.filter(n => rc.people.includes(n));
            if (group.length === 1) {
                newParticipants[group[0]].push({ dishName: name, dishCost: it.price, dishQuantity: rest });
            } else {
                // Пустой список = все участники
                const all = group.length === 0 || group.length === rc.people.length;
                newShared.push({ sharedDishName: name, sharedDishCost: it.price, sharedDishQuantity: rest, participants: all ? [] : group });
            }
        }
    });

    participants = newParticipants;
    sharedDishes = newShared;
    dishPrices = Object.assign({}, dishPrices, prices);
    commission = rc.service || 0;
    restaurantName = rc.place || '';
    checkDate = rc.date || todayLocal();
    if (!participants[payer]) payer = null;
    currentHistoryId = null;

    document.getElementById('commission').value = commission || '';
    document.getElementById('restaurantName').value = restaurantName;
    document.getElementById('checkDate').value = checkDate;

    updateUI();
    closeModal('receiptModal');
    pushToast('success', 'Чек перенесён в расчёт. Выберите, кто платил');
}

// ---------- Фото ----------
function rcLoadScript(url) {
    return new Promise((resolve, reject) => {
        if (document.querySelector(`script[src="${url}"]`)) return resolve();
        const s = document.createElement('script');
        s.src = url;
        s.onload = resolve;
        s.onerror = () => reject(new Error('Не удалось загрузить ' + url));
        document.head.appendChild(s);
    });
}

// Фото → canvas нужного размера, в оттенках серого с растянутым контрастом
function rcImageCanvas(file, maxSide) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            const k = Math.min(1, maxSide / Math.max(img.width, img.height));
            const c = document.createElement('canvas');
            c.width = Math.round(img.width * k);
            c.height = Math.round(img.height * k);
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            URL.revokeObjectURL(url);
            resolve(c);
        };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось открыть фото')); };
        img.src = url;
    });
}

function rcGrayscale(src) {
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const ctx = c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const im = ctx.getImageData(0, 0, c.width, c.height);
    const d = im.data;
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 4) {
        const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0;
        d[i] = g; hist[g]++;
    }
    // Растянуть контраст между 2% и 98% яркостей
    const total = d.length / 4;
    let lo = 0, hi = 255, acc = 0;
    for (; lo < 255; lo++) { acc += hist[lo]; if (acc > total * 0.02) break; }
    acc = 0;
    for (; hi > 0; hi--) { acc += hist[hi]; if (acc > total * 0.02) break; }
    const span = Math.max(1, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
        const v = Math.max(0, Math.min(255, (d[i] - lo) * 255 / span)) | 0;
        d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(im, 0, 0);
    return c;
}

function rcReadQr(canvas) {
    if (typeof jsQR !== 'function') return null;
    const tryScan = cv => {
        const ctx = cv.getContext('2d');
        const im = ctx.getImageData(0, 0, cv.width, cv.height);
        const r = jsQR(im.data, cv.width, cv.height, { inversionAttempts: 'attemptBoth' });
        return r ? r.data : null;
    };
    let data = tryScan(canvas);
    if (!data && canvas.width < 1000) {
        const c2 = document.createElement('canvas');
        c2.width = canvas.width * 2; c2.height = canvas.height * 2;
        const ctx = c2.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(canvas, 0, 0, c2.width, c2.height);
        data = tryScan(c2);
    }
    return data ? parseFiscalQr(data) : null;
}

async function receiptFromPhoto(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file || rcBusy) return;
    rcBusy = true;
    document.getElementById('receiptModal').classList.add('rc-busy');
    try {
        rcProgress('Открываю фото…', null);
        const canvas = await rcImageCanvas(file, 2000);

        // QR (фискальный чек): дата и итог — независимо от способа распознавания
        let qr = null;
        try {
            await rcLoadScript(JSQR_URL);
            qr = rcReadQr(canvas);
        } catch (e) { console.warn(e); }

        let parsed = null;
        let source = '';
        if (rcGeminiKey()) {
            try {
                rcProgress('Распознаю с помощью Gemini…', null);
                parsed = await rcGemini(canvas);
                source = 'Gemini';
            } catch (e) {
                console.error(e);
                pushToast('error', (e.userMessage || 'Gemini не ответил') + ' — распознаю без ИИ');
            }
        }
        if (!parsed) {
            parsed = await rcTesseract(canvas, qr);
            source = 'Tesseract';
        }
        rcApplyParsed(parsed, qr, source);
    } catch (e) {
        console.error(e);
        pushToast('error', e.userMessage || 'Не удалось распознать чек. Проверьте интернет и попробуйте ещё раз');
    } finally {
        rcBusy = false;
        document.getElementById('receiptModal').classList.remove('rc-busy');
        rcProgress(null);
    }
}

let rcTessWorker = null;
async function rcTesseract(canvas, qr) {
    rcProgress('Загружаю распознавание (только в первый раз)…', null);
    await rcLoadScript(TESSERACT_URL);
    if (!rcTessWorker) {
        rcTessWorker = await Tesseract.createWorker('rus', 1, {
            langPath: TESSERACT_LANG,
            logger: m => {
                if (m.status === 'recognizing text') rcProgress('Распознаю текст…', m.progress * 100);
                else if (/loading/.test(m.status)) rcProgress('Загружаю распознавание (только в первый раз)…', m.progress * 100);
            }
        });
    }
    rcProgress('Распознаю текст…', 0);
    const { data } = await rcTessWorker.recognize(rcGrayscale(canvas));
    window.rcLastText = data.text; // для отладки: что именно распознано
    return parseReceiptText(data.text, qr ? { total: qr.total } : null);
}

// Позиции из распознавания → черновик
function rcApplyParsed(parsed, qr, source) {
    // Склеить одинаковые позиции (одно название и цена)
    const merged = [];
    parsed.items.forEach(p => {
        const key = (p.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
        const same = key && merged.find(m => m.key === key && m.price === p.price);
        if (same) { same.qty += p.qty; if (p.flag && !same.flag) same.flag = p.flag; }
        else merged.push(Object.assign({ key }, p));
    });

    rc.items = merged.map(p => rcItem(p));
    rc.subtotal = expectedSubtotal(parsed);
    if (rc.subtotal == null && qr && qr.total != null) {
        rc.subtotal = parsed.servicePercent
            ? Math.round(qr.total / (1 + parsed.servicePercent / 100) * 100) / 100
            : qr.total;
    }
    if (parsed.servicePercent != null) rc.service = parsed.servicePercent;
    else if (parsed.serviceAmount && rc.subtotal) rc.service = Math.round(parsed.serviceAmount / rc.subtotal * 1000) / 10;
    if (qr && qr.date) rc.date = qr.date;
    else if (parsed.date) rc.date = parsed.date;
    if (parsed.place) rc.place = parsed.place;
    rc.source = source;
    rcOpenId = null;

    const sum = rc.items.reduce((a, it) => a + rcCents(rcItemSum(it)), 0);
    const matches = rc.subtotal != null && sum === rcCents(rc.subtotal);
    // Итог сошёлся — значит числа верные, снимаем «проверьте количество и цену»
    if (matches) rc.items.forEach(it => { if (it.flag === 'check') it.flag = null; });

    rcSave();
    renderReceipt();
    const n = rc.items.length;
    if (!n) pushToast('error', 'Позиции не найдены. Попробуйте сфотографировать ровнее и ближе');
    else if (matches) pushToast('success', `Распознано ${n} поз., сумма совпадает с чеком ✓`);
    else pushToast('success', `Распознано ${n} поз. Проверьте отмеченные строки`);
}

// ---------- Gemini ----------
function rcGeminiKey() {
    try { return localStorage.getItem(RC_GEMINI_KEY) || ''; } catch (e) { return ''; }
}

function rcRenderAiStatus() {
    const el = document.getElementById('receiptAi');
    if (!el) return;
    const key = rcGeminiKey();
    el.innerHTML = key
        ? `<span class="rc-ai-on"><i class="fas fa-magic"></i> Распознавание: Gemini</span>
           <button class="rc-link" onclick="rcAiSettings()">настроить</button>`
        : `<span class="rc-muted"><i class="fas fa-magic"></i> Для точного распознавания подключите бесплатный Gemini</span>
           <button class="rc-link" onclick="rcAiSettings()">подключить</button>`;
}

function rcAiSettings() {
    const box = document.getElementById('receiptAiSetup');
    box.classList.toggle('hidden');
    document.getElementById('rcGeminiKeyInput').value = rcGeminiKey();
}

function rcSaveGeminiKey() {
    const v = document.getElementById('rcGeminiKeyInput').value.trim();
    try {
        if (v) localStorage.setItem(RC_GEMINI_KEY, v);
        else localStorage.removeItem(RC_GEMINI_KEY);
        localStorage.removeItem(RC_GEMINI_MODEL);
    } catch (e) { /* без хранилища ключ не сохранится */ }
    document.getElementById('receiptAiSetup').classList.add('hidden');
    rcRenderAiStatus();
    pushToast('success', v ? 'Ключ Gemini сохранён на этом устройстве' : 'Ключ Gemini удалён');
}

function rcGeminiError(status, text) {
    const e = new Error('Gemini ' + status + ': ' + text);
    e.userMessage = status === 400 || status === 403 ? 'Ключ Gemini не подходит'
        : status === 429 ? 'Лимит бесплатных запросов Gemini исчерпан'
            : 'Gemini не ответил';
    return e;
}

// Выбрать доступную модель Flash (названия моделей со временем меняются)
async function rcGeminiModel(key) {
    try {
        const saved = localStorage.getItem(RC_GEMINI_MODEL);
        if (saved) return saved;
    } catch (e) { /* нет хранилища */ }
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', {
        headers: { 'x-goog-api-key': key }
    });
    if (!res.ok) throw rcGeminiError(res.status, await res.text());
    const data = await res.json();
    const names = (data.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
        .map(m => m.name.replace(/^models\//, ''))
        .filter(n => /^gemini-[\d.]+-flash(-latest)?$/.test(n) || n === 'gemini-flash-latest');
    if (!names.length) throw rcGeminiError(404, 'нет подходящей модели');
    // Самая новая версия Flash
    const ver = n => parseFloat((n.match(/gemini-([\d.]+)/) || [0, 0])[1]);
    names.sort((a, b) => ver(b) - ver(a) || (a.includes('latest') ? 1 : -1));
    const model = names.includes('gemini-flash-latest') ? 'gemini-flash-latest' : names[0];
    try { localStorage.setItem(RC_GEMINI_MODEL, model); } catch (e) { /* ок */ }
    return model;
}

const RC_GEMINI_PROMPT = `Это фото ресторанного чека (Таджикистан, валюта сомони). Извлеки позиции.
Правила:
- items: только заказанные блюда и напитки. Название может переноситься на следующую строку — склей его.
- qty — количество, price — цена за ОДНУ штуку, sum — сумма строки (qty * price).
- Не включай в items: обслуживание/сервис, налоги (ААИ, НДС), оплату (наличные, накд), итоги, скидки.
- subtotal — сумма позиций без обслуживания, если напечатана.
- service_percent и service_amount — процент и сумма обслуживания, если есть.
- total — итог к оплате.
- date — дата чека в формате YYYY-MM-DD.
- place — название заведения, если напечатано.
- Пиши названия как на чеке, исправляя только очевидные опечатки печати.
Если поле не видно — null.`;

const RC_GEMINI_SCHEMA = {
    type: 'OBJECT',
    properties: {
        items: {
            type: 'ARRAY',
            items: {
                type: 'OBJECT',
                properties: {
                    name: { type: 'STRING' },
                    qty: { type: 'NUMBER' },
                    price: { type: 'NUMBER' },
                    sum: { type: 'NUMBER' }
                },
                required: ['name', 'qty', 'price']
            }
        },
        subtotal: { type: 'NUMBER', nullable: true },
        service_percent: { type: 'NUMBER', nullable: true },
        service_amount: { type: 'NUMBER', nullable: true },
        total: { type: 'NUMBER', nullable: true },
        date: { type: 'STRING', nullable: true },
        place: { type: 'STRING', nullable: true }
    },
    required: ['items']
};

async function rcGemini(canvas) {
    const key = rcGeminiKey();
    const model = await rcGeminiModel(key);
    // Цветное фото, но не слишком большое: ~1600 px по длинной стороне
    const k = Math.min(1, 1600 / Math.max(canvas.width, canvas.height));
    const c = document.createElement('canvas');
    c.width = Math.round(canvas.width * k);
    c.height = Math.round(canvas.height * k);
    c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
    const b64 = c.toDataURL('image/jpeg', 0.85).split(',')[1];

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
            contents: [{ parts: [{ text: RC_GEMINI_PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: b64 } }] }],
            generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: RC_GEMINI_SCHEMA }
        })
    });
    if (!res.ok) {
        // Модель могли убрать — в следующий раз выбрать заново
        if (res.status === 404) { try { localStorage.removeItem(RC_GEMINI_MODEL); } catch (e) { /* ок */ } }
        throw rcGeminiError(res.status, await res.text());
    }
    const data = await res.json();
    const text = (((data.candidates || [])[0] || {}).content || {}).parts?.map(p => p.text || '').join('') || '';
    let j;
    try { j = JSON.parse(text); } catch (e) { throw rcGeminiError(500, 'неверный ответ: ' + text.slice(0, 200)); }
    return rcFromGemini(j);
}

// Ответ Gemini → тот же формат, что у разбора текста
function rcFromGemini(j) {
    const items = (j.items || []).map(i => {
        let qty = Math.max(1, Math.round(+i.qty || 1));
        let price = i.price != null ? +i.price : null;
        const sum = i.sum != null ? +i.sum : null;
        if ((price == null || isNaN(price)) && sum != null) price = sum / qty;
        // Иногда модель путает цену за штуку и сумму строки
        if (price != null && sum != null && qty > 1 && Math.abs(price - sum) < 0.005) price = sum / qty;
        return { name: String(i.name || '').trim(), qty, price: price == null || isNaN(price) ? null : Math.round(price * 100) / 100, flag: price == null ? 'price' : null };
    });
    const date = typeof j.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(j.date) ? j.date : null;
    return {
        items,
        subtotal: j.subtotal ?? null,
        total: j.total ?? null,
        servicePercent: j.service_percent ?? null,
        serviceAmount: j.service_amount ?? null,
        date,
        place: j.place ? String(j.place).trim() : ''
    };
}
