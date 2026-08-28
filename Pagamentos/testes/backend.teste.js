/* O que o Apps Script faz antes de gravar: exigir a chave e guardar uma cópia.
   E o resumo diário, que lê as mesmas abas por outro caminho. */
'use strict';
const { grupo, ok, igual, carregarCodeGs } = require('./apoio');
const A = carregarCodeGs();
const { ss, memoria, arquivos, post } = A;

/* ------------------------------------------------------------------- chave */
grupo('Chave de escrita');
ok('sem chave definida, tudo passa', chaveConfere_('qualquer') && !chaveExigida_());
definirChaveEscrita('segredo123');
ok('senha certa passa', chaveConfere_('segredo123') === true);
ok('senha errada barra', chaveConfere_('errada') === false);
ok('sem senha barra', chaveConfere_(undefined) === false);
let recusou = false;
try { definirChaveEscrita('123'); } catch(e){ recusou = true; }
ok('recusa senha curta demais', recusou);

memoria.Titulos = [{ numero: 'antigo' }];
A.limparDrive();
let r = post({ titulos: [{ numero: 'novo' }] });
ok('envio sem a chave é recusado', r.ok === false && /Chave/.test(r.erro));
ok('e nada foi gravado', memoria.Titulos[0].numero === 'antigo');
ok('e nenhum backup foi criado à toa', arquivos.length === 0);

/* ------------------------------------------------------------------ backup */
grupo('Backup antes de gravar');
r = post({ chave: 'segredo123', titulos: [{ numero: 'novo' }] });
ok('com a chave, grava', r.ok === true && memoria.Titulos[0].numero === 'novo');
ok('o estado anterior foi guardado', arquivos.length === 1 &&
   JSON.parse(arquivos[0]._corpo).abas.Titulos[0].numero === 'antigo');
ok('o nome do backup volta na resposta', /^pgv2-backup-/.test(r.recebido.backup));

memoria.Baixas = [{ numero: 'b1' }];
A.limparDrive();
r = post({ chave: 'segredo123', titulos: [{ numero: 'x' }] });
igual('só entra no backup a aba que o envio toca',
      Object.keys(JSON.parse(arquivos[0]._corpo).abas), ['Titulos']);

A.limparDrive();
r = post({ chave: 'segredo123', acao: 'limpar', alvo: 'tudo' });
ok('limpar também faz backup', arquivos.length === 1 && /^pgv2-backup-/.test(r.backup));
ok('e esvazia as abas', memoria.Titulos.length === 0);
ok('sem nada para salvar, não cria arquivo',
   post({ chave: 'segredo123', titulos: [{ numero: 'y' }] }).recebido.backup === '');

grupo('Restaurar');
memoria.Titulos = [{ numero: 'certo' }, { numero: 'certo2' }];
A.limparDrive();
post({ chave: 'segredo123', titulos: [{ numero: 'ERRADO' }] });
const nome = arquivos[0].getName();
restaurarBackup(nome);
ok('voltou ao estado anterior',
   memoria.Titulos.length === 2 && memoria.Titulos[0].numero === 'certo');
ok('e guardou o estado ruim antes de voltar',
   arquivos.length === 2 && JSON.parse(arquivos[1]._corpo).abas.Titulos[0].numero === 'ERRADO');

grupo('Rotatividade dos backups');
A.limparDrive();
for (let i = 0; i < 35; i++){
  arquivos.push({ _nome: 'pgv2-backup-2026-08-' + String(i).padStart(2,'0') + 'T00-00-00.json',
    _corpo: '{"abas":{}}', _lixo: false, getName(){ return this._nome; },
    getBlob(){ return { getDataAsString: () => this._corpo }; },
    setTrashed(v){ this._lixo = v; } });
}
const apagados = limparBackupsAntigos_();
const vivos = arquivos.filter(f => !f._lixo);
ok('mantém trinta', apagados === 5 && vivos.length === 30);
ok('e os que sobram são os mais novos', vivos[0].getName().indexOf('-05T') > 0);
removerChaveEscrita();

/* --------------------------------------------- de onde vem o id do histórico */
grupo('Planilha de histórico');
ok('sem propriedade, vale o que está no código', idHistorico_() === HIST_SHEET_ID);
definirIdHistorico('OUTRO-ID');
ok('com propriedade, ela manda', idHistorico_() === 'OUTRO-ID');
A.props['histSheetId'] = '';
ok('propriedade vazia volta para o código', idHistorico_() === HIST_SHEET_ID);
delete A.props['histSheetId'];

/* -------------------------------------------------------------- histórico */
grupo('Alimentação do histórico');
let gravou = 0;
const original = globalThis.gravarHistorico_;
globalThis.gravarHistorico_ = linhas => { gravou = (linhas || []).length; return { novos:gravou, atualizados:0 }; };
const envio = { titulos:[{ numero:'1' }],
  historico:[{ chave:'k', dt_baixa:'2026-08-26', valor_pago:100 }] };
post(envio);
if (ALIMENTAR_HISTORICO) ok('ligado: o histórico recebe o que veio', gravou === 1);
else ok('desligado: nada é gravado no histórico, mesmo se o envio trouxer', gravou === 0);
globalThis.gravarHistorico_ = original;

/* ---------------------------------------------------------- resumo diário */
grupo('Resumo diário');
const hoje = new Date().toISOString().slice(0,10);
const d = new Date(); do { d.setDate(d.getDate()+1); } while ([0,6].indexOf(d.getDay()) >= 0);
const amanha = d.toISOString().slice(0,10);
const d3 = new Date(); d3.setDate(d3.getDate()-3);
const atrasado = d3.toISOString().slice(0,10);
const t = (n, forn, venc, vlr, extra) => Object.assign({ prefixo:'', numero:n, parcela:'',
  tipo:'NF', fornecedor_cod:forn, loja:'01', vencimento:venc, valor_rs:vlr, dt_baixa:'' }, extra||{});
memoria.Titulos = [ t('1','A',hoje,1000), t('2','B',hoje,500), t('3','C',amanha,2000),
                    t('4','D',atrasado,333), t('5','E',hoje,900,{ dt_baixa:'2026-01-01' }) ];
memoria.TitulosManual = [];
memoria.Baixas = [ t('9','Z',hoje,777,{ dt_baixa:hoje, valor_liquido:777 }) ];
memoria.Ajustes = [
  { alvo:'|2||NF|B|01', campo:'oculto', valor_novo:'1', motivo:'ocultei à mão' },
  { alvo:'|9||NF|Z|01', campo:'oculto', valor_novo:'1', motivo:'Devolvido pelo banco — conta incorreta' },
];
A.props['lastUpdated'] = new Date().toISOString();
let R = montarResumoDiario_();
ok('vence hoje conta só o que vai sair', R.hoje.qtd === 1 && R.hoje.valor === 1000);
ok('vence amanhã', R.amanha.qtd === 1 && R.amanha.valor === 2000);
ok('atrasado', R.atrasado.qtd === 1 && R.atrasado.valor === 333);
ok('devolvido pelo banco aparece', R.devolucoes.qtd === 1 && R.devolucoes.valor === 777);
ok('base recente não vira alerta de base velha', R.baseVelha === false);
ok('mas atraso e devolução acendem o alerta', R.alerta === true);
igual('moeda em português', moedaBR_(1234567.8), 'R$ 1.234.567,80');
A.props['lastUpdated'] = new Date(Date.now() - 30*36e5).toISOString();
ok('base parada há trinta horas avisa', montarResumoDiario_().baseVelha === true);
