const express = require('express');
const amqp = require('amqplib');
const nodemailer = require('nodemailer');

const PORTA = Number(process.env.PORT || 3002);
const FILA_NOTIFICACOES = 'fila.notificacoes';
const FILA_CONFIRMACOES = 'fila.confirmacoes';
const app = express();
const notificacoes = []; // Registros demonstrativos (em memoria).
const chavesProcessadas = new Set();
let canalRabbit;

const smtpConfigurado = Boolean(process.env.SMTP_HOST);
const transporte = smtpConfigurado
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      ...(process.env.SMTP_USER
        ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }
        : {})
    })
  : null;

function publicar(fila, evento) {
  return new Promise((resolve, reject) => {
    canalRabbit.sendToQueue(
      fila,
      Buffer.from(JSON.stringify(evento)),
      { persistent: true, contentType: 'application/json' },
      (erro) => (erro ? reject(erro) : resolve())
    );
  });
}

async function notificar(pagamento, tipo) {
  const assunto = tipo === 'PAGAMENTO_RECEBIDO'
    ? `Solicitacao do pagamento #${pagamento.id} recebida`
    : `Pagamento #${pagamento.id} confirmado`;
  const mensagem = tipo === 'PAGAMENTO_RECEBIDO'
    ? `Ola, ${pagamento.nome}! Recebemos seu pagamento de R$ ${pagamento.valor}. Aguarde a confirmacao.`
    : `Ola, ${pagamento.nome}! Seu pagamento de R$ ${pagamento.valor} foi confirmado com sucesso.`;

  if (transporte) {
    await transporte.sendMail({
      from: process.env.SMTP_FROM || 'notificacoes@comprefacil.local',
      to: pagamento.email,
      subject: assunto,
      text: mensagem
    });
  }

  // Sem SMTP: notificacao fica visivel no console e na API /notificacoes.
  // Com SMTP: tambem e enviada ao destinatario por e-mail.
  notificacoes.push({
    pagamentoId: pagamento.id,
    email: pagamento.email,
    tipo,
    assunto,
    mensagem,
    envio: smtpConfigurado ? 'EMAIL' : 'SIMULADO',
    data: new Date().toISOString()
  });
  console.log(`[NOTIFICACAO] ${smtpConfigurado ? 'E-mail enviado' : 'Aviso simulado'}: ${mensagem}`);
}

async function consumir(mensagem) {
  if (!mensagem) return;
  try {
    const evento = JSON.parse(mensagem.content.toString());
    const pagamento = evento.pagamento;
    if (!pagamento || !Number.isInteger(pagamento.id) || !pagamento.email ||
        !['PAGAMENTO_RECEBIDO', 'PAGAMENTO_CONFIRMADO'].includes(evento.tipo)) {
      console.warn('[NOTIFICACAO] Evento invalido ignorado');
      canalRabbit.ack(mensagem);
      return;
    }

    const chave = `${pagamento.id}:${evento.tipo}`;
    if (!chavesProcessadas.has(chave)) {
      await notificar(pagamento, evento.tipo);
      chavesProcessadas.add(chave);
    }

    if (evento.tipo === 'PAGAMENTO_RECEBIDO') {
      // Retorno por AMQP, sem comunicacao HTTP entre os dois servicos.
      await publicar(FILA_CONFIRMACOES, {
        tipo: 'SOLICITACAO_NOTIFICADA',
        pagamentoId: pagamento.id
      });
      console.log(`[NOTIFICACAO] Aviso de recebimento do #${pagamento.id} concluido`);
    }
    canalRabbit.ack(mensagem);
  } catch (erro) {
    console.error('[NOTIFICACAO] Erro ao processar mensagem:', erro.message);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    canalRabbit.nack(mensagem, false, true);
  }
}

app.get('/health', (req, res) => {
  res.json({ servico: 'notificacao', status: 'online', modo: smtpConfigurado ? 'email' : 'simulacao' });
});

app.get('/notificacoes', (req, res) => {
  const email = req.query.email;
  const resultado = email
    ? notificacoes.filter((n) => n.email.toLowerCase() === String(email).toLowerCase())
    : notificacoes;
  res.json(resultado);
});

async function iniciar() {
  const conexao = await amqp.connect(process.env.RABBITMQ_URL);
  canalRabbit = await conexao.createConfirmChannel();
  await canalRabbit.assertQueue(FILA_NOTIFICACOES, { durable: true });
  await canalRabbit.assertQueue(FILA_CONFIRMACOES, { durable: true });
  await canalRabbit.prefetch(1);
  await canalRabbit.consume(FILA_NOTIFICACOES, consumir, { noAck: false });
  app.listen(PORTA, '0.0.0.0', () => {
    console.log(`[NOTIFICACAO] API disponivel na porta ${PORTA}`);
    if (!smtpConfigurado) console.log('[NOTIFICACAO] Modo local: avisos simulados.');
  });
}

iniciar().catch((erro) => {
  console.error('[NOTIFICACAO] Nao foi possivel iniciar:', erro);
  process.exit(1);
});
