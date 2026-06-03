// ─── Insights — Inteligência sobre os dados do app ──────────────────────────
// Tudo client-side, sem chamadas externas. Usa apenas as transações já carregadas.
const Insights = {
    // ─── Helpers ──────────────────────────────────────────────────────────────
    _money(v) {
        return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    _normDesc(d) {
        return (d || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    },

    _isExpense(t) {
        return Storage.getBehavior(t.type) === 'subtrai';
    },

    // Compara duas strings por trigramas (Jaccard). Retorna 0..1.
    _similarity(a, b) {
        const trigrams = s => {
            const padded = '  ' + (s || '') + '  ';
            const set = new Set();
            for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3));
            return set;
        };
        const ta = trigrams(a), tb = trigrams(b);
        if (!ta.size || !tb.size) return 0;
        let inter = 0;
        for (const t of ta) if (tb.has(t)) inter++;
        return inter / (ta.size + tb.size - inter);
    },

    // Soma despesas por categoria
    _expenseByCategory(txns) {
        const map = {};
        for (const t of txns) {
            if (!this._isExpense(t)) continue;
            const cat = t.category || 'Sem categoria';
            map[cat] = (map[cat] || 0) + (Number(t.value) || 0);
        }
        return map;
    },

    // ─── 1. Resumo mensal em linguagem natural ────────────────────────────────
    monthlySummary(currTxns, prevTxns, currMonth, prevMonth) {
        const currCat = this._expenseByCategory(currTxns);
        const prevCat = this._expenseByCategory(prevTxns);
        const currTotal = Object.values(currCat).reduce((s, v) => s + v, 0);
        const prevTotal = Object.values(prevCat).reduce((s, v) => s + v, 0);

        const out = { sentences: [], deltas: [], summary: '' };

        // Variação total
        if (prevTotal > 0) {
            const diffPct = ((currTotal - prevTotal) / prevTotal) * 100;
            const dir = diffPct >= 0 ? 'a mais' : 'a menos';
            out.sentences.push(`Você gastou ${this._money(Math.abs(currTotal - prevTotal))} ${dir} que no mês anterior (${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(1)}%).`);
        } else if (currTotal > 0) {
            out.sentences.push(`Seu gasto total este mês foi de ${this._money(currTotal)}.`);
        }

        // Por categoria — top 3 variações (positivas e negativas)
        const allCats = new Set([...Object.keys(currCat), ...Object.keys(prevCat)]);
        const deltas = [];
        for (const cat of allCats) {
            const c = currCat[cat] || 0;
            const p = prevCat[cat] || 0;
            if (c === 0 && p === 0) continue;
            const diff = c - p;
            const pct = p > 0 ? ((diff / p) * 100) : (c > 0 ? 100 : -100);
            deltas.push({ cat, diff, pct, curr: c, prev: p });
        }
        deltas.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
        out.deltas = deltas.slice(0, 5);

        // Frases sobre as 2 maiores variações
        for (const d of deltas.slice(0, 2)) {
            if (Math.abs(d.diff) < 10) continue; // ignora variação irrelevante
            if (d.prev === 0) {
                out.sentences.push(`Nova categoria neste mês: ${d.cat} (${this._money(d.curr)}).`);
            } else if (d.curr === 0) {
                out.sentences.push(`Você não gastou nada com ${d.cat} este mês (antes: ${this._money(d.prev)}).`);
            } else if (d.diff > 0) {
                out.sentences.push(`${d.cat} subiu ${this._money(d.diff)} (+${d.pct.toFixed(0)}%).`);
            } else {
                out.sentences.push(`${d.cat} caiu ${this._money(-d.diff)} (${d.pct.toFixed(0)}%).`);
            }
        }

        out.summary = out.sentences.join(' ');
        return out;
    },

    // ─── 2. Previsão de fechamento de mês ─────────────────────────────────────
    projectMonthEnd(currTxns, ymStr) {
        const [year, month] = ymStr.split('-').map(Number);
        const daysInMonth = new Date(year, month, 0).getDate();
        const today = new Date();
        const isCurrentMonth = today.getFullYear() === year && (today.getMonth() + 1) === month;
        const dayNow = isCurrentMonth ? today.getDate() : daysInMonth;
        const daysElapsed = Math.max(1, Math.min(dayNow, daysInMonth));

        let expenseToDate = 0;
        for (const t of currTxns) {
            if (this._isExpense(t) && t.date && t.date <= (isCurrentMonth ? today.toISOString().slice(0, 10) : `${ymStr}-${String(daysInMonth).padStart(2,'0')}`)) {
                expenseToDate += Number(t.value) || 0;
            }
        }

        if (!isCurrentMonth || daysElapsed >= daysInMonth) {
            return { isCurrent: false, projection: expenseToDate, message: '' };
        }

        // Lançamentos futuros já agendados (parcelas com data futura)
        const todayStr = today.toISOString().slice(0, 10);
        let futurePlanned = 0;
        for (const t of currTxns) {
            if (this._isExpense(t) && t.date && t.date > todayStr) {
                futurePlanned += Number(t.value) || 0;
            }
        }

        // Projeção: extrapola o ritmo + soma o que já está agendado
        const dailyRate = expenseToDate / daysElapsed;
        const daysRemaining = daysInMonth - daysElapsed;
        const linearProjection = expenseToDate + (dailyRate * daysRemaining);
        const totalProjection = Math.max(linearProjection, expenseToDate + futurePlanned);

        return {
            isCurrent: true,
            expenseToDate,
            futurePlanned,
            projection: totalProjection,
            daysElapsed,
            daysRemaining,
            daysInMonth,
            message: `No ritmo atual, o mês fecha em ${this._money(totalProjection)} (${daysRemaining} dia${daysRemaining !== 1 ? 's' : ''} restante${daysRemaining !== 1 ? 's' : ''}).`,
        };
    },

    // ─── 3. Gastos recorrentes não cadastrados como lembrete ──────────────────
    findRecurringWithoutReminder(allTxns, reminders) {
        // Agrupa transações por descrição normalizada
        const groups = {};
        for (const t of allTxns) {
            if (!this._isExpense(t)) continue;
            const key = this._normDesc(t.description || t.category);
            if (!key || key.length < 3) continue;
            if (!groups[key]) groups[key] = [];
            groups[key].push(t);
        }

        const result = [];
        for (const [key, items] of Object.entries(groups)) {
            // Precisa aparecer em ≥3 meses distintos para ser "recorrente"
            const months = new Set(items.map(t => (t.date || '').slice(0, 7)).filter(Boolean));
            if (months.size < 3) continue;

            // Dias do mês em que aparece
            const days = items.map(t => parseInt((t.date || '').slice(8, 10))).filter(d => !isNaN(d));
            if (!days.length) continue;
            // Dia médio (mediana)
            const sortedDays = [...days].sort((a, b) => a - b);
            const medianDay = sortedDays[Math.floor(sortedDays.length / 2)];

            // Verifica se já existe lembrete similar
            const description = items[items.length - 1].description || items[items.length - 1].category;
            const hasReminder = reminders.some(r =>
                this._similarity(this._normDesc(r.name), key) > 0.65 ||
                this._similarity(this._normDesc(r.description), key) > 0.65
            );
            if (hasReminder) continue;

            // Valor médio
            const avgValue = items.reduce((s, t) => s + Number(t.value), 0) / items.length;

            result.push({
                description,
                category: items[items.length - 1].category,
                day: medianDay,
                avgValue,
                occurrences: items.length,
                months: months.size,
            });
        }

        // Ordena por nº de ocorrências
        result.sort((a, b) => b.occurrences - a.occurrences);
        return result.slice(0, 5);
    },

    // ─── 4. Sugestão de metas por mediana dos últimos 3 meses ─────────────────
    suggestGoals(txnsByMonth) {
        // txnsByMonth: { 'YYYY-MM': [txns...], ... } — os últimos 3 meses
        const months = Object.keys(txnsByMonth).sort().slice(-3);
        if (months.length < 2) return {}; // poucos dados

        const catTotalsPerMonth = {};
        for (const m of months) {
            const cat = this._expenseByCategory(txnsByMonth[m] || []);
            for (const [c, total] of Object.entries(cat)) {
                if (!catTotalsPerMonth[c]) catTotalsPerMonth[c] = [];
                catTotalsPerMonth[c].push(total);
            }
        }

        const goals = {};
        for (const [cat, totals] of Object.entries(catTotalsPerMonth)) {
            if (totals.length < 2) continue; // categoria precisa aparecer ≥2 meses
            const sorted = [...totals].sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)];
            // Arredonda para 10
            goals[cat] = Math.round(median / 10) * 10;
        }
        return goals;
    },

    // ─── 5. Alertas de meta — quanto já gastou + dias restantes ───────────────
    goalAlerts(currTxns, goals, ymStr) {
        if (!goals || !Object.keys(goals).length) return [];

        const [year, month] = ymStr.split('-').map(Number);
        const today = new Date();
        const daysInMonth = new Date(year, month, 0).getDate();
        const isCurrentMonth = today.getFullYear() === year && (today.getMonth() + 1) === month;
        if (!isCurrentMonth) return [];

        const dayNow = today.getDate();
        const daysRemaining = daysInMonth - dayNow;
        const monthFraction = dayNow / daysInMonth;

        const currCat = this._expenseByCategory(currTxns);
        const alerts = [];

        for (const [cat, limit] of Object.entries(goals)) {
            if (!limit || limit <= 0) continue;
            const spent = currCat[cat] || 0;
            const pct = (spent / limit) * 100;
            const expectedPct = monthFraction * 100;

            let level = 'ok';
            let message = '';
            if (pct >= 100) {
                level = 'danger';
                message = `Você estourou a meta de ${cat}: ${this._money(spent)} de ${this._money(limit)} (${pct.toFixed(0)}%).`;
            } else if (pct >= 80) {
                level = 'warning';
                message = `Você está em ${pct.toFixed(0)}% da meta de ${cat} e ainda faltam ${daysRemaining} dia${daysRemaining !== 1 ? 's' : ''} do mês.`;
            } else if (pct > expectedPct + 25) {
                level = 'attention';
                message = `Gasto com ${cat} acelerado: ${pct.toFixed(0)}% da meta com ${expectedPct.toFixed(0)}% do mês passado.`;
            } else continue;

            alerts.push({ category: cat, spent, limit, pct, level, message, daysRemaining });
        }

        alerts.sort((a, b) => b.pct - a.pct);
        return alerts;
    },

    // ─── 6. Detecção de duplicatas ────────────────────────────────────────────
    findDuplicates(monthTxns) {
        const byDate = {};
        for (const t of monthTxns) {
            const d = t.date || '';
            if (!d) continue;
            if (!byDate[d]) byDate[d] = [];
            byDate[d].push(t);
        }

        const dupes = [];
        for (const items of Object.values(byDate)) {
            if (items.length < 2) continue;
            const used = new Set();
            for (let i = 0; i < items.length; i++) {
                if (used.has(items[i].id)) continue;
                const group = [items[i]];
                for (let j = i + 1; j < items.length; j++) {
                    if (used.has(items[j].id)) continue;
                    const sameValue = Math.abs(Number(items[i].value) - Number(items[j].value)) < 0.01;
                    const descA = this._normDesc(items[i].description);
                    const descB = this._normDesc(items[j].description);
                    const similar = sameValue && (descA === descB || this._similarity(descA, descB) > 0.7);
                    if (similar) { group.push(items[j]); used.add(items[j].id); }
                }
                if (group.length > 1) {
                    used.add(items[i].id);
                    dupes.push(group);
                }
            }
        }
        return dupes;
    },

    // ─── 7. Parcelas faltantes ────────────────────────────────────────────────
    findMissingInstallments(allTxns) {
        const groups = {};
        for (const t of allTxns) {
            if (!t.installment_group_id) continue;
            const gid = t.installment_group_id;
            if (!groups[gid]) groups[gid] = [];
            groups[gid].push(t);
        }

        const missing = [];
        for (const [gid, items] of Object.entries(groups)) {
            const total = items[0].installment_total;
            if (!total || total < 2) continue;
            const present = new Set(items.map(t => t.installment_current));
            const gaps = [];
            for (let i = 1; i <= total; i++) {
                if (!present.has(i)) gaps.push(i);
            }
            if (!gaps.length) continue;

            // Só sinaliza gaps internos ou últimas parcelas já passadas
            const today = new Date().toISOString().slice(0, 10);
            const refTxn = items.find(t => t.installment_current === Math.max(...present));
            if (!refTxn?.date) continue;
            const refDate = new Date(refTxn.date + 'T12:00:00');

            // Para cada gap, calcula data prevista (mês ref + (gap - current))
            const overdue = [];
            for (const g of gaps) {
                const offset = g - refTxn.installment_current;
                const expected = new Date(refDate);
                expected.setMonth(expected.getMonth() + offset);
                const expectedStr = expected.toISOString().slice(0, 10);
                if (expectedStr <= today) {
                    overdue.push({ num: g, expectedDate: expectedStr });
                }
            }
            if (!overdue.length) continue;

            missing.push({
                group_id: gid,
                description: refTxn.description,
                category: refTxn.category,
                value: refTxn.value,
                type: refTxn.type,
                total,
                missing: overdue,
            });
        }
        return missing;
    },

    // ─── 8. Re-categorização: lançamentos possivelmente mal categorizados ─────
    // validCategories: Set/Array com nomes de categorias existentes para o usuário.
    //                   Sugestões fora desse conjunto são descartadas (não há como aplicar).
    findMiscategorized(txns, suggestFn, validCategories = null) {
        const validSet = validCategories
            ? (validCategories instanceof Set ? validCategories : new Set(validCategories))
            : null;
        const result = [];
        for (const t of txns) {
            if (!t.description) continue;
            const current = t.category || 'Outros';
            const suggested = suggestFn(t.description);
            if (!suggested || suggested === 'Outros' || suggested === current) continue;
            // Só sugere categorias que o usuário REALMENTE possui
            if (validSet && !validSet.has(suggested)) continue;
            result.push({ tx: t, current, suggested });
        }
        return result;
    },
};
