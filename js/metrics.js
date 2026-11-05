// Métricas LOCAIS de uso (sem rede, sem dados pessoais): agregados por método de lançamento — quantidade, mediana de toques e
// mediana de segundos entre abrir e salvar. Fica só em localStorage; nada é enviado a lugar algum. Consulta: Metrics.summary() no console.
const Metrics = {
    KEY: 'metrics_v1',
    METHODS: ['favorito', 'formulario', 'texto', 'atalho'],
    MAX_SAMPLES: 100,
    _cur: null,

    _load() {
        try { const d = JSON.parse(localStorage.getItem(this.KEY) || '{}'); return d && typeof d === 'object' ? d : {}; } catch (_) { return {}; }
    },
    _save(d) { try { localStorage.setItem(this.KEY, JSON.stringify(d)); } catch (_) {} },

    // Começa a medir um lançamento. initialTaps = toques que já aconteceram para chegar aqui (ex.: o toque que abriu o painel).
    begin(method, initialTaps = 1) {
        if (!this.METHODS.includes(method)) return;
        this._cur = { method, t0: Date.now(), taps: Math.max(0, initialTaps | 0) };
    },
    tap() { if (this._cur) this._cur.taps++; },
    cancel() { this._cur = null; },
    // Lançamento salvo: registra os agregados do método em curso.
    end() {
        const c = this._cur; this._cur = null;
        if (!c) return null;
        const secs = Math.max(0, Math.round((Date.now() - c.t0) / 100) / 10);
        const d = this._load(), m = d[c.method] || { count: 0, taps: [], secs: [] };
        m.count = (m.count || 0) + 1;
        m.taps = [...(m.taps || []), c.taps].slice(-this.MAX_SAMPLES);
        m.secs = [...(m.secs || []), secs].slice(-this.MAX_SAMPLES);
        d[c.method] = m; this._save(d);
        return { method: c.method, taps: c.taps, seconds: secs };
    },

    median(a) {
        const v = (a || []).filter(Number.isFinite).sort((x, y) => x - y);
        if (!v.length) return null;
        const h = v.length >> 1;
        return v.length % 2 ? v[h] : Math.round(((v[h - 1] + v[h]) / 2) * 10) / 10;
    },
    summary() {
        const d = this._load(), out = {};
        for (const m of this.METHODS) {
            const x = d[m] || { count: 0, taps: [], secs: [] };
            out[m] = { count: x.count || 0, medianTaps: this.median(x.taps), medianSeconds: this.median(x.secs) };
        }
        return out;
    },
    reset() { try { localStorage.removeItem(this.KEY); } catch (_) {} this._cur = null; },
};
// Conta os toques/cliques enquanto um lançamento está sendo feito (captura: antes dos handlers da tela)
if (typeof document !== 'undefined') document.addEventListener('click', () => Metrics.tap(), true);
