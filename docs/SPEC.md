# Cashu AMM — especificação da PoC

Status: proposta executável para a demo da semana.

Esta especificação descreve a prova de conceito do Cashu AMM. Ela não define
um protocolo de produção, uma custódia real ou uma DEX trustless.

## 1. Objetivo

Demonstrar, no navegador, um pool BTC/USD com curva de produto constante:

```text
depositar BTC + USD → receber LP shares → trocar contra a pool → resgatar
```

A demo deve tornar visíveis três coisas:

1. a cotação muda conforme as reservas mudam;
2. a pool recebe a fee e arredonda em seu favor;
3. uma posição de liquidez pode ser representada por um bearer receipt.

## 2. Escopo da PoC

Incluído:

- dois ativos: BTC e USD;
- BTC em satoshis;
- USD em cents, a menor unidade inteira exposta pela mint de teste;
- pool de dois ativos;
- `x × y = k`;
- fee fixa de 1% (`100 bps`);
- swaps `exact-in`;
- depósitos proporcionais dos dois ativos;
- LP shares fungíveis;
- resgates proporcionais;
- estado persistido no `localStorage` do navegador;
- faucet sintético para os saldos da demo;
- consulta somente leitura aos mints Testnut usados pelo Granola.

Fora do escopo:

- custodiar ou gastar proofs Cashu reais;
- pool compartilhada entre navegadores;
- backend, operador remoto ou banco de dados;
- HTLC, Nostr, oracle, router multi-pool ou federação;
- depósito single-sided;
- StableSwap, Weighted Math ou concentrated liquidity;
- proof of reserves;
- governança, recuperação de chaves e tratamento de insolvência.

## 3. Estado inicial

A pool começa com reservas sintéticas:

| Campo | Valor |
| --- | ---: |
| Reserva BTC | `1.000.000 sat` |
| Reserva USD | `50.000 cents` (`$500,00`) |
| Preço inicial | `USD 50.000 / BTC` |
| Fee | `1%` |
| LP supply inicial | `floor(sqrt(1.000.000 × 50.000)) = 223.606 LP` |

O seed inicial pertence ao operador da demo. A carteira do visitante começa
sem saldo e pode receber valores sintéticos pelos botões de faucet.

## 4. Modelo de preço

O preço spot exibido é a razão entre reservas, convertida para BTC inteiro:

```text
spot_usd_per_btc = reserve_usd_cents × 1.000.000 / reserve_sat
```

O invariant de referência é:

```text
k = reserve_sat × reserve_usd_cents
```

O invariant não precisa permanecer exatamente igual porque a fee fica dentro
da pool. Depois de um swap válido, ele não pode diminuir.

## 5. Swap exact-in

Para um input `a`, reserva de entrada `x`, reserva de saída `y` e fee `f`:

```text
BPS = 10.000
effective = a × (BPS - f)
amount_out = floor(effective × y / (x × BPS + effective))
```

Na PoC, `f = 100`.

Depois do swap:

```text
reserve_in  = reserve_in  + amount_in
reserve_out = reserve_out - amount_out
```

O swap falha quando:

- o input é zero ou não inteiro;
- a carteira não possui o input;
- a reserva de saída é insuficiente;
- o output arredondado é zero;
- a operação produziria um estado inválido.

O operador não usa HTLC neste experimento. A execução é uma operação local
serializada no navegador; a aplicação registra um evento e atualiza o estado.

## 6. Liquidez e LP shares

### 6.1 Depósito

O visitante deposita os dois ativos na proporção atual da pool. A interface
ajusta o segundo valor automaticamente quando um dos inputs muda.

Para reservas `R_sat`, `R_usd`, supply `S` e depósito `D_sat`, `D_usd`:

```text
shares_sat = floor(D_sat × S / R_sat)
shares_usd = floor(D_usd × S / R_usd)
shares     = min(shares_sat, shares_usd)
```

As shares são emitidas somente depois de os dois inputs serem aceitos pela
operação local. Qualquer sobra causada por arredondamento permanece na pool.

### 6.2 Resgate

Para `L` shares resgatadas:

```text
amount_sat = floor(R_sat × L / S)
amount_usd = floor(R_usd × L / S)
```

O resgate falha se `L > S` ou se o visitante não possui as shares. O saldo de
shares é reduzido somente junto com a atualização dos dois ativos.

### 6.3 Bearer receipt

O receipt emitido pela demo tem o formato explícito:

```text
cashu-amm-mock:<base64-json>
```

O payload contém `kind`, `pool`, `amount`, `nonce` e `mock: true`. Ele não é um
token Cashu válido e não deve ser apresentado como prova de solvência.

Uma integração futura poderá substituir esse receipt por proofs de uma share
mint, mas isso exigirá um operador/backend para custodiar as reservas e emitir
os outputs reais.

## 7. Estado e concorrência

O estado da PoC é um único objeto local com:

```text
pool:    reserve_sat, reserve_usd, shares
wallet:  sat, usd, lp
ledger:  eventos locais
```

Cada ação é executada de forma serial pelo JavaScript da página. Não existe
reservation lease, `state_seq` distribuído ou consenso entre usuários.

## 8. Arredondamento e tipos

- toda quantia de settlement é inteira;
- a matemática usa `BigInt`;
- output de swap arredonda para baixo;
- shares emitidas arredondam para baixo;
- resgates arredondam para baixo;
- o remainder fica com a pool;
- valores `Number` aparecem somente para formatação visual e preço exibido.

## 9. Invariantes da demo

Após qualquer operação bem-sucedida:

- reservas e saldos são não negativos;
- nenhum output ultrapassa a reserva correspondente;
- `wallet.lp <= pool.shares`;
- `pool.shares` diminui somente em resgates;
- swaps não criam nem destroem LP shares;
- a fee permanece na pool;
- o invariant ajustado pela fee não diminui;
- o ledger contém um registro do evento executado.

## 10. Testes de aceitação

Os testes matemáticos devem cobrir:

- raiz quadrada inteira;
- supply inicial;
- fee de 1%;
- output arredondado para baixo;
- crescimento de `k` após swap;
- depósito proporcional;
- resgate proporcional;
- rejeição de shares acima do supply.
- rejeição de ativos, direções, inputs e receipts inválidos;
- atomicidade das operações que falham;
- mudança do preço após swap;
- round-trip do estado serializado.

O teste manual deve demonstrar:

1. emitir saldo sintético BTC e USD;
2. depositar liquidez e receber LP receipt;
3. executar BTC → USD;
4. executar USD → BTC;
5. observar reservas, preço, fee e invariant mudarem;
6. resgatar parte das shares;
7. reiniciar a demo, recarregar a página e confirmar que o estado local foi apagado.

## 11. Testnet e próxima integração

O painel consulta os endpoints públicos usados no protótipo Granola:

- `https://testnut.cashu.space`;
- `https://nofee.testnut.cashu.space`.

Essa consulta é informativa e não movimenta fundos. A próxima etapa, caso a
PoC valide a experiência, é substituir o faucet local por uma carteira Cashu
de testnet e definir um serviço de pool que receba proofs, atualize reservas e
emita outputs. Essa etapa não faz parte desta especificação.

## 12. Mapa da implementação

O núcleo matemático está em `amm.js`; as transições de estado, ledger, faucet,
receipt mock e serialização estão em `poc.js`. A página em `index.html` e
`app.js` expõe as duas abas e persiste a simulação no `localStorage`. A consulta
read-only dos mints está isolada em `mints.js`.

`npm test` executa os testes matemáticos (`amm.test.js`), de transições e
invariantes (`poc.test.js`), de parsing de inputs (`inputs.test.js`), de
disponibilidade dos mints (`mints.test.js`) e do contrato mínimo da interface
(`ui-contract.test.js`).
