# Cashu AMM proof of concept

PoC de uma pool BTC/USD `x × y = k` com fee fixa de 1%, usando proofs Cashu
reais através de três wallets Nutshell no backend: SAT, USD e LP.

O navegador não guarda reservas, saldos ou recibos sintéticos. Ele apenas cola
TokenV4, chama a API e mostra os tokens devolvidos. A operação é custodial e
single-process: adequada para a demo, não para fundos reais.

## Desenvolvimento

O backend requer Python 3.12 e `cashu==0.20.2` (a mesma linha usada pelo
Nutshell/Granola):

```sh
uv sync
uv run uvicorn backend.main:app --host 127.0.0.1 --port 8090
```

O frontend estático pode ser servido em outro terminal:

```sh
npm test
npm run serve
```

Abra `http://localhost:4173`. Para apontar a UI para outro backend, defina
`window.CASHU_AMM_API_URL` antes de carregar `app.js`.

## Configuração Nutshell

Defina as mints e os tokens de seed antes da primeira inicialização:

```sh
export CASHU_AMM_SAT_MINT_URL=https://testnut.cashu.space
export CASHU_AMM_USD_MINT_URL=https://testnut.cashu.space
export CASHU_AMM_LP_MINT_URL=https://testnut.cashu.space
export CASHU_AMM_LP_UNIT=sat
export CASHU_AMM_SEED_SAT_TOKEN='cashuB…'
export CASHU_AMM_SEED_USD_TOKEN='cashuB…'
export CASHU_AMM_SEED_LP_TOKEN='cashuB…'
export CASHU_AMM_DATA_DIR=./data
```

O seed inicial deve conter `floor(sqrt(reserve_sat * reserve_usd))` unidades LP.
Depois da primeira execução, o snapshot e os bancos Nutshell ficam em
`CASHU_AMM_DATA_DIR`. Se houver uma operação pendente no journal, o backend
abre em modo fechado e exige reconciliação manual do operador.

## Fluxo da demo

1. Gere uma mint quote SAT/USD, pague a invoice e copie o TokenV4 emitido.
2. Cole SAT + USD na aba **Liquidez** e guarde o TokenV4 LP recebido.
3. Cole um TokenV4 na aba **Trade**, escolha a direção e guarde o output.
4. Cole o LP na gaveta de resgate para receber os dois ativos subjacentes.

As respostas de erro incluem refunds Cashu quando a compensação foi possível.

## Testes

```sh
npm test
/Users/breno/Documents/code/PROJECTS/granola/.venv/bin/python -m pytest backend/tests -q
```

Os testes Python cobrem matemática, persistência, journal, contrato HTTP,
atomicidade e a fronteira de validação do gateway Nutshell. Não é necessário
um mint online para executar a suíte; a emissão e o recebimento reais são
exercitados quando o backend é configurado com mints testnet.
