# Proposta de Content-Security-Policy (NÃO ativada)

**Por que não ativei:** o GitHub Pages não envia cabeçalhos, então a CSP teria de ir em `<meta http-equiv="Content-Security-Policy">`.
Consegui validar a política abaixo em Chromium (Playwright) com o app carregado e os fluxos principais (abas Início/Histórico/Resumo/Investir,
modal de lançamento, compartilhar) — **0 violações** — mas o ambiente de teste não alcança `cdn.tailwindcss.com`: lá o Tailwind foi
substituído por um CSS pré-compilado. O script real do Tailwind (modo "play CDN") injeta `<style>` e pode exigir `'unsafe-eval'`; isso
**só se confirma no navegador com o site real**. Uma `<meta>` errada derruba o app inteiro para todos os usuários, então fica como proposta.

## Política validada (com os 2 concessões documentadas)
```
default-src 'none';
script-src  'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdn.tailwindcss.com;
style-src   'self' 'unsafe-inline';
img-src     'self' data: blob:;
font-src    'self' data:;
connect-src 'self' https://<ref-do-projeto>.supabase.co wss://<ref-do-projeto>.supabase.co;
worker-src  'self';
manifest-src 'self';
media-src   'self' blob:;
object-src  'none';
base-uri    'self';
form-action 'self';
frame-src   'none'
```
| Concessão | Motivo | Como eliminar |
|---|---|---|
| `script-src 'unsafe-inline'` | 1 bloco `<script>` inline (registro do Service Worker, ~linha 1919 do `index.html`) e 6 atributos `onclick=` em `index.html` (modais). **Sem** `'unsafe-inline'` o teste acusa `script-src-elem :: inline`. | Mover o bloco do SW para `js/sw-register.js` e trocar os 6 `onclick=` por `addEventListener`; depois remover `'unsafe-inline'` (com a CSP já validada, é o ganho real contra XSS). |
| `style-src 'unsafe-inline'` | `<style>` no `index.html`, 47 atributos `style="..."` e o Tailwind CDN injeta CSS em runtime. | Migrar o Tailwind para build (ver DECISOES.md, D6) e mover estilos inline para classes. |
| `'unsafe-eval'` (**ainda não incluído**) | Possivelmente exigido pelo Tailwind play CDN. | Testar no site real; se necessário, incluir **temporariamente** até migrar o Tailwind. |

Hosts: `cdn.jsdelivr.net` (supabase-js, chart.js, xlsx, jsPDF, autotable — com SRI), `cdn.tailwindcss.com` (sem SRI possível), Supabase (REST/Auth/Functions e WebSocket).
`https://wa.me` é só link de navegação (não precisa de diretiva).

## Como validar antes de ativar (sem risco para os usuários)
1. Em um deploy de teste (ex.: Netlify com arquivo `_headers`), publique com **`Content-Security-Policy-Report-Only: ...`** (a `<meta>` não suporta report-only) e navegue por todo o app com o DevTools aberto (aba Console/Network).
2. Repita: login, criar carteira, lançamento, parcelamento, importar Excel, exportar PDF/Excel, gráficos do Resumo, cofrinhos, push (ativar/desativar), recuperar senha.
3. Sem violações → troque para `<meta http-equiv="Content-Security-Policy" content="...">` no `index.html` (tem de vir antes de qualquer `<script>`).
4. Reversão: remover a `<meta>` e publicar.

## Como reproduzi a validação
`CSP="<política>" node csp_check.mjs` (harness local: servidor estático com o cabeçalho + listener de `securitypolicyviolation`).
