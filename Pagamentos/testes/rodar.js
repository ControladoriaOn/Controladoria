/* Roda tudo. Sem dependência nenhuma: `node testes/rodar.js`. */
'use strict';
require('./conciliacao.teste');
require('./backend.teste');
process.exit(require('./apoio').placar() > 0 ? 1 : 0);
