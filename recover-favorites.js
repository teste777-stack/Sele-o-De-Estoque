'use strict';
/**
 * recover-favorites.js
 * Recupera favoritos de um favorites.json truncado (escrita interrompida).
 * Estratégia: encontra o último objeto completo na array JSON quebrada e
 * reconstrói um array válido com todos os itens até esse ponto.
 *
 * Uso: node recover-favorites.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// userData do Electron no Windows
const userData = path.join(os.homedir(), 'AppData', 'Roaming', 'yupoo-scraper');
const favFile  = path.join(userData, 'favorites.json');
const outFile  = path.join(userData, 'favorites.json');
const bakFile  = path.join(userData, 'favorites.bak_truncated');

console.log('Lendo:', favFile);
const raw = fs.readFileSync(favFile, 'utf8');
console.log(`Tamanho do arquivo: ${raw.length} caracteres`);

// 1) Tenta parse direto (improvável mas seguro verificar)
try {
  const direct = JSON.parse(raw);
  console.log(`JSON já está válido! ${direct.length} favoritos.`);
  process.exit(0);
} catch (_) {
  console.log('JSON inválido (truncado) — iniciando recuperação…');
}

// 2) Tenta adicionar ']' no final (caso o corte foi entre objetos)
let recovered = null;
try {
  recovered = JSON.parse(raw + ']');
  console.log(`Recuperado com ']' simples: ${recovered.length} itens.`);
} catch (_) {
  // Não funcionou — o corte foi no meio de um objeto
}

// 3) Se não funcionou, remove o objeto incompleto do final
if (!recovered) {
  // Encontra a última ocorrência de "}," ou "}" que termina um objeto completo.
  // O padrão: o array é [...},{...},{...  (truncado)
  // Queremos o índice depois do último "}," que precede o objeto quebrado.
  let attempt = raw;
  // Remove tudo a partir do último '{' que não tem '}' correspondente
  for (let i = raw.length - 1; i >= 0; i--) {
    if (raw[i] === '}') {
      // Tenta fechar o array aqui
      const candidate = raw.slice(0, i + 1) + ']';
      try {
        recovered = JSON.parse(candidate);
        console.log(`Recuperado cortando em posição ${i}: ${recovered.length} itens.`);
        break;
      } catch (_) {
        // Continua procurando para trás
        if (i < raw.length - 500000) {
          // Se já recuamos 500KB sem achar nada, desiste para não demorar muito
          console.error('Não foi possível encontrar um corte válido nos últimos 500KB.');
          break;
        }
      }
    }
  }
}

if (!recovered || !Array.isArray(recovered) || recovered.length === 0) {
  console.error('Não foi possível recuperar nenhum favorito. Arquivo muito corrompido.');
  process.exit(1);
}

// Filtra apenas objetos que parecem favoritos válidos
const valid = recovered.filter(
  (f) => f && typeof f === 'object' && f.store && f.albumId
);
console.log(`Objetos válidos com store+albumId: ${valid.length} de ${recovered.length}`);

// Salva o arquivo recuperado
fs.writeFileSync(outFile, JSON.stringify(valid), 'utf8');
const saved = fs.statSync(outFile);
console.log(`\n✓ favorites.json recuperado: ${valid.length} favoritos, ${saved.size} bytes`);
console.log(`  Backup do arquivo truncado: ${bakFile}`);
console.log('\nReinicie o app para ver os favoritos recuperados.');
