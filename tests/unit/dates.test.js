// G2 [MON-05]: datas de calendário no horário LOCAL (não UTC). Roda sob 4 fusos, com relógio simulado em processo filho.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..', '..');

const FUSOS = ['America/Sao_Paulo', 'UTC', 'Asia/Tokyo', 'America/New_York'];
// [relógio local simulado, hoje, mês, ontem(rótulo), cenário]
const CENARIOS = [
  ['2026-10-27 22:30', '2026-10-27', '2026-10', 'noite (22:30 local: em UTC já é o dia seguinte no Brasil)'],
  ['2026-10-28 00:30', '2026-10-28', '2026-10', 'madrugada (00:30 local: em UTC ainda é o dia anterior em Tóquio)'],
  ['2026-10-27 21:00', '2026-10-27', '2026-10', '21:00 exato (limite UTC-3 → 00:00Z)'],
  ['2026-10-31 23:30', '2026-10-31', '2026-10', 'última noite do mês: o mês NÃO pode virar'],
  ['2026-12-31 23:45', '2026-12-31', '2026-12', '31/12 à noite: o ano NÃO pode virar'],
  ['2027-01-01 00:15', '2027-01-01', '2027-01', '01/01 logo após a meia-noite'],
  ['2028-02-29 22:00', '2028-02-29', '2028-02', 'ano bissexto, 29/02 à noite'],
];

function rodar(fuso, relogio) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'dates-runner.js'), relogio],
    { env: { ...process.env, TZ: fuso }, encoding: 'utf8', cwd: ROOT });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

for (const fuso of FUSOS) {
  for (const [relogio, hoje, mes, desc] of CENARIOS) {
    test(`[${fuso}] ${relogio} — ${desc}`, () => {
      const o = rodar(fuso, relogio);
      assert.equal(o.todayLocal, hoje);
      assert.equal(o.monthKeyLocal, mes);
      assert.equal(o.appCurrentMonth, mes, 'mês inicial do app');
      assert.equal(o.localAddDefaultDate, hoje, 'data padrão do lançamento');
      assert.equal(o.formatHoje, 'Hoje');
      assert.equal(o.formatOntem, 'Ontem');
    });
  }
  test(`[${fuso}] helpers e aritmética de datas (bissexto, fim de mês, virada de ano)`, () => {
    const o = rodar(fuso, '2026-10-27 22:30');
    assert.equal(o.localDateStr, '2028-02-29');
    assert.deepEqual(o.parseDateLocal, [2026, 10, 27, 0], 'parse local: meia-noite local, dia correto');
    assert.equal(o.monthEnd_bissexto, '2028-02-29');
    assert.equal(o.monthEnd_nao_bissexto, '2027-02-28');
    assert.equal(o.monthEnd_dez, '2026-12-31');
    assert.equal(o.addMonths_31jan, '2026-02-28');
    assert.equal(o.addMonths_bissexto, '2028-02-29');
    assert.equal(o.addMonths_virada_ano, '2027-01-15');
    assert.equal(o.parseImport_vazio, '2026-10-27');
  });
}

test('nenhum uso de toISOString/new Date("AAAA-MM-DD") para DATA DE CALENDÁRIO fora da lista de exceções', () => {
  // Exceções (instantes/timestamps) documentadas em docs/qa/DECISOES.md (D8). Chave = arquivo:trecho.
  const EXCECOES = [
    /created_at\s*[:=]\s*new Date\(\)\.toISOString\(\)/, /updated_at\s*:\s*new Date\(\)\.toISOString\(\)/,
    /fire_at\s*:\s*new Date\(at\)\.toISOString\(\)/, /const at = new Date\(Date\.now\(\) \+ 40 \* 1000\)\.toISOString\(\)/,
    /created_at\s*:\s*new Date\(\)\.toISOString\(\)/,
  ];
  const achados = [];
  for (const f of fs.readdirSync(path.join(ROOT, 'js')).filter(n => n.endsWith('.js'))) {
    fs.readFileSync(path.join(ROOT, 'js', f), 'utf8').split('\n').forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, '');
      const calendario = /toISOString\(\)\s*\.\s*(?:split\('T'\)|slice\(0,\s*(?:7|10)\))/.test(code) || /new Date\((?:\w+\.)*\w*[dD]ate\s*\+\s*'T/.test(code) || /new Date\('\d{4}-/.test(code);
      if (calendario && !EXCECOES.some(re => re.test(code))) achados.push(`${f}:${i + 1}: ${l.trim()}`);
    });
  }
  assert.deepEqual(achados, [], 'datas de calendário via UTC/toISOString:\n' + achados.join('\n'));
});
