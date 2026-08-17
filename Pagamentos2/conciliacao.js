/* ============================================================================
   PAGAMENTOS V2 · NÚCLEO DE CONCILIAÇÃO
   ----------------------------------------------------------------------------
   Arquivo compartilhado entre o painel (index.html) e a tela de envio
   (atualizar.html). Toda a regra de cruzamento Fluig x Totvs mora aqui, então
   um acerto vale para as duas telas de uma vez.

   Nada aqui toca no DOM nem na rede: entra dado, sai dado.
   ============================================================================ */
(function (raiz) {
'use strict';

/* ---------------------------------------------------------------- básicos */
const safeStr = v => (v === null || v === undefined) ? '' : String(v).trim();

function norm(s){
  return safeStr(s).toLowerCase().normalize('NFD')
    .replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
}
function normHdr(s){ return norm(s).replace(/[^a-z0-9]/g,''); }

/* Número de título: sem zeros à esquerda, sem espaço, maiúsculo.
   O Totvs grava "0E6828185" onde o Fluig manda "E6828185". */
function normNum(v){
  const s = safeStr(v).toUpperCase().replace(/\s+/g,'');
  if (!s) return '';
  return s.replace(/^0+/,'') || s;
}
/* Nome de favorecido: o Totvs corta em 20 caracteres e o Fluig às vezes traz
   o CNPJ na frente do nome. */
function normNome(v){
  return norm(v).replace(/^[\d.\-\/]+\s+/,'').replace(/[^a-z0-9 ]/g,'').trim();
}
function nomesBatem(a, b){
  const x = normNome(a), y = normNome(b);
  if (!x || !y) return false;
  const n = Math.min(x.length, y.length);
  return n < 8 ? (x === y) : (x.slice(0,n) === y.slice(0,n));
}

function parseBRNumber(x){
  if (x === null || x === undefined || x === '') return 0;
  if (typeof x === 'number') return x;
  let s = String(x).trim().replace(/R\$\s*/i,'').replace(/\s/g,'');
  if (!s) return 0;
  if (s.indexOf(',') >= 0) s = s.replace(/\./g,'').replace(',','.');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}
function parseBRDate(x){
  if (x === null || x === undefined || x === '') return null;
  if (x instanceof Date && !isNaN(x)){
    return x.getFullYear() + '-' + String(x.getMonth()+1).padStart(2,'0') + '-' + String(x.getDate()).padStart(2,'0');
  }
  const s = String(x).trim();
  if (!s || /^[\/\s]+$/.test(s)) return null;
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return m[3] + '-' + m[2] + '-' + m[1];
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return s.slice(0,10);
  const n = Number(s);
  if (!isNaN(n) && n > 20000 && n < 80000) return parseBRDate(new Date((n - 25569) * 86400 * 1000));
  return null;
}
const fmtBR  = n => (Number(n)||0).toLocaleString('pt-BR',{minimumFractionDigits:2, maximumFractionDigits:2});
const fmtBR0 = n => (Number(n)||0).toLocaleString('pt-BR',{minimumFractionDigits:0, maximumFractionDigits:0});
function fmtData(iso){
  if (!iso) return '—';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? (m[3]+'/'+m[2]+'/'+m[1]) : String(iso);
}
function hojeISO(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
/* ---------------------------------------------------------- dias úteis
   Pagamento só acontece em dia útil. Os feriados vêm da aba Feriados da
   planilha, que o Arthur edita uma vez por ano — sem isso o painel apontaria
   a previsão para um dia em que ninguém paga. */
let FERIADOS = {};
function definirFeriados(lista){
  FERIADOS = {};
  (lista || []).forEach(f => {
    const d = (typeof f === 'string') ? f : (f && (f.data || f.dia));
    const iso = safeStr(d).slice(0,10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) FERIADOS[iso] = (f && f.descricao) || 'feriado';
  });
}
function ehFeriado(iso){ return !!FERIADOS[safeStr(iso).slice(0,10)]; }

function isoDe_(d){
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function dataDe_(iso){
  const p = String(iso).split('-');
  return new Date(+p[0], +p[1]-1, +p[2]);
}
function ehDiaUtil(iso){
  const d = dataDe_(iso);
  return d.getDay() !== 0 && d.getDay() !== 6 && !ehFeriado(iso);
}
function proxDiaUtil(iso){
  const d = dataDe_(iso);
  do { d.setDate(d.getDate()+1); } while (!ehDiaUtil(isoDe_(d)));
  return isoDe_(d);
}
function diaUtilAnterior(iso){
  const d = dataDe_(iso);
  do { d.setDate(d.getDate()-1); } while (!ehDiaUtil(isoDe_(d)));
  return isoDe_(d);
}
/* Título que vence em sábado, domingo ou feriado é pago no próximo dia útil —
   é o que a controladoria faz na prática. A data original continua guardada
   para a tela poder mostrar de onde ele veio. */
function vencimentoEfetivo(iso){
  const s = safeStr(iso).slice(0,10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return ehDiaUtil(s) ? s : proxDiaUtil(s);
}

/* ---------------------------------------------------- acentos quebrados */
const MAPA_ACENTO = {
  '\u0081':'Á','\u0082':'Â','\u0083':'Ã','\u0084':'Ä','\u0087':'Ç','\u0088':'È',
  '\u0089':'É','\u008A':'Ê','\u008D':'Í','\u0093':'Ó','\u0094':'Ô','\u0095':'Õ',
  '\u009A':'Ú','\u00A0':'à','\u00A1':'á','\u00A2':'â','\u00A3':'ã','\u00A7':'ç',
  '\u00A8':'è','\u00A9':'é','\u00AA':'ê','\u00AD':'í','\u00B3':'ó','\u00B4':'ô',
  '\u00B5':'õ','\u00BA':'ú',
  '\u0192':'Ã','\u2021':'Ç','\u2030':'É','\u0160':'Ê','\u201C':'Ó',
  '\u201D':'Ô','\u2022':'Õ','\u0161':'Ú','\u02C6':'È','\u201E':'Ä',
};
function repararAcentos(t){
  if (t === null || t === undefined) return t;
  return String(t).replace(/[Aa]([\u0080-\u00BF\u0160\u0161\u0192\u02C6\u2021\u2022\u2030\u201C\u201D\u201E])/g,
    (todo, b) => MAPA_ACENTO[b] || todo);
}
const txt = v => repararAcentos(safeStr(v));

/* ------------------------------------------------------- status do Fluig
   O mapa pode ser sobrescrito pela aba Config da planilha, porque o Fluig
   inventa status novos de vez em quando. */
let MAPA_STATUS = null;
function definirMapaStatus(mapa){ MAPA_STATUS = mapa || null; }

function classificarStatus(status){
  const s = norm(status);
  if (!s) return 'outro';
  if (MAPA_STATUS){
    for (const chave in MAPA_STATUS){
      if (norm(chave) === s) return MAPA_STATUS[chave];
    }
  }
  if (s.indexOf('cancelad') >= 0) return 'cancelado';
  if (s.indexOf('aprovac') >= 0 || s.indexOf('aguardando aprova') >= 0) return 'pendente';
  if (s.indexOf('aguardando baixa') >= 0 || s.indexOf('disponivel') >= 0) return 'aprovado';
  return 'outro';
}

/* -------------------------------------------------------------- títulos */
/* Identidade do título. Lançamento próprio (CIOT e afins) repete o mesmo número
   todo dia, então ele carrega um id próprio — senão o ajuste feito no de hoje
   valeria também para o de ontem. */
function chaveTitulo(t){
  if (safeStr(t.id_manual)) return 'manual:' + safeStr(t.id_manual);
  return [t.prefixo, t.numero, t.parcela, t.tipo, t.fornecedor_cod, t.loja]
    .map(v => safeStr(v)).join('|');
}

/* Modelo do CIOT: um título por dia, valor total transferido, tudo fixo menos
   o valor. Os códigos vêm do relatório que a controladoria já usa. */
const MODELO_CIOT = {
  banco: 'ITAU', numero: '1', tipo: 'CIOT',
  natureza: '11030406', conta_fluxo: '21004', fluxo_caixa: 'Frota Tercerizada',
  fornecedor: 'EFRETE', bordero: 'Manual', manual: true, origem_manual: 'CIOT',
};
function novoCiot(dataISO){
  return Object.assign({}, MODELO_CIOT, {
    id_manual: 'CIOT-' + dataISO,
    vencimento: dataISO, dt_baixa: null,
    valor: 0, valor_rs: 0, valor_liquido: 0, saldo: 0,
    historico: 'ADIANTAMENTO CIOT ' + fmtData(dataISO),
  });
}
const estaPago = t => !!t.dt_baixa;

const SITUACOES = {
  pago:                ['Pago',                       'b-ok'],
  em_aberto:           ['Em aberto no Totvs',         'b-orange'],
  em_aberto_pendente:  ['Em aberto · falta aprovar',  'b-warn'],
  sem_titulo_pendente: ['Aguardando aprovação',       'b-warn'],
  sem_titulo_aprovado: ['Aprovado, sem título',       'b-danger'],
  cancelado:           ['Cancelado',                  'b-mute'],
};
/* Enquanto a solicitação não vira título, o Totvs ainda não deu um tipo a ela.
   Usamos o tipo que ela vai receber, pela categoria e pelo tipo de solicitação
   do Fluig — assim o filtro por tipo funciona também nessas linhas. */
function tipoPresumido(item){
  if (!item) return '';
  if (item.cat === 'nf_servico') return 'NF';
  if (item.cat === 'nf_titulo')  return 'BOL';
  if (item.cat === 'reembolso'){
    const s = norm(item.fluig && item.fluig.tipo_solicitacao);
    if (s.indexOf('adiantamento') >= 0 || s.indexOf('antecipa') >= 0) return 'PA';
    if (s.indexOf('prestacao') >= 0) return 'PC';
    return 'RB';
  }
  return '';
}

const semTituloSit  = s => s === 'sem_titulo_pendente' || s === 'sem_titulo_aprovado';
const aguardandoSit = s => s === 'sem_titulo_pendente' || s === 'em_aberto_pendente';

/* ============================================================================
   AJUSTES MANUAIS
   ----------------------------------------------------------------------------
   Aplicados por cima do dado cru a cada carregamento. Regra de validade: um
   ajuste vale até o Totvs contar a mesma história. Quando o dado original passa
   a dizer o que o ajuste dizia, o ajuste é dado como absorvido e sai de cena —
   é isso que impede a planilha de acumular mentira com o tempo.
   ============================================================================ */
const CAMPO_OCULTO = 'oculto';
const CAMPOS_DATA = ['vencimento','dt_baixa','dt_emissao'];
const CAMPOS_NUM  = ['valor','valor_rs','valor_liquido','saldo'];

function valorIgual(campo, a, b){
  if (CAMPOS_NUM.indexOf(campo) >= 0) return Math.abs(parseBRNumber(a) - parseBRNumber(b)) < 0.005;
  if (CAMPOS_DATA.indexOf(campo) >= 0) return safeStr(a).slice(0,10) === safeStr(b).slice(0,10);
  return safeStr(a) === safeStr(b);
}
function converter(campo, valor){
  if (CAMPOS_NUM.indexOf(campo) >= 0) return parseBRNumber(valor);
  if (CAMPOS_DATA.indexOf(campo) >= 0) return safeStr(valor) ? safeStr(valor).slice(0,10) : null;
  return safeStr(valor);
}

/* Recebe os títulos crus e o log de ajustes; devolve os títulos já ajustados,
   marcando em cada um o que foi editado. Não altera os objetos originais. */
function aplicarAjustes(titulos, ajustes){
  const log = (ajustes || []).filter(a => a && !a.desfeito);
  const porAlvo = {};
  log.forEach(a => { (porAlvo[safeStr(a.alvo)] = porAlvo[safeStr(a.alvo)] || []).push(a); });

  const usados = new Set();
  const saida = (titulos || []).map(t => {
    const chave = chaveTitulo(t);
    const lista = porAlvo[chave];
    if (!lista || !lista.length) return t;
    usados.add(chave);

    const novo = Object.assign({}, t);
    novo._edicoes = {};
    // ordem cronológica: o último ajuste de cada campo é o que vale
    lista.slice().sort((x, y) => safeStr(x.quando).localeCompare(safeStr(y.quando)))
      .forEach(a => {
        const campo = safeStr(a.campo);
        if (!campo) return;
        // o dado original já diz o que o ajuste dizia → absorvido
        if (campo !== CAMPO_OCULTO && valorIgual(campo, t[campo], a.valor_novo)){
          novo._edicoes[campo] = { id: a.id, autor: a.autor, quando: a.quando,
                                   original: t[campo], absorvido: true };
          return;
        }
        // título já baixado manda mais que qualquer previsão de vencimento
        if (campo === 'vencimento' && t.dt_baixa){
          novo._edicoes[campo] = { id: a.id, autor: a.autor, quando: a.quando,
                                   original: t[campo], descartado: true };
          return;
        }
        if (campo === CAMPO_OCULTO){
          // ocultar não é edição de dado: some da prévia e dos totais, mas o
          // título continua existindo e pode voltar a qualquer momento
          novo._oculto = safeStr(a.valor_novo) !== '0' && safeStr(a.valor_novo) !== '';
          novo._ocultoInfo = { id: a.id, autor: a.autor, quando: a.quando, motivo: a.motivo };
          return;
        }
        novo[campo] = converter(campo, a.valor_novo);
        novo._edicoes[campo] = { id: a.id, autor: a.autor, quando: a.quando,
                                 motivo: a.motivo, original: t[campo] };
      });
    novo._editado = Object.keys(novo._edicoes).some(k => {
      const e = novo._edicoes[k];
      return !e.absorvido && !e.descartado;
    });
    return novo;
  });

  /* Ajustes cuja chave não existe mais: o título mudou de identidade na origem
     ou saiu do relatório. Aparecem numa lista à parte em vez de sumir calados. */
  const orfaos = [];
  Object.keys(porAlvo).forEach(alvo => {
    if (usados.has(alvo) || alvo.indexOf('fluig:') === 0) return;
    porAlvo[alvo].forEach(a => orfaos.push(a));
  });

  return { titulos: saida, orfaos: orfaos };
}

/* ============================================================================
   CONCILIAÇÃO
   ----------------------------------------------------------------------------
   O Totvs carimba em cada título o campo IDFluig com o número da solicitação
   que o originou. Esse é o casamento exato, e vale para as três categorias,
   inclusive reembolso (que não tem número em comum entre os dois sistemas).

   Só quando o título está SEM IDFluig a gente tenta o casamento aproximado,
   por número (notas) ou por favorecido + vencimento + valor (reembolsos).
   Título que já tem um IDFluig diferente nunca é candidato: ele pertence a
   outra solicitação, e casar por semelhança ali só produziria erro.
   ============================================================================ */
const TOL = 0.05;

function conciliar(store){
  const titulos = store.totvs || [];
  const usados = new Set();

  const porIdFluig = {};
  titulos.forEach((t, i) => {
    const k = safeStr(t.id_fluig);
    if (k) (porIdFluig[k] = porIdFluig[k] || []).push(i);
  });
  const porNumero = {};
  titulos.forEach((t, i) => {
    if (safeStr(t.id_fluig)) return;
    const k = normNum(t.numero);
    if (k) (porNumero[k] = porNumero[k] || []).push(i);
  });

  const itens = [];

  const acharPar = (idFluig, aproximado) => {
    const exatos = (porIdFluig[safeStr(idFluig)] || []).filter(i => !usados.has(i));
    if (exatos.length) return { i: exatos[0], modo: 'id' };
    const apr = aproximado();
    return (apr === undefined || apr === null) ? null : { i: apr, modo: 'aprox' };
  };

  [['nf_servico','numero_nf','NF de Serviço'], ['nf_titulo','numero_titulo','Conta']]
  .forEach(function(cfg){
    const cat = cfg[0], campo = cfg[1], rotulo = cfg[2];
    (store[cat] || []).forEach(r => {
      const est = classificarStatus(r.status);
      const item = {
        cat: cat, rotulo: rotulo, fluig: r, estado: est,
        numero: safeStr(r[campo]), valor: r.valor_total,
        vencimento: r.vencimento, fornecedor: r.fornecedor,
        par: null, situacao: '', aviso: '', modoPar: '',
      };
      if (est !== 'cancelado'){
        const achado = acharPar(r.id, () => {
          const cands = (porNumero[normNum(r[campo])] || []).filter(i => !usados.has(i));
          const c = cands.find(i => titulos[i].vencimento === r.vencimento);
          return c !== undefined ? c : cands[0];
        });
        if (achado){ usados.add(achado.i); item.par = titulos[achado.i]; item.modoPar = achado.modo; }
      }
      classificarItem(item);
      itens.push(item);
    });
  });

  (store.reembolso || []).forEach(r => {
    const est = classificarStatus(r.status);
    const item = {
      cat: 'reembolso', rotulo: 'Reembolso', fluig: r, estado: est,
      numero: '', valor: r.valor_total, vencimento: r.vencimento,
      fornecedor: r.fornecedor, par: null, situacao: '', aviso: '', modoPar: '',
    };
    if (est !== 'cancelado'){
      const achado = acharPar(r.id, () => {
        const cands = [];
        titulos.forEach((t, i) => {
          if (usados.has(i) || safeStr(t.id_fluig)) return;
          if (!nomesBatem(t.fornecedor, r.fornecedor)) return;
          if (t.vencimento && r.vencimento && t.vencimento !== r.vencimento) return;
          cands.push(i);
        });
        const c = cands.find(i => Math.abs((titulos[i].valor_rs||0) - (r.valor_total||0)) <= TOL);
        if (c !== undefined) return c;
        return cands.length === 1 ? cands[0] : null;
      });
      if (achado){ usados.add(achado.i); item.par = titulos[achado.i]; item.modoPar = achado.modo; }
    }
    classificarItem(item);
    itens.push(item);
  });

  /* O que sobrou do Totvs, em dois casos bem diferentes:
     · direto — sem IDFluig e sem parcela em letras: lançado direto no Totvs
     · antigo — de solicitação de outro mês, incluindo parcela de parcelamento */
  const soTotvsDireto = [], soTotvsAntigo = [];
  titulos.forEach((t, i) => {
    if (usados.has(i)) return;
    const parcelado = /[A-Za-z]/.test(safeStr(t.parcela));
    ((safeStr(t.id_fluig) || parcelado) ? soTotvsAntigo : soTotvsDireto).push(t);
  });

  return { itens: itens, soTotvs: soTotvsDireto.concat(soTotvsAntigo),
           soTotvsDireto: soTotvsDireto, soTotvsAntigo: soTotvsAntigo, titulos: titulos };
}

/* Estar aprovado no Fluig e existir como título no Totvs são coisas
   independentes: nos dados reais aparece título já lançado cuja liberação de
   pagamento ainda está em aprovação. Por isso as duas dimensões entram. */
function classificarItem(item){
  const t = item.par;
  if (item.estado === 'cancelado'){ item.situacao = 'cancelado'; return; }
  if (!t){
    item.situacao = (item.estado === 'pendente') ? 'sem_titulo_pendente' : 'sem_titulo_aprovado';
    if (item.fluig.valor_numerico_cru) item.aviso = 'valor_corrigido_sem_par';
    return;
  }
  if (estaPago(t)) item.situacao = 'pago';
  else item.situacao = (item.estado === 'pendente') ? 'em_aberto_pendente' : 'em_aberto';

  if (item.fluig.valor_numerico_cru && Math.abs((t.valor_rs||0) - (item.valor||0)) <= TOL){
    item.aviso = 'valor_corrigido';
    return;
  }
  if (Math.abs((t.valor_rs||0) - (item.valor||0)) > TOL) item.aviso = 'valor_diverge';
}

/* ============================================================================
   NÚMEROS DO DIA
   Cada título é classificado pelo VENCIMENTO dele, não pela data do envio.
   ============================================================================ */
/* Um título nunca é baixado no dia em que é pago: o pagamento de hoje só vira
   baixa amanhã. Por isso "Pago" é sempre uma foto de um dia anterior, e vem de
   um relatório próprio (filtrado por data de baixa), não do de vencimento. */
function resumir(conc, dataRef, baixas){
  const amanha = proxDiaUtil(dataRef);
  const z = () => ({ qtd:0, valor:0 });
  const r = {
    dataRef: dataRef, amanha: amanha,
    pago: z(), dataPago: null, datasBaixa: [],
    pagoHoje: z(),
    abertoHoje: z(), abertoAmanha: z(),        // títulos do Totvs, sem baixa
    foraTotvsHoje: z(), foraTotvsAmanha: z(),  // Fluig que ainda não virou título
    aPagarHoje: z(), aPagarAmanha: z(),        // soma dos dois acima
    aguardandoHoje: z(), aguardandoAmanha: z(),// recorte sobreposto: falta aprovar
    atrasado: z(), semTituloAprovado: z(), cancelados: z(),
    divergencias: 0, suspeitos: 0, aproximados: 0, editados: 0, ocultos: 0,
    soTotvs: z(), historico: z(), temDataRef: false,
  };
  const add = (b, v) => { b.qtd++; b.valor += (Number(v)||0); };

  /* Pago — vem do relatório de baixas. A data é a que estiver no arquivo, e a
     tela mostra qual é, em vez de fingir que é sempre ontem. */
  /* O CIOT nunca aparece no relatório de baixas do Totvs — ele é lançado aqui.
     Por isso o Pago soma as duas fontes: o relatório e os lançamentos próprios
     que já têm data de pagamento. */
  const manuaisPagos = (conc.titulos || []).filter(t => t.manual && t.dt_baixa && !t._oculto);
  const bx = (baixas || []).filter(t => !t._oculto).concat(manuaisPagos);
  const porData = {};
  bx.forEach(t => {
    const d = safeStr(t.dt_baixa).slice(0,10);
    if (!d) return;
    (porData[d] = porData[d] || []).push(t);
  });
  r.datasBaixa = Object.keys(porData).sort();
  if (r.datasBaixa.length){
    // a mais recente que não passe do dia escolhido; senão, a mais recente de todas
    const ateHoje = r.datasBaixa.filter(d => d <= dataRef);
    r.dataPago = ateHoje.length ? ateHoje[ateHoje.length-1] : r.datasBaixa[r.datasBaixa.length-1];
    (porData[r.dataPago] || []).forEach(t => add(r.pago, t.valor_liquido || t.valor_rs));
  }

  conc.titulos.forEach(t => {
    if (t._oculto){ r.ocultos++; return; }
    if (t._editado) r.editados++;
    const venc = vencimentoEfetivo(t.vencimento);
    if (venc === dataRef || t.dt_baixa === dataRef) r.temDataRef = true;
    if (estaPago(t)){
      // manual já pago entrou no bloco do Pago acima; não conta duas vezes
      if (t.manual) return;
      if (t.dt_baixa === dataRef) add(r.pagoHoje, t.valor_liquido || t.valor_rs);
      add(r.historico, t.valor_liquido || t.valor_rs);
      return;
    }
    if (!venc) return;
    if (venc === dataRef) add(r.abertoHoje, t.valor_rs);
    else if (venc === amanha) add(r.abertoAmanha, t.valor_rs);
    else if (venc < dataRef) add(r.atrasado, t.valor_rs);
  });
  (conc.soTotvsDireto || []).forEach(t => { if (!estaPago(t)) add(r.soTotvs, t.valor_rs); });

  conc.itens.forEach(it => {
    if (it.par && it.par._oculto) return;
    if (it.aviso === 'valor_diverge') r.divergencias++;
    if (it.aviso === 'valor_corrigido' || it.aviso === 'valor_corrigido_sem_par') r.suspeitos++;
    if (it.modoPar === 'aprox') r.aproximados++;
    if (it.situacao === 'cancelado'){ add(r.cancelados, it.valor); return; }

    // no "a pagar" só entra o que ainda NÃO existe como título — o que já
    // existe já foi contado do lado do Totvs, somar de novo duplicaria
    const vi = vencimentoEfetivo(it.vencimento);
    if (semTituloSit(it.situacao)){
      if (it.situacao === 'sem_titulo_aprovado') add(r.semTituloAprovado, it.valor);
      if (vi === dataRef) add(r.foraTotvsHoje, it.valor);
      else if (vi === amanha) add(r.foraTotvsAmanha, it.valor);
    }
    if (aguardandoSit(it.situacao)){
      if (vi === dataRef) add(r.aguardandoHoje, it.valor);
      else if (vi === amanha) add(r.aguardandoAmanha, it.valor);
    }
  });

  const soma = (a, b) => ({ qtd: a.qtd + b.qtd, valor: a.valor + b.valor });
  r.aPagarHoje = soma(r.abertoHoje, r.foraTotvsHoje);
  r.aPagarAmanha = soma(r.abertoAmanha, r.foraTotvsAmanha);
  return r;
}

/* ============================================================================
   LINHAS UNIFICADAS
   ----------------------------------------------------------------------------
   O painel mostra uma lista só, não uma lista do Totvs e outra do Fluig. Cada
   linha é um pagamento: ou um título (com a solicitação do Fluig junto, quando
   houver) ou uma solicitação do Fluig que ainda não virou título.
   ============================================================================ */
function montarLinhas(conc, baixas){
  const itemPorTitulo = new Map();
  conc.itens.forEach(it => { if (it.par) itemPorTitulo.set(it.par, it); });

  const linhas = [];

  const doTitulo = (t, ondeVeio) => {
    const it = itemPorTitulo.get(t);
    const parcelado = /[A-Za-z]/.test(safeStr(t.parcela));
    return {
      // lançamento próprio já pago conta como baixa, mesmo sem estar no
      // relatório do Totvs — é o caso do CIOT
      fonte: (t.manual && t.dt_baixa) ? 'baixa' : ondeVeio,
      chave: chaveTitulo(t),
      manual: !!t.manual,
      id_manual: t.id_manual || '',
      titulo: t, item: it || null,
      tipo: safeStr(t.tipo) || tipoPresumido(it),
      origem: it ? it.rotulo
              : (t.origem_manual === 'relatorio' ? 'Relatório do dia'
              : (t.manual ? (t.origem_manual || 'Lançado à mão')
              : ((safeStr(t.id_fluig) || parcelado) ? 'Fluig (anterior)' : 'Direto no Totvs'))),
      numero: t.numero + (t.parcela ? ('/' + t.parcela) : ''),
      fornecedor: t.fornecedor,
      detalhe: t.historico,
      vencimento: vencimentoEfetivo(t.vencimento) || t.vencimento,
      vencimentoOriginal: t.vencimento,
      empurrado: !!(t.vencimento && vencimentoEfetivo(t.vencimento) !== t.vencimento),
      dt_baixa: t.dt_baixa,
      valor: (ondeVeio === 'baixa') ? (t.valor_liquido || t.valor_rs) : t.valor_rs,
      valorTotvs: t.valor_rs,
      valorFluig: it ? it.valor : null,
      situacao: it ? it.situacao : (estaPago(t) ? 'pago' : 'em_aberto'),
      aviso: it ? it.aviso : '',
      modoPar: it ? it.modoPar : '',
      id_fluig: t.id_fluig,
      status: it ? it.fluig.status : '',
      editavel: true,
      editado: !!t._editado,
      edicoes: t._edicoes || null,
      oculto: !!t._oculto,
      ocultoInfo: t._ocultoInfo || null,
      estimado: !!(t.manual && !t.dt_baixa),
      natureza: t.natureza, conta_fluxo: t.conta_fluxo, fluxo_caixa: t.fluxo_caixa,
      banco: t.banco, bordero: t.bordero,
      valorPago: t.valor_liquido || t.valor_rs,
    };
  };

  (conc.titulos || []).forEach(t => linhas.push(doTitulo(t, 'previsto')));
  (baixas || []).forEach(t => linhas.push(doTitulo(t, 'baixa')));

  // solicitações do Fluig que ainda não viraram título
  conc.itens.forEach(it => {
    if (it.par) return;
    linhas.push({
      fonte: 'previsto',
      chave: 'fluig:' + it.fluig.id,
      titulo: null, item: it,
      origem: it.rotulo,
      numero: it.numero || ('#' + it.fluig.id),
      fornecedor: it.fornecedor,
      detalhe: it.fluig.solicitante ? ('solicitado por ' + it.fluig.solicitante) : '',
      vencimento: vencimentoEfetivo(it.vencimento) || it.vencimento,
      vencimentoOriginal: it.vencimento,
      empurrado: !!(it.vencimento && vencimentoEfetivo(it.vencimento) !== it.vencimento),
      dt_baixa: null,
      valor: it.valor, valorTotvs: null, valorFluig: it.valor,
      situacao: it.situacao, aviso: it.aviso, modoPar: '',
      tipo: tipoPresumido(it),
      id_fluig: safeStr(it.fluig.id), status: it.fluig.status,
      editavel: false,
      editado: false, edicoes: null, oculto: false, ocultoInfo: null,
      estimado: false, manual: false, id_manual: '',
      natureza: it.fluig.natureza_cod || '', conta_fluxo: '', fluxo_caixa: '',
      banco: '', bordero: '', valorPago: it.valor,
    });
  });

  return linhas;
}

/* Linhas que vão para o histórico (base do futuro fluxo de caixa):
   todo título com data de baixa, seja de qual vencimento for. */
function montarHistorico(conc){
  return conc.titulos.filter(estaPago).map(t => ({
    chave: chaveTitulo(t),
    dt_baixa: t.dt_baixa, vencimento: t.vencimento,
    numero: t.numero, id_fluig: t.id_fluig,
    parcela: t.parcela, prefixo: t.prefixo, tipo: t.tipo,
    natureza: t.natureza, conta_fluxo: t.conta_fluxo,
    fornecedor_cod: t.fornecedor_cod, loja: t.loja, fornecedor: t.fornecedor,
    valor_pago: t.valor_liquido || t.valor_rs,
    valor_titulo: t.valor_rs,
    historico: t.historico, banco: t.banco, bordero: t.bordero,
    fluxo_caixa: t.fluxo_caixa,
    origem: t.manual ? 'manual' : 'totvs',
  }));
}

/* ============================================================================
   EXPORTAÇÃO NO FORMATO DO RELATÓRIO DA CONTROLADORIA
   ----------------------------------------------------------------------------
   Reproduz o arquivo que a equipe já usa: aba Descritivo, título com a data,
   doze colunas na ordem conhecida, Courier New 8 centralizado, coluna Banco em
   laranja e o TOTAL A PAGAR com SUBTOTAL, que continua respeitando o filtro se
   alguém filtrar a planilha depois.

   Conta Fluxo C e Fluxo Caixa saem com o valor já resolvido pelo mapa de
   naturezas, em vez do PROCV com link externo do modelo original.
   ============================================================================ */
/* Código interno do banco no Protheus, não o número da FEBRABAN: aqui o 001 é
   a conta do Itaú. Códigos novos aparecem no relatório como estão, para ficar
   visível que falta traduzir, em vez de sair um nome errado. */
const BANCOS = { '001':'ITAU' };
function nomeBanco(cod){
  const s = safeStr(cod);
  if (!s) return 'ITAU';
  return BANCOS[s] || BANCOS[s.replace(/^0+/,'').padStart(3,'0')] || s;
}

const COLUNAS_RELATORIO = [
  'Banco','No. Titulo','Tipo','Natureza','Conta Fluxo C','Fluxo Caixa',
  'Nome Fornece','Vencto Real','Vlr.Titulo','Historico','Saldo','Bordero',
];
const LARGURAS_RELATORIO = [10, 12, 7, 12, 16.3, 18.6, 23.1, 12.7, 13.4, 27.7, 14.9, 12.6];
const FMT_CONTABIL = '_-* #,##0.00_-;\\-* #,##0.00_-;_-* "-"??_-;_-@_-';

/* Uma linha da tela vira uma linha do relatório. */
function linhaRelatorio(x, naturezas){
  const nat = safeStr(x.natureza);
  const info = (naturezas && (naturezas[nat] || naturezas[nat.replace(/^0+/,'')])) || null;
  const conta = x.conta_fluxo || (info ? info.conta_fluxo : '');
  const fluxo = x.fluxo_caixa && x.fluxo_caixa !== 'Sim' && x.fluxo_caixa !== 'Nao'
    ? x.fluxo_caixa : (info ? info.fluxo_caixa : '');
  const numero = safeStr(x.titulo ? x.titulo.numero : x.numero);
  return [
    nomeBanco(x.banco),
    /^\d+$/.test(numero) ? Number(numero) : numero,
    safeStr(x.titulo ? x.titulo.tipo : ''),
    /^\d+$/.test(nat) ? Number(nat) : nat,
    /^\d+$/.test(safeStr(conta)) ? Number(conta) : safeStr(conta),
    safeStr(fluxo),
    safeStr(x.fornecedor),
    (x.vencimentoOriginal || x.vencimento) ? new Date((x.vencimentoOriginal || x.vencimento) + 'T12:00:00') : '',
    Number(x.valorTotvs != null ? x.valorTotvs : x.valor) || 0,
    safeStr(x.detalhe).replace(/[\r\n]+/g, ' '),
    Number(x.valorPago != null ? x.valorPago : x.valor) || 0,
    safeStr(x.bordero) || 'Manual',
  ];
}

/* Monta e baixa o arquivo. Precisa do XLSX (xlsx-js-style) já carregado. */
function exportarRelatorio(linhas, dataRef, naturezas, recorte){
  if (typeof XLSX === 'undefined') throw new Error('Biblioteca de planilha não carregada.');
  const visiveis = (linhas || []).filter(x => !x.oculto);
  if (!visiveis.length) throw new Error('Nada para exportar.');

  const titulo = 'RELATÓRIO CONTAS A PAGAR ON TIME - ' + fmtData(dataRef) +
    (recorte ? ('  ·  ' + recorte) : '');
  const aoa = [[], [titulo], [], COLUNAS_RELATORIO.slice()];
  visiveis.forEach(x => aoa.push(linhaRelatorio(x, naturezas)));

  const primeira = 5;                       // linha 5 do Excel
  const ultima = primeira + visiveis.length - 1;
  const linhaTotal = ultima + 2;
  while (aoa.length < linhaTotal - 1) aoa.push([]);
  const total = [];
  total[9]  = 'TOTAL A PAGAR';
  total[10] = { f: 'SUBTOTAL(9,K' + primeira + ':K' + ultima + ')' };
  aoa.push(total);

  const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true });
  ws['!merges'] = [{ s:{r:1,c:0}, e:{r:1,c:11} }];
  ws['!cols'] = LARGURAS_RELATORIO.map(w => ({ wch: w }));
  ws['!autofilter'] = { ref: 'A4:L' + ultima };

  const base = { font:{ name:'Courier New', sz:8 }, alignment:{ horizontal:'center', vertical:'center' } };
  const clone = extra => JSON.parse(JSON.stringify(Object.assign({}, base, extra)));

  const estilos = {
    titulo: clone({ font:{ name:'Courier New', sz:8, bold:true } }),
    cabec:  clone({ font:{ name:'Courier New', sz:8, bold:true } }),
    banco:  clone({ fill:{ patternType:'solid', fgColor:{ rgb:'FFC000' } } }),
    normal: clone({}),
  };

  const setStyle = (addr, s, z) => {
    if (!ws[addr]) ws[addr] = { t:'z' };
    ws[addr].s = s;
    if (z) ws[addr].z = z;
  };
  setStyle('A2', estilos.titulo);
  COLUNAS_RELATORIO.forEach((_, i) => setStyle(XLSX.utils.encode_col(i) + '4', estilos.cabec));

  for (let r = primeira; r <= ultima; r++){
    for (let c = 0; c < COLUNAS_RELATORIO.length; c++){
      const addr = XLSX.utils.encode_col(c) + r;
      const s = (c === 0) ? estilos.banco : estilos.normal;
      let z = null;
      if (c === 8 || c === 10) z = FMT_CONTABIL;
      if (c === 7) z = 'dd/mm/yyyy';
      setStyle(addr, s, z);
    }
  }
  setStyle('J' + linhaTotal, clone({ font:{ name:'Courier New', sz:8, bold:true } }));
  setStyle('K' + linhaTotal, clone({ font:{ name:'Courier New', sz:8, bold:true } }), FMT_CONTABIL);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Descritivo');
  const nome = dataRef.replace(/-/g,'_') + '_RELATORIO_CONTAS_A_PAGAR' +
    (recorte ? ('_' + norm(recorte).replace(/[^a-z0-9]+/g,'_')) : '') + '.xlsx';
  XLSX.writeFile(wb, nome);
  return { linhas: visiveis.length, arquivo: nome };
}

/* ============================================================================
   TENDÊNCIA DO PAGO
   Últimos dias úteis a partir do histórico já empilhado. Serve para o número do
   Pago deixar de ser um valor solto e ganhar contexto.
   ============================================================================ */
function serieDiaria(baixas, ateISO, dias){
  const n = dias || 10;
  const porData = {};
  (baixas || []).filter(t => !t._oculto).forEach(t => {
    const d = safeStr(t.dt_baixa).slice(0,10);
    if (!d) return;
    porData[d] = (porData[d] || 0) + (Number(t.valor_liquido || t.valor_rs) || 0);
  });
  const saida = [];
  let cursor = ehDiaUtil(ateISO) ? ateISO : diaUtilAnterior(ateISO);
  for (let i = 0; i < n; i++){
    saida.unshift({ data: cursor, valor: porData[cursor] || 0, temDado: cursor in porData });
    cursor = diaUtilAnterior(cursor);
  }
  return saida;
}

/* -------------------------------------------------------------- exporta */
raiz.Conc = {
  safeStr, norm, normHdr, normNum, normNome, nomesBatem,
  parseBRNumber, parseBRDate, fmtBR, fmtBR0, fmtData, hojeISO,
  proxDiaUtil, diaUtilAnterior, ehDiaUtil, ehFeriado, definirFeriados, vencimentoEfetivo,
  repararAcentos, txt,
  classificarStatus, definirMapaStatus,
  chaveTitulo, estaPago, SITUACOES, semTituloSit, aguardandoSit, tipoPresumido, TOL,
  aplicarAjustes, conciliar, resumir, montarLinhas, montarHistorico,
  exportarRelatorio, linhaRelatorio, nomeBanco, COLUNAS_RELATORIO, serieDiaria,
  MODELO_CIOT, novoCiot, CAMPO_OCULTO,
  CAMPOS_DATA, CAMPOS_NUM,
};

})(typeof window !== 'undefined' ? window : globalThis);
