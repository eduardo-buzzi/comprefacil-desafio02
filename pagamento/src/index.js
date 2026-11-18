const express = require('express');
const { Pool } = require('pg');
const amqp = require('amqplib');
const { validarPagamento } = require('./validacao');

const PORTA = Number(process.env.PORT || 3001);
const FILA_NOTIFICACOES = 'fila.notificacoes';
const FILA_CONFIRMACOES = 'fila.confirmacoes';
const banco = new Pool({ connectionString: process.env.DATABASE_URL });
const app = express();
app.use(express.json());

let conexaoRabbit;
let canalRabbit;
let recuperacaoEmAndamento = false;

function publicar(fila, evento) {
  if (!canalRabbit) throw new Error('RabbitMQ indisponivel.');
  return new Promise((resolve, reject) => {
    canalRabbit.sendToQueue(
      fila,
      Buffer.from(JSON.stringify(evento)),
      { persistent: true, contentType: 'application/json' },
      (erro) => (erro ? reject(erro) : resolve())
    );
  });
}

async function criarTabela() {
  await banco.query(`
    CREATE TABLE IF NOT EXISTS pagamentos (
      id SERIAL PRIMARY KEY,
      nome VARCHAR(120) NOT NULL,
      email VARCHAR(180) NOT NULL,
      valor NUMERIC(10,2) NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'PENDENTE',
      solicitacao_publicada BOOLEAN NOT NULL DEFAULT FALSE,
      confirmacao_publicada BOOLEAN NOT NULL DEFAULT FALSE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function eventoSolicitacao(pagamento) {
  return {
    tipo: 'PAGAMENTO_RECEBIDO',
    pagamento: {
      id: pagamento.id,
      nome: pagamento.nome,
      email: pagamento.email,
      valor: pagamento.valor
    }
  };
}

async function publicarSolicitacao(pagamento) {
  await publicar(FILA_NOTIFICACOES, eventoSolicitacao(pagamento));
  await banco.query('UPDATE pagamentos SET solicitacao_publicada = TRUE WHERE id = $1', [pagamento.id]);
  console.log(`[PAGAMENTO] Solicitacao #${pagamento.id} publicada no RabbitMQ`);
}

// Tenta reenviar solicitacoes que foram gravadas, mas nao publicadas.
async function reenviarSolicitacoesPendentes() {
  if (recuperacaoEmAndamento || !canalRabbit) return;
  recuperacaoEmAndamento = true;
  try {
    const { rows } = await banco.query(
      'SELECT * FROM pagamentos WHERE solicitacao_publicada = FALSE ORDER BY id LIMIT 50'
    );
    for (const pagamento of rows) await publicarSolicitacao(pagamento);
  } catch (erro) {
    console.error('[PAGAMENTO] Falha na republicacao:', erro.message);
  } finally {
    recuperacaoEmAndamento = false;
  }
}

async function receberConfirmacao(mensagem) {
  if (!mensagem) return;
  try {
    const evento = JSON.parse(mensagem.content.toString());
    if (evento.tipo !== 'SOLICITACAO_NOTIFICADA' || !Number.isInteger(evento.pagamentoId)) {
      console.warn('[PAGAMENTO] Evento desconhecido ignorado');
      canalRabbit.ack(mensagem);
      return;
    }

    const id = evento.pagamentoId;
    await banco.query(
      "UPDATE pagamentos SET status = 'SUCESSO' WHERE id = $1 AND status = 'PENDENTE'",
      [id]
    );
    const { rows } = await banco.query('SELECT * FROM pagamentos WHERE id = $1', [id]);
    const pagamento = rows[0];
    if (!pagamento) {
      console.warn(`[PAGAMENTO] Pagamento #${id} nao encontrado`);
      canalRabbit.ack(mensagem);
      return;
    }

    // Se houver reentrega, nao gera uma segunda confirmacao se ja foi publicada.
    if (!pagamento.confirmacao_publicada) {
      await publicar(FILA_NOTIFICACOES, {
        tipo: 'PAGAMENTO_CONFIRMADO',
        pagamento: {
          id: pagamento.id,
          nome: pagamento.nome,
          email: pagamento.email,
          valor: pagamento.valor
        }
      });
      await banco.query(
        'UPDATE pagamentos SET confirmacao_publicada = TRUE WHERE id = $1', [id]
      );
      console.log(`[PAGAMENTO] Pagamento #${id} confirmado: SUCESSO`);
    }
    canalRabbit.ack(mensagem);
  } catch (erro) {
    console.error('[PAGAMENTO] Erro ao confirmar pagamento:', erro.message);
    // Em caso de erro temporario, devolve a mensagem para nova tentativa.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    canalRabbit.nack(mensagem, false, true);
  }
}

app.get('/health', (req, res) => {
  res.json({ servico: 'pagamento', status: 'online' });
});

app.get('/pagamentos', async (req, res) => {
  try {
    const { rows } = await banco.query('SELECT * FROM pagamentos ORDER BY id DESC');
    res.json(rows);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao consultar pagamentos.' });
  }
});

app.get('/pagamentos/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ erro: 'ID invalido.' });
  try {
    const { rows } = await banco.query('SELECT * FROM pagamentos WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ erro: 'Pagamento nao encontrado.' });
    res.json(rows[0]);
  } catch (erro) {
    console.error(erro);
    res.status(500).json({ erro: 'Falha ao consultar pagamento.' });
  }
});

app.post('/pagamentos', async (req, res) => {
  const erro = validarPagamento(req.body);
  if (erro) return res.status(400).json({ erro });

  const { nome, email, valor } = req.body;
  try {
    const { rows } = await banco.query(
      `INSERT INTO pagamentos (nome, email, valor, status)
       VALUES ($1, $2, $3, 'PENDENTE') RETURNING *`,
      [nome.trim(), email.trim(), valor]
    );
    const pagamento = rows[0];
    console.log(`[PAGAMENTO] Pagamento #${pagamento.id} salvo com status PENDENTE`);
    try {
      await publicarSolicitacao(pagamento);
    } catch (erroPublicacao) {
      console.error('[PAGAMENTO] Solicitacao sera reenviada:', erroPublicacao.message);
      // O pagamento foi salvo. Uma rotina de recuperacao tentara publicar novamente.
    }
    res.status(202).json({
      mensagem: 'Pagamento recebido para processamento assincrono.',
      pagamento: { id: pagamento.id, nome: pagamento.nome, email: pagamento.email,
        valor: pagamento.valor, status_inicial: 'PENDENTE' },
      consultar: `/pagamentos/${pagamento.id}`
    });
  } catch (erroBanco) {
    console.error('[PAGAMENTO] Erro no cadastro:', erroBanco.message);
    res.status(500).json({ erro: 'Nao foi possivel salvar o pagamento.' });
  }
});

async function iniciar() {
  await criarTabela();
  conexaoRabbit = await amqp.connect(process.env.RABBITMQ_URL);
  canalRabbit = await conexaoRabbit.createConfirmChannel();
  await canalRabbit.assertQueue(FILA_NOTIFICACOES, { durable: true });
  await canalRabbit.assertQueue(FILA_CONFIRMACOES, { durable: true });
  await canalRabbit.prefetch(1);
  await canalRabbit.consume(FILA_CONFIRMACOES, receberConfirmacao, { noAck: false });

  // O recebimento HTTP nao depende da notificacao estar ligada.
  app.listen(PORTA, '0.0.0.0', () => {
    console.log(`[PAGAMENTO] API disponivel na porta ${PORTA}`);
  });
  await reenviarSolicitacoesPendentes();
  setInterval(reenviarSolicitacoesPendentes, 5000);
}

iniciar().catch((erro) => {
  console.error('[PAGAMENTO] Nao foi possivel iniciar:', erro);
  process.exit(1);
});
