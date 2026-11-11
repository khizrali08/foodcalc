// Разбор распознанного текста чека в список позиций.
// Работает с двумя видами чеков:
//   A) пречек ресторана:   «Шашлык из корейки   3   177»
//   B) фискальный чек:     «Цезарь салат» / «43,00 * 1.000 = 43,00» / «Мол»
// Распознавание ошибается (З вместо 3, мусор вместо количества, искажённые копейки),
// поэтому разбор старается восстановить числа по смыслу, а сомнительные строки помечает.

(function (root) {
    // Строки шапки и подвала, в которых нет позиций
    // Ключевые слова ищем только с начала слова, иначе «Куринные» ловится на «инн», «Шаурма» на «рма»
    const SKIP_RE = /(?:^|[^А-Яа-яЁёӢӣҲҳҚқҒғҶҷӮӯ])(дата|официант|сч[её]т\s*№|стол|гост|наименование|кол-во|рма|рсб|хазин|днх|расиди|та[ъь]?рих|амали|анали|фискал|касс|телефон|инн|адрес|спасибо|накд|ғайри|айри|бақия|бакия|ааи|ндс|маблағ|маблаг|меъ[её]р|сдача)/i;
    const TOTAL_RE = /(итог|хамаг|ханаг|ҳамағ|всего|к\s*оплате|total)/i;
    const SUBTOTAL_RE = /^[^А-Яа-яЁё]*сумма(?![а-яё])/i;
    const SERVICE_RE = /(обсл|служ|ание\s*:|сервис|service)/i;
    // «Мол» (товар) и как его путает распознавание: Кол, Нол, Mon, Hon
    const UNIT_LINE_RE = /^[\s|]*[МмKКкНнMH][оo][лЛln](?![А-Яа-яЁёA-Za-z])/;

    // Похожие на цифры буквы → цифры (только внутри числовых токенов)
    function digitsOf(tok) {
        return tok
            .replace(/[ЗзЭ]/g, '3')
            .replace(/[ОоOo]/g, '0')
            .replace(/[бБ]/g, '6')
            .replace(/[lI|!]/g, '1');
    }

    // Число из токена или null. Допускает «12», «12,50», «12.5», «1.000».
    function num(tok) {
        if (tok == null) return null;
        // Одиночные черты и восклицательные знаки — линии на чеке, а не единицы
        if (!/\d/.test(tok) && /^[|!lI]+$/.test(tok)) return null;
        const d = digitsOf(String(tok));
        if (/[A-Za-zА-Яа-яЁё]/.test(d)) return null; // остались буквы — это не число
        const t = d.replace(/[^\d.,]/g, '');
        if (!/\d/.test(t)) return null;
        const m = t.match(/^(\d+)(?:[.,](\d+))?$/);
        if (!m) return null;
        return parseFloat(m[1] + (m[2] ? '.' + m[2] : ''));
    }

    const cents = v => Math.round(v * 100);
    // Насколько «круглая» цена: 13.00 и 12.50 — круглые, 13.09 — подозрительная
    const roundness = v => (cents(v) % 100 === 0 ? 2 : cents(v) % 50 === 0 ? 1 : 0);

    function cleanName(s) {
        let n = s
            .split(/\s[|‚„`»«\[\]]\s?|\s\/\s|[|\[\]]/)[0]  // всё после разделителя-мусора
            .replace(/^[\s|‚„`'’—–\-_.,:;]+/, '')      // мусор в начале
            .replace(/[\s|‚„`'’—–\-_,:;]+$/, '')       // мусор в конце
            .replace(/\s{2,}/g, ' ')
            .trim();
        // В кириллическом названии хвост из латиницы — мусор распознавания («Чорба i»)
        if (/[А-Яа-яЁё]{3,}/.test(n)) {
            const toks = n.split(' ');
            while (toks.length > 1 && !/[А-Яа-яЁё]/.test(toks[toks.length - 1])) toks.pop();
            n = toks.join(' ');
        }
        return n;
    }

    // Название выглядит как мусор: смесь алфавитов, точки, цифры
    function dubiousName(n) {
        return !n || (/[A-Za-z]/.test(n) && /[А-Яа-яЁё]/.test(n)) || /[.;:\d]/.test(n.replace(/\(.*\)/, ''));
    }

    const hasWord = s => /[А-Яа-яЁёA-Za-zӢӣҲҳҚқҒғҶҷӮӯ]{3,}/.test(s);

    function findDate(lines) {
        for (const l of lines) {
            if (!/(дата|та[ъь]?рих)/i.test(l)) continue;
            const m = l.match(/(\d{2})[.\/-](\d{2})[.\/-](\d{4}|\d{2})\b/);
            if (m) return toIsoDate(m[1], m[2], m[3]);
        }
        return null;
    }

    function toIsoDate(d, m, y) {
        if (y.length === 2) y = '20' + y;
        const dd = +d, mm = +m;
        if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;
        return `${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    }

    // Последнее число в строке (сумма справа)
    function lastAmount(line) {
        const toks = line.split(/\s+/).filter(Boolean);
        for (let i = toks.length - 1; i >= 0; i--) {
            const v = num(toks[i]);
            if (v != null) return v;
        }
        return null;
    }

    // --- Формат B: «цена * кол-во = сумма» ---
    const PRICE_LINE_RE = /(\d[\d\s]*[.,]\d{2})\s*[*×xх+]\s*([\dЗзОо]+(?:[.,][\dЗзОо]+)?)/;
    // Запасной вариант, когда количество не прочиталось: «74,00 ао | = 222,00»
    const PRICE_EQ_RE = /^\D{0,3}(\d+[.,]\d{2})\b.*=\s*([\d\s]+[.,]\d{2})/;

    function parseFiscal(lines, res) {
        let lastName = null;
        let serviceNext = false;
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            if (TOTAL_RE.test(line)) {
                const v = lastAmount(line);
                if (v != null && res.total == null) res.total = v;
                continue;
            }
            if (SERVICE_RE.test(line) && /%/.test(line)) {
                const p = line.match(/(\d+(?:[.,]\d+)?)\s*%/);
                if (p) res.servicePercent = num(p[1]);
                serviceNext = true;
                lastName = null;
                continue;
            }
            const pm = line.match(PRICE_LINE_RE);
            const pe = !pm && line.match(PRICE_EQ_RE);
            if (pm || pe) {
                let price, qty, sum;
                if (pm) {
                    price = num(pm[1].replace(/\s/g, ''));
                    qty = num(pm[2]);
                    const after = line.slice(line.indexOf(pm[0]) + pm[0].length);
                    const eq = after.match(/=\s*([\d\s]+[.,]\d{2})/);
                    sum = eq ? num(eq[1].replace(/\s/g, '')) : null;
                } else {
                    price = num(pe[1]);
                    qty = null;
                    sum = num(pe[2].replace(/\s/g, ''));
                }

                if (serviceNext) {
                    res.serviceAmount = sum != null ? sum : price;
                    serviceNext = false;
                    continue;
                }
                res.items.push(fixPriceQty(lastName, price, qty, sum));
                lastName = null;
                continue;
            }
            if (UNIT_LINE_RE.test(line)) continue;
            // Строка шапки — следующая цена не может относиться к названию выше неё
            if (SKIP_RE.test(line)) { lastName = null; continue; }
            if (hasWord(line)) {
                const n = cleanName(line);
                if (n) lastName = n;
            }
        }
    }

    // Согласовать цену, количество и сумму из строки фискального чека
    function fixPriceQty(name, price, qty, sum) {
        const item = { name: name || '', price: null, qty: 1, flag: null };
        if (dubiousName(name)) item.flag = 'name';

        const qtyOk = qty != null && qty > 0 && qty <= 99 && Math.abs(qty - Math.round(qty)) < 0.01;
        let q = qtyOk ? Math.round(qty) : null;

        if (price != null && sum != null) {
            if (q == null) q = Math.max(1, Math.round(sum / price));
            if (cents(price) * q === cents(sum)) {
                item.price = price; item.qty = q;
            } else {
                // Что-то прочиталось неверно. Если кол-во ломает равенство — пересчитать его,
                // иначе выбрать более «круглое» из цены и суммы/кол-во
                const q2 = Math.round(sum / price);
                if (q2 >= 1 && cents(price) * q2 === cents(sum)) {
                    item.price = price; item.qty = q2;
                } else {
                    // Цена и сумма не сходятся: берём более «круглую», при равенстве — сумму
                    // (колонка суммы обычно печатается чётче). Второй вариант запоминаем:
                    // если итог чека не сойдётся, подставим его.
                    const fromSum = sum / q;
                    const useSum = roundness(fromSum) >= roundness(price);
                    item.price = useSum ? fromSum : price;
                    item.alt = useSum ? price : fromSum;
                    item.qty = q;
                    item.flag = item.flag || 'check';
                }
            }
        } else if (price != null) {
            item.price = price; item.qty = q || 1;
            item.flag = item.flag || 'check';
        } else if (sum != null) {
            item.qty = q || 1; item.price = sum / item.qty;
            item.flag = item.flag || 'check';
        } else {
            item.qty = q || 1;
            item.flag = 'price';
        }
        if (item.price != null) item.price = Math.round(item.price * 100) / 100;
        return item;
    }

    // --- Формат A: «Название  кол-во  сумма» ---
    function parseTable(lines, res) {
        let prev = null; // последняя позиция — к ней может относиться перенос названия
        for (const raw of lines) {
            const line = raw.trim().replace(/^[|‚„`'’—–\-_.:;\s]+/, '');
            if (!line) continue;

            if (SUBTOTAL_RE.test(line)) {
                const v = lastAmount(line);
                if (v != null) res.subtotal = v;
                prev = null;
                continue;
            }
            if (TOTAL_RE.test(line)) {
                const v = lastAmount(line);
                if (v != null && res.total == null) res.total = v;
                prev = null;
                continue;
            }
            if (SERVICE_RE.test(line) && /%/.test(line)) {
                const p = line.match(/(\d+(?:[.,]\d+)?)\s*%/);
                if (p) res.servicePercent = num(p[1]);
                const after = line.slice(line.indexOf('%') + 1);
                const v = lastAmount(after);
                if (v != null) res.serviceAmount = v;
                prev = null;
                continue;
            }
            if (SKIP_RE.test(line)) { prev = null; continue; }

            const toks = line.split(/\s+/);
            const sumTok = toks.length >= 3 ? toks[toks.length - 1] : null;
            const qtyTok = toks.length >= 3 ? toks[toks.length - 2] : null;
            const sum = num(sumTok);
            const qtyRaw = qtyTok && qtyTok.length <= 3 ? num(qtyTok) : null;
            const name = cleanName(toks.slice(0, toks.length - 2).join(' '));

            const looksLikeItem = sumTok && qtyTok && qtyTok.length <= 3 && hasWord(name) &&
                (sum != null || qtyRaw != null);

            if (looksLikeItem) {
                const item = { name, price: null, qty: 1, flag: null };
                let q = qtyRaw != null && qtyRaw >= 1 && qtyRaw <= 99 && Number.isInteger(qtyRaw) ? qtyRaw : null;
                if (sum != null) {
                    // Количество, на которое сумма не делится нацело, — мусор распознавания
                    if (q != null && cents(sum) % q !== 0) { q = null; }
                    if (q == null) { item.flag = qtyRaw == null || qtyRaw !== 1 ? 'check' : null; }
                    item.qty = q || 1;
                    item.price = Math.round(sum / item.qty * 100) / 100;
                    if (q == null && qtyRaw == null) item.flag = 'check';
                } else {
                    item.qty = q || 1;
                    item.flag = 'price';
                }
                res.items.push(item);
                prev = item;
                continue;
            }

            // Строка без чисел: перенос названия (с маленькой буквы) или заголовок раздела
            if (prev && /^[а-яё]/.test(line) && !/\d/.test(line)) {
                prev.name = (prev.name + ' ' + cleanName(line)).trim();
                // «ассор» + «ти» → «ассорти»
                prev.name = prev.name.replace(/(\S{3,}) (\S{1,3})$/, (m, a, b) => (b.length <= 2 ? a + b : m));
                continue;
            }
            prev = null;
        }
    }

    // Сумма позиций без сервиса, известная из чека
    function expectedSubtotal(r) {
        if (r.subtotal != null) return r.subtotal;
        if (r.total != null && r.serviceAmount != null) return Math.round((r.total - r.serviceAmount) * 100) / 100;
        if (r.total != null && r.servicePercent != null) return Math.round(r.total / (1 + r.servicePercent / 100) * 100) / 100;
        if (r.total != null) return r.total;
        return null;
    }

    // Если у ровно одной позиции цена не распознана — вычислить её из итога чека
    function fillMissingPrice(r) {
        const missing = r.items.filter(i => i.price == null);
        const target = expectedSubtotal(r);
        if (missing.length !== 1 || target == null) return;
        const known = r.items.reduce((a, i) => a + (i.price != null ? cents(i.price) * i.qty : 0), 0);
        const rest = cents(target) - known;
        const it = missing[0];
        if (rest > 0 && rest % it.qty === 0) {
            it.price = rest / it.qty / 100;
            it.flag = 'auto';
        }
    }

    // Итог не сошёлся — попробовать второй вариант цены у сомнительных позиций
    function tryAlternatives(r) {
        const target = expectedSubtotal(r);
        if (target == null) return;
        const total = () => r.items.reduce((a, i) => a + (i.price != null ? cents(i.price) * i.qty : 0), 0);
        if (total() === cents(target)) return;
        for (const it of r.items) {
            if (it.alt == null) continue;
            const diff = (cents(it.alt) - cents(it.price)) * it.qty;
            if (total() + diff === cents(target)) {
                it.price = Math.round(it.alt * 100) / 100;
                break;
            }
        }
    }

    // hints.total — итог из QR-кода, если он есть (надёжнее распознанного текста)
    function parseReceiptText(text, hints) {
        const lines = String(text || '').split(/\r?\n/);
        const res = {
            items: [], subtotal: null, total: null,
            servicePercent: null, serviceAmount: null, date: findDate(lines)
        };
        const fiscalLines = lines.filter(l => PRICE_LINE_RE.test(l)).length;
        if (fiscalLines >= 2) parseFiscal(lines, res); else parseTable(lines, res);
        if (hints && hints.total != null) res.total = hints.total;
        fillMissingPrice(res);
        tryAlternatives(res);
        res.items.forEach(i => { delete i.alt; });
        return res;
    }

    // QR фискального чека Таджикистана: t=03.11.26 21:17&i=...&s=666,60&fn=...&fp=...
    function parseFiscalQr(data) {
        if (!data) return null;
        const params = {};
        String(data).replace(/^[^?]*\?/, '').split('&').forEach(kv => {
            const i = kv.indexOf('=');
            if (i > 0) params[kv.slice(0, i).trim().toLowerCase()] = kv.slice(i + 1).trim();
        });
        const out = {};
        if (params.s) out.total = num(params.s);
        if (params.t) {
            const m = params.t.match(/(\d{2})\.(\d{2})\.(\d{2,4})/);
            if (m) out.date = toIsoDate(m[1], m[2], m[3]);
        }
        return (out.total != null || out.date) ? out : null;
    }

    const api = { parseReceiptText, parseFiscalQr, expectedSubtotal };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else Object.assign(root, api);
})(typeof window !== 'undefined' ? window : this);
