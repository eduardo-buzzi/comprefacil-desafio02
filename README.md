# Aplicacao de Pagamento (Desafio 2)

Projeto desenvolvido para a disciplina **Desenvolvimento de Sistemas Distribuidos**, usando Node.js, PostgreSQL, RabbitMQ e Docker Compose.

## Objetivo

Demonstrar dois microsservicos independentes que se comunicam de maneira assincrona: um recebe os pagamentos e o outro notifica o usuario sobre o recebimento e a confirmacao.

**OBS:** este projeto e uma simulacao academica.

## Tecnologias Utilizadas

- Node.js com Express (APIs REST)
- PostgreSQL (dados dos pagamentos)
- RabbitMQ (mensagens AMQP entre os servicos)
- Docker Compose (execucao dos quatro containers)

## Estrutura de pastas

```text
CompreFacil-Desafio2-DSD/
├── compose.yaml
├── .env.exemplo
├── .gitignore
├── pagamento/
│   ├── Dockerfile
│   ├── package.json
│   ├── src/
│   │   ├── index.js
│   │   └── validacao.js
│   └── test/
│       └── validacao.test.js
├── notificacao/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       └── index.js
└── exemplos/
    └── requisicoes.http
```

## Como executar

**Pre-requisitos:** Docker Desktop instalado e aberto (com containers Linux). Nao e necessario instalar PostgreSQL, RabbitMQ ou Node.js separadamente para executar pelo Docker.

1. Abra a pasta do projeto no VS Code.
2. Abra o terminal do VS Code na pasta que contem `compose.yaml`.
3. Execute:

```powershell
docker compose up --build -d
```

4. Verifique se os quatro containers iniciaram:

```powershell
docker compose ps
```

5. Para acompanhar os logs de pagamento e notificacao:

```powershell
docker compose logs -f pagamento notificacao
```

Use **Ctrl+C** para parar a visualizacao de logs. Os containers continuam funcionando.

## Enderecos Utilizados

| Servico | Endereco |
| --- | --- |
| API Pagamento | http://localhost:3001/health |
| API Notificacao | http://localhost:3002/health |
| Consultar pagamentos | http://localhost:3001/pagamentos |
| Consultar avisos | http://localhost:3002/notificacoes |
| Painel do RabbitMQ | http://localhost:15672 |

No painel RabbitMQ, use **usuario `aluno`** e **senha `aluno123`**. No menu **Queues and Streams**, verifique as filas `fila.notificacoes` e `fila.confirmacoes`.

## Como testar (Postman)

Crie uma requisicao **POST** para:

`http://localhost:3001/pagamentos`

Em **Body > raw > JSON**, use:

```json
{
  "nome": "Alanzinho123",
  "email": "alanzinho@exemplo.com",
  "valor": 9999.90
}
```

Clique em **Send**. A API deve responder HTTP **202 Accepted**, informando que o pagamento foi recebido para processamento. O objeto da resposta mostra `status_inicial: "PENDENTE"` (nao e uma consulta atualizada do banco).

Aguarde alguns segundos e abra no navegador:

- `http://localhost:3001/pagamentos`: pagamento com status **SUCESSO**.
- `http://localhost:3002/notificacoes`: duas notificacoes do mesmo pagamento, uma de recebimento e outra de confirmacao.

## Como funciona a comunicacao

1. O servico de pagamento recebe o POST e grava o pagamento no PostgreSQL como **PENDENTE**.
2. O servico de pagamento publica `PAGAMENTO_RECEBIDO` em `fila.notificacoes`.
3. O servico de notificacao consome a mensagem, registra (ou envia por e-mail, se configurado) um aviso e publica `SOLICITACAO_NOTIFICADA` em `fila.confirmacoes`.
4. O servico de pagamento consome essa mensagem de retorno e atualiza o status para **SUCESSO**.
5. O pagamento publica `PAGAMENTO_CONFIRMADO` em `fila.notificacoes`.
6. O servico de notificacao consome o evento de confirmacao e registra/envia o segundo aviso.

O retorno adicional da etapa 3 serve para garantir a ordem: so confirmar o pagamento depois que o primeiro aviso for processado. Nenhum servico precisa fazer requisicao HTTP diretamente ao outro.

## Servicos sao independentes

Com tudo funcionando, execute:

```powershell
docker compose stop notificacao
```

Depois envie outro pagamento pelo Postman. Ele sera armazenado como **PENDENTE**; como o servico de notificacao esta parado, a mensagem fica na fila do RabbitMQ. Em seguida execute:

```powershell
docker compose start notificacao
```

A notificacao processa a mensagem pendente, devolve o evento de retorno e o pagamento muda para **SUCESSO**. Isso demonstra a troca de mensagens sem acoplamento direto entre os dois servicos.
