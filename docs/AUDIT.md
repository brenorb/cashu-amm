# Auditoria adversarial da PoC

Data da auditoria: 2026-08-03

## Veredito

O caminho executado pela UI agora é real: o backend chama Nutshell para
receber, selecionar e serializar proofs Cashu, e persiste o estado econômico.
Os testes usam gateways falsos somente para testar atomicidade sem depender de
uma mint online; isso não é o runtime da aplicação.

## Controles presentes

- validação de mint e unidade antes de aceitar TokenV4;
- `Wallet.load_mint`, keysets e `receive` do Nutshell no gateway;
- outputs serializados com DLEQ (`include_dleq=True`);
- snapshots versionados com rename atômico;
- journal durável para operações em andamento;
- lock de processo para impedir duas mutações econômicas simultâneas;
- refunds Cashu quando uma etapa de compensação consegue produzir o token.

## Limites conhecidos da PoC

- existe um único operador custodial e um único processo;
- uma operação pendente bloqueia a inicialização até reconciliação manual;
- não há recuperação automática multi-operador, proof-of-reserves, HTLC,
  Nostr, oracle ou governança;
- a cotação Lightning exige pagamento externo da invoice;
- não há garantia de solvência se o operador perder chaves, fundos ou acesso à
  mint.

Esses limites são deliberados para testar o conceito nesta semana. A UI não
fabrica mais saldos, faucets ou LP receipts: entradas e saídas de operações são
TokenV4 reais quando as três mints Nutshell estão configuradas.
