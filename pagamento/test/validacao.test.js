const test = require('node:test');
const assert = require('node:assert/strict');
const { validarPagamento } = require('../src/validacao');

test('aceita pagamento com dados corretos', () => {
  assert.equal(validarPagamento({ nome: 'Ana Silva', email: 'ana@exemplo.com', valor: 89.9 }), null);
});

test('rejeita email invalido', () => {
  assert.match(validarPagamento({ nome: 'Ana', email: 'invalido', valor: 20 }), /e-mail/);
});

test('rejeita valor negativo', () => {
  assert.match(validarPagamento({ nome: 'Ana', email: 'ana@exemplo.com', valor: -5 }), /positivo/);
});

test('rejeita mais de duas casas decimais', () => {
  assert.match(validarPagamento({ nome: 'Ana', email: 'ana@exemplo.com', valor: 10.123 }), /duas casas/);
});

test('aceita valores monetarios comuns, como 19.99 e 0.29', () => {
  for (const valor of [19.99, 0.29, 29.99]) {
    assert.equal(validarPagamento({ nome: 'Ana', email: 'ana@exemplo.com', valor }), null);
  }
});
