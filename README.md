# Cashu AMM proof of concept

Pool SAT/USD de produto constante (`x × y = k`) com taxa de 1%. O site aceita
TokenV4 reais da Testnut, emite um bearer token LP e permite swaps nos dois
sentidos.

A pool tem duas portas sobre as mesmas reservas:

- **Liquidez:** recebe SAT + USD proporcionais e manda a mint LP privada emitir
  a participação correspondente. No resgate, recebe e invalida o LP e devolve
  SAT + USD pro rata.
- **AMM:** recebe um dos ativos e entrega o outro pela curva, deixando a taxa de
  1% nas reservas. Isso aumenta o valor econômico de cada LP.

É uma PoC custodial, single-process e testnet-only. Não use fundos reais.

## Rodar tudo em um container

Pré-requisito: Docker com Compose.

```sh
cp .env.example .env
# substitua o placeholder por: openssl rand -hex 32
docker compose up --build
```

Abra <http://localhost:8090>. O mesmo processo público serve o site e a API. A
mint LP Nutshell roda no mesmo container, mas escuta somente em
`127.0.0.1:3338`; visitantes não conseguem mintar LP diretamente.

Os bancos das wallets, a mint LP e o snapshot da pool ficam em `./data`, montado
como volume. O primeiro depósito SAT + USD inicializa a pool e define o preço.
`MINT_PRIVATE_KEY` é obrigatório, fica no `.env` ignorado pelo Git e deve
permanecer estável junto com o volume.

A mint LP usa blind signatures, keysets e proofs reais do Nutshell. O único
mock de infraestrutura é seu backend de pagamento `FakeWallet`: quotes LP são
marcadas como pagas automaticamente porque o lastro econômico não é Lightning,
mas o par de tokens Cashu SAT + USD custodiado pela própria pool. Usuários não
podem chamar essa mint diretamente; ela escuta apenas em loopback.

Para parar:

```sh
docker compose down
```

## Fluxo da demo

1. Em **Obter TokenV4**, gere tokens SAT e USD da Testnut.
2. Em **Liquidez**, deposite os dois tokens na proporção da pool e guarde o LP.
3. Em **Trade**, troque SAT por USD ou USD por SAT.
4. Em **Liquidez → Resgatar**, devolva o LP e receba os dois ativos pro rata.

O backend contabiliza o valor que realmente entrou na wallet depois das fees de
input Cashu. Essas fees são da mint e são separadas da taxa de 1% do AMM.
Quando uma operação pode ser desfeita com segurança, a resposta de erro mostra
os TokenV4 de refund para o usuário copiar.

## Verificação

Testes unitários:

```sh
.venv/bin/pytest
npm test
```

Com o container saudável e a pool vazia, o smoke test executa o circuito real
com SAT e USD da Testnut sem imprimir bearer tokens:

```sh
.venv/bin/python scripts/smoke-local.py
```

Ele comprova mint e operações idempotentes, depósito, emissão LP privada, swaps
nos dois sentidos e resgate total.

O E2E de navegador abre o Chrome e executa o mesmo circuito pela interface:

```sh
npm run test:e2e
```

Ambos exigem o container saudável e uma pool vazia, e ambos terminam com a pool
vazia. A especificação está em [`docs/SPEC.md`](docs/SPEC.md) e os limites
auditados em [`docs/AUDIT.md`](docs/AUDIT.md).

Para operar sem navegador, `scripts/smoke-local.py` já serve como CLI de
validação. Também é possível chamar a API com `curl`; o `operation_id` UUID deve
ser mantido ao repetir uma mutação cuja resposta possa ter se perdido. Servir
somente os arquivos estáticos com `npm run serve` não substitui o backend.

## Desenvolvimento sem container

O backend requer Python 3.12 e usa `cashu==0.20.2`:

```sh
uv sync
uv run uvicorn backend.main:app --host 127.0.0.1 --port 8090
```

Esse modo pressupõe uma mint LP Nutshell já disponível na URL configurada. Para
a demo normal, prefira o Compose, que inicia as duas partes na ordem correta.
