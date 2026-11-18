function validarPagamento(dados) {
  if (!dados || typeof dados !== 'object' || Array.isArray(dados)) {
    return 'Envie um JSON com nome, email e valor.';
  }

  const { nome, email, valor } = dados;
  if (typeof nome !== 'string' || nome.trim().length < 2) {
    return 'Informe um nome com pelo menos 2 caracteres.';
  }
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return 'Informe um e-mail valido.';
  }
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0 || valor > 999999.99) {
    return 'O valor deve ser um numero positivo ate 999999.99.';
  }
  if (Math.abs(Math.round(valor * 100) - valor * 100) > 1e-7) {
    return 'O valor pode ter no maximo duas casas decimais.';
  }
  return null;
}

module.exports = { validarPagamento };
