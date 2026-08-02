# Auditoria adversarial da PoC

Data da auditoria: 2026-08-02  
Referências: [`docs/SPEC.md`](./SPEC.md), código atual e o adapter
`Granola/NutshellWalletBackend` em `granola/src/granola/nutshell.py`, incluindo
`granola/tests/test_nutshell_backend.py`.

## Veredito

Depois das correções listadas abaixo, a implementação está conforme a SPEC da
PoC. A suíte local deve permanecer verde com `npm test`.

## Achados corrigidos

| ID | Severidade | Achado | Correção |
| --- | --- | --- | --- |
| A-001 | P2 | `asset in FAUCET_AMOUNTS` aceitava chaves herdadas como `toString`. | O faucet agora usa `Object.hasOwn` e exige uma string de ativo conhecida; há teste de regressão. |
| A-002 | P2 | Snapshots persistidos não tinham versão explícita. | `serializeState` grava `version: 1`; `deserializeState` rejeita versões ausentes ou desconhecidas e o carregamento retorna ao seed. |
| A-003 | P2 | Receipt mock podia ser criado com nonce vazio. | Criação e decodificação exigem nonce não vazio; há teste de regressão. |

## Comparação com Nutshell

O backend Nutshell trata a fronteira Cashu como uma sequência verificável:

1. normaliza unidade e mint;
2. atualiza informações do mint e keysets;
3. considera `input_fee_ppk` e validade/expiração do keyset;
4. valida TokenV4, unidade, mint, DLEQ e estado dos proofs;
5. prepara outputs antes do submit;
6. faz commit, invalida inputs e recupera outputs após crash com NUT-09.

O navegador desta PoC só implementa o equivalente informativo do item 1
(`mints.js` consulta `/v1/info`) e uma simulação local dos itens econômicos. Não
há proofs reais, TokenV4, DLEQ, keysets, fees Cashu, split no mint, reserva de
proofs, invalidação durável ou recovery. Isso não é um bug oculto: a SPEC
declara faucet sintético, receipt mock, backend remoto e HTLC fora do escopo.

## Itens deliberadamente fora do escopo

- trocar o faucet sintético por uma carteira Cashu Testnut;
- emitir LP shares como proofs de uma share mint;
- aceitar depósitos, swaps e resgates entre navegadores;
- implementar `prepare/commit/recover`, NUT-09, HTLC, locktime ou refund;
- incorporar `input_fee_ppk`, expiração de keyset e proof-of-reserves na curva.

Esses itens são os gates da próxima integração backend. Não devem ser tratados
como implementados pela demo atual.
