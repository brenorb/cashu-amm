# Cashu AMM — especificação da PoC

Status: implementação executável com backend Cashu/Nutshell.

Esta especificação descreve a prova de conceito do Cashu AMM. Ela não define
um protocolo de produção ou uma DEX trustless. O backend, porém, movimenta
proofs Cashu reais quando configurado com carteiras e mints do operador.

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
- backend HTTP server-side;
- proofs Cashu TokenV4 como entrada e saída;
- três carteiras Nutshell persistentes: SAT, USD e LP;
- estado da pool persistido no servidor;
- emissão de cotações de mint para obter tokens Testnet pagando a invoice;
- consulta de capacidade dos mints antes da operação.

Fora do escopo:

- pool compartilhada entre navegadores;
- operação trustless sem operador;
- HTLC, Nostr, oracle, router multi-pool ou federação;
- depósito single-sided;
- StableSwap, Weighted Math ou concentrated liquidity;
- proof of reserves;
- governança, recuperação de chaves e tratamento de insolvência.

## 3. Estado inicial e configuração

A pool começa com tokens Cashu fornecidos pelo operador:

| Campo | Valor |
| --- | ---: |
| Reserva BTC | `1.000.000 sat` |
| Reserva USD | `50.000 cents` (`$500,00`) |
| Preço inicial | `USD 50.000 / BTC` |
| Fee | `1%` |
| LP supply inicial | `floor(sqrt(1.000.000 × 50.000)) = 223.606 LP` |

O seed é recebido uma vez pelas carteiras Nutshell do backend e deve obedecer
`shares = floor(sqrt(reserve_sat × reserve_usd))`. Os tokens de seed não ficam
no navegador. A configuração mínima é:

- `CASHU_AMM_SAT_MINT_URL` e `CASHU_AMM_USD_MINT_URL`;
- `CASHU_AMM_LP_MINT_URL` e `CASHU_AMM_LP_UNIT`;
- `CASHU_AMM_SEED_SAT_TOKEN`, `CASHU_AMM_SEED_USD_TOKEN` e
  `CASHU_AMM_SEED_LP_TOKEN` na primeira inicialização;
- `CASHU_AMM_DATA_DIR` para os bancos Nutshell e o snapshot da pool.

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

O operador não usa HTLC neste experimento. A execução é uma operação serializada
no backend; o navegador apenas envia o TokenV4 e exibe a resposta.

## 6. Liquidez e LP shares Cashu

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

### 6.3 Token LP

Cada LP share corresponde a uma unidade da carteira de share mint configurada.
O depósito devolve um TokenV4 dessa mint; o resgate recebe esse TokenV4 no
backend, invalida as provas recebidas na wallet do operador e emite os dois
tokens subjacentes.
O token LP é bearer Cashu real, mas não é prova de solvência independente: a
solvência depende das reservas das carteiras do operador.

## 7. Estado, concorrência e recuperação

O estado econômico da PoC é um único objeto server-side com:

```text
pool:    reserve_sat, reserve_usd, shares
wallet:  três carteiras Nutshell do operador; a carteira do usuário fica fora do servidor
ledger:  eventos server-side
```

O snapshot server-side inclui `version: 1` e é gravado por rename atômico.
Cada operação serializa pelo lock do processo, grava um evento e mantém os
bancos Nutshell como fonte de verdade dos proofs.

Se o processo cair depois de um split no mint, a operação deve permanecer
identificável pelo journal e os outputs reservados não podem ser reutilizados.
O operador precisa reconciliar operações pendentes antes de reabrir a pool;
isso é a versão PoC do prepare/commit/recover usado pelo Nutshell/Granola.

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
- o total de LP contabilizado pela pool não excede o seed e os depósitos aceitos;
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

1. obter e pagar uma mint quote de SAT/USD, ou colar tokens Cashu já existentes;
2. depositar os dois TokenV4 e receber o TokenV4 de LP;
3. executar BTC → USD;
4. executar USD → BTC;
5. observar reservas, preço, fee e invariant mudarem;
6. resgatar parte das shares;
7. reiniciar o backend e confirmar que o snapshot e os bancos Nutshell foram
   reabertos sem perder a pool.

## 11. Testnet e integração Cashu

O painel consulta os endpoints públicos usados no protótipo Granola:

- `https://testnut.cashu.space`;
- `https://nofee.testnut.cashu.space`.

O backend usa essas mints apenas quando configuradas explicitamente. A rota de
mint quote chama `Wallet.request_mint`; depois que o usuário paga a invoice,
`Wallet.mint` e `serialize_proofs(include_dleq=True)` devolvem um TokenV4.
Nenhum faucet sintético é usado.

## 12. Contrato HTTP

- `GET /api/pool`: reservas, preço, `k`, fee e ledger;
- `POST /api/liquidity/deposit`: recebe `{sat_token, usd_token}` e devolve
  `{shares, lp_token}`;
- `POST /api/swap`: recebe `{direction, token}` e devolve o token da outra
  carteira;
- `POST /api/liquidity/redeem`: recebe `{lp_token}` e devolve tokens SAT/USD;
- `GET /health`: verifica que o processo está vivo.

Falhas depois de receber um token retornam refunds Cashu quando possível e não
alteram o snapshot econômico. Falhas de compensação ficam como operação
pendente para reconciliação do operador.

## 13. Mapa da implementação

O núcleo de matemática de referência está em `amm.js`; o backend real está
em `backend/amm.py`, `backend/service.py`, `backend/nutshell.py`,
`backend/store.py` e `backend/app.py`. A UI chama o contrato HTTP e não mantém
reservas autoritativas no `localStorage`.

`npm test` cobre a UI e a matemática JS. `pytest backend/tests` cobre a
matemática Python, gateways, refunds, persistência e contrato HTTP. O adapter
`backend/nutshell.py` é a única camada que conhece a API do Nutshell.
