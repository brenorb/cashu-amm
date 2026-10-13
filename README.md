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

1. Clique em **Get liquidity test tokens** para mintar na Testnut um par SAT +
   USD proporcional à pool. A página salva os outputs automaticamente na
   carteira testnet do navegador. Os botões **Mint SAT/USD** permitem obter
   tokens adicionais para trades.
2. Use **Add liquidity** na carteira para carregar os tokens SAT + USD no
   depósito e receber um token LP, também salvo automaticamente.
   Na aba **One asset**, você também pode enviar apenas SAT ou USD depois que a
   pool já estiver inicializada. A pool faz um zap interno de parte do token e
   emite as shares correspondentes.
3. Use **Sell BTC** ou **Buy BTC** na carteira para carregar o token mais recente
   no trade. Confira saída estimada, mínimo recebido e impacto; ajuste a tolerância
   e execute enquanto a cotação estiver válida. O ativo recebido substitui
   economicamente o token gasto.
4. Use **Redeem** na carteira para devolver o LP e salvar os dois ativos pro rata.

A carteira é propositalmente mínima: persiste em `localStorage` somente bearer
tokens cujos valores a própria demo conhece. Ela não consulta uma mint para
descobrir tokens externos, não faz split/merge e não deve ser usada com fundos
reais. Limpar os dados do site apaga o acesso aos tokens locais.

O backend contabiliza o valor que realmente entrou na wallet depois das fees de
input Cashu. Essas fees são da mint e são separadas da taxa de 1% do AMM.
Quando uma operação pode ser desfeita com segurança, a resposta de erro mostra
os TokenV4 de refund para o usuário copiar.

## Mínimo de saída e cotação

A interface consulta `POST /api/swap/quote` com direção e face do token. Para
um token colado manualmente, informe sua quantidade inteira (SAT ou centavos
USD); tokens conhecidos pela carteira preenchem esse valor automaticamente.
O trade consome o token inteiro. A estimativa precede taxas de input Cashu, e o
impacto inclui curva/arredondamento, separado da taxa AMM de 1%.

O cliente escolhe `minimum_amount_out` e pode enviar `quote_deadline_ms` (Unix em
milissegundos). O piso é obrigatório na API; zero o desliga explicitamente. A UI
sempre envia um piso positivo, calculado com a tolerância escolhida, e o prazo de
30 segundos devolvido pela cotação. Atualize a cotação quando ela expirar.

Saída abaixo do mínimo ou prazo expirado durante receive retorna HTTP 409 com
`refunds` e `refund_amounts`: tokens de devolução e a quantidade líquida realmente
recebida, após taxas Cashu. As reservas não mudam. Um prazo já expirado antes do
receive deixa o token original sem consumo. `input_received` distingue esses
casos; se a devolução falhar, a UI não mantém o input gasto como saldo disponível.
O journal exige recuperação pelo operador antes de novas mutações pendentes.

Mantenha o mesmo `operation_id`, token, mínimo e prazo em retries. Outputs e
refunds concluídos são recuperáveis do cache durável mesmo após expiração. Na
página aberta, uma falha de rede/5xx mantém os parâmetros e oferece **Retry saved
trade**, sem renovar o mínimo ou o prazo automaticamente. O ID também deve ser
preservado por clientes de API; a página não oferece recuperação automática de
uma operação pendente após um hard reload do navegador.

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

## Verification

```sh
npm ci
uv sync --no-config --locked --dev
uv run --no-config --locked ruff check .
npm test
uv run --no-config --locked pytest
```

PR, main and version-tag CI runs both the frontend and backend suites. These
gates use local/fake mint fixtures; the existing browser E2E against running
mints remains a separate integration command.
