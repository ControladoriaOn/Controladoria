/* Regras do dia a dia: casamento, valor que vale, confirmação de divergência,
   relatório do próprio dia e devolução do banco. */
'use strict';
const { grupo, ok, igual, carregarConc } = require('./apoio');
const C = carregarConc();

const HOJE = '2026-08-26', ONTEM = '2026-08-25';
const tit = (n, vlr, venc, extra) => Object.assign({
  numero:n, prefixo:'', parcela:'', tipo:'NF', fornecedor_cod:'F'+n, loja:'01',
  id_fluig:'', fornecedor:'FORNEC '+n, vencimento:venc, dt_baixa:null,
  valor:vlr, valor_rs:vlr, valor_liquido:0, saldo:vlr, natureza:'1',
  banco:'ITAU', bordero:'9', manual:false, historico:'h' }, extra || {});
const rel = (n, forn, vlr, id, dt) => ({
  numero:n, id_manual:'REL~'+id, origem_manual:'relatorio', prefixo:'', parcela:'',
  tipo:'NF', fornecedor_cod:'', loja:'', fornecedor:forn, vencimento:dt, dt_baixa:dt,
  valor:vlr, valor_rs:vlr, valor_liquido:vlr, saldo:0, natureza:'1',
  banco:'ITAU', bordero:'2', manual:true, historico:'pgto' });

/* ------------------------------------------------------------------ valores */
grupo('Qual valor vale');
ok('previsto usa o valor do título', C.valorAPagar(tit('1', 850, HOJE)) === 850);
ok('previsto confirmado usa o confirmado',
   C.valorAPagar(tit('1', 850, HOJE, { valor_confirmado: 1000 })) === 1000);
ok('pago usa o que de fato saiu',
   C.valorAPagar(tit('1', 850, HOJE, { dt_baixa: HOJE, valor_liquido: 820 })) === 820);
ok('pago sem Val Liq Baix cai no valor do título',
   C.valorAPagar(tit('1', 850, HOJE, { dt_baixa: HOJE, valor_liquido: 0 })) === 850);
ok('confirmação não sobrevive à baixa',
   C.valorAPagar(tit('1', 850, HOJE, { dt_baixa: HOJE, valor_liquido: 830, valor_confirmado: 1000 })) === 830);

/* ------------------------------------------------------- ajustes e validade */
grupo('Ajustes manuais');
const ajusteConfirma = [{ id:'a', alvo:'|1||NF|F1|01', campo:'valor_confirmado',
  valor_novo:'1000', autor:'Arthur', quando: HOJE + 'T10:00' }];
let r = C.aplicarAjustes([tit('1', 850, HOJE)], ajusteConfirma);
ok('confirmação entra no título previsto', r.titulos[0].valor_confirmado === 1000);
r = C.aplicarAjustes([tit('1', 850, HOJE, { dt_baixa: HOJE, valor_liquido: 850 })], ajusteConfirma);
ok('e é descartada quando a baixa chega',
   !!(r.titulos[0]._edicoes.valor_confirmado || {}).descartado);
r = C.aplicarAjustes([tit('1', 1000, HOJE)],
  [{ id:'b', alvo:'|1||NF|F1|01', campo:'valor_rs', valor_novo:'1000', autor:'A', quando:'x' }]);
ok('ajuste que o Totvs passou a dizer é absorvido',
   !!(r.titulos[0]._edicoes.valor_rs || {}).absorvido);

/* ------------------------------------------------ confirmação de divergência */
grupo('Caixinha de confirmação');
const comFluig = (totvs, fluigVal, irrf) => {
  const t = tit('1', totvs, HOJE, { id_fluig:'99', irrf: irrf || 0 });
  const conc = C.conciliar({ totvs:[t], nf_servico:[{ id:99, fornecedor:'FORNEC 1',
    valor_total:fluigVal, vencimento:HOJE, status:'Aguardando Baixa', natureza_cod:'1' }],
    nf_titulo:[], reembolso:[] });
  return C.montarLinhas(conc, [])[0];
};
let l = comFluig(850, 1000, 150);
ok('divergência com retenção sugere o Totvs', l.confirmacao && l.confirmacao.sugerido === 'totvs');
igual('e nomeia o imposto', l.confirmacao.imposto, 'IRRF');
l = comFluig(900, 1000, 0);
ok('divergência sem explicação não sugere nada', l.confirmacao && l.confirmacao.sugerido === null);
l = comFluig(1000, 1000, 0);
ok('valores iguais não pedem confirmação', l.confirmacao === null);

/* ------------------------------------ relatório do dia baixando o previsto */
grupo('Relatório do próprio dia');
const titulos = [tit('101', 1000, HOJE), tit('102', 2000, HOJE), tit('103', 500, HOJE),
                 tit('201', 700, '2026-08-27')];
const baixas = [rel('090', 'ANTIGO', 333, 'o1', ONTEM),
                rel('101', 'FORNEC 101', 1000, 'h1', HOJE),
                rel('102', 'FORNEC 102', 2000, 'h2', HOJE),
                rel('999', 'AVULSO', 150, 'h3', HOJE)];
const casado = C.casarRelatorio(titulos, baixas);
ok('o título coberto pelo relatório sai do previsto',
   casado.titulos.filter(t => t._baixadoPorRelatorio).map(t => t.numero).join() === '101,102');
igual('linha do relatório sem título vira aviso', casado.semPar.map(x => x.numero), ['999']);
ok('relatório de dia anterior não vira aviso', casado.semPar.length === 1);
ok('a linha casada carrega a chave do título',
   casado.baixas[1].chave_titulo === '|101||NF|F101|01');

const conc = C.conciliar({ totvs: casado.titulos, nf_servico:[], nf_titulo:[], reembolso:[] });
const res = C.resumir(conc, HOJE, casado.baixas);
ok('o pago de ontem continua de ontem', res.dataPago === ONTEM && res.pago.valor === 333);
ok('o efetivo de hoje soma o relatório do dia', res.temEfetivoHoje && res.efetivoHoje.valor === 3150);
ok('o que não foi coberto continua previsto', res.previstoSobrou.valor === 500);
ok('amanhã não é tocado', res.abertoAmanha.valor === 700);
ok('nenhum pagamento aparece nos dois lugares',
   C.montarLinhas(conc, casado.baixas).filter(x => x.numero === '101').length === 1);

/* ----------------------------------------------------- devolução do banco */
grupo('Retorno do banco');
const ajDevolvido = [{ id:'d1', alvo:'manual:REL~h2', campo:'oculto', valor_novo:'1',
  autor:'Arthur', quando: HOJE + 'T18:00',
  motivo:'Devolvido pelo banco — Conta do beneficiário incorreta' }];
const aT = C.aplicarAjustes(titulos, ajDevolvido);
const aB = C.aplicarAjustes(baixas, ajDevolvido);
const c2 = C.casarRelatorio(aT.titulos, aB.titulos);
const conc2 = C.conciliar({ totvs: c2.titulos, nf_servico:[], nf_titulo:[], reembolso:[] });
const res2 = C.resumir(conc2, HOJE, c2.baixas);
const linhas2 = C.montarLinhas(conc2, c2.baixas);
ok('devolvido sai da soma do dia', res2.efetivoHoje.valor === 1150);
ok('e é contado como devolução', res2.devolvidosHoje.qtd === 1 && res2.devolvidosHoje.valor === 2000);
ok('o título volta a aparecer como previsto',
   linhas2.some(x => x.numero === '102' && x.fonte === 'previsto' && !x.dt_baixa));
ok('a linha devolvida guarda o motivo do banco',
   linhas2.filter(C.ehDevolvido).map(C.motivoRetorno)[0] === 'Conta do beneficiário incorreta');
ok('devolvido não entra no histórico do fluxo',
   C.montarHistorico({ titulos: linhas2.filter(x => x.fonte === 'baixa' && !x.oculto)
     .map(x => x.titulo) }).length === 3);
ok('o pago de ontem segue intacto', res2.pago.valor === 333);
