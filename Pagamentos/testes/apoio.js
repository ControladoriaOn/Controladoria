/* ============================================================================
   APOIO DOS TESTES
   ----------------------------------------------------------------------------
   Os testes rodam em Node puro, sem instalar nada. É de propósito: quem mantém
   esta ferramenta não é programador, e um teste que exige montar ambiente é um
   teste que ninguém roda.

   Duas coisas moram aqui: o carregamento do conciliacao.js (que espera um
   `window`) e um Apps Script de mentira, com o mínimo para o Code.gs rodar
   fora do Google.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const RAIZ = path.join(__dirname, '..');

let falhas = 0, passes = 0, secao = '', pulados = 0;
function grupo(nome){ secao = nome; console.log('\n— ' + nome); }
function ok(titulo, condicao, detalhe){
  if (condicao){ passes++; console.log('  ok   ' + titulo); }
  else { falhas++; console.log('  FALHA ' + titulo + (detalhe ? ('  → ' + detalhe) : '')); }
}
function igual(titulo, obtido, esperado){
  const a = JSON.stringify(obtido), b = JSON.stringify(esperado);
  ok(titulo, a === b, 'obtido ' + a + ', esperado ' + b);
}
function pular(motivo, quantas){
  pulados += (quantas || 0);
  console.log('  (pulado) ' + motivo);
}
function placar(){
  console.log('\n' + passes + ' passaram, ' + falhas + ' falharam' +
    (pulados ? (', ' + pulados + ' não puderam ser verificadas') : '') + '.');
  return falhas;
}

/* O conciliacao.js publica tudo em window.Conc. */
function carregarConc(){
  const g = globalThis;
  g.window = g;
  vm.runInThisContext(fs.readFileSync(path.join(RAIZ, 'conciliacao.js'), 'utf8'));
  return g.Conc;
}

/* O Code.gs mora no Apps Script; a cópia no repositório existe para estes
   testes. Se ela não estiver aqui, as verificações do backend não têm o que
   ler — e isso não é uma falha: é uma parte que não pôde ser conferida. O
   comando continua verde e diz, no fim, quantas ficaram de fora. */
function temCodeGs(){
  return fs.existsSync(path.join(RAIZ, 'Code.gs'));
}

/* Apps Script de mentira. Planilha e Drive viram objetos em memória; as abas
   são um mapa simples, porque o que se quer testar é a regra, não a API do
   Google. */
function carregarCodeGs(){
  const abas = {};
  const arquivos = [];
  const props = {};

  const mkFile = (nome, corpo) => ({
    _nome: nome, _corpo: corpo, _lixo: false,
    getName(){ return this._nome; },
    getBlob(){ const self = this; return { getDataAsString: () => self._corpo }; },
    setTrashed(v){ this._lixo = v; },
  });
  const pasta = {
    getFilesByType(){ const l = arquivos.filter(f => !f._lixo); let i = 0;
      return { hasNext: () => i < l.length, next: () => l[i++] }; },
    getFilesByName(n){ const l = arquivos.filter(f => !f._lixo && f._nome === n); let i = 0;
      return { hasNext: () => i < l.length, next: () => l[i++] }; },
    createFile(n, c){ const f = mkFile(n, c); arquivos.push(f); return f; },
  };

  globalThis.PropertiesService = { getScriptProperties: () => ({
    getProperty: k => (k in props ? props[k] : null),
    setProperty: (k, v) => { props[k] = String(v); },
    deleteProperty: k => { delete props[k]; },
  })};
  globalThis.Utilities = { formatDate: (d, tz, f) => {
    const x = new Date(d), p = n => String(n).padStart(2, '0');
    const Y = x.getFullYear(), M = p(x.getMonth()+1), D = p(x.getDate());
    const h = p(x.getHours()), m = p(x.getMinutes()), s = p(x.getSeconds());
    if (f.indexOf('HH-mm-ss') >= 0) return Y+'-'+M+'-'+D+'T'+h+'-'+m+'-'+s;
    if (f.indexOf('HH:mm:ssXXX') >= 0) return Y+'-'+M+'-'+D+'T'+h+':'+m+':'+s+'-03:00';
    if (f.indexOf('HH:mm:ss') >= 0) return Y+'-'+M+'-'+D+'T'+h+':'+m+':'+s;
    return Y+'-'+M+'-'+D;
  }};
  globalThis.MimeType = { PLAIN_TEXT: 'text/plain' };
  globalThis.Logger = { log: () => {} };
  globalThis.CacheService = { getScriptCache: () => ({
    get: () => null, put: () => {}, remove: () => {}, removeAll: () => {} }) };
  globalThis.ContentService = { MimeType: { JSON: 'json' },
    createTextOutput: t => ({ _t: t, setMimeType(){ return this; }, getContent(){ return this._t; } }) };
  globalThis.DriveApp = {
    getFoldersByName(){ let i = 0; return { hasNext: () => i++ < 1, next: () => pasta }; },
    createFolder: () => pasta };
  globalThis.MailApp = { _enviados: [], sendEmail(o){ this._enviados.push(o); } };
  globalThis.ScriptApp = { getProjectTriggers: () => [], newTrigger: () => ({
    timeBased: () => ({ atHour(){ return this; }, nearMinute(){ return this; },
      everyDays(){ return this; }, inTimezone(){ return this; }, create(){} }) }) };

  const memoria = {};
  const ss = { _id: 'PLANILHA', getId(){ return this._id; },
    getSheetByName: n => abas[n] || null, getSheets: () => Object.values(abas) };
  globalThis.SpreadsheetApp = { openById: () => ss, getActiveSpreadsheet: () => ss, flush(){} };

  const codigo = fs.readFileSync(path.join(RAIZ, 'Code.gs'), 'utf8');
  vm.runInThisContext(codigo);

  /* readTab_/writeTab_ de verdade falam com Range; aqui viram memória pura. */
  globalThis.readTab_ = (s, nome) => JSON.parse(JSON.stringify(memoria[nome] || []));
  globalThis.writeTab_ = (s, nome, arr) => { memoria[nome] = JSON.parse(JSON.stringify(arr || [])); };

  return { ss, memoria, arquivos, props,
    post: body => JSON.parse(doPost({ postData: { contents: JSON.stringify(body) } }).getContent()),
    limparDrive: () => { arquivos.length = 0; } };
}

module.exports = { grupo, ok, igual, pular, placar, carregarConc, carregarCodeGs, temCodeGs, RAIZ };
