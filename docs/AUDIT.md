# Auditoria adversarial da PoC

Data: 2026-08-04

## Veredito atual

Os bloqueios da demo foram corrigidos. SAT e USD vêm da Testnut; LP é um
TokenV4 assinado dinamicamente por uma mint Nutshell privada controlada pela
pool; site e API rodam juntos em um único container.

Há exatamente um mock no runtime: a mint LP usa `FakeWallet` como backend de
pagamento e auto-liquida suas quotes. Isso não fabrica os tokens de reserva nem
substitui a criptografia Cashu do LP. É o atalho que permite à pool emitir
shares sem fingir que elas são lastreadas por Lightning: o lastro econômico são
os dois tokens Cashu SAT e USD depositados nas wallets da pool.

O fluxo real validado foi:

```text
mint SAT/USD → depositar → emitir LP → swap nos dois sentidos → resgatar LP
```

O smoke test de API e o E2E Chrome terminaram com as reservas e o supply LP
novamente em zero. O smoke não imprime bearer tokens.

## Achados resolvidos

- removido o inventário LP pré-semeado;
- LP agora pertence a uma mint privada distinta da mint dos ativos;
- removido o deploy estático em GitHub Pages;
- primeiro depósito inicializa a pool sem bootstrap parcial;
- depósitos desproporcionais são recusados com refund;
- o valor efetivamente recebido incorpora fees de input Cashu;
- inputs inválidos não deixam journal pendente;
- resgates que arredondam um ativo para zero são recusados;
- outputs de resgate preparados são cancelados antes de devolver LP em uma
  falha;
- retry da mesma quote paga devolve o mesmo token;
- depósito, swap e resgate aceitam `operation_id` e devolvem exatamente o mesmo
  resultado — inclusive bearer tokens — em retry;
- refunds aparecem na UI;
- existe E2E de API e de navegador com Testnut real e container saudável;
- a chave privada da mint LP saiu do Compose e agora é obrigatória em `.env`.

## Controles presentes

- validação de mint e unidade de cada TokenV4;
- keysets, DLEQ, proof state e double-spend delegados ao Nutshell;
- lock único para mutações econômicas;
- snapshot versionado com escrita atômica;
- journal durável para operações em andamento;
- cache durável de respostas idempotentes, gravado antes de encerrar o journal;
- mint LP acessível somente via loopback;
- estado e bancos persistidos em volume;
- testes unitários dos caminhos de compensação.

## Limites aceitos para esta PoC

- um operador custodia tudo;
- um único processo atende a pool;
- falha ambígua que não pode ser compensada bloqueia o restart para ação manual;
- não há atomicidade distribuída perfeita entre mints;
- o `.env` e o volume da mint precisam de backup conjunto;
- `invalidate()` remove as proofs LP recebidas da wallet do operador, mas não é
  um burn Cashu protocolar auditável; as proofs originais do usuário já foram
  gastas no `receive`, porém a redução de liability depende da contabilidade da
  aplicação;
- não há autenticação, rate limiting da aplicação, backup operacional, proof of
  reserves ou proteção para fundos reais;
- swaps ainda não aceitam `minimum_amount_out`; isso está registrado na
  [issue #1](https://github.com/brenorb/cashu-amm/issues/1);
- perder chaves, reservas ou acesso às mints pode tornar LP insolvente.

Esses itens não impedem a demo local desta semana. Eles impedem chamar a PoC de
produto pronto ou colocar valor real nela.
