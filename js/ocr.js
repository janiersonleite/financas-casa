const OCR = {

    // ── PDF: extrai texto via PDF.js, com fallback para OCR se PDF for escaneado ──
    async processPDF(file, onProgress) {
        if (onProgress) onProgress(10);

        // Carrega PDF.js sob demanda
        if (!window.pdfjsLib) {
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js';
                s.onload = resolve; s.onerror = reject;
                document.head.appendChild(s);
            });
            window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js';
        }

        if (onProgress) onProgress(25);

        try {
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

            // 1. Tenta extrair texto (PDFs digitais têm texto embutido)
            let fullText = '';
            for (let i = 1; i <= Math.min(pdf.numPages, 5); i++) {
                const page = await pdf.getPage(i);
                const content = await page.getTextContent();
                const pageText = content.items.map(it => it.str).join(' ');
                fullText += pageText + '\n';
            }
            console.log('=== PDF TEXT ===\n', fullText);

            if (onProgress) onProgress(70);

            if (fullText.trim().length > 30) {
                // PDF digital: texto extraído com sucesso
                if (onProgress) onProgress(100);
                return this.parseComprovante(fullText);
            }

            // 2. PDF escaneado: renderiza primeira página como imagem e roda OCR
            if (onProgress) onProgress(50);
            const page1   = await pdf.getPage(1);
            const vp      = page1.getViewport({ scale: 2.0 });
            const canvas  = document.createElement('canvas');
            canvas.width  = vp.width;
            canvas.height = vp.height;
            await page1.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

            const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
            return await this.processImage(blob, pct => {
                if (onProgress) onProgress(60 + Math.round(pct * 0.4));
            });

        } catch (err) {
            console.error('PDF error:', err);
            throw new Error('Não foi possível ler o PDF. Tente tirar um print do comprovante e enviar a imagem.');
        }
    },

    async processImage(file, onProgress) {
        try {
            const worker = await Tesseract.createWorker('por', 1, {
                logger: m => {
                    if (onProgress && m.status === 'recognizing text') {
                        onProgress(Math.round(m.progress * 100));
                    }
                }
            });
            const { data: { text } } = await worker.recognize(file);
            await worker.terminate();
            console.log('=== OCR RAW TEXT ===\n', text);
            return this.parseComprovante(text);
        } catch (err) {
            console.error('OCR error:', err);
            throw new Error('Não foi possível ler a imagem. Tente colar o texto do comprovante.');
        }
    },

    parseComprovante(text) {
        const lower = text.toLowerCase();
        // Comprovante bancário tem prioridade sobre nota fiscal
        const isBankReceipt = this.isBankReceipt(lower);
        const isReceipt     = !isBankReceipt && this.isNotaFiscal(lower);

        const result = {
            value:       null,
            date:        null,
            type:        'saida',
            category:    isReceipt ? 'Outros' : 'PIX',
            description: '',
            rawText:     text,
            confidence:  0
        };

        // ── Valor ────────────────────────────────────────────────────────────
        if (isReceipt) {
            result.value = this.extractReceiptTotal(text);
        }
        if (!result.value) {
            result.value = this.extractValue(text);
        }
        if (result.value) result.confidence++;

        // ── Data ─────────────────────────────────────────────────────────────
        result.date = this.extractDate(text);
        if (result.date) result.confidence++;

        // ── Tipo (entrada / saída) ────────────────────────────────────────────
        if (!isReceipt) {
            const incomeSignals = [
                'recebid', 'pix recebido', 'transferência recebida', 'transferencia recebida',
                'crédito', 'credito', 'você recebeu', 'remetente', 'depósito recebido',
                'deposito recebido', 'ted recebido'
            ];
            for (const s of incomeSignals) {
                if (lower.includes(s)) { result.type = 'entrada'; result.confidence++; break; }
            }
        }

        // ── Descrição ─────────────────────────────────────────────────────────
        if (isReceipt) {
            result.description = this.extractStoreName(text);
            result.category    = this.guessReceiptCategory(lower);
        } else {
            // Padrões separados por tipo:
            // saída → queremos o RECEBEDOR (para / favorecido / beneficiário)
            // entrada → queremos o REMETENTE (de / pagador / depositante)
            const recipientPatterns = [
                /(?:para|destinatário|destinatario|favorecido|beneficiário|beneficiario|recebedor)\s*:?\s*([^\n\r]{3,50})/i,
                /(?:histórico|historico|finalidade|motivo|memo)\s*:?\s*([^\n\r]{3,60})/i,
                /transferência\s+para\s+([A-ZÀ-Úa-zà-ú][^\n\r]{2,40})/i,
                /transferencia\s+para\s+([A-ZÀ-Úa-zà-ú][^\n\r]{2,40})/i,
            ];
            const senderPatterns = [
                /(?:remetente|origem|pagador|depositante)\s*:?\s*([^\n\r]{3,50})/i,
                /(?:histórico|historico|finalidade|motivo|memo)\s*:?\s*([^\n\r]{3,60})/i,
                /depósito\s+(?:de\s+)?([A-ZÀ-Úa-zà-ú][^\n\r]{2,40})/i,
                /deposito\s+(?:de\s+)?([A-ZÀ-Úa-zà-ú][^\n\r]{2,40})/i,
            ];

            const bankPatterns = result.type === 'entrada' ? senderPatterns : recipientPatterns;

            for (const p of bankPatterns) {
                const m = text.match(p);
                if (m) {
                    const candidate = m[1].trim()
                        .replace(/\s*\*{3}[\d.*]+\s*/, '') // Remove CPF/CNPJ mascarados
                        .trim();
                    if (candidate.length >= 3) {
                        result.description = candidate;
                        result.confidence++;
                        break;
                    }
                }
            }
            if (!result.description) {
                result.description = result.type === 'entrada' ? 'PIX Recebido' : 'PIX Enviado';
            }
        }

        return result;
    },

    // ── Helpers ──────────────────────────────────────────────────────────────

    extractDate(text) {
        const pad = n => String(n).padStart(2, '0');
        const fmt = (d, m, y) => `${y}-${pad(m)}-${pad(d)}`;

        const months = {
            jan:0, fev:1, mar:2, abr:3, mai:4, jun:5,
            jul:6, ago:7, set:8, out:9, nov:10, dez:11,
            janeiro:0, fevereiro:1, março:2, marco:2, abril:3, maio:4, junho:5,
            julho:6, agosto:7, setembro:8, outubro:9, novembro:10, dezembro:11
        };

        // Normaliza chars que OCR confunde com barra
        const norm = text.replace(/(\d{2})[|lI](\d{2})[|lI](\d{2,4})/g, '$1/$2/$3');

        const tryMonth = str => months[str.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'')];

        // 1. "02/fev/2026" — formato PicPay (dia/mês-abreviado/ano)
        const mSlash = text.match(/(\d{1,2})\/([a-záàâãéèêíïóôõúü]{3,})\/(\d{4})/i);
        if (mSlash) {
            const mo = tryMonth(mSlash[2]);
            if (mo !== undefined) {
                const d = +mSlash[1], y = +mSlash[3];
                if (d >= 1 && d <= 31) return fmt(d, mo + 1, y);
            }
        }

        // 2. "24 de abril de 2026" ou "24 de abril 2026" (Nubank, Bradesco)
        const mExt = text.match(/(\d{1,2})\s+de\s+([a-záàâãéèêíïóôõúü]+)\s+(?:de\s+)?(\d{4})/i);
        if (mExt) {
            const mo = tryMonth(mExt[2]);
            if (mo !== undefined) {
                const d = +mExt[1], y = +mExt[3];
                if (d >= 1 && d <= 31) return fmt(d, mo + 1, y);
            }
        }

        // 3. "24 abr 2026" ou "24 abr. 2026" (abreviado sem preposição)
        const mAbr = text.match(/(\d{1,2})\s+([a-záàâãéèêíïóôõúü]{3})\.?\s+(\d{4})/i);
        if (mAbr) {
            const mo = tryMonth(mAbr[2]);
            if (mo !== undefined) {
                const d = +mAbr[1], y = +mAbr[3];
                if (d >= 1 && d <= 31) return fmt(d, mo + 1, y);
            }
        }

        const numPatterns = [
            // DD/MM/YYYY ou DD.MM.YYYY
            { re: /(\d{2})[\/.](\d{2})[\/.](\d{4})/, order: 'dmy4' },
            // DD/MM/YY
            { re: /(\d{2})[\/.](\d{2})[\/.](\d{2})(?!\d)/, order: 'dmy2' },
            // YYYY-MM-DD (ISO)
            { re: /(\d{4})-(\d{2})-(\d{2})/, order: 'ymd' },
            // DD-MM-YYYY
            { re: /(\d{2})-(\d{2})-(\d{4})/, order: 'dmy4' },
        ];

        for (const { re, order } of numPatterns) {
            const m = norm.match(re) || text.match(re);
            if (!m) continue;
            let d, mo, y;
            if (order === 'dmy4') { [, d, mo, y] = m; }
            else if (order === 'dmy2') {
                [, d, mo, y] = m;
                y = +y < 50 ? '20' + y : '19' + y;
            } else { [, y, mo, d] = m; }

            if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) continue;
            return fmt(+d, +mo, y);
        }
        return null;
    },

    // Detecta comprovante bancário (tem prioridade sobre nota fiscal)
    isBankReceipt(lower) {
        return /\b(pix|ted\b|doc\b)\b/.test(lower) ||
               lower.includes('comprovante bb') ||
               lower.includes('banco do brasil') ||
               lower.includes('bradesco') ||
               lower.includes('nubank') ||
               lower.includes('picpay') ||
               lower.includes('mercado pago') ||
               lower.includes('pagbank') ||
               lower.includes('c6 bank') ||
               lower.includes('itau') ||
               lower.includes('itaú') ||
               lower.includes('santander') ||
               lower.includes('sicredi') ||
               lower.includes('sicoob') ||
               lower.includes('caixa econômica') ||
               lower.includes('caixa economica') ||
               lower.includes('chave pix') ||
               lower.includes('comprovante de transferência') ||
               lower.includes('comprovante de transferencia') ||
               lower.includes('comprovante de depósito') ||
               lower.includes('comprovante de deposito');
    },

    isNotaFiscal(lower) {
        return lower.includes('cnpj') ||
               lower.includes('total a pagar') ||
               lower.includes('nota fiscal') ||
               lower.includes('cupom fiscal') ||
               lower.includes('subtotal') ||
               lower.includes('vendedor') ||
               lower.includes('fabricante') ||
               lower.includes('orçamento') ||
               lower.includes('orcanento') ||   // OCR garbled
               lower.includes('orcamento') ||
               lower.includes('ticket') ||
               /\bqtde\b/.test(lower) ||
               /\bvlr\b/.test(lower);
    },

    extractReceiptTotal(text) {
        // Tenta pegar o valor após "Total a Pagar" ou "Total:" na nota
        const totalPatterns = [
            /total\s+a\s+pagar[\s\S]{0,20}?r?\$?\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/i,
            /total\s+a\s+pagar[\s\S]{0,5}?\n\s*r?\$?\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/i,
            /total[:\s]+r?\$?\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/i,
            /valor\s+total[:\s]+r?\$?\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/i,
        ];
        for (const p of totalPatterns) {
            const m = text.match(p);
            if (m) {
                const val = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (!isNaN(val) && val > 0) return val;
            }
        }

        // Fallback: maior valor encontrado (provavelmente o total)
        const allValues = [];
        const re = /r\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/gi;
        let m;
        while ((m = re.exec(text)) !== null) {
            const v = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
            if (!isNaN(v) && v > 0) allValues.push(v);
        }
        return allValues.length ? Math.max(...allValues) : null;
    },

    extractValue(text) {
        const patterns = [
            /r\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2}))/i,
            /r\$\s*(\d+(?:,\d{2})?)/i,
            /valor[:\s]+r?\$?\s*(\d+(?:[.,]\d{2})?)/i,
            /(\d+(?:\.\d{3})*,\d{2})/
        ];
        for (const p of patterns) {
            const m = text.match(p);
            if (m) {
                const val = parseFloat(m[1].replace(/\./g, '').replace(',', '.'));
                if (!isNaN(val) && val > 0) return val;
            }
        }
        return null;
    },

    extractStoreName(text) {
        const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 3);
        const skipLine = /\b(cnpj|contato|email|endere|cidade|cliente|vendedor|venda|cpf|fabricante|qtde|vlr|unt|descri|ticket|orçamento|orcamento|obs|pago|subtotal|total|richet|remetente|dre|anais)\b/i;
        const addressInLine = /\b(rua|av\.|avenida|travessa|alameda|rodovia|estrada|cep|bairro|centro)\b/i;
        const isCleanLine = line => (line.match(/[a-zA-ZÀ-ú]/g) || []).length / line.length > 0.65;

        // 1. Busca padrão de nome em CAIXA ALTA no início de linha (ex: CASA ALMEIDA)
        const allCapsMatch = text.match(/^([A-ZÁÉÍÓÚÀÂÊÔÃÕÇ]{3,}(?:\s+[A-ZÁÉÍÓÚÀÂÊÔÃÕÇ]{2,}){0,5})/m);
        if (allCapsMatch) {
            const candidate = allCapsMatch[1].trim();
            const isJunk = /^(COMPROVANTE|RECIBO|BANCO|FABRICANTE|PRODUTO|TOTAL|QTDE|DESCRI|CONTATO|CNPJ|EMAIL|CIDADE|CLIENTE|VENDEDOR|PAGO|OBS|COD|PAGAMENTO|TRANSFERENCIA|TRANSFERÊNCIA)$/i.test(candidate);
            if (!isJunk && candidate.length > 3) {
                return candidate.split(' ')
                    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                    .join(' ');
            }
        }

        // 2. Tenta extrair domínio do email
        const emailMatch = text.match(/[\w.+-]+@([\w-]+)\./i);
        if (emailMatch) {
            const domain = emailMatch[1];
            const cleaned = domain
                .replace(/^(contato|info|suporte|admin|financeiro|vendas|comercial)/i, '')
                .replace(/[-_]/g, ' ').trim();
            if (cleaned.length > 3) {
                return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
            }
        }

        // 3. Palavras alfa-puras do início da primeira linha sem dígitos (OCR parcialmente garbled)
        for (const line of lines.slice(0, 8)) {
            if (skipLine.test(line)) continue;
            if (addressInLine.test(line)) continue;
            if (/^\W+$/.test(line)) continue;
            const words = line.split(/\s+/);
            const leadWords = [];
            for (const w of words) {
                if (/\d/.test(w)) break;
                const alpha = w.replace(/[^A-ZÀ-Úa-zà-ú]/g, '');
                if (alpha.length < 2) break;
                leadWords.push(alpha);
            }
            const name = leadWords.join(' ').trim();
            if (name.length >= 4) {
                return name.split(' ')
                    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                    .join(' ');
            }
        }

        // 4. Varre linhas buscando algo limpo (alta densidade de letras)
        for (const line of lines.slice(0, 12)) {
            if (skipLine.test(line)) continue;
            if (/^\d[\d\/\s:.,-]+$/.test(line)) continue;
            if (!isCleanLine(line)) continue;
            if (addressInLine.test(line)) {
                const before = line.split(addressInLine)[0].trim();
                if (before.length > 5 && isCleanLine(before)) return before.slice(0, 60);
                continue;
            }
            return line.slice(0, 60);
        }

        return 'Compra em loja';
    },

    guessReceiptCategory(lower) {
        if (/farmácia|farmacia|remédio|remedio|drogaria/.test(lower)) return 'Saúde';
        if (/mercado|supermercado|hortifruti|açougue|padaria|feira/.test(lower)) return 'Alimentação';
        if (/restaurante|lanchonete|pizza|hamburguer/.test(lower)) return 'Alimentação';
        if (/posto|gasolina|combustível|auto/.test(lower)) return 'Transporte';
        if (/livraria|papelaria|escola|curso/.test(lower)) return 'Educação';
        return 'Outros';
    },

    parseClipboardText(text) {
        return this.parseComprovante(text);
    }
};
